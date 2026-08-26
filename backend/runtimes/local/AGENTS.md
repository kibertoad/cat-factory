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
  Per run AND per IMAGE: a step declaring `image: 'ui'` gets its own container keyed
  `ui:<runId>` on `LOCAL_HARNESS_IMAGE_UI`, always per-run even with a warm pool on, since pool
  members all run one image. `LOCAL_HARNESS_IMAGE_UI` DEFAULTS to the backend-matched tag, so
  this facade serves that variant out of the box (paying the pull on the first dispatch, see
  `harnessImage.ts`). A DEPLOYMENT's own variant works the same way, mapped by
  `LOCAL_HARNESS_IMAGE_VARIANTS` (`pixel-tools=ghcr.io/acme/pixel:2,…`). A variant this facade
  genuinely cannot serve is REFUSED at dispatch, naming what to correct, never run on the default
  image. `deploy` is refused here too: the agent runner path does not serve it, which is a mistake
  in a kind's registration rather than a missing pin, so it is a distinct refusal, matching the
  Worker's `agentContainerNamespace`.
- `LocalProcessRunnerTransport.ts`: the NATIVE backend (`LOCAL_NATIVE_AGENTS`), one long-lived
  host process serving every concurrent job. Its stderr is PIPED and kept as a bounded tail
  (nothing is forwarded to the developer's console), because that is where the harness routes its
  warn/error lines: it is the post-mortem for a host process that dies mid-job, and it is folded
  into the dispatch error for one that never becomes healthy at all. The backend OUTLIVES a run,
  so the tail is attached only when the process serving a job is confirmed gone; a live process
  that merely 404s says so instead, exactly as the warm pool does. "The process serving this job"
  is a GENERATION, not "the process": one death evicts every concurrent job, and answering the
  first eviction re-dispatches, which spawns the replacement while the siblings have yet to poll.
  So the exit record is kept ACROSS a respawn and stamped with the generation it belongs to, and
  each job remembers the generation it was dispatched to. Without that pairing a sibling's 404 is
  read off whatever process is answering NOW and the run is told its harness "is still serving
  other local runs", which is a fact about a different process.
- `runtimes/`: the `ContainerRuntimeAdapter`s per engine (docker CLI shared by
  Docker/Podman/OrbStack/Colima; a separate Apple `container` adapter), selected by
  `LOCAL_CONTAINER_RUNTIME`. Two contracts an adapter is easy to get wrong: `endpoint()`
  resolves an EXITED container to `undefined` (that is what lets the transport remove and
  re-create it via `dispatchPerRun`) yet still throws for a fault against a LIVE one (a runtime
  that can't tell the two apart, Apple, takes the `undefined` half), and `exitState()` reports
  how a stopped container ended so a mid-run death leaves a post-mortem (plus a scrubbed `logs()`
  tail) onto the failed view's `detail`, since `release()` removes it as the run settles. A
  re-dispatch removes it too, so the FIRST death's post-mortem is retained on
  `PipelineStep.firstEvictionDetail`. `exitState()`'s `code` is the one half that is a VERDICT
  rather than a diagnostic: `0` means the harness exited cleanly with a job still in flight, which
  the transport reports as `harnessShutdown` instead of an eviction (terminal, never retried), so a
  runtime that cannot read an exit code leaves it ABSENT rather than defaulting it. Both readings
  come from ONE `exitState()` per poll, and the verdict is asked on the 404 branch too: on a backend
  that outlives a run the 404 is often the REPLACEMENT harness, so what decides is the one the job
  was dispatched to. Each adapter also exposes a `localDind` capability, which
  `applyLocalInfrastructureCapabilities` turns into the `testEnv` half of
  `config.infrastructure`, so a runtime that cannot nest containers (Apple `container`) never
  offers `local-compose` as a test environment at all. That capability is about the HOST runtime.
  Whether the job CONTAINER actually got a Docker daemon is a second and independent fact, and only
  the container can know it: the harness records its own verdict at boot and REFUSES a compose
  stand-up that verdict says cannot work, reporting `infraSetup.dockerAvailable: false` with the
  cause rather than degrading to a no-infra run in silence (executor-harness README, "Local infra:
  the container's Docker daemon").
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
  hub's rooms) are the two halves of its real-time channel. The key split cuts BOTH ways: the
  laptop's own credentials never go up, and the ORG's never come down as keys: a sealed org row is
  opened (and a row this node provisions is sealed) BY the mothership, addressed by row, through
  the `secretDelegate` `composeMothership` builds. So a mothership-mode node provisions
  environments and probes release-health monitors for real without ever holding the org key. Read
  `docs/initiatives/mothership-mode.md` before touching any of it, and `CLAUDE.md` → "Every new
  feature ships MOTHERSHIP-READY" before adding a repository method anywhere in the backend.
- `sqlite/db.ts`: the shared open/init for every local `node:sqlite` store, plus the typed
  `queryAll<Row>` / `queryOne<Row>` every read goes through. `StatementSync.all()` is typed
  `Record<string, SQLOutputValue>[]`, so a raw `.prepare(…).all(…)` needs an `as unknown as` at
  each call site; run the query through these instead. The `SqliteRow<Row>` bound checks the row
  shape is one SQLite could actually return, so a `boolean`, a nested object or a domain union
  fails the build rather than being asserted into existence (decode it from the raw column).
  **Opening RECONCILES the file's columns against the schema it was handed**, additively: a
  `CREATE TABLE IF NOT EXISTS` is a no-op against a table the file already has, so a column added
  to a shipped schema would otherwise reach a fresh database and no other and every read naming it
  would fail with `no such column`. So ADD a column to the store's `SCHEMA` and nothing else; a
  column that SQLite cannot add (`NOT NULL` with no default, `UNIQUE`, a key) refuses the open
  rather than failing one query at a time, and a column the schema drops is left in place, because
  removing one means rebuilding the table.
- `sqlite/*.conformance.test.ts`: this store runs the SAME conformance suites D1 and Postgres do,
  for every one of its six telemetry repositories. It is the store a developer's own runs are
  recorded in, so a property all three must agree about belongs in the shared suite rather than in
  a hand-rolled local sibling; `sqlite/telemetryStore.test.ts` is what is left after that, and holds
  only what no other store has to answer for (the synchronous BEGIN/COMMIT, the exact prune count,
  the ingest reader).
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
  boot (must stay a matched set with the backend; `CLAUDE.md` → "Releases & changesets"), plus
  `RECOMMENDED_UI_HARNESS_IMAGE`, its browser-carrying sibling. The UI image is NOT pre-pulled at
  boot: a stock start should not spend gigabytes on tooling most deployments never dispatch to,
  so the runtime pulls it on the first `image: 'ui'` dispatch.
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
