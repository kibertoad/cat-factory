# `@cat-factory/local-server`: local-mode runtime facade

> Directory `backend/runtimes/local`, published as `@cat-factory/local-server`.

The Node facade (`@cat-factory/node-server`) with **two swaps** so a developer runs the whole
product on their own machine: agent jobs run as **per-run local containers**
(Docker/Podman/OrbStack/Colima/Apple), and GitHub is reached via a **PAT** instead of a GitHub
App. Reuses ALL of Node's persistence / pg-boss / gateways unchanged; only the runner
transport + the GitHub token/client seams differ.

**Entry:** `src/index.ts` (`startLocal()` / `buildLocalContainer`); `src/main.ts`.

**Where things live:**

- `LocalContainerRunnerTransport.ts`: the per-run container transport (the local analogue of
  the CF Container transport + the runner-pool transport, over the same `RunnerTransport` port).
- `runtimes/`: the `ContainerRuntimeAdapter`s per engine (docker CLI shared by
  Docker/Podman/OrbStack/Colima; a separate Apple `container` adapter), selected by
  `LOCAL_CONTAINER_RUNTIME`. Two contracts an adapter is easy to get wrong: `endpoint()`
  resolves an EXITED container to `undefined` (that is what lets the transport remove and
  re-create it via `dispatchPerRun`) yet still throws for a fault against a LIVE one (a runtime
  that can't tell the two apart, Apple, takes the `undefined` half), and `exitState()` reports
  how a stopped container ended so a mid-run death leaves a post-mortem (plus a scrubbed `logs()`
  tail) onto the failed view's `detail`, since `release()` removes it as the run settles. A
  re-dispatch removes it too, so the FIRST death's post-mortem is retained on
  `PipelineStep.firstEvictionDetail`. Each adapter also exposes a `localDind` capability threaded
  into `ExecutionService` as `localTestInfraSupported`, so a runtime that can't nest containers
  refuses a local-infra Tester run at start.
- `github.ts`, `link-repo.ts` / `linkRepo.ts`, `installations.ts`: the PAT-backed GitHub
  client (`createLocalGitHubClient`) + the repo-projection seeding (`linkRepo`).
- `vcsCredential.ts` + `sqlite/vcsCredentialStore.ts` + `vcsClientRouter.ts`: the deployment's
  source-control credential as ONE LIVE value. `.env` (`GITHUB_PAT` / `GITLAB_PAT`) wins; else the
  sealed local store a developer installs into from the SIGN-IN SCREEN (`/auth/pat` with a pasted
  token, kernel's `LocalVcsSetup`), because local mode's one token is both the identity and what
  every agent step clones/pushes/merges with, and sending someone to `.env` + a restart is a dead
  end at exactly the moment they have just created a token. Three rules bind anything reading it:
  - **Ask at CALL time, never at build time.** The clients, the dispatch token mint, the clone
    origin and the harness host allow-list are always built and resolve the token per call — so
    "no credential" is a REFUSAL that names the fix, never an absent client. An absent client is
    what makes the layers above wire nothing (no `github` module, no gate providers, no repo
    picker), and that decision is taken once and never revisited.
  - **What genuinely cannot be per-call FOLLOWS the credential** via `onChange`: the container
    transport's `resolveEnv`, and `gateProviderFollowing.ts` (a gate probes iff its provider is
    wired, so a deployment that can reach nothing must pass CI through and one that gains reach
    must stop doing so). Its predicate is REACH, not the credential: a mothership node holds no
    token and still gates, on installation tokens the mothership mints.
  - **`.env` beating the store is what keeps that file honest**, so the browser flow is offered
    only while it names nothing (`patLogin.installable`); an already-INSTALLED token can still be
    replaced, since the sign-in screen is the only surface a locked-out developer can reach.
    The store seals with a SYNCHRONOUS AES-GCM envelope under the deployment `ENCRYPTION_KEY` rather
    than the shared `WebCryptoSecretCipher`, so every reader stays synchronous and no boot window
    can report "unconfigured" while a decrypt is in flight; an envelope it cannot open (a rotated
    key) reads as NO credential, the state the sign-in screen already knows how to fix.
- `container.ts`: threads the transport + credential/VCS seams into Node's `buildNodeContainer`.
- `mothership.ts` + `sqlite/`: **mothership mode** (`LOCAL_MOTHERSHIP_URL`), a third boot shape
  with NO local Postgres, where org/durable state is served by a hosted cat-factory over the
  `/internal/*` machine API and only credentials/settings/the work queue/**telemetry** stay on the
  laptop in `node:sqlite`. `mothershipPropagator.ts` (outbound engine events) and
  `mothershipSubscriber.ts` (inbound per-workspace subscriptions, opened on demand from the local
  hub's rooms) are the two halves of its real-time channel. Read
  `docs/initiatives/mothership-mode.md` before touching any of it, and `CLAUDE.md` → "Every new
  feature ships MOTHERSHIP-READY" before adding a repository method anywhere in the backend.
- `sqlite/telemetryStore.ts` (+ `sqlite/telemetryRows.ts`, `sqlite/telemetryIngestReader.ts`) +
  `telemetryRetention.ts` + `telemetryIngest.ts`: the LOCAL-FIRST telemetry bucket (per-call
  LLM metrics, agent-context snapshots, performed web searches, the provisioning log, modeled quota
  cycles) and its hourly prune. Layered over the remote registry by `composeMothership`, so every
  consumer resolves it with no per-consumer wiring; the bucket's membership is declared once in
  `@cat-factory/server`'s `LOCAL_FIRST_PERSISTENCE_REPOSITORIES`, which TYPES the composition:
  adding a telemetry repository without listing it there fails to compile rather than silently
  resolving a remote proxy the allow-list will only answer `unknown_method`. `telemetryIngest.ts` is
  the sync UP: a background sweep that uploads a QUIESCED run's rows to the mothership's
  `POST /internal/telemetry/ingest`, so a run this laptop drove is readable by hosted teammates and
  outlives the local prune. Quiescence stands in for "finished" because the node holds no execution
  index of its own; a failed upload leaves the run's high-water mark alone and retries, including
  when the node holds no machine token yet, which THROWS rather than resolving empty, because the
  sweep's success path advances that mark. Only rows scoped to a run sync up: an inline LLM call
  that resolved no `executionId` stays local and is eventually pruned.
- `telemetryReadThrough.ts`: the sync DOWN, and the reason the prune is not a blind spot. It
  decorates the three RUN-SCOPED sinks so a read the local store answers with NOTHING is served
  from the mothership's copy over `POST /internal/telemetry/read`. It covers two runs that used to
  render blank, neither of which reported a problem: one whose local rows were pruned, and (the
  common case, since a mothership-mode SPA shows the whole org's board) one another node drove
  entirely, and a third the first cut missed (one the prune took only PART of, where the store
  answers with a suffix and nothing looks missing). Local wins where it is WHOLE rather than merely
  non-empty (`sqlite/telemetryCoverage.ts` supplies the difference), so the capture path never pays
  a round trip; `record`/`recordMany`/`latestChainTip`/`deleteOlderThan` are not decorated at all;
  a page the mothership refuses for SIZE is halved and re-asked rather than failing the run; and a
  failed fallback THROWS rather than degrading back into the empty answer it was called to replace.
- `sqlite/telemetryCoverage.ts`: which runs the local store is still AUTHORITATIVE for. The prune
  deletes by `created_at`, so a run straddling the cutoff keeps a subset, and a subset answered as
  though it were the run is how a pruned run's token rollup silently reads low. Each sink records
  what its own prune took (`telemetry_pruned_runs`) BEFORE deleting, since afterwards there is
  nothing left to tell; the retention sweep forgets a marker once its run has no local rows left.
- `harnessImage.ts`: `RECOMMENDED_HARNESS_IMAGE`, the executor image tag local mode pulls at
  boot (must stay a matched set with the backend; `CLAUDE.md` → "Releases & changesets").
- `harnessInline.ts`: serving an enabled subscription harness ref as an INLINE call: the
  developer's host `claude`/`codex` (ambient login, unmetered) when its binary is present, else a
  warm container on a leased credential. Also the host-CLI supervision budget
  (`LOCAL_INLINE_CLI_*`) and the `stream-json` reader. That reader publishes each model call the CLI
  makes AS IT ARRIVES, through the container harness's own fold
  (`@cat-factory/executor-harness/claude-call-aggregator`) rather than a second one; an inline
  `doc-researcher` here is 16+ calls over 8 minutes, so per-call-and-live is the difference between
  a step that is observable while it works and one that reports nothing until it exits. The rows are
  filed by the MODEL (`CliInlineLanguageModel`, handed the facade's recorder through the wrap deps),
  not by the instrumentation middleware around it; see `CLAUDE.md` → "Telemetry & agent-context
  observability". Two things about that reader are memory rules, not niceties: the reconstruction it
  drives is retained in THIS process, so it is bounded (`MAX_TRANSCRIPT_CHARS`) and skipped entirely
  when the deployment retains no prompts (`recordInlineBodies`); see `OUTPUT_TAIL_RETAIN_CHARS` in
  the same file for the fault they avoid. And every fold step is isolated, because `onLine` runs
  inside the spawn's `stdout` listener and the flush on the killed path runs before the failure is
  enriched with what the run had burned.

## The deployment extension surface

`src/index.ts` publishes every app-owned registry constructor, the authoring types and the
descriptor helpers, so a local deployment's only cat-factory runtime dependency is this facade
([ADR 0044](../../docs/adr/0044-facade-extension-surface.md)). `test/registry-seams.spec.ts`
derives both halves from the Node facade rather than re-listing them: the options are a superset of
its seams, and the exports a superset of its registry constructors. That derivation matters most
here, because `startLocal` withholds `buildContainer`, so a seam this facade cannot construct is one
a local deployment cannot register AT ALL.

**See also:** `deploy/local/README.md`, `CLAUDE.md` → "Multi-runtime facades".
