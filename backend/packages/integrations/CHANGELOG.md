# @cat-factory/integrations

## 0.165.2

### Patch Changes

- Updated dependencies [3f7d8b2]
  - @cat-factory/contracts@0.318.0
  - @cat-factory/kernel@0.308.0

## 0.165.1

### Patch Changes

- 2a2b6ef: Reclaim EVERY container a run holds, and stop losing the variant on the way to the container.

  Routing a step to the UI-tester image gave a run a SECOND container, and four of the paths that
  address a run's container by name were still written for a world with exactly one.

  `AsyncAgentExecutor.stopJob` is now `reclaimRun`, taking a `RunReclaimTarget` instead of a job
  handle. It could not be fixed as it stood: the engine synthesised a handle with no `agentKind`, so
  the ref carried no image and every terminal, cancel and supersede path released the ordinary
  container and left the browser one running to its maximum lifetime. Supplying the kind would not
  have been enough either, since a run holds one container per IMAGE and that API reclaims one. The
  engine now hands over every kind the run DISPATCHED (read off the persisted `step.dispatches`, so a
  gate's helper and a replayed reclaim both count) and the executor maps them to the distinct images
  it started.

  Three more places the qualified key was mishandled. The Apple `container` adapter's name sanitiser
  folded `ui:<runId>` onto a name its own inverse read back as a run called `ui-run-1`, so the boot
  orphan sweep classed a live UI container as belonging to no run and deleted it mid-step; the
  variant now round-trips through the name, and `RunContainerSpec.runId` is renamed `containerKey`
  because reading it as a run id is what produced an encoding nothing could reverse.
  `runIdFromContainerKey` stripped ANY prefix before a colon rather than a known variant, which
  truncates a key it never produced into a run id that matches no run: the same data-destroying
  misread it exists to prevent. And the local transport's stop-escalation evicted its cache entry
  under the run id while destroying the container it had resolved under the qualified one, leaving a
  cached handle pointing at a container that no longer exists (`resolve` returns a cached entry
  without probing liveness).

  Two refusals were also less total than they read. The local transport tested only for `ui`, so a
  `deploy` ref silently ran on the agent image where the Worker names the registration mistake; it is
  now exhaustive over the variant union, with the `default:` arm routed through a helper taking
  `never` so a new variant fails the build. And the Cloudflare reaper resolved a row's container class
  BEFORE removing the row, so a `ui` row whose class is no longer bound re-threw on every sweep pass
  for ever: an unbound class is not a transient failure, so that row is dropped, counted apart from
  the kills as `unreachable`, and named once with the binding to restore.

  Watch for: `reclaimRun` replaces `stopJob` on the executor port (internal, no migration), and the
  `live_containers` sweep now returns `{ reaped, unreachable }`.

- Updated dependencies [2a2b6ef]
  - @cat-factory/kernel@0.307.0

## 0.165.0

### Minor Changes

- 5333319: Route a job to the UI-tester executor image, on every backend, and publish that image.

  The `image: 'ui'` dispatch variant has existed since the visual-confirmation gate landed: the
  `tester-ui` kind declares it, the executor sets it, the job body carries the screenshot-upload
  seam and the reference-design manifest that go with it. Nothing mapped it to an image. On
  Cloudflare and local Docker a browser-driven tester therefore ran on the plain executor image,
  which has no browser, and the repo published no UI image for anything to point at even if it had.

  The variant now travels on the job REF rather than only on the dispatch options, because a
  per-run container backend has to address the same container again on every poll and release, and
  those get no options. `containerKeyForRef` derives the container's identity from it (the run id,
  qualified by the variant), and the executor re-derives the variant from the step's agent kind at
  each site, so a poll from a fresh process after a durable replay lands on the right container with
  nothing remembered in between. Cloudflare gains a `UiTesterContainer` class bound as
  `UI_CONTAINER`; local Docker gains `LOCAL_HARNESS_IMAGE_UI` and a second per-run container.

  **An unwired variant is refused, not downgraded.** Every backend fails the dispatch, naming the
  binding or variable to set, where the Kubernetes pool previously fell back to its default image.
  Falling back is what the variant existed to prevent: the tester runs happily until it needs a
  browser, which is after the checkout, the install and the model's first turns, and reports an
  `abort` no reader can distinguish from an app that would not start. A deployment that has not
  wired the image loses the step, not the diagnosis, and the visual-confirmation gate still runs on
  screenshots a person uploads.

  Two things to watch. The live-container inventory carries the variant (D1 migration 0094) because
  the cron reaper kills through a Durable Object namespace and `idFromName` returns a usable stub in
  any of them: reaping a browser container through the executor class killed nothing and reported
  success. And the local orphan sweep now maps a container key back to its run before asking whether
  that run is live, or every UI container reads as belonging to no run and is swept out from under a
  run mid-step.

  The UI image is published by CI alongside the executor image it layers on, pinned to the same
  version, and is BOOTED before it is pushed: the smoketest starts a container, waits for the
  harness, then drives a real Chromium against a `serve`d page inside it. A build-only gate was not
  enough, which the corepack line this branch already fixed demonstrates: it had been unrunnable
  since the base moved to `node:26` and no build ever failed for it.

### Patch Changes

- Updated dependencies [5333319]
  - @cat-factory/kernel@0.306.0

## 0.164.1

### Patch Changes

- Updated dependencies [053aac8]
  - @cat-factory/contracts@0.317.0
  - @cat-factory/kernel@0.305.0

## 0.164.0

### Minor Changes

- 9d8fdf6: Wire a registry pull credential into per-PR Kubernetes namespaces on a local cluster.

  A per-PR namespace is created seconds before the manifests are applied, so no pull secret can be
  waiting in it, and a private package was therefore unpullable with no configuration path out. When
  the apiserver names the machine the platform runs on, a provision now writes the run's own git
  credential into the namespace as a `dockerconfigjson` Secret and attaches it to the service
  accounts the manifests run as. Nothing is configured for it; remote clusters are unchanged.

  The gate is kernel's new `isLocalMachineHost`, which the CLI's own `looksLocalCluster` composes
  too: it covers loopback plus the spellings a local kubeconfig actually contains (k3d's wildcard
  `0.0.0.0`, the Docker Desktop host aliases) and still refuses the RFC1918 space.

  Two bounds are stated rather than implied. The credential is the provision's own short-lived git
  token, so it expires about an hour later and nothing renews it: a pull after that needs a
  re-provision. And on the container-render path a kustomize overlay that declares its own namespace
  is skipped, because the namespace is resolved inside the deploy container and there is nowhere to
  place a Secret before dispatch. Both land in the provisioning log as a `registry-auth` step, as
  does every other reason no credential was wired.

  `AsyncProvisionCapability.buildProvisionJob` returns a `Promise` now, so the container-render path
  can prepare the cluster before dispatch. Only the Kubernetes adapter implements it.

### Patch Changes

- Updated dependencies [eb5fa75]
- Updated dependencies [9d8fdf6]
  - @cat-factory/contracts@0.316.0
  - @cat-factory/kernel@0.304.0

## 0.163.1

### Patch Changes

- Updated dependencies [eb740be]
  - @cat-factory/contracts@0.315.0
  - @cat-factory/kernel@0.303.0

## 0.163.0

### Minor Changes

- 7f990ea: Classify environment provisioning failures by cause, and repair the one class a checkout edit can
  actually fix. A provision whose `{{placeholder}}` cannot be filled by the environment CONNECTION is
  now refused BEFORE the apply, naming the field that fills it, rather than rendering an empty string
  and letting the platform reject the result and blame the file. A placeholder the RUN supplies keeps
  the documented lenient substitution, so a template folding an optional value into its output is
  unaffected. Adds a provider-neutral seam (`environmentFailure`, `unresolvedPlaceholders`,
  `describeUnfilledConfigPlaceholders`, and `ProvisionedEnvironment.reason` for a provider that
  reports a failure without throwing) so a deployment-registered environment backend participates in
  the same classification as the built-ins.

  On a `manifest_invalid` failure the `deployer` step now escalates to a new `deploy-fixer` agent,
  which pushes a fix onto the pull-request branch, and re-provisions against it (twice by default,
  configurable per step via `stepOptions.deployFix`). Every other cause takes the previous terminal
  path unchanged. When the budget is spent the run fails and raises a new `deploy_blocked`
  notification whose act retries the run, the `ci_failed` shape.

  The public API gains one additive notification type (`deploy_blocked`), so the OpenAPI surface moves
  to 1.55.0 and the four SDK clients regenerate. It is in the default webhook type set, and its act
  takes the same individual-usage-credential refusal `ci_failed` and `test_failed` already take.

### Patch Changes

- Updated dependencies [7f990ea]
  - @cat-factory/contracts@0.314.0
  - @cat-factory/kernel@0.302.0

## 0.162.1

### Patch Changes

- Updated dependencies [409238f]
  - @cat-factory/kernel@0.301.0
  - @cat-factory/contracts@0.313.0

## 0.162.0

### Minor Changes

- 0ef48d1: Stop an agent's own cleanup command from killing the harness that supervises it, and report a
  harness that WAS stopped as what it is.

  A local acceptance run failed as "the container kept vanishing, treating as deterministic" after
  two full coder passes. Nothing evicted anything. The harness ran as PID 1 with the command line
  `node dist/server.js`, which is also where the Fastify service the coder was scaffolding built to;
  the agent started that service in the background to smoke-test it over a real socket, then ran
  `pkill -f 'node dist/server.js'` to stop it again. The image ships no `pkill`, so that failed with
  `command not found` and the next turn used something that works without procps, which matched PID 1
  and shut the harness down. The container exited 0, the engine could only see a backend that had
  stopped answering, so it called it an eviction, spent its crash-recovery budget re-running the same
  agent into the same wall, and blamed infrastructure churn.

  **The harness no longer answers to a pattern kill aimed at anything else.** It runs from
  `dist/harness-server.js` and sets `process.title = 'cat-factory-harness'`, which on Linux rewrites
  both `/proc/<pid>/cmdline` and (truncated) `/proc/<pid>/comm`, so neither `pkill -f 'node dist/…'`
  nor a bare `pkill node` nor a hand-rolled `/proc` sweep can name it. It is not a security boundary
  and is not claimed as one: the agent shares the harness's uid, and separating them needs a PID 1
  running as root, which this image deliberately does not have. What it removes is the accident.

  **`procps` + `psmisc` are now in the image**, which reads backwards until you look at what the
  absence caused: `pkill`/`pgrep`/`ps` are the narrow tools an agent reaches for first, and the
  fallback it writes when they are missing is the unbounded one that took the harness down.

  **A harness that exits cleanly mid-job is no longer an eviction.** Every transport that can read an
  exit code (the local container and native-process legs, the Cloudflare per-run container, and a
  Kubernetes runner pod's `state.terminated`) now distinguishes a workload that exited 0 with a job
  still in flight from one that crashed or was reclaimed, and reports `harnessShutdown` instead of
  `evicted`. The engine fails that run immediately with a new `harness_shutdown` failure kind
  (additive to the public failure-kind vocabulary; OpenAPI surface 1.54.0) and a hint that names the
  causes worth checking, rather than spending an automatic retry that walks back into whatever
  stopped it. A backend that reports no exit code (Apple `container`, a manifest-driven runner pool
  whose scheduler exposes only status words) keeps reporting an eviction, because an absent code is
  not a zero.

  The distinction is only ever drawn where NOTHING else explains the stop. Infrastructure churn is
  named and recovers on its own budget, and it stays named even after its attribution window passes:
  a rollout drain the harness answered by exiting 0, discovered minutes later by a re-driven poll, is
  still that drain rather than a shutdown. The same rule orders the engine's own reading: a killed
  job that some branch settles WITHOUT failing the run (a parked PR review's read-only Challenge
  Investigator) keeps that settlement, since losing a human's in-flight curation is worse than the
  retry this failure kind exists to prevent. `container.harness_shutdown` counts the class, kept out
  of `container.evicted` so the eviction rate an operator sizes infrastructure by is not inflated by
  deaths no infrastructure change prevents.

  **An aborted agent run says who aborted it.** The Claude Code / Codex runner rejected with a
  hard-coded "agent run aborted by watchdog" for every abort, including the shutdown handler's, so a
  job killed by something else filed its failure against a watchdog that never fired. It now carries
  the abort reason the caller supplied, the way the Pi runner already did, and an abort that supplied
  none falls back to saying so rather than quoting the platform's own contentless "This operation was
  aborted" (a reasonless `abort()` sets an `AbortError` that IS an `Error`, so the fallback was
  unreachable).

  The image moves to `cat-factory-executor:1.121.0` across the wrangler config, the publish script and
  `RECOMMENDED_HARNESS_IMAGE`: the entrypoint rename and `procps` are only in effect once a deployment
  runs a tag that contains them.

  **The acceptance suite stops blaming the merge threshold for a failed run.** Its "the merge was
  HELD" hint fired on "there is a pull request and the status is not done", which is also true of a
  run that died three phases before any merge was considered; it is now offered only where nothing
  else explains the stop.

### Patch Changes

- Updated dependencies [0ef48d1]
  - @cat-factory/kernel@0.300.0
  - @cat-factory/contracts@0.312.0

## 0.161.0

### Minor Changes

- c67e924: A bug hunt on a repo-backed tracker scopes to the service's repository, not a picked board

  GitHub Issues and GitLab Issues put every issue in one repository, and the only repository a hunt
  may read is the one its service frame is linked to. Both now offer NO board control: the hunt
  carries the container an adopted bug will land in, and the board is that container's service repo,
  resolved through the same `resolveRepoTarget` walk an issue search scopes with (now shared as
  `server/src/modules/tasks/sourceRepoScope.ts`). A board picker there could scan, rate and adopt a
  bug from a repository nothing on the board points at, whose run would then open its PR somewhere
  else entirely.

  Internal wire break (`POST /workspaces/:ws/bug-hunt/:source/hunts`): the body now takes
  `containerId` plus a REQUIRED, NULLABLE `board`. `null` is the only legal value for a repo-backed
  source, and naming one there is refused (`details.reason: 'board_from_service'`) rather than
  ignored; a repo-less source with no board is refused too. Board LISTING is refused for a repo-backed
  source with the same reason, so `GitHubIssuesProvider.listBoards` and
  `GitLabIssuesProvider.listBoards` are gone along with the shared `repoRefsToBoards` projection.
  `TaskSourceState` gains `repoBacked` (derived from the provider's declared `repoScope`) so the SPA
  knows which surface to render before it asks.

  Every refusal now lands as soon as it is decidable, cheapest first: an unhuntable source on the
  registry, then the board shape from the request body alone, then the repository walk, then the
  container. So an unregistered source is refused by name instead of being told to pick a board it
  has no control for, a board named beside an unlinked service no longer costs two round trips to
  learn it was never allowed, and a `containerId` naming no block on this workspace refuses before
  the vendor read and the ranking call rather than at adoption.

### Patch Changes

- d5c1f1c: Refresh every direct and transitive dependency to the newest version the 24h
  `minimumReleaseAge` supply-chain gate admits, staying inside each package's current major.

  The Vercel AI SDK family moves within the majors `workers-ai-provider` pairs with (`ai@7.0.64`,
  `@ai-sdk/openai@4.0.41`, `@ai-sdk/amazon-bedrock@5.0.55`). The Cloudflare toolchain moves
  together again: `wrangler@4.122.0` and `@cloudflare/vitest-pool-workers@0.21.2`, whose bundled
  wrangler tracks it. `@aws-sdk/client-s3` goes to 3.1109.0 and the SPA's store engine to
  `pinia@4.0.3` / `@pinia/nuxt@1.0.2`.

  `capnweb` moves 0.10.0 to 0.11.0 in the Gatekeeper Worker. The release is additive (stubs as
  stream chunks, exact ArrayBuffer/DataView serialization, URL over RPC) and touches neither
  `RpcTarget` nor `newWorkersRpcResponse`, the only two symbols we import. Its 0.11.1 patch, which
  enforces an ASCII-only dist bundle so a consumer's `btoa()` cannot choke on the runtime, missed
  the release-age window by two hours and is the first thing the next sweep should pick up.

  Held back deliberately: `@changesets/cli` 3.0.0 and, in the frontend, `typescript` 7 (Nuxt 4.5.2
  itself depends on `typescript@6.0.3`). No `minimumReleaseAgeExclude` entries were added: every
  version above already satisfies the gate.

- Updated dependencies [d5c1f1c]
- Updated dependencies [c67e924]
  - @cat-factory/kernel@0.299.1
  - @cat-factory/contracts@0.311.0

## 0.160.17

### Patch Changes

- Updated dependencies [056e18d]
  - @cat-factory/contracts@0.310.0
  - @cat-factory/kernel@0.299.0

## 0.160.16

### Patch Changes

- Updated dependencies [a81879b]
  - @cat-factory/contracts@0.309.0
  - @cat-factory/kernel@0.298.2

## 0.160.15

### Patch Changes

- Updated dependencies [0e1e0fa]
  - @cat-factory/contracts@0.308.1
  - @cat-factory/kernel@0.298.1

## 0.160.14

### Patch Changes

- Updated dependencies [7312e0a]
  - @cat-factory/kernel@0.298.0
  - @cat-factory/contracts@0.308.0

## 0.160.13

### Patch Changes

- Updated dependencies [95408c2]
  - @cat-factory/contracts@0.307.0
  - @cat-factory/kernel@0.297.0

## 0.160.12

### Patch Changes

- 792ecde: Refresh every direct and transitive dependency to the newest version the 24h
  `minimumReleaseAge` supply-chain gate admits, staying inside each package's current major.

  The Vercel AI SDK family moves within the majors `workers-ai-provider` pairs with (`ai@7.0.62`,
  `@ai-sdk/anthropic@4.0.38` / `openai@4.0.40` / `openai-compatible@3.0.30` /
  `amazon-bedrock@5.0.54`). The Cloudflare toolchain moves together: `wrangler@4.121.0`,
  `@cloudflare/workers-types@5.20260812.1` and `@cloudflare/vitest-pool-workers@0.21.1`, whose only
  change over 0.20.3 is the wrangler and miniflare it bundles, so the pool now carries the same
  wrangler the workspace declares instead of one release behind it.

  `esbuild` gains three scoped `pnpm-workspace.yaml` overrides pinning vite's, tsx's and nitropack's
  loose ranges to the 0.28.1 that wrangler and `@cloudflare/vitest-pool-workers` pin exactly. Without
  them a re-resolve hands vite's optional PEER slot the newer 0.28.2 and the tree gains a second
  esbuild; because pnpm resolves an auto-installed peer without its own `optionalDependencies`, that
  copy never gets its platform binary and esbuild's postinstall aborts the entire install. The
  overrides are deliberately scoped rather than top-level: `drizzle-kit`, `@intlify/bundle-utils` and
  `fontless` declare narrower ranges that a blanket pin would force them out of.

  Held back deliberately: `@changesets/cli` 3.0.0 and, in the frontend, `typescript` 7 (Nuxt 4.5.2
  itself depends on `typescript@6.0.3`). No `minimumReleaseAgeExclude` entries were added: every
  version above already satisfies the gate.

- Updated dependencies [792ecde]
  - @cat-factory/kernel@0.296.1

## 0.160.11

### Patch Changes

- Updated dependencies [fc56d82]
- Updated dependencies [fc9afb4]
  - @cat-factory/contracts@0.306.0
  - @cat-factory/kernel@0.296.0

## 0.160.10

### Patch Changes

- Updated dependencies [edd4fd0]
  - @cat-factory/kernel@0.295.0
  - @cat-factory/contracts@0.305.0

## 0.160.9

### Patch Changes

- Updated dependencies [36e0c9b]
  - @cat-factory/contracts@0.304.0
  - @cat-factory/kernel@0.294.1

## 0.160.8

### Patch Changes

- Updated dependencies [569181d]
  - @cat-factory/contracts@0.303.0
  - @cat-factory/kernel@0.294.0

## 0.160.7

### Patch Changes

- Updated dependencies [1a0b593]
  - @cat-factory/contracts@0.302.0
  - @cat-factory/kernel@0.293.0

## 0.160.6

### Patch Changes

- Updated dependencies [7d1477c]
  - @cat-factory/kernel@0.292.2

## 0.160.5

### Patch Changes

- Updated dependencies [c09ddbe]
  - @cat-factory/kernel@0.292.1

## 0.160.4

### Patch Changes

- Updated dependencies [fc4a1e4]
  - @cat-factory/contracts@0.301.0
  - @cat-factory/kernel@0.292.0

## 0.160.3

### Patch Changes

- Updated dependencies [ee733ee]
  - @cat-factory/contracts@0.300.0
  - @cat-factory/kernel@0.291.0

## 0.160.2

### Patch Changes

- 01086d8: `GET /api/v1/models` now says whether a model's subscription is actually CONNECTED for the person a
  key belongs to, and stops calling the commonest one unwired. Surface version 1.47.0, additive: two
  new response fields and no change to anything already published.

  **The bug.** `userScoped` was added so a caller could tell "your credential was never consulted" from
  "no provider is wired", and it was derived from the route IN FORCE. A model with more than one route
  resolves, when nothing is configured, to the most-preferred route it merely DECLARES, and
  `subscription` is last in that order, so `claude-opus`, the built-in Claude preset's own model, which
  also declares OpenRouter, answered `userScoped: false`. The flag shipped to remove that misreport
  never fired for the model every report of it has been about; the acceptance suite kept printing "no
  provider wired for it" at operators whose workspace runs Claude every day, and the fix it named (add
  a provider key) was for a deployment that was already correct.

  **Why a new field rather than a corrected one.** `userScoped` is published, and correcting it in
  place would have moved its meaning in two directions at once: true where a model merely declares a
  subscription route (right), and no longer true for a POOLED vendor whose subscription route is in
  force (also right, and also a change under any consumer branching on it). So `userScoped` keeps
  answering exactly what it always answered and is marked superseded, `personalSubscription` is served
  beside it, and dropping the old half is a later change. `personalSubscription` is true where a model
  declares a subscription route whose vendor is individual-usage only, read through kernel's own
  `individualVendorForModelId`, the same predicate the run path gates a personal credential on. The
  pooled exclusion matters: a Kimi or DeepSeek token belongs to the WORKSPACE, so every key can already
  see it, and reporting one as personal sent an operator to re-mint a token when the fix was a pooled
  token or a provider key.

  **The existence field.** `personalSubscription` alone still stops one step short of useful: told a
  row cannot be judged, an operator's next move is to re-mint the token bound and see what happens,
  which is exactly how the last person to hit this found the answer. Each row now carries
  `subscriptionConfigured`: whether a personal subscription for that vendor is stored for the person
  the key belongs to (`actsAsUserId` when bound, else its minter), and `null` when there was nobody to
  ask about. Existence is a row lookup, so the deployment answers it without the personal password that
  OPENS the credential.

  That is also the correction to 1.45.0's reasoning, which rejected reporting this on the grounds that
  "the server cannot know whether one exists without a user". An unbound key does have a user for
  DESCRIPTION purposes: its minter, who is exactly who the remedy names. Reading it changes nothing
  about admission: `available` is still resolved under `actsAsUserId` alone, so a system token reads
  `available: false` beside `subscriptionConfigured: true`, and both are true. `createdByUserId` rides
  `PublicApiKeyAuth` for that one reader and stays provenance; nothing authorizes off it. The
  disclosure this trades (an `admin`-scoped key learns one bit about its minter, who need not be its
  holder) is documented on the field and in `public-api.md`.

  **Three fixes underneath.** A LAPSED personal subscription reported as configured (`has` checked
  existence where `unlock` checks expiry), so the catalog offered a model whose run was then refused at
  its first dispatch, naming the model rather than the subscription. Both credential stores answered
  the vendor sweep one single-row question at a time; `PersonalSubscriptionService.liveVendors` and the
  new `ProviderSubscriptionService.liveVendors` each answer the whole vocabulary in one read, on a path
  both the catalog render and every run start take. The pooled half needed a new
  `ProviderSubscriptionTokenRepository.listByWorkspace`, mirrored across D1, Drizzle and the local
  sqlite credential store with a conformance assertion.

  The acceptance suite reads all of it: `configure`'s menu and the `model-preset` / `agent-model` gates
  now distinguish five states with five different fixes, with the account model-family policy ranked
  ahead of every credential state (it is the one cause no credential can undo) and the state that
  matters most saying the subscription is connected and naming the token as the only thing in the way.

- Updated dependencies [01086d8]
  - @cat-factory/contracts@0.299.1
  - @cat-factory/kernel@0.290.1

## 0.160.1

### Patch Changes

- Updated dependencies [1bcdacc]
  - @cat-factory/kernel@0.290.0

## 0.160.0

### Minor Changes

- 195b248: Tracker writeback is ON by default, and `/api/v1` can now read and change it:
  `GET /api/v1/tracker/writeback` reports what a task's linked tracker issue hears as its pull request
  progresses, and `PATCH /api/v1/tracker/writeback` changes one action without moving the others.
  Surface version 1.46.0, additive.

  **BEHAVIOUR CHANGE, and worth reading before upgrading.** All three writeback actions (comment when
  the pull request opens, comment and CLOSE the issue when it merges, post a headless run's parked
  review findings) now default to ON for a workspace that has never configured them. All three were
  off. Nothing published said what the defaults were, so this is not an `/api/v1` break, but it IS a
  change a deployment notices: a board that never opened the issue-tracker settings panel now closes a
  linked ticket when its task's pull request merges, and comments on it twice on the way. A deployment
  that wants the old behaviour turns it off with one call to the new PATCH (or in the app), and a single
  task can still opt out through its own per-task override.

  The reasoning for the flip is that these actions only ever touch an issue a task is LINKED to, and
  nothing links one by accident: a link arrives because somebody imported the issue, the recurring
  intake picked it up, or a headless caller filed a task with `ticket`. Every one of those is a request
  to work the issue where it was filed, so the half-closed loop was the common outcome and the wrong
  one: a merged pull request beside an issue still sitting open with nothing on it saying the work was
  done. The default now lives in ONE place (`DEFAULT_TRACKER_WRITEBACK` in `@cat-factory/contracts`),
  read by the settings service, the writeback service and the SPA's panel, which previously spelled it
  three times.

  The public pair closes the last gap in the ticket-driven loop. A caller could file a task FROM a
  ticket and the platform would write back to that issue, but WHETHER it did was workspace
  configuration reachable only from the app, so the deployment shape that most needs the loop closed
  (nobody in the SPA at all) could neither read the disposition nor change it, and could not tell "this
  deployment leaves tickets open" from "the writeback is broken". Three things about the shape: it
  publishes the WRITEBACK half of `tracker_settings` and not the filing selection, which is a separate
  decision the writeback does not key off; the write MERGES, so a caller acting on one action cannot
  move the other two; and `updatedAt` is null when nobody has ever chosen, which is how a caller knows
  it is reading defaults rather than somebody's decision.

  **Every writeback write now merges, the app's own included.** An omitted action used to revert to the
  deployment default on the internal wholesale PUT, which the default flip above turns from harmless
  into a silent re-enable: the recurring-pipeline dialog persists a FILING tracker and names no
  writeback action, so scheduling a tech-debt pipeline switched writeback back on for a workspace that
  had deliberately turned it off. Absence now means "not moving this action" on both doors, which is
  the only reading any caller wanted, and the merge itself moved down into the two repositories
  (`TrackerSettingsRepository.merge`, replacing `put`), so the SPA panel and a headless patch naming
  different actions both land instead of one silently losing to the other's stale snapshot.

  The acceptance suite gains a fifth spec built on all of it: an issue filed on the backend repository
  by an OUTSIDE reporter (its own provider credential, since an issue the platform created and closed
  proves only that the credential works), a task filed FROM that issue over `/api/v1`, delivery through
  `pl_build`, and then the pair of claims that the platform CLOSED the issue and commented on it at both
  edges of the pull request's life. The pair matters because a provider closes an issue by itself when a
  merged pull request's text carries `Closes #12`, and that path posts no comment: a closed issue alone
  cannot tell the writeback from the host noticing a word an agent wrote. Two new prerequisites refuse
  before any of it spends anything, and `run configure` opens the token page prefilled.

### Patch Changes

- Updated dependencies [195b248]
  - @cat-factory/contracts@0.299.0
  - @cat-factory/kernel@0.289.1

## 0.159.0

### Minor Changes

- bc2478d: A public-API key now has an IDENTITY as well as a scope: a SYSTEM token (the default, unchanged) or
  a PERSONAL token its minter bound to themselves, which can run their own individual-usage
  subscription headlessly. Surface version 1.45.0, additive. Plus two bug fixes that made the old
  behaviour unreadable rather than merely limited.

  **The reported problem.** A workspace whose Claude runs come from a stored personal subscription was
  told by `GET /api/v1/models` that `claude-opus` was `available: false`, which the acceptance suite
  rendered as "no provider wired for it". Both statements are false, and the remedy they imply (add a
  provider key) is for a deployment that was already correct. The model was wired — as a credential
  belonging to a person, which a key-authenticated read is not allowed to see.

  **Two things were genuinely broken, independent of the feature.**

  `resolveWorkspaceCapabilities` did not know about NATIVE ambient execution. A vendor served by the
  host's own `claude`/`codex` CLI login (`LOCAL_NATIVE_AGENTS`) has no credential in either store, and
  the resolver consulted only those two stores, so the catalog and the pipeline-start guard called the
  model unconfigured on the very machine that would have run it. The personal-credential gate, reading
  the same allow-list, had already decided such a vendor needs no unlock: two halves of one decision,
  disagreeing. They now share `isAmbientNativeVendor`, which is where the executor's half already was.

  `GET /api/v1/models` could not say why a personal subscription's model was unavailable. The existing
  `excludesUserScopedModels` flag reports what an answer OMITS, and a subscription model is not omitted
  — it is listed, unjudged, because no user's credential store was consulted. Each row now carries
  `userScoped`, so the distinction is stated where it applies. Widening the response flag instead was
  tried and rejected: with no user resolved the server cannot know whether a personal subscription
  exists, so the honest predicate is "this deployment has `ENCRYPTION_KEY`", which is true nearly
  everywhere. A flag that is always true stops answering its question, and it would have re-pointed a
  published field at a new predicate under the same name.

  **The feature.** `POST /workspaces/:ws/public-api-keys` takes `actsAsSelf`, and the key row carries
  `actsAsUserId`. A personal token's runs record that person as initiator, `GET /api/v1/models`
  resolves under them, and a start/retry/decision call may unlock their subscription by sending
  `X-Personal-Password` — the same header, the same 428, and the same per-run activation the app uses.
  A system token behaves exactly as every key did before, including the `409
individual_model_unsupported` refusal, which is now reserved for the case no password could fix.

  Three properties bound it, and each is a shape rather than a rule to remember. The wire field is a
  BOOLEAN and the server reads the id off the session, so minting a key onto a colleague's
  subscription is unrepresentable rather than merely forbidden; a mint with no signed-in user is
  refused instead of quietly producing an unbound key. Headless provisioning (`POST /api/v1/keys`)
  can never bind, because a provisioning key holds nobody's consent to inherit. And the password is
  stored NOWHERE — not on the row, not in a session — so the binding alone spends nothing and a
  leaked personal token reaches that user's PAT (as a leaked session would) but not their
  subscription.

  A bound key attributes EVERY run it starts, not only the ones needing an unlock. The alternative
  makes one key produce runs under two identities depending on which model a task happened to pin,
  with two credential scopes and two merge-policy roles, and nothing in the request to say which.

  **And a bound run is that person's run all the way through, policy included.** The two public start
  routes resolve the bound user's workspace ROLE and pin it, so a headless start is admitted under the
  same role-scoped merge narrowing and the same dry-run sandbox its holder gets in the app: a key
  cannot land what the person behind it could not. An initiator with no role is not a lenient run, it
  is a run with no policy — which is what the bug-hunt adopt route once shipped, and why
  `runAdmission.coverage.spec.ts` makes every start route CLASSIFY itself. A retry deliberately keeps
  the ORIGINAL run's pinned authority instead (`buildResumedInstance`), because a re-drive is the same
  work under the authority it was first granted, and dropping it would launder a dry run into a live
  one via restart-from-step-0.

  `POST /api/v1/jobs` runs the same personal-credential gate as the board start. Being inline-only
  settles what a public run may DO (no container, no push) and says nothing about whose credential it
  needs: the inline harness leases a personal subscription for every individual-usage vendor, so
  skipping the gate there traded an actionable refusal for a run that dies at its first dispatch.

  Deliberately not lifted: `POST /api/v1/notifications/:id/act`. Its ci-/test-failure arm retries
  through a shared effect that mints no activation, so admitting a bound key there would trade a
  refusal the caller can act on for a run that dies at its first dispatch. Lifting it means threading
  the gate through that effect for the SPA and this surface at once.

  **Answering a park no longer re-derives a credential that is already fresh.** Each re-mint runs
  210k PBKDF2 iterations per vendor, which a human clicking through a run pays once and a headless
  driver answering eight follow-ups would pay eight times in a row — seconds of blocked event loop on
  Node, a CPU-limit kill on workerd. The interaction path now skips the whole gate while the run holds
  an activation with over half its life left, and both facades share one helper, so the SPA gets the
  same. The decision surface's refusal is returned as DATA (a `428` in that surface's own envelope,
  carrying the vendor and reason) rather than thrown, which is the invariant every other gate there
  already keeps.

  **`X-Personal-Password` is declared on the operations that read it**, so it reaches
  `docs/openapi.json` and the four generated clients instead of being discoverable only by getting a 428. Each client also gained a post-construction setter for it, since that is when a caller learns
  it is needed.

  **The acceptance suite** now runs on the operator's own subscription. It prompts for the personal
  password at the terminal on the first call that needs one — never at `configure` time, and never at
  all for a workspace on a provider API key — and holds it in memory only: not the `.env`, not the
  ledger, not the journal, because a copy beside `CAT_FACTORY_API_KEY` would put both halves of a
  two-factor credential in one file. The header then rides every request, since answering a park
  re-mints the run's activation server-side. `configure` and the `model-preset` gate now say "not
  visible to this system token" and name the fix, instead of the wrong one they used to name — read
  off the ROW, so a model that genuinely has no provider still reads as unwired, and an invisible
  workspace default stays SELECTED rather than being quietly swapped for a model nobody chose.

  The prompt opens the CONTROLLING TERMINAL rather than reading `process.stdin`. The suite runs under
  vitest, whose workers are forked with piped stdio, so a prompt built on stdin could never have asked
  anything: the one path this exists for would have thrown "stdin is not a terminal" on every pass. It
  is also stricter than the check it replaces, since a controlling terminal cannot be fed from a pipe
  or a file at all. And the entered password is no longer trimmed: a space is printable ASCII, so a
  legal password with one at either end was being silently altered and then reported as wrong.

### Patch Changes

- Updated dependencies [bc2478d]
  - @cat-factory/contracts@0.298.0
  - @cat-factory/kernel@0.289.0

## 0.158.0

### Minor Changes

- a634746: A locally-run model can now be given a run's design renders. Its image support resolves in two
  tiers: a table of recognised open-weights families (`KNOWN_LOCAL_MODELS`, so ticking Gemma 4 or Muse
  Glimmer needs no second step), overridden by a per-model declaration on the user's own runner entry
  for anything the table cannot know about.

  The gap was structural rather than a missed case. `acceptsImages` is a per-FLAVOUR fact declared on
  `MODEL_CATALOG`, and a local model has no catalog row: it lives on one person's machine, its id is
  free text, and the OpenAI-compatible `/models` probe the panel discovers models with returns ids and
  nothing else. So every local ref arrived with the modality absent and `resolveDesignImageDelivery`
  answered `unknown_model_image_input` for all of them, forever. That reason exists precisely so this
  would stay visible instead of reading as a text-only model, and the arrival of image-capable local
  models is what turned it from a latent hole into a lost capability.

  The declaration wins over the table on purpose: the person who pulled the weights is the one who
  knows whether they are running a text-only quant, a fine-tune or a re-tagged copy. The table
  therefore carries only families whose SILENCE costs a capability (every member is image-capable; a
  text-only entry would behave identically to an absent one), and a family whose modality depends on
  the size is left out rather than approximated, which is why Gemma 3 is absent while Gemma 4 is
  present. It lives in `@cat-factory/contracts` because the settings panel labels its "not set" option
  with what the table will do and the engine folds the same answer onto the dispatched ref.

  The initiator's declarations are read on EVERY dispatch, because the winning model is not known
  until the shared resolver has walked its sources, so the read goes through a new `AppCaches`
  slice keyed on the user (the endpoint write paths invalidate it). Without that, a deployment with no
  local runners at all still paid a query per step, and a mothership-mode node an extra
  `/internal/persistence` round trip per step.

  Delivery still joins the HARNESS's answer first, and that is what decides where this lands today: a
  local ref names no harness, so a container dispatch runs it on Pi, whose `HARNESS_IMAGE_INPUT` entry
  is `false` and refuses without consulting the ref. The modality is therefore acted on by the inline
  path, and the container path becomes a reader the day an image-carrying harness serves a local model,
  which is a one-line table edit rather than new plumbing. It is resolved for every path regardless,
  because the winning model is not known until the shared resolver has walked its sources.

  `contextTokens` is deliberately NOT declared for a local model, though the same shape could carry it.
  The window a runner serves is a fact about its config rather than about the weights (Ollama's
  `num_ctx` default sits far below what a 128K-window model can do), nothing enforces it for a local
  ref, and stating a number the runner silently ignores would be worse than stating none. The
  truncation trap that follows from that is now written down in `backend/docs/model-support.md`.

  **Internal break:** the endpoint row's enabled-model list changes from `string[]` to a declaration
  array. A row written before this loses its entries on read: bare strings are dropped rather than
  coerced, so the break cannot arrive as a model id of `[object Object]`. The endpoint reports the
  discard (`unreadableModels`) and the panel names it per runner, because a shortened list on its own
  reads exactly like a runner nobody ever enabled a model on and only one of those is fixed by
  re-ticking. The fix is to re-tick the models in "My local runners", which rewrites the whole blob.

### Patch Changes

- Updated dependencies [a634746]
  - @cat-factory/contracts@0.297.0
  - @cat-factory/kernel@0.288.0

## 0.157.0

### Minor Changes

- 7893f35: `/api/v1` can ADOPT a repository that already exists: `GET /api/v1/repos/available` lists what a
  workspace's connection can reach, and `POST /api/v1/repos/link` adopts one by name. Surface version
  1.44.0, additive.

  The hole they close was invisible from the surface. `GET /api/v1/repos` serves the repositories a
  workspace has LINKED, which is a set someone assembles in the app: linking is explicit per workspace,
  the provider webhook for an added repository does not project one, and a resync refreshes what is
  already linked rather than rediscovering the installation. So a repository that exists and is
  perfectly reachable is absent from every public read until a human opens the picker, and
  `POST /api/v1/services` answers 404 for its `repoId`, which is byte-for-byte what a caller gets for a
  repository that does not exist. A deployment could CREATE a repository through this API (1.41.0's
  bootstrap) and could not adopt one it already had.

  The two reads are a population pair rather than a duplicate, with `linked` as the join, so an absent
  repository is now diagnosable: reachable-but-unadopted appears in `/repos/available` with
  `linked: false`, and one that does not exist appears in neither. The adopt takes `owner`/`name`
  because a caller setting a workspace up from configuration knows the name and cannot know a provider
  id for a repository no public read lists; it is idempotent, answers the same row shape `/repos`
  serves (projected from the same read, so the two cannot disagree about whether a repository is free),
  and refuses an unreachable one with `404 repo_not_reachable`, a reason that covers "does not exist"
  and "your credential is not granted it" together because a provider answers those identically.
  `GitHubSyncService.linkRepoBySlug` resolves through the same path the app's own picker uses, and
  matches the OWNER as well as the name: a slug search can surface a look-alike, and linking that one
  would file a caller's work in someone else's account while answering 200.

  The acceptance suite uses them, which is what makes a hand-written `.env` a supported way in rather
  than a setup only `configure` could finish. Spec 01 adopts a repository the workspace does not hold
  instead of refusing; `target-repos` gates on REACHABILITY, point-reading `/repos/available` for
  anything unlinked and reporting "reachable but not adopted yet" as a pass; and `configure` adopts each
  repository rather than printing instructions for doing it by hand. Every attempt states its outcome,
  because a loop that reports only its positive answer is indistinguishable from one doing nothing, and
  what a refusal now asks for is only what no API can do: create the repository, and grant the
  credential access to it.

  Review follow-ups on the pair, all still inside 1.44.0 and still additive:

  Both rows now report whether a repository is SPOKEN FOR, from one account-scoped judgement.
  `/repos/available` publishes `serviceId` and `linkedElsewhere` exactly as `/repos` does, because a
  repository nobody here has linked can still back a service on another board of the account, and
  `POST /api/v1/services` refuses it either way. A discovery read that could not say so handed a
  caller a repository whose next call fails, and it was the acceptance gate that felt it first: it
  green-lit a pass that then died on the adopt, after the run the gate exists to precede. The
  judgement is now `PublicBoardReads.repoUse`, asked once of the projection (the repos list) and once
  of a batch of ids (the available read), so there is no second derivation to drift.

  The available read also publishes `truncated`. The provider legs behind it stop at a page cap and a
  search cap, so on a wide connection the rows are a prefix and a reachable repository can be missing
  from them, which is indistinguishable from the non-existence this read exists to diagnose. A
  point-read (`?q=owner/name`) resolves the exact slug directly and stays authoritative either way.

  A provider refusal is answered as one on BOTH operations and on either provider. The available read
  was left unwrapped, so a revoked credential or a rate limit on it arrived as `500 internal` rather
  than the documented 503/429; and the mapping recognised `GitHubApiError` alone, so a GitLab-connected
  workspace got that same `500` for a revoked token on both routes. Kernel now owns a `VcsApiError`
  base that both provider clients extend, which is the identity a consumer above the adapters branches
  on.

  The adopt is idempotent for a repository the credential can no longer reach: it resolves from what
  the workspace LINKS before consulting the provider, so a re-run no longer answers 404 for a
  repository `GET /api/v1/repos` still lists (a personal repository, or a narrowed App grant). And the
  link's `owner` accepts a namespace PATH, so a GitLab project under nested groups can be adopted at
  all: the available read published `group/subgroup` and the adopt refused it with a 422.

  In the suite, "the connection cannot reach it" is now recognised by `details.reason`, not by the 404
  alone: a deployment older than these endpoints answers an unmatched route with the same status, and
  reading that as "create the repository" sent an operator to create one they already had.

  Internal, breaking for in-repo callers only: `GitHubSyncService.listAvailableRepos` answers
  `{ repos, truncated }` rather than an array, the kernel `GitHubClient.searchInstallationRepos` port
  answers a `Paged` rather than an array (every adapter caps something, and a search that filters a
  bounded listing can return two rows and still be a prefix, which no row count reveals), and the
  `viewerRepos` / `patInstallationRepos` caches hold the whole page rather than its items (an
  enumeration that stopped at the cap is a prefix, and caching only the rows served that prefix to
  every later keystroke as the complete set).

### Patch Changes

- Updated dependencies [7893f35]
  - @cat-factory/contracts@0.296.0
  - @cat-factory/kernel@0.287.0

## 0.156.1

### Patch Changes

- Updated dependencies [07ff467]
  - @cat-factory/contracts@0.295.0
  - @cat-factory/kernel@0.286.3

## 0.156.0

### Minor Changes

- 9b3473a: `cat-factory k3s` no longer promises an ingress-derived environment URL it has not established, and
  can recreate a local cluster.

  An ingress-template URL needs two things: an ingress controller inside the cluster, and a host port
  published into it. The command assumed both. It published no host port when creating a k3d cluster
  (k3d forwards only the ports asked for at create time), created kind clusters with neither the port
  mapping nor an ingress controller, and checked nothing at all when reusing an existing cluster. The
  printed summary and the SPA connect-form deep link then named `{{branch}}.127.0.0.1.nip.io` as
  wired. Provisioning still succeeded, because environment readiness is workload readiness, so the
  failure surfaced later at the `tester` step against a URL that answered nothing.

  Now: a create publishes the port (`--ingress-port`, default 80), and every path probes both halves
  and reports one of three outcomes (verified, verified-missing with the fix, or could-not-tell). An
  unestablished ingress withholds the host-template prefill rather than filling the form with a
  promise, and the summary says what is missing and how to get it. Where the cluster is one the CLI
  can name, the port half is settled against the container runtime's own port table, so a host port
  answered by something other than the cluster is reported as the gap it is instead of as ready.

  New `--recreate`: destroy a named k3d/kind cluster and build it again from the current flags, which
  is the only way to change a published host port. It names what is on the cluster before deleting it,
  only ever targets a k3d/kind cluster the CLI can name, and is never selected for you (`--yes` alone
  cannot pick it). `--recreate --runtime k3s` is refused: k3s is a host service, not a cluster this
  command can delete and build again.

  The `ingressTemplate` environment URL source gains an optional `port`, on `/api/v1` (OpenAPI
  `info.version` 1.42.0, so the four SDK clients gain the field) and on the internal handler config
  alike. Additive, and existing configs are unaffected. A non-default host port needs its own carrier
  because the rendered `hostTemplate` is also the Ingress `spec.rules[].host` a service's manifests
  declare, and Kubernetes rejects a `host` with a port in it: folding the port into the template gave
  the right URL and an invalid manifest. Both connect forms gain the field beside the host template.

  Breaking for anyone scripting the CLI hand-off: the deep link now carries `scheme=http` (a local
  ingress controller's TLS is self-signed) plus `ingressPort` for a non-default port, and omits
  `hostTemplate` when the ingress was not verified. `buildK3sHandler` now returns `null` for a
  connection whose ingress was not established (there is no honest `url` block to register), and
  `buildK3sSetupUrl` takes the resolved connection rather than a built handler plus a verification
  flag.

### Patch Changes

- Updated dependencies [9b3473a]
  - @cat-factory/contracts@0.294.0
  - @cat-factory/kernel@0.286.2

## 0.155.5

### Patch Changes

- b889842: Report the actual cause of a failure everywhere, not just on a "Test connection" button.

  The previous slice taught the connection PROBES to read the cause chain, because on Node a transport
  failure is `TypeError: fetch failed` and what happened hangs off `.cause`. It turned out the repo had
  three describers of a thrown value and the other two stopped at `error.message`: `getErrorMessage`
  (the string a human is shown, and what a persisted failure reason or a PR comment records) and
  `describeError` (every log line). So a probe could name `connect ECONNREFUSED 127.0.0.1:6443` while
  the log line and the toast for the same failure still said `fetch failed`, which is what made a
  Kubernetes connect failure unexplainable even with the probe fixed.

  All three now flatten through one kernel core (`shared/error-chain.logic.ts`): `.cause` plus each
  `AggregateError` branch (so a dual-stack `localhost` reports what happened on each address), scrubbed
  through `redactSecrets`, capped with a marker saying what it dropped, and bounded by link identity so
  a cause cycle terminates. Roughly 90 hand-rolled `e instanceof Error ? e.message : String(e)` copies
  across the backend now call `getErrorMessage`, and five local `errMessage`/`messageOf` wrappers are
  deleted.

  Who may read a chain is part of the rule. An AUTHENTICATED reader gets it, because the inner link is
  usually the only thing saying whether the fix is theirs or the deployment's; where a deployment's
  model endpoints are platform-internal, their host and port do reach a workspace member through an
  ordinary 4xx. An UNAUTHENTICATED surface does not: `/ready` on BOTH facades answers with kernel's
  `publicDiagnostic` (the outermost link, scrubbed) rather than publishing the deployment's database
  address, sharing one helper so the two runtimes cannot drift to different depths.

  A VERDICT does not read the rendered string either. `errorChainMatches` tests each link uncapped, so
  a sentinel phrase pushed past the display budget by a long wrapper cannot silently turn a recognised
  rollout stop into a crash. Relatedly, log fields get their own, much wider cap than the 400 characters
  a human-facing message is held to, and an error with nothing to say answers with the empty string
  rather than the bare constructor name, so a call site's `getErrorMessage(e) || '<what to do>'` guard
  still fires.

  `redactSecrets` now spares a single-case word and an env-var-shaped identifier where a field-name rule
  matched: it scrubs the message a person reads, and `Missing required key: OPENAI_API_KEY` must not
  lose the name they have to go and set. Every credential shape the rules exist for still matches.

  An error message may therefore now carry appended causes where it did not before. The opening phrase
  is unchanged, which is what the downstream `/dispatch failed/i` and eviction-sentinel checks match on.

  On the SPA, every failure toast goes through the one funnel that already existed for pipeline errors,
  instead of 29 per-component copies of the same `notifyError(title, e)` and ~83 direct `toast.add`
  calls rendering the raw message. Beyond the translated copy that funnel already resolved, a failure
  toast now stays until dismissed instead of vanishing after about five seconds, its text is
  selectable, and one click copies the whole report: the action that failed, the class of failure, the
  backend's own account, and the `requestId` that is the only join between what the user saw and the
  server log line explaining it. Conflict (409) toasts get the same treatment, which matters most on
  the unknown-reason path, since that is where a reason an older SPA build has never heard of lands.

  `@cat-factory/cli` carries its own copy of the describer rather than importing kernel. That package is
  published and deliberately runtime-dependency-free, so a `workspace:*` import from its `bin` resolves
  through pnpm's link locally and is simply absent off the registry; a conformity test pins the copy to
  kernel's output byte for byte.

- Updated dependencies [b889842]
  - @cat-factory/kernel@0.286.1

## 0.155.4

### Patch Changes

- Updated dependencies [b25732f]
  - @cat-factory/contracts@0.293.0
  - @cat-factory/kernel@0.286.0

## 0.155.3

### Patch Changes

- 7119ca7: Warn on board load when the GitHub token a run would use cannot push or open pull requests.

  A personal access token is the operational credential on two deployment shapes: local mode, where
  one token is both the sign-in identity and what every agent step clones, pushes and merges with,
  and a hosted deployment whose run initiator stored a `github_pat`, which outranks the App
  installation on the run path. On both, a token minted without `repo` (or a fine-grained token
  pointed at the wrong repositories) reached its first failure several steps into a pipeline, as a
  403 out of a container, after the run had already spent money. Local mode logged a boot warning
  about it, which is a line in a terminal nobody is looking at; a hosted deployment said nothing at
  all.

  A new `GET /workspaces/:id/github/pat-check` answers what that token can actually do, and the SPA
  raises a banner linking straight to GitHub's token form, pre-filled where GitHub allows it.

  The parts worth reviewing:

  **Which token gets judged, and whether one is judged at all.** The check resolves through the same
  `resolveRunInitiatorToken` the dispatch mint and the engine's GitHub client already share, now
  surfaced on `CoreDependencies`, so a workspace that turned `allowInitiatorPat` off is not nagged
  about a credential none of its runs touch. Re-deriving the gate in the controller was the
  alternative, and it would have been a fourth copy of a security decision that exists to be singular.

  The second half of that question is answered by a new `listWorkspaceRunRepos` seam, the block-free
  counterpart of `resolveRepoTarget`, built beside it on every facade: every repository this board's
  mounted services target. A token is judged only where a run would present it, so a board that
  targets no GitHub repository (bound to GitLab, or nothing linked yet) answers `not_applicable`
  rather than rendering a scope verdict over pipelines that never reach GitHub. The same set is what
  a fine-grained token is probed against, so the probe's cap samples the work rather than the
  alphabet: the repository projection lists everything the connection can see and is ordered by owner
  and name, which no run consults.

  **Per capability, not a boolean.** GitHub reports a classic token's scopes in `x-oauth-scopes` and
  reports nothing whatsoever for a fine-grained one, whose reach is knowable only by probing a
  repository: that answers for push and answers nothing for pull requests or workflows. Each
  capability therefore carries `granted` / `missing` / `unknown`, and only `missing` raises anything.
  Folding `unknown` into either would have meant silencing a real gap or nagging every correctly
  configured fine-grained deployment forever. The fine-grained probe is a capped sample of the
  targeted repositories and says how many it did not read.

  **What a repository read can and cannot establish.** GitHub's repository payload reports the
  authenticated IDENTITY's role, not the grants of the credential presenting it, and a token's reach
  is a subset of its owner's. So `push: false` refutes the token while `push: true` only fails to
  refute it, and only the first is reported as a verdict. The one positive statement available about
  the credential itself is a 404, which GitHub returns rather than a 403 for a repository a
  credential may not see; a 404 on every targeted repository is therefore `missing`, and the report
  names those repositories, which is the fine-grained-token-pointed-at-the-wrong-repositories case
  this feature exists to catch. A single 404 among readable repositories stays `unknown`: it is
  ambiguous with a projection row pointing at a renamed repository, and a stale row must not be
  reported as a broken credential.

  **A throttled token is not a rejected one.** GitHub spells an exhausted primary or secondary rate
  limit with the same 403 it uses to refuse a credential, so the rate-limit markers are read first
  and answer `probe_failed`. Read as a rejection, a throttled board load raises the loudest banner
  the product has and advertises minting a replacement.

  **A classic token with no scopes is a distinct fact from an unreadable one.** GitHub sends
  `x-oauth-scopes` for every classic token, so an empty value states that this one grants nothing.
  Treating an empty header as an absent one classified it as unreadable, which sent it down the
  fine-grained path where a repository read its owner could satisfy reported it as fine. It now
  classifies as a classic token missing everything, and the connect form gained a warning
  (`github_pat_no_scopes`) saying so.

  **The scope list is not on the wire.** Nothing renders it, reads pass the route's permission mount,
  and the one source whose scopes this endpoint could expose is a shared deployment credential.

  **What does not raise the banner.** An unreachable GitHub is `probe_failed`, not a verdict: the
  remedy a permissions banner advertises is wrong and expensive during an upstream blip. A missing
  `workflow` scope is advisory, listed inside the card but never its reason for opening, because
  without it a run still pushes, opens its PR and merges and fails only on changes that touch
  `.github/workflows/*`.

  **Classic versus fine-grained.** The re-mint link carries over the kind of the token being
  replaced, so a deployment that standardised on fine-grained tokens is not pushed back to a classic
  one by a warning. Only the classic form accepts a prefill; GitHub's fine-grained form takes no
  permission parameters at all, so that half is a bare link and the banner names the permissions to
  grant. Saying so is deliberate: a link that silently arrived with nothing selected reads as
  "already done for you".

  **On the SPA side**, the check is single-flighted separately from the connection reads and never
  awaited by them. It is the only one of the three that leaves the deployment, and two modals block
  their open on `probe()`; awaited, an unreachable GitHub held those modals for the full outbound
  timeout to settle a banner they do not render. It follows the door rather than the batch: the
  on-board-open fan-out checks at most once per board, while the deliberate-refresh door re-checks,
  because the surfaces that force a refresh are the ones that just changed what the answer depends
  on. Three panels whose own comments said "probe once so the pickers light up" moved onto
  `ensureProbed`, which is what they meant.

  The required-scope list is now one constant in `@cat-factory/contracts`, read by the local
  facade's boot warning and setup link, its scope classifier, and the SPA — it was two copies before,
  which is two answers to "what should I tick".

- Updated dependencies [7119ca7]
  - @cat-factory/contracts@0.292.2
  - @cat-factory/kernel@0.285.3

## 0.155.2

### Patch Changes

- 3dde85c: Fix every Kubernetes apiserver call that carries a custom CA or "skip TLS verification": the
  undici `Agent` holding the TLS options was handed to Node's global `fetch`, whose request handler
  comes from Node's own bundled undici, so one undici validated the other's handler and the request
  died before a socket was opened as `fetch failed: invalid onRequestStart method
(UND_ERR_INVALID_ARG)`. The dispatcher and the `fetch` that uses it now come from one undici
  instance. A k3s apiserver serves a self-signed certificate, so this was every k3s connection.

  `undici` moves from `devDependencies` to `dependencies`, where the runtime import that path
  performs has always belonged. Declared as dev-only it resolved in every test lane and in no
  production image (`pnpm install --prod` prunes it), so the same calls would have kept failing
  once deployed, and a load failure now reports the load error itself instead of claiming the
  runtime is not Node.

## 0.155.1

### Patch Changes

- 57a7ecd: Report what actually went wrong when a connection test fails.

  Every "Test connection" button rendered the thrown error's `message`, which on Node is undici's
  generic `fetch failed` wrapper; the real failure hangs off the cause chain. A stopped k3s cluster,
  an untrusted certificate, an unresolvable host and a firewalled port all read identically. A new
  kernel helper flattens the chain into the exact failure and adds a remedy for each cause it
  recognises, wired into the Kubernetes environment + runner probes, the shared HTTP probe behind the
  manifest environment/runner-pool providers, the Cloudflare preview probe, and the Compose probe. An
  unrecognised failure is still reported verbatim, with no hint.

  The failure CLASS also rides the wire as `ConnectionTestResult.failureCause` (a new optional field,
  with the vocabulary in `@cat-factory/contracts`), so the connect forms state what failed in the
  operator's own language and keep the backend's English account, which names the concrete host and
  the remedy, as the detail beneath it.

  A pasted ServiceAccount token is also checked on the field now: a token copied across a wrapped
  terminal line carries a newline that no HTTP header can hold, and it previously surfaced as an
  opaque request failure minutes later. The impossible case blocks Test and Save and is refused by
  the apiserver client; a still-base64 `.data.token` value or a non-JWT shape is an overrulable
  warning, since an apiserver using static bearer tokens accepts arbitrary strings.

  The `cat-factory k3s` deep link now scrolls the Infrastructure window to the Kubernetes section
  instead of opening at the top of the tab, and the CLI no longer lists the ServiceAccount among the
  values to type into a form that has no such field.

- Updated dependencies [57a7ecd]
  - @cat-factory/contracts@0.292.1
  - @cat-factory/kernel@0.285.2

## 0.155.0

### Minor Changes

- 5f6699a: Let an MCP host connect over OAuth, instead of being handed a key to paste into a config file.

  The hosted endpoint (`POST /api/v1/mcp`) has always accepted a public-API key, and a key was the only
  way in. That rules out the hosts the endpoint exists for: claude.ai, Claude Desktop and the IDE
  clients discover authorization from the server and have no console at someone else's deployment to
  paste a credential into. It also puts a long-lived credential in a config file on disk, which is the
  exact hazard this project's own docs warn about for the stdio path.

  This deployment now speaks the MCP authorization spec, as its own authorization server. A host asks
  the endpoint, is answered `401` with a `WWW-Authenticate` naming the protected-resource metadata,
  walks that to the authorization-server metadata, registers itself dynamically, and opens a browser.
  A signed-in person with `secrets.manage` picks the board and the rung of the scope ladder, and the
  host is issued a credential of its own.

  **What it issues is an ordinary public-API key**, and that one choice decides most of the rest.
  Nothing downstream learns a second token format, every `/api/v1` route the tools reach authenticates
  exactly as before, and revoking the connection is the button already in the board's key panel, where
  it appears as `MCP: <host name>`. The honest cost is stated on the wire rather than hidden: a key
  does not expire, so `expires_in` is OMITTED (RFC 6749 makes it optional precisely so a server can say
  this by absence) and NO refresh grant is advertised, because a refresh could only mint duplicates. A
  client asking for one is refused in the protocol's own vocabulary rather than by a 404 it would read
  as a broken deployment. Giving keys a real expiry is what would make a refresh grant honest, and it
  needs an `expiresAt` column on both runtimes.

  **Nothing is persisted.** The `client_id`, the in-flight authorization request and the code are each
  sealed into the value the other party carries, under the deployment's own key with an explicit `kind`
  the opener pins. A table would have cost a migration on both runtimes, a repository pair, a
  mothership routing decision, and a sweeper for the rows behind every consent screen anyone abandoned.
  It buys two residual gaps, both recorded rather than papered over. There is no single-use enforcement
  on the code, which PKCE makes survivable (redeeming needs the verifier, which never left the host, so
  a code lifted from a history or a proxy log is unredeemable by whoever lifted it) and which a 60
  second TTL bounds; and a registration cannot be revoked, which is acceptable because it confers
  nothing at all until a human approves a specific board.

  **Dynamic client registration IS performed here, the opposite of the decision on the consuming side**,
  where this platform is the OAuth client of a vendor's MCP server and deliberately does not register
  itself. There, a runtime-minted client is deployment state with no operator-visible identity at the
  vendor, so nobody can find, rotate or revoke it. Here the registration is a name and a redirect list
  that grant nothing until a `secrets.manage` holder approves a board and a scope, and what they
  approve is a key they can see and delete.

  **The consent screen is a page in the SPA, not a screen the backend renders**, which is the same
  shape the consuming side's vendor callback settled on, reached from the opposite direction. An
  authorization endpoint is a top-level browser navigation a third party triggers, so it carries no
  bearer token, and a screen served there could not say who was approving; any "is this the right
  person" check written on it is unreachable code that reads like protection. So `GET /oauth/authorize`
  validates, seals, and redirects to `/mcp-authorize`, whose two calls are ordinary session-gated API.
  On an SSO deployment that is also where the identity provider gets into a flow that otherwise knows
  about nobody.

  Two asymmetries in that controller are deliberate. A DENIAL takes no permission, because a person who
  cannot approve must still be able to answer, or the host waits out its timeout and its user goes
  looking for a fault in the deployment. And WHERE a refusal at the authorize endpoint goes turns on
  one line: until the `redirect_uri` has been matched against the registration there is no address it
  may be sent to, because bouncing it back would BE the open redirect that check exists to prevent, so
  it renders as a page; once it has been matched, RFC 6749 §4.1.2.1 puts every remaining fault (a bad
  `response_type`, missing PKCE, a `resource` naming somewhere else) on the client's own registered
  address, because a page instead leaves a conforming host waiting on a callback that never arrives.
  The distinction is carried by the error the service throws rather than re-derived at the route, so
  nothing downstream re-decides it from attacker-supplied input.

  **The consent screen preselects the platform's default scope, never the host's ask above it.**
  Registration is unauthenticated, so `scope=admin` costs an attacker nothing, and an ask arriving as
  the checked radio button would put the rung that deletes tasks and merges pull requests in front of a
  person as though it were the shipped default. The ask is honoured only downward; above the default it
  is REPORTED on the screen instead, so raising the grant stays something a person does.

  **The 401 challenge is the piece with no second source.** Everything else in the chain was already
  serveable and would have been unreachable, because nothing told a client to look. It is set by the
  route on the request context and rendered by `handleError`, which stays the one producer of the error
  envelope: the route knows its challenge before it knows whether it will refuse, and the refusal is
  raised inside shared key-authentication code that has no business knowing which surface it protects.
  `WWW-Authenticate` also joins `CORS_EXPOSED_HEADERS`, without which a browser-hosted client cannot
  read the one header it cannot connect without.

  **Verified against a real vendor rather than against expectations written beside the code.** The
  serving documents are asserted by driving this repository's own CONSUMING discovery walk over them,
  and the same test drives that walk over the documents Figma's live MCP server actually serves,
  recorded verbatim. One client, two servers, and the second held to what the first demonstrates is
  enough. The Figma fixture earns its place twice: it is also the only regression test the consuming
  walk has against a shipping, OAuth-protected MCP server.

  **`/.well-known/*` and `/oauth/*` answer any browser origin**, whatever `CORS_ALLOWED_ORIGINS` says,
  through one predicate in the shared CORS layer both facades read. That is the complement of the
  allowlist rather than a hole in it: the allowlist names the origins that may drive an existing
  credential's surface, every route under these two prefixes is reached by a party that has no
  credential yet, and the hosts this exists for run on origins no operator can be expected to have
  listed. It belongs in the CORS layer rather than on a handler because a preflight is answered before
  any route runs: covering the documents alone reads as working, since discovery is a plain GET nobody
  preflights, and then the first call that ACTS on what was discovered is dropped by the browser.

  Serving is enabled exactly when a deployment can complete the flow: an `ENCRYPTION_KEY` (everything
  carried is sealed under it) and the public-API key store (what it issues). Absent either, NOTHING is
  advertised: the discovery documents refuse with the same 503 as the routes they describe, and a host
  falls back to asking for a key. A deployment that described an authorization server it cannot run
  would send every host down a chain that fails at the last step, which reads as a broken deployment
  rather than as one that has not enabled a capability.
  `APP_BASE_URL` is read only for the consent redirect and falls back to the request's own origin,
  which is right for every same-origin install; unlike the consuming side's `MCP_OAUTH_REDIRECT_URL`,
  no third party holds this string.

### Patch Changes

- Updated dependencies [5f6699a]
  - @cat-factory/contracts@0.292.0
  - @cat-factory/kernel@0.285.1

## 0.154.0

### Minor Changes

- 2428b6b: Attribute a cross-service run's pull request to every involved service frame whose changes ride
  it, not just the first.

  The multi-repo fan-out checks out one repo per REPO, so several involved services living in one
  monorepo already shared a checkout, a work branch and a single pull request. Only the RECORD was
  singular, which left every frame but the first looking like a service the run had opened no pull
  request for. The attribution is now a set (`frameIds`) from the dispatch through the harness echo
  to `block.peerPullRequests`, the merge order, and the verification report. The own-service report
  carries it too, naming the involved services co-located in the task's own repo: those open no pull
  request of their own, so that report is the only place their change is reported. A peer checkout
  also stops inheriting one co-located service's `serviceDirectory`: it is whole-repo, as the primary
  already was, so the services that resolved second are reachable.

  A recorded peer pull request is now ADDRESSED by its repo rather than by its frames, which is what
  a checkout is identified by, and one the platform cannot resolve is named to the merger instead of
  being dropped from the combined diff it scores.

  Internal break: `peerPullRequestSchema.frameId`, `allPullRequests`, `MergePrEntry.frameId`,
  `PrReportTarget.frameId` and the harness `peerRepos`/`peerPullRequests` wire fields are replaced
  by `frameIds`. Peer PRs recorded on a block before this ship lose their frame attribution (the
  pull requests themselves are untouched). Public `/api/v1` is additive only: `PrReportScope` gains
  `frameIds` and keeps `frameId` as its head (surface version 1.40.0). `frameId` is no longer always
  null on an own-service report: it names a co-located involved service when there is one.

  The runner image moves to `cat-factory-executor:1.109.0`.

### Patch Changes

- Updated dependencies [22b2459]
- Updated dependencies [2428b6b]
  - @cat-factory/kernel@0.285.0
  - @cat-factory/contracts@0.291.0

## 0.153.12

### Patch Changes

- Updated dependencies [19baddf]
  - @cat-factory/kernel@0.284.0

## 0.153.11

### Patch Changes

- Updated dependencies [31f43c1]
  - @cat-factory/contracts@0.290.0
  - @cat-factory/kernel@0.283.0

## 0.153.10

### Patch Changes

- Updated dependencies [3ff215a]
  - @cat-factory/contracts@0.289.1
  - @cat-factory/kernel@0.282.1

## 0.153.9

### Patch Changes

- Updated dependencies [e3cf16a]
  - @cat-factory/contracts@0.289.0
  - @cat-factory/kernel@0.282.0

## 0.153.8

### Patch Changes

- Updated dependencies [83764b5]
  - @cat-factory/contracts@0.288.0
  - @cat-factory/kernel@0.281.3

## 0.153.7

### Patch Changes

- Updated dependencies [1fbd83c]
- Updated dependencies [00228c6]
  - @cat-factory/contracts@0.287.1
  - @cat-factory/kernel@0.281.2

## 0.153.6

### Patch Changes

- Updated dependencies [bf473bd]
  - @cat-factory/contracts@0.287.0
  - @cat-factory/kernel@0.281.1

## 0.153.5

### Patch Changes

- Updated dependencies [4715b74]
- Updated dependencies [8c1d8a6]
  - @cat-factory/contracts@0.286.0
  - @cat-factory/kernel@0.281.0

## 0.153.4

### Patch Changes

- Updated dependencies [afe1250]
  - @cat-factory/contracts@0.285.0
  - @cat-factory/kernel@0.280.0

## 0.153.3

### Patch Changes

- e3fdc15: A typing pass that removes the casts a better type, a generic or a guard could carry.

  New in `@cat-factory/contracts`: `parseStoredProviderConfig(schema, raw, label)`, the one place a
  native environment backend re-reads its own config off a stored manifest's `providerConfig`. The
  Kubernetes, Cloudflare and EKS backends used to assert that value; a config written before a schema
  change (or edited in the database) therefore flowed on as a fake-valid object and misbehaved deep
  inside a provision instead of being named at the boundary. Those three now THROW on an off-contract
  stored config where they previously carried on.

  That re-read is split by what the operation USES, which is the difference between a loud refusal
  and an environment nobody can reclaim. Standing one up parses the whole config; tearing one down
  parses only the connection (`kubernetesConnectionConfigSchema` / `eksConnectionConfigSchema` /
  `cloudflareConnectionConfigSchema`), so a `manifestSource`, `url` or `workersSubdomain` that
  stopped matching the contract still fails a provision and can never strand a live namespace or
  preview. The fields the reclaim itself reads stay validated: there is no safe default for which
  cluster to delete from, and none for a GitHub Enterprise API root whose fallback is the public one.

  Behaviour changes worth knowing about:

  - The Worker's bindings are read through `envVar` / `envVars`, which filter by `typeof`. A binding
    that is not a string (a D1 database, a queue, a Durable Object namespace) now reads as absent
    where the previous assertion handed it on as a string.
  - `SlackApiClient.chatPostMessage` takes the rendered `SlackMessageBody` instead of an arbitrary
    `Record<string, unknown>`. `SlackMessageBody` and `DeployJobSpec` are type aliases rather than
    interfaces so they keep the implicit index signature their JSON sinks need.
  - The workspace-RBAC mount tag is read through a shape guard; an unrelated object stored under the
    same symbol no longer reads as a permission gate.

  - `EksEnvironmentProvider` parses its own superset config. It inherited the Kubernetes parse, and
    a valibot object drops entries it does not declare, so `region` / `clusterName` / `stsHost` were
    read off a config that no longer had them: every EKS call was presigning its apiserver token
    against `sts.undefined.amazonaws.com`.
  - The Kubernetes engine form narrows a stored `url.source` through `isKubernetesUrlSource`, a guard
    derived from the contract variant's own members. The discriminant is a closed vocabulary that is
    nonetheless persisted, so a config naming a source this build does not define now falls back to
    the form's default rather than reaching an exhaustive `switch` with no branch for it.

  Everything else is type-level only: typed `queryAll` / `queryOne` helpers behind the local
  `node:sqlite` stores (the row shape is now checked to be one SQLite could produce), a `BadgeColor`
  derived from `UBadge`'s own prop type so the SPA's chip maps agree with the component, and the
  Kubernetes engine form building its config as the contract's discriminated union.

- Updated dependencies [e3fdc15]
  - @cat-factory/contracts@0.284.0
  - @cat-factory/kernel@0.279.3

## 0.153.2

### Patch Changes

- 3036af7: Refresh every direct and transitive dependency to the newest version the 24h
  `minimumReleaseAge` supply-chain gate admits, staying inside each package's current major.

  The Vercel AI SDK family moves within the majors `workers-ai-provider` pairs with
  (`ai@7.0.58`, `@ai-sdk/*@4.0.36` / `openai-compatible@3.0.27` / `amazon-bedrock@5.0.50`), and the
  Vue singleton pin plus its `@vue/*` overrides move together to 3.5.41 so the SPA still bundles
  exactly one Vue.

- Updated dependencies [3036af7]
  - @cat-factory/kernel@0.279.2

## 0.153.1

### Patch Changes

- Updated dependencies [de7caaf]
  - @cat-factory/contracts@0.283.1
  - @cat-factory/kernel@0.279.1

## 0.153.0

### Minor Changes

- f0e1c45: Issue writeback is a `TaskSourceProvider` capability, and GitLab Issues accept webhooks

  The engine's writeback (a comment when the PR opens, comment + resolve on merge, the intake
  pickup claim, a parked review's questions and the acknowledgement of a reply) dispatched on a
  hard-coded `github | jira | linear` chain inside one service. GitLab Issues, a shipped task
  source, therefore had full intake and no way to answer it, and a tracker a deployment registers
  could not have one however it was wired. Providers now declare `writeback`, the outbound mirror
  of the existing `webhook` capability, and the service dispatches through the registry.

  `GitLabIssuesProvider` also gains the inbound half: GitLab echoes a shared secret in
  `x-gitlab-token` rather than signing the body, so its adapter compares that in constant time and
  still fails closed on an empty secret. Board equality is now the source's own rule
  (`TaskSourceProvider.sameBoard`), because GitLab project paths are case-sensitive where every
  other board id folds.

  A writeback adapter declares where it gets its authority (`authenticates`), which decides what an
  unreadable tracker connection costs. Jira and Linear post with the stored bag, so a row that will
  not open takes their writeback with it. GitHub Issues and GitLab Issues authenticate through the
  workspace's VCS installation and read that row only for the inbound reply secret, so they keep
  posting and lose just the reply grammar, which is withheld rather than promised.

  Two internal breaks, per the pre-1.0 policy. The facades' `commentOnGitHubIssue` /
  `closeGitHubIssue` / `labelGitHubIssue` writeback seams are gone (the source resolves its own
  installation now), and a writeback for a workspace with no stored connection REFUSES where the
  Jira and Linear legs used to return quietly: that silent return let the parked-review echo record
  its idempotency marker for a comment the tracker never received.

### Patch Changes

- Updated dependencies [f0e1c45]
  - @cat-factory/kernel@0.279.0

## 0.152.8

### Patch Changes

- Updated dependencies [6ad1d8b]
  - @cat-factory/contracts@0.283.0
  - @cat-factory/kernel@0.278.0

## 0.152.7

### Patch Changes

- a596b9c: Refuse a pipeline whose environment lifecycle does not add up when it is saved: a tester /
  acceptance / human-test step with no live environment to run against (nothing provisioned one, or
  the `disposer` reclaimed it first), a `deployer` that neither reclaims nor declares that its
  environment outlives the run, or a `disposer` with nothing standing to reclaim. The rule is
  enforced at pipeline create and update only, so a stored pipeline authored before it keeps running;
  the builder shows the same faults inline off the one shared rule in `@cat-factory/contracts`, and
  the run door now reads that same rule for the two faults that would genuinely dead-end a run,
  rather than re-deriving the ordering beside it.

  An environment that is MEANT to outlive its run stays expressible: the deployer step declares it
  (`stepOptions.retainEnvironment`), which is also what lets the PR verification report render the
  teardown leg as `retained` instead of a `pending` reclaim that is never coming. That adds one enum
  value to the report's `teardown` field on `/api/v1` (spec 1.35.0, additive).

  Every built-in preset that deploys now ends with a terminal `disposer` (`pl_build`, `pl_simple`,
  `pl_full`, `pl_visual`, `pl_frontend`, `pl_tech_debt`), each with a version bump so seeded
  workspaces are offered the reseed.

- Updated dependencies [a596b9c]
  - @cat-factory/contracts@0.282.0
  - @cat-factory/kernel@0.277.0

## 0.152.6

### Patch Changes

- Updated dependencies [2585b2f]
  - @cat-factory/contracts@0.281.0
  - @cat-factory/kernel@0.276.0

## 0.152.5

### Patch Changes

- Updated dependencies [faddbf5]
  - @cat-factory/contracts@0.280.0
  - @cat-factory/kernel@0.275.4

## 0.152.4

### Patch Changes

- Updated dependencies [8a06abc]
- Updated dependencies [8a06abc]
  - @cat-factory/contracts@0.279.0
  - @cat-factory/kernel@0.275.3

## 0.152.3

### Patch Changes

- Updated dependencies [11f9efa]
  - @cat-factory/contracts@0.278.0
  - @cat-factory/kernel@0.275.2

## 0.152.2

### Patch Changes

- Updated dependencies [c44e9d7]
  - @cat-factory/contracts@0.277.0
  - @cat-factory/kernel@0.275.1

## 0.152.1

### Patch Changes

- Updated dependencies [dfa4a8e]
  - @cat-factory/kernel@0.275.0

## 0.152.0

### Minor Changes

- 3e9a6af: Public API (`/api/v1`, spec 1.31.0): board provisioning, task relationships, and the evidence a
  judging consumer was missing. All additive.

  Seven new operations: `GET /api/v1/repos` and `POST /api/v1/services` (create a service, optionally
  backed by a repository, so a headless deployment can provision the board it drives),
  `POST /api/v1/tasks/:taskId/dependencies` and `.../dependencies/remove` (declare an ordering
  instead of racing a batch of related tasks against one repository), and
  `GET|POST /api/v1/tasks/:taskId/documents` plus `.../documents/detach` (a task's spec routinely
  arrives after the task does). New fields: `autoStartDependents` on the task patch, `dependsOn` and
  `autoStartDependents` on the task projection, `output` and `data` on a run step (an inline-only
  pipeline's deliverable, previously readable only in the app), `truncated` on a run step,
  `linkedElsewhere` on a repo option, and `scope` on a run artifact.

  Two rules a consumer of the new fields should read. **`GET /api/v1/tasks/:taskId/events` serves a
  run's step deliverables REDUCED**: an SSE frame carries the whole run, so an oversized `output` is
  clipped to a preview and an oversized `data` withheld, with `truncated: true` on the step saying so.
  The point read (`GET /api/v1/tasks/:taskId/run`) serves both whole and is what to read for a
  deliverable. And **`GET /api/v1/repos` distinguishes three states, not two**: `serviceId` names the
  service a repository backs ON THIS BOARD, and `linkedElsewhere` marks one already backing a service
  homed on another board of the account, which `POST /api/v1/services` refuses
  (`reason: repo_service_homed_elsewhere`) rather than answering with a frame id a workspace-scoped
  key could not then use.

  One population change worth reading before upgrading: `GET /api/v1/runs/:runId/artifacts` now
  returns the reference designs attached to the run's TASK alongside the artifacts the run captured,
  each row saying which it is. A consumer counting rows to mean "screenshots this run captured" must
  filter on `scope: "run"`; one comparing a screenshot against the design it was judged against
  finally has both.

  BREAKING for a deployment that registers its own polling gate (internal API, not `/api/v1`): a gate
  declares `pollExhaustion` on its REGISTRATION rather than on the `GateDefinition` its factory
  builds. `HUMAN_WAIT_GATE_KINDS` and `BUILTIN_GATE_KINDS` are removed from
  `@cat-factory/contracts` with them. A declaration left on the definition now fails to typecheck
  rather than being silently ignored. The payoff is that public-API admission reads every gate's own
  declaration, so a deployment's unbounded human-wait gate is no longer admitted for a plain `write`
  key and then parked forever with nothing able to name the surface.

  See [ADR 0050](https://github.com/kibertoad/cat-factory/blob/main/backend/docs/adr/0050-public-api-headless-completeness.md).

### Patch Changes

- Updated dependencies [3e9a6af]
  - @cat-factory/contracts@0.276.0
  - @cat-factory/kernel@0.274.0

## 0.151.0

### Minor Changes

- a62bcf8: Deliver notifications by email, and add the notification manager that decides which events go to
  which channel.

  The `EmailSender` port, its SendGrid/Resend adapters and the per-account connection have been live
  for a while and were used only for invitations. A new `EmailNotificationChannel` puts them behind
  the same `NotificationChannel` port the in-app and Slack transports implement, so the engine call
  sites that raise notifications are untouched. It resolves recipients from the SAME rules
  `resolveWorkspaceAccess` applies (account membership is the prerequisite, an account admin always
  qualifies, a `workspace_members` row counts only for a still-current account member), reads them in
  three batched queries rather than a point-read per person, and isolates each send so one bad address
  cannot cost every other recipient their notification. An account with no sender connected produces
  zero attempts and zero warnings.

  The manager (`notification_settings`, one row per workspace, D1 ⇄ Drizzle with a conformance suite)
  stores per-type, per-channel OVERRIDES over the shipped defaults, and one service answers both the
  settings API and the delivery gate so the toggle a human sees cannot say something the engine does
  not do. **By default email carries only the high-impact events**: the ones where something is
  stopped until a human acts (`merge_review`, `decision_required`, `ci_failed`, `test_failed`,
  `release_regression`) or the deployment itself is degraded (`platform_health`, `infra_unreachable`,
  `budget_paused`, `key_drift`). The per-step review parks are deliberately off by default — several
  arrive on nearly every task, and mailing them is the firehose that gets a sender's domain filtered.

  Only the channels whose delivery is a plain yes/no are routed here: the in-app push and email.
  Slack and the outbound webhooks answer "which types" where their DESTINATION is declared (a Slack
  route's channel, a webhook endpoint's own `types` filter), so a second switch would be a place to
  look that does not decide. The settings panel says so and links to the Slack routing.

  Delivery now carries WHICH lifecycle edge it reports (`NotificationDeliveryReason`: `raised` /
  `refreshed` / `settled`), because the service re-delivers a card on every transition it makes and
  the transports split hard on what that means. A STATE transport (the in-app push, the outbound
  webhook) takes every edge, so a board holding an open card sees it settle instead of rendering an
  already-made decision as still actionable. An ALERT transport (email, Slack) takes the `raised` edge
  alone: a mailbox and a chat channel cannot render a correction, so a second "Decision needed" after
  the decision was made is simply false. This also corrects Slack, which re-posted on every resolve
  and dismissal before the edge existed, and it is why the escalation sweep's loop over a workspace's
  overdue cards now performs no routing or audience reads at all. **The edge is a required parameter
  and rides the mothership delegation wire**, where it is refused rather than defaulted: the persisted
  row cannot supply it (a raise and an escalation are both `open`), so a node one build behind fails
  loudly instead of mailing the org about decisions already made.

  Two more behaviours to watch for when reviewing. The in-app push is gated too, but only on the raise:
  muting a type stops the live toast, while the card is still persisted, still in the inbox on the next
  snapshot, and still pushed when it settles. And a settings read that FAILS falls back to the shipped
  default and logs, rather than defaulting to deliver-everything (a mailshot) or deliver-nothing (the
  parked run nobody hears about). In the settings panel the same distinction is explicit: a deployment
  with no routing store and a read that broke are separate states, and only the first renders the
  shipped defaults, because saving is a full replace and a grid built from defaults would otherwise
  overwrite overrides nobody had seen.

- 2544fb3: Give the five HKDF cipher-info tags their own exported constants beside the services that
  own the sealed data, and import them in both facades instead of re-typing the literals.

  These strings derive the keys that seal provider subscriptions, provider API keys, personal
  subscriptions, local model endpoints and user secrets at rest, so a divergence between the
  two facades produces credentials one seals and the other cannot open, with nothing failing
  loudly. Four of their siblings were already imported constants; these five had been missed.

- fe8ca56: Let a deployment define its own binary artifact stores in code. Implement the kernel
  `BinaryBlobBackend` port, register it on the new app-owned `BinaryStoreRegistry`, and pass the
  registry to `start()` / `startLocal()` / `createWorker({ overrides })`: each registered store then
  appears in the account-settings storage picker beside the platform's `fs` / `db` / `s3` / `r2`
  backends, and the per-account resolver builds it when an account selects it. The registered id is
  stamped onto every artifact row, an account naming a store this build does not register resolves to
  no storage and is named in the log and the settings panel, and the retention sweeps reclaim through
  a custom store like any built-in one.

  On the Worker the registry is held PROCESS-WIDE rather than on the app, alongside the model-provider
  and capability-credential registrations and for the same reason: that runtime builds a container per
  entry point, and the entry points that write and reclaim artifacts (the durable driver, the queue
  consumers, the retention cron) take no overrides. A store must be registered on every process that
  handles its bytes, which in mothership mode means the nodes that write them AND the mothership that
  sweeps them; a mothership-mode node now says so at boot.

  Internal break: `ContentStorageCapability` gains a required `customStores` and `ContentStorageSummary`
  a required `customStoreId`, so a facade or test building either literal must add them (the compile
  error is the point). `BinaryArtifactStorageKind` is now open at the type level, since a registered
  store's id is a legitimate value of the `storage` column.

- 2544fb3: Make the provider-routing VCS client reflective, so it can no longer under-report the port.

  `ProviderRoutingGitHubClient` was a hand-written delegate over a 53-method port, 20 of whose
  methods are optional. It implemented the 33 required ones and 18 of the optional ones were
  simply absent, which typechecks precisely because they are optional. `providerRoutingGitHubClient`
  replaces it with a `Proxy` (the shape `runtimes/local/src/vcsClientRouter.ts` already documents),
  so the surface it presents is the union of what its backing clients implement.

  Behaviour change, in a deployment running BOTH a GitHub App and GitLab connect: the branch
  protection preflight now answers for real on GitHub installations, where it previously reported
  `capability: 'unavailable'` for the whole workspace. A call landing on a provider whose client
  does not implement the method refuses with the new `VcsCapabilityUnsupportedError` rather than
  `undefined is not a function`; `GitHubService.checkDefaultBranchProtection` absorbs it and keeps
  reporting `unavailable`, which is exactly the fact it already models.

  Reflecting means deciding what counts as a member, and the first answer was too generous:
  membership was tested with `Reflect.has`, which walks into `Object.prototype`, so `toString`,
  `valueOf`, `constructor` and the rest were answered with installation-routing functions. Coercing
  the client to a string called `toString()` with no arguments, which routed on `undefined` as the
  installation id and returned a promise where a primitive was required, so a template literal or a
  logger touching the client threw `TypeError: Cannot convert object to primitive value` with an
  unawaited repository read rejecting behind it. Membership now stops at `Object.prototype` and
  anything that is not a port member is answered by the proxy target, so those names behave as they
  do on any object while an unimplemented optional method still reads as absent.

  `VcsCapabilityUnsupportedError`'s reason joins the shared `UNAVAILABLE_REASONS` vocabulary and
  gains translated SPA copy. Without it the refusal rendered as the generic 503 wording, "this
  deployment has not configured the capability", which is the misattribution the class exists to
  prevent: no operator wiring changes what a provider does not offer. Its sibling
  `vcs_client_unconfigured` deliberately stays on the generic copy, because that one IS a wiring gap.

### Patch Changes

- Updated dependencies [a62bcf8]
- Updated dependencies [fe8ca56]
- Updated dependencies [2544fb3]
  - @cat-factory/kernel@0.273.0
  - @cat-factory/contracts@0.275.0

## 0.150.0

### Minor Changes

- 35bc18f: Say what killed a container, on every transport that can run one.

  The post-mortem machinery was wired into exactly one path (the local per-run poll), so on the
  DEPLOYED runtime a container death reached the operator as `Job not found (container evicted or
crashed)` and nothing else. Each of the three remaining transports already held the evidence and
  discarded it at the moment it became the only evidence there was.

  **Cloudflare.** A per-run container recorded only a rollout drain, so an OOM kill recorded
  nothing. It now records `{ exitCode, reason }` for EVERY stop, and the transport attaches it to
  the eviction detail. That state is deliberately a SECOND, independent half of the stop record: the
  churn cause decides the recovery budget (unchanged, so the crash-eviction backstop behaves exactly
  as before), while the exit state decides the detail and is kept for the cause-less deaths, which
  are precisely the ones nobody could diagnose. The two hooks that see a stop now merge onto one
  record instead of overwriting: `onError` recognises the churn and knows no exit code, `onStop`
  knows the exit code and cannot name the churn, and they fire in either order. The merge is bounded
  to observations of ONE stop, since records are not reliably cleared between stops and merging onto
  a stale one would back-date a fresh crash out of its own attribution window. A stop the container
  asked for (its idle reclaim, its shutdown RPC) records no exit, because that code is its own signal
  echoed back; the shutdown also clears the record, so it stays transient rather than outliving the
  run in a per-run Durable Object. And where a cause was recognised, the detail reports the mechanics
  of that stop rather than offering a second cause of death: a reclaim escalating to SIGKILL used to
  read as "most often an out-of-memory kill" directly under a verdict saying the container was
  reclaimed while idle. What this runtime cannot supply is a log tail: a Container's stdout goes to
  the deployment's Workers logs and no API returns it to the Durable Object, so the detail says where
  the output actually is rather than implying it was withheld.

  **Kubernetes.** The pod object outlives its workload (`restartPolicy: Never`), so the kubelet's
  account of the death was one GET away and never read. The 404 poll now reads `state.terminated`,
  falls back to `lastState.terminated` for a container between lives (where a crash loop's real
  cause sits), and adds the pod-level account on top rather than instead, since a kubelet eviction
  under node pressure names itself only there and the container never saw it. That account is read as
  two independent halves: the apiserver does not guarantee a machine-readable `reason` beside its
  prose, and gating the prose on the code renders an evidence-carrying pod as an empty detail. A pod
  that is GONE and a pod that could not be READ are reported as themselves, because an unreachable
  control plane must not read like a clean death.

  **The native host-process transport** was spawned `stdio: 'ignore'`, discarding both the exit code
  and the stderr the harness routes its warn/error lines to. It now keeps a bounded stderr tail
  (nothing is forwarded onward, so the developer's console is as quiet as before) and retains the
  last exit past the process handle, which is dropped before the poll that needs it. Because this
  backend outlives a run, the tail is attached only when the process serving a job is confirmed gone;
  a live process that merely forgot the job says so, the same rule the warm pool follows. "The
  process serving this job" is tracked as a generation rather than as "the process": one death evicts
  every concurrent job, and answering the first eviction re-dispatches, which spawns the replacement
  while the siblings have yet to poll, so without the pairing a sibling is told its harness is
  "still serving other local runs", which is a fact about a different process. The same tail is
  folded lazily into a dispatch that never got the harness healthy, so a harness that will not boot
  at all stops failing with a sentence that names only the symptom.

  Kernel gains `composePostMortem`, the one place the two obligations every such detail carries
  (scrub through `redactSecrets`, then cap and state what was dropped) are implemented, and
  `tailPostMortemMaterial`, which bounds BULK material from the other end: a log's value is at its
  end, so letting one reach the head-keeping cap unbounded keeps the boot chatter and drops the
  crash. The local runtimes' shared log shaping now bounds by characters rather than by lines only,
  which is what a `--tail 50` of an agent echoing a payload needs.

  Internal break: the per-run container's `recentEvictionCause` RPC is replaced by
  `recentStopObservation`, which answers both halves. Worker and container deploy together, so
  nothing spans the change.

- 882b94f: Feed the visual-confirmation gate from the designs a task links. The frames an import retained for
  a linked Figma/Zeplin document now populate the gate's actual-vs-reference gallery on their own, so
  a designer who linked a frame gets screenshot-vs-design comparison with no manual upload at all.

  A reference that was explicitly chosen for a view still wins: an upload is a deliberate act against
  that one task and survives every re-import, while a design render is a projection the next
  body-changing import replaces wholesale. So an upload assigns over the fold, and a view whose
  reference the capture itself named is left alone. Each pair now says which of the two it is showing,
  and says nothing when the capture named its own, because a reference the gate did not source is one
  whose provenance it can only guess at.

  A view name two designs both claim is qualified with its design on BOTH sides rather than just the
  second, the same rule the Figma import applies to a frame name repeated across pages: leaving the
  first bare would hand the plain name to whichever design is listed first, and re-ordering the links
  would then silently re-point a reviewed view at a different screen.

  The gate also states what the linked designs contributed whenever a design is attached, including
  when everything worked, so "no design is linked" stays distinguishable from "one is and it gave
  nothing". The latter carries a per-design reason, since retaining part of a design, failing to
  download it, having no frames at all, and having had nowhere to store them each ask for a different
  fix. That verdict is derived from what the artifact store actually holds rather than from the
  recorded render status alone, so any status claiming retention over an empty shelf reports the
  absence rather than describing a gallery that is not there. The gallery's ceiling on design views is
  shared round-robin across the linked designs instead of being spent in read order, and each design
  that loses frames to it is named, so a design the ceiling shut out cannot read as one with no
  frames.

  Gathering the pairs no longer confuses a gallery ROW with a captured screenshot. A reference-only row
  (a design frame, an uploaded mock) makes a pair too, so a run that captured nothing had been losing
  the warning that gates the gate's approve button behind an acknowledgement, reporting a verified
  gallery of blanks in its run outcome, and summoning reviewers to screenshots that were not there. The
  rule now lives once in `@cat-factory/contracts` and all three ask it.

  `BinaryArtifactStore` grows a batched `listByDocuments`, mirrored D1 ⇄ Drizzle with a conformance
  assertion and allow-listed for mothership mode, so a task linking several designs still costs the
  driver path one read.

### Patch Changes

- Updated dependencies [35bc18f]
- Updated dependencies [882b94f]
- Updated dependencies [f2ead2a]
  - @cat-factory/kernel@0.272.0
  - @cat-factory/contracts@0.274.0

## 0.149.0

### Minor Changes

- 6e07961: Retain a design document's rendered frames when it is imported. A Figma import now downloads the
  PNGs (the linked frame, or the first six top-level frames of a whole file) and stores them as
  `reference` binary artifacts keyed to the document, on the same shelf the visual-confirmation gate
  already reads from; a re-import that changes the body replaces the previous set wholesale. The
  download is host-pinned to Figma's signed-asset hosts and carries no credential.

  Renders ride a new `DocumentSourceProvider.fetchRenders` port rather than `fetchDocument`, and only
  run on an import that actually writes a body: a design file's version moves on any edit anywhere in
  it, so the dispatch-time freshness ladder re-fetches the text far more often than the pictures
  change.

  A new `documents.render_status` records what became of them (`stored` / `partial` / `none` /
  `failed` / `storage_unavailable`, or null where the question does not apply), because every way of
  ending up with no images is otherwise the same absence. It is derived from what was RETAINED, and
  counts the frames a provider's own cap excluded as unillustrated, so a six-picture pass over a
  twenty-frame file reads as `partial` rather than as a complete design with six screens. A
  deployment with no image storage configured imports the design textually and says so rather than
  downloading bytes it cannot keep; a settings read that FAILS is `failed`, not
  `storage_unavailable`, since telling an operator to configure storage they already have sends them
  to fix the wrong thing.

  A document's renders are exempt from the age-based artifact retention sweep. Age is the right
  lifetime for run debris and the wrong one for a projection of a live row: renders are replaced by
  the next import that changes the body and by nothing else, and an unedited design is never
  re-imported, so a clock-based sweep would leave the row claiming `stored` over an empty set with
  nothing to re-download them.

  Internal break: `binary_artifacts` rows and `documents` rows written before this change carry no
  document keying and no render status. Both self-heal on the next import; nothing needs a backfill.
  `BinaryArtifactMetadataStore.deleteByDocument` is replaced by `deleteByIds`: every id-scoped
  reclaim now names the rows whose bytes it has already removed, so a concurrent import's fresh row
  cannot be deleted out from under its blob.

### Patch Changes

- Updated dependencies [6e07961]
- Updated dependencies [9f9c240]
  - @cat-factory/kernel@0.271.0
  - @cat-factory/contracts@0.273.0

## 0.148.0

### Minor Changes

- 6c6dd0c: Bring the document and task source integrations to a mothership-mode node

  Every other connection surface reached mothership mode long ago: environments, observability,
  Slack, runner pools all store their credential as a sealed blob, so only ciphertext crosses the
  persistence RPC and the mothership opens it on request. The document-source and tracker connections
  were the last two outside that, and the reason was mechanical rather than a judgement about how
  sensitive a Figma or Jira token is. Their repositories decrypted INSIDE, which shuts both doors at
  once: a repository that decrypts can only be called by a key-holder, so proxying its read would have
  put a plaintext token on the wire, and it exposes no sealed field, so `/internal/secrets/unseal` had
  nothing to name either. That is why the prerequisite was always "give those repositories a
  sealed-blob read first, and only then a source-table entry".

  The row now carries its envelope. `DocumentConnectionRecord` and `TaskConnectionRecord` split into a
  stored `Sealed*Record` the repository persists and an open record the services read, with a new
  kernel port pair (`DocumentConnectionStore` / `TaskConnectionStore`) as the seam and one shared
  implementation over `createOrgSecretCipher`. All four repositories (D1 and Drizzle, documents and
  tasks) stopped decrypting and became ordinary sealed-blob stores.

  With that in place, `document_source_connection` and `task_source_connection` join the closed
  org-secret table, keyed by `(workspace, source)` under their own HKDF domains, and the persistence
  allow-list widens to the whole of both integrations: the connection repositories and the
  per-workspace source toggle, the document import/link writes and the role-link surface, and the task
  import/link writes including the atomic claim that holds one-task-per-ticket. Batched forms move
  with their point siblings rather than behind them, since `linkBlockMany`/`detachBlocks` are the same
  write as `linkBlock` and a claim whose import cannot land claims nothing.

  The store's surface is deliberately split by how much a caller needs opened rather than how much it
  reads. Listing summaries opens nothing, because a settings panel renders labels and opening a bag
  per connected source would turn one page load into a burst of unseal round trips and fail the whole
  list on the first unopenable row. Connecting and disconnecting read the summary for the same reason
  from the other direction: replacing or removing a connection is the remedy for a bag that has gone
  bad, so neither may be the call that needs the key.

  Dispatch-time document freshness now runs on a mothership-mode node. Its `credentials_unreadable`
  verdict stays a distinct gap and is worth more than it was: it no longer means "this deployment
  structurally cannot read the credentials" on every dispatch of every run, so its remaining causes are
  real faults. Its log line went back to `warn` accordingly.

  How many row identifiers a delegated unseal must carry is now declared once, in kernel's
  `ORG_SECRET_KEY_ARITY`, and enforced by the type system. It previously lived only in the server-side
  bindings table, which is the one part of a binding a caller has to get right and the one table a
  caller in `@cat-factory/integrations` cannot see. `DelegatedSecretRef` became a union over the source
  vocabulary, so a literal is checked against its own source's arity, and `orgSecretRef` is the door
  for a generic caller that never names a member. This matters more than it reads: a deployment with no
  delegate wired ignores the reference entirely, so a malformed one is invisible everywhere except the
  single deployment shape that delegates.

  Two behaviour changes worth knowing about. A credential bag that cannot be opened now raises instead
  of resolving to an empty bag, because an empty bag is indistinguishable from a connection saved with
  no credentials and every caller was re-deriving the difference from whatever the vendor said next. It
  raises a 503 carrying `reason: 'connection_credentials_unreadable'`, so the surfaces that genuinely
  cannot proceed refuse with translated copy rather than a generic server error. And the legacy
  plaintext `credentials` column fallback is gone: a row written before these tables were encrypted at
  all is no longer read as JSON and re-encrypted on the next write, so re-connect the affected source.
  Pre-1.0 internals break rather than grow a compatibility path, and keeping the fallback would have
  meant the unseal endpoint answering for a field that is sometimes not an envelope.

  Raising rather than emptying puts weight on WHO raises and to whom, so the failure is scoped to what
  actually failed. A batched open answers per source: the sources in one call are independent facts
  about independent vendors, and one rejection speaking for all of them would report a run's whole
  document corpus as unreadable because a single shelf entry drifted, or take the reply channel away
  from a healthy ticket because a different tracker's envelope went bad. Both read to an operator as
  the healthy sources being broken. A corpus-wide verdict is now reachable only when the stored-row
  query itself failed, where nothing about any source was learned.

  For the same reason, a surface whose job is to REPAIR an unopenable connection is not allowed to be a
  surface that needs the key. Re-connecting a tracker reads the old bag only to carry the
  platform-owned webhook secret across a vendor-credential rotation; refusing on that read left a
  workspace with no way out of a bad row at all, so it now degrades and says so, and the operator mints
  a fresh secret. Sealing rides the same delegation as opening, which is what keeps that from being a
  silent loss on a transient fault: a node that cannot reach its key service fails the write too, so
  nothing is overwritten. The setup check reports the fault as a verdict instead of failing, and the
  read-only webhook panel states it as a new `credentialsReadable: false` rather than reporting
  `configured: false`, which would send an operator to mint a secret over a bag that still holds the
  live one. Clearing the webhook secret still refuses, because clearing rewrites the bag minus a key
  and proceeding blind would replace the vendor credentials with an empty object.

- 70745b6: Link repositories, merge/pull requests and issues to the instance a workspace is actually
  connected to. A VCS connection (and each connect option) now carries `webUrl`, the browser-facing
  host derived from the provider's configured API base, and the SPA builds every repo link from it
  in the provider's own shape instead of hand-building `https://github.com/...`. A deployment whose
  API base does not name a host withholds those links rather than pointing at the provider's public
  instance. The source-control panel's pull-request vocabulary is provider-keyed, so a GitLab
  workspace sees merge requests.

  `AppConfig.gitlab` is now always present, shaped like its GitHub sibling: `apiBase` is the address
  of the instance a deployment talks to, and `enabled` alone carries the `GITLAB_TOKEN` opt-in for
  the single-token engine connection. Gating the whole config on that token had made the address
  unreadable on a deployment reaching GitLab any other way, so local mode's `GITLAB_PAT` shape got
  no links at all.

  Internal breaks, so a SPA build and a backend must be deployed together: `webUrl` is required on
  the connection and connect-option shapes, and `AppConfig.gitlab` is no longer optional.

### Patch Changes

- Updated dependencies [6c6dd0c]
- Updated dependencies [70745b6]
  - @cat-factory/kernel@0.270.0
  - @cat-factory/contracts@0.272.0

## 0.147.0

### Minor Changes

- 55310f6: Close the review findings on the start-from-design work, two of which made shipped features
  unreachable.

  **The document-source OAuth callback was default-denied.** `/documents` was not in the session
  gate's public allowlist, so Figma's browser redirect was refused before the callback could exchange
  its code: a vendor navigation carries no `Authorization` header, so the receiver was not gated but
  unreachable, and the whole OAuth connect worked only under `AUTH_DEV_OPEN`. The same omission was
  already live for the Linear callback at `/tasks`, which is why the fix is not another string in the
  list: the provider-facing receivers are now one exported list beside the workspace controllers, and
  a test derives both sides and refuses a mount that is missing from the allowlist. This class of bug
  reads correctly at the mount, at the handler, and in review, and shows up only against the live
  vendor on a redirect nobody can retry.

  **A grant with no stated expiry was treated as expired at the epoch.** `Number('')` is `0`, not
  `NaN`, so the guard meant to skip a credential bag that recorded no deadline never fired. Every
  resolution of a personal-access-token connection logged a permanent-outage warning, and every
  resolution of an OAuth grant whose token response omitted `expires_in` spent a refresh round trip
  and a write, on a path that runs for each step of every run.

  **A targeted spawn duplicated the modules it was told to reuse.** The targeted planner is shown the
  frame's existing module names and asked to reuse them; the write then created a new module per
  planned module regardless, so a plan that obeyed the instruction produced a second "Checkout" beside
  the first. The reuse is now computed rather than requested, matched case- and whitespace-insensitively
  because the thing being asked is a language model. A reused module is reported separately from a
  created one: folding them together would claim a write that did not happen, and dropping the count
  would report "0 modules" against a preview that showed three.

  Also: two stale-response races (the spawn preview's re-plan when the target frame is switched
  mid-request, and the pasted-link offer in the task form, where accepting a superseded offer attached
  a document no longer named in the description); a blur that swallowed the first click on
  **Continue** in the start-from-design modal, because clicking the button re-resolved the link and
  disabled the button before mouseup; and the OAuth spec/descriptor pairing a comment claimed was
  asserted, which is now actually asserted at registration, in both directions and over the scopes,
  since a half-declared source is silently either unreachable or a dead button.

- 55310f6: Make a linked design something a designer can actually start work from.

  Figma has been a document source for a while, and none of it was reachable by the person it exists
  for. Connecting meant minting a personal access token by hand. Attaching a design meant finding the
  Integrations hub, importing the page there, going back to the board, adding a task, and attaching
  it. Nothing on the board or the task form said "start from a design" at all, and every string on
  the way through said requirements, RFC or PRD. Expanding a design into board structure was worse
  than absent: the planner asks what architecture a document describes, which for a design is a
  service per Figma page.

  Four things close that.

  **OAuth connect.** A source can now declare an `authorization_code` half, and one shared flow runs
  it. The provider contributes four constants (two endpoints, a refresh endpoint or null, the scopes)
  and nothing else: no fetch, no token parsing, no credential mapping, so the second source to gain
  OAuth adds a declaration rather than a second copy of the flow. The credential bag is
  platform-owned, which is what keeps the token lifecycle out of every provider — a provider's whole
  share of it is noticing an access token in the bag it was handed. Declaring an OAuth half is
  deliberately NOT the same as offering one: running it needs an app the deployment registered, so
  the source listing answers "what this source supports" and "what this deployment can run" as two
  separate fields. Folded into one, a board with no registered Figma app would render a "Connect with
  Figma" button that can only 503.

  **A start-from-design entry on the board.** A frame-header button, and an offer on any Add-task
  description that links a page. Both ask only host-pinned sources, which is the safety property
  rather than an optimisation: a host-blind parser claims a shape, so asking Notion about a Figma
  link whose file key carries a UUID-shaped run gets a confident yes and stages the design into
  Notion's key space. The paste is resolved before anything is created, and a reference the parser
  had to WIDEN (Figma's own Copy link emits an unreadable id for any component instance, so the
  parser falls back to the whole file) says so on its own line, apart from the ordinary trim: "I
  attached this frame" and "I attached the entire design" otherwise render identically, and for a
  designer that widening is the defect.

  **Target-aware planning.** `plan` now asks one of two questions, with two different answer shapes:
  what architecture a document describes, or what work it implies inside a service that already
  exists. A targeted response that proposes frames is refused rather than re-read as modules, because
  a model proposing services where one exists has made a mistake and re-reading it would launder that
  onto the board. This is also what makes the `frameId` spawn safe to offer: flattening a board-wide
  plan into a frame discarded the frame titles and types the preview rendered, so the spawn produced
  something other than what was approved, while a plan authored for the target carries one frame that
  IS the target. Design documents require a target for the reason above.

  **Copy and a tour.** Connect copy that names designs, and a `start-from-design` tour in the launch
  arc rather than the catalogue-only half, gated on a design source being connected rather than on
  permission to connect one — that is the admin's job, and gating on it would withhold the tour from
  exactly the persona it is written for.

  Two compatibility notes. `DocumentBoardPlan` gains a required `targetFrameId`, and the OAuth
  install URL is admin-tier even though it only reads: what it hands back is the first half of a
  credential write, completed through a public callback where no tier can be checked.

### Patch Changes

- Updated dependencies [55310f6]
- Updated dependencies [55310f6]
  - @cat-factory/contracts@0.271.0
  - @cat-factory/kernel@0.269.0

## 0.146.0

### Minor Changes

- 17687a1: Let a headless provisioner say who a key acts for, and carry that onto the runs the key starts

  `POST /api/v1/keys` accepts an optional `externalIdentity`: an opaque string naming who, on the
  CALLER's side, the key acts for. An integration that mints one key per person (the Cloudflare OS
  gatekeeper of `docs/initiatives/cloudflare-os-gatekeeper.md` is the motivating consumer) could
  already get real per-user attribution, but only by keeping its own keyId-to-person table and
  joining it against every run it read. The field removes that table: the identity is echoed on the
  key resource, on `GET /api/v1/me`, and on both run projections (`publicRun`, `publicJob`) as the
  identity the run was started for.

  It is opaque in the strongest sense: stored verbatim, never parsed, never resolved against a user,
  never an authorization input. What a key may do is still its `scope`; what a run may do is still
  its pinned role and mode. Bounded at 200 characters and refused if it carries control characters,
  because it is echoed onto surfaces that later render it.

  The run's copy is PINNED at admission rather than resolved from the key on read, which is the
  decision worth reviewing. Revoking a per-user key is exactly what an integration does when someone
  leaves, and that must not erase who a finished run was for; pinning also keeps a page of runs from
  becoming a page of credential reads, and matches what the run already does with `initiatedByRole`
  and `mode`. It rides `agent_runs.detail` through the shared mappers, so a retry carries it forward
  (same work, same requester, whoever pressed retry) and the conformance case asserts it survives
  both the store round-trip and the key's revocation on each facade.

  A run's identity is not readable by every key. A key that carries an `externalIdentity` of its own
  sees the value only on the runs started for that identity; a key with none (the provisioner, or
  one a member minted in the app) sees every run's. Without the rule, the one-key-per-person
  deployment this feature is built for would hand each person's key the roster of everyone else, and
  the value is routinely an email. The run projections carry `externalIdentityWithheld` beside the
  value so a withholding is STATED: `null` already means "this run names nobody", and reporting a
  mapping the platform holds as one it never had is the failure the flag exists to prevent.

  Two smaller calls: the identity is never inherited from the provisioning key, since a provisioner
  mints for many identities and naming itself would attribute every run to the integration; and the
  field is offered on the headless mint only, because the session-authed create already records
  `createdByUserId`, an account the platform can resolve.

  The validation splits along what can be PUBLISHED. The shipped `pattern` refuses the C0 controls,
  DEL and the C1 controls, spelled with `\xHH` escapes because that is the one syntax ECMA-262, RE2,
  PCRE, Python and Java all read: the `\uHHHH` spelling this started with is a parse error in RE2 and
  PCRE, so it would have broken the Go client outright rather than rejected a value. U+2028 and
  U+2029 have no portable spelling at all and are refused off the schema, which makes the published
  pattern a necessary condition rather than a sufficient one.

  Additive on the public surface: one optional request field, one nullable field plus its
  withheld flag on the run projections, `null` being the correct answer for every key and run that
  predates it. New nullable `external_identity` column on both stores (D1 0086, Drizzle). OpenAPI
  `info.version` goes to 1.30.0 (1.29.0 was published by the dispatch-diagnostics change while this
  branch was in flight).

### Patch Changes

- Updated dependencies [17687a1]
  - @cat-factory/contracts@0.270.0
  - @cat-factory/kernel@0.268.0

## 0.145.0

### Minor Changes

- f0154ce: Let a GitLab-only deployment run the recurring bug-intake schedule and the interactive bug hunt.

  The GitLab task source could import an issue you pointed at and search the project a service frame
  was linked to, but neither of the two paths that PICK work by predicate: the recurring `bug-intake`
  schedule and the bug hunt. So a shop running GitLab for both code and issues could have its agents
  work in its repositories and still had to connect a second tracker to schedule anything.

  `GitLabIssuesProvider` now implements `searchIssues`, `listBoards` and `listBugCandidates`, all
  three riding the project-scoped issue read the earlier slice added: the scope is an ARGUMENT of the
  request rather than a qualifier in a query string, and GitLab returns the description, labels, age
  and note count in the same response, so a whole hunt scan is one call per page and never a
  per-candidate fetch. A schedule scopes itself with a new `gitlabProject` board field (its own leg,
  because a GitLab namespace nests and `owner/name` cannot express it) which the recurring-pipeline
  modal now renders.

  Two provider differences are stated rather than smoothed over. GitLab's issue search covers the
  description as well as the title, so a title-fragment predicate now rides a new `textIn: 'title'`
  narrowing: without it a schedule configured on a fragment would have started a pipeline on an issue
  that merely mentions it in its body. And `issueType` is ignored, as it already is on Linear:
  GitLab's own type vocabulary is `issue` / `incident` / `test_case` / `task`, which has no member
  meaning "bug", and `bug` is exactly what intake defaults the predicate to, so a GitLab intake
  narrows to bugs through a label instead.

  This also fixes a live mis-routing the previous slice opened: the bug hunt mapped a caller's board
  id onto the leg its provider reads with an `if`-chain that fell through to the opaque
  deployment-registered leg, so every GitLab hunt handed its project path to a field no built-in
  provider reads and reported an empty board. It is now an exhaustive record over the built-in
  vocabulary, so a fifth built-in source fails to compile until it names its leg.

  A predicate a source cannot evaluate is now declared rather than dropped in silence. GitLab and
  Linear both ignore `issueType`, and both intake forms rendered the field anyway, so an operator
  configuring a schedule saw a filter that was never applied: on an unattended `bug-intake` schedule,
  whose default is `bug`, that starts the bugfix pipeline on whatever is oldest and open. A provider
  now states its gaps on `TaskSourceProvider.ignoredIntakePredicates`, `TaskSourceState` carries them
  to the SPA, and the recurring-schedule and bug-hunt modals replace the field with what to narrow
  with instead. `intakePredicateSupport.test.ts` keeps a declaration honest by compiling each source's
  query with and without each predicate, so the answer is read off the compiler rather than restated
  beside it.

  Two GitLab-specific corrections ride along. The intake walk now pages on GitLab's own
  `Link: rel="next"` (carried out on the new `ProjectIssuePage`) instead of treating a short page as
  the last one: `max_page_size` is an instance setting an administrator can lower below the overscan
  size, and on such an instance every page is short, so the walk stopped after page 1 and reported a
  board it never finished as exhausted. And a walk whose workspace has no GitLab connection now
  refuses instead of returning an empty list, which the intake step renders as the cause of a
  no-pickup fire rather than as "no matching open issues".

  `ProjectIssuePage` replaces the bare hit array `VcsClient.searchProjectIssues` /
  `GitHubClient.searchProjectIssues` returned. Both are internal ports with one implementation.

- 2b74bd0: Let a mothership open the org credentials a mothership-mode node holds no key for

  Mothership mode splits the encryption keys on purpose: a laptop seals its own agent and model
  credentials under a local key, and the mothership's `ENCRYPTION_KEY` never travels. That split is
  what made every sealed-blob repository safe to serve over the persistence RPC, and it is also what
  left those blobs unreadable on the node. A row a hosted teammate wrote is sealed under the
  mothership's key, so a mothership-mode node could save an infrastructure connection and never
  provision with it, save a Datadog connection and never probe with it, and four earlier slices parked
  a surface rather than ship it broken.

  `POST /internal/secrets/unseal` and `POST /internal/secrets/seal` close that. The node names the
  ROW, never the ciphertext: it posts a source from a closed table plus the row's identifiers, and the
  mothership re-reads the authoritative row from its own store, binds the workspace to an account
  exactly as the persistence RPC does, and decrypts under its own key. A compromised node token can
  therefore only ask for a value it could already have read had it held the key, in an account it can
  already reach, which is what keeps this from being a decryption oracle. The seal direction matters
  just as much: a mothership-mode node provisions environments, and a row it sealed locally would be
  unopenable by the mothership's own teardown with nothing saying so until a reclaim failed.

  Consumers reach it through one kernel seam, `createOrgSecretCipher`. With no delegate wired (every
  hosted deployment, and local mode over its own Postgres) it is a pass-through to the facade's own
  cipher, so nothing changes there.

  With provisioning writes now safe to persist, `environmentRegistryRepository.insert`/`update` join
  the persistence allow-list, and so does `softDelete`, the tombstone half every re-provision and
  every reclaim runs. A mothership-mode node therefore provisions, polls and tears down environments
  for real, and the ephemeral-environment self-test runs end to end. Provisioning and teardown take
  the delegate together rather than separately: teardown opens the very provision fields provisioning
  sealed, so a node holding one and not the other could stand infrastructure up and never reclaim it.

  A mothership-mode node may not itself answer the delegation endpoints. They are wired only where a
  facade holds its own main database, because a node's `ENCRYPTION_KEY` is the local key that seals
  its own agent credentials, and sealing an org row under it is the split this change removes.

  Behaviour change worth knowing about on an existing mothership-mode node: rows it previously sealed
  under its LOCAL key are no longer opened locally. Pre-1.0 internals break rather than grow a
  compatibility path, so re-save an affected environment or observability connection; the key-drift
  sweep reports them.

  Deliberately still off, and stated in the tracker: the document/task source connections (their
  repositories decrypt inside, so there is no sealed field for a row-addressed unseal to name), the
  mothership-side Slack residual, and the sealed-blob consumers a mothership-mode node does not
  currently drive. Each is a table entry plus service threading on the same pattern, not a new
  mechanism.

### Patch Changes

- Updated dependencies [01bb6d2]
- Updated dependencies [f0154ce]
- Updated dependencies [eac67c5]
- Updated dependencies [2b74bd0]
  - @cat-factory/contracts@0.269.0
  - @cat-factory/kernel@0.267.0

## 0.144.0

### Minor Changes

- eaab22a: Register several NAMED outbound webhooks per workspace, instead of one that each integration overwrites

  `/api/v1/notification-webhook` was one endpoint per workspace, which made a second integration's
  enrolment a destructive act: registering it replaced whatever was already there, and the only symptom
  was that the previous receiver went quiet. `GET /api/v1/notification-webhooks` plus
  `GET|PUT|DELETE /api/v1/notification-webhooks/:webhookId` are the additive fix. The singular routes
  keep working unchanged and now address the reserved id `default`, which appears in the collection
  like any other entry, so the two surfaces are two views of one store rather than two stores.

  The endpoint id is CALLER-CHOSEN and `PUT` is idempotent by it. That is what the motivating consumer
  needs (a credential-holding front-end, the Cloudflare OS gatekeeper of
  `docs/initiatives/cloudflare-os-gatekeeper.md`): a Worker booting cold writes its own well-known id
  and is enrolled, whether or not it has ever run, with no id table of its own and no
  create-or-discover round trip it might be racing a second instance on. A server-minted id would have
  pushed exactly that state back onto the caller.

  Each endpoint carries its own sealed signing secret and its own three filters, and every rule the
  singular routes enforce holds identically: the `admin` floor, keep-on-omit in every field, the
  write-only secret, the SSRF guard at the write boundary and per redirect hop. Deliveries FAN OUT to
  every subscribed endpoint, concurrently but BOUNDED at six in flight, isolated per endpoint, and
  sharing ONE wall-clock budget. All three are deliberate: the caller awaits the fan-out on a run's
  terminal path, so serial delivery would make enrolling a second integration a latency cost on every
  run; six is the Workers ceiling on simultaneous connections, past which a `fetch` queues invisibly
  while the delivery's clock runs, so an unbounded fan-out reports failures it never attempted; and a
  shared failure path would let one permanently broken receiver mask every sibling's health. An
  endpoint the budget never reached is reported as not attempted rather than as a delivery failure.
  `deliveryId` is unchanged and carries no endpoint segment, because each receiver only ever sees its
  own copy.

  Watch for two things in review. `notification_webhooks` is re-keyed to `(workspace_id, id)` on both
  stores, and neither generator produces a migration that survives existing rows: the D1 side is the
  usual SQLite rebuild, and drizzle-kit's in-place `ALTER` adds `name` as `NOT NULL` with no default,
  so both are hand-healed (add nullable, backfill to `default` / `Default`, then constrain). And the
  per-workspace cap of 10 is a 409 `webhook_limit_reached` that bounds only what CREATES an endpoint,
  since disabling and deleting are the actions an operator at the cap needs. The cap is enforced in
  the STORE, because counting in the service and writing a statement later admits two racing
  enrolments, which is the access pattern this exists for: D1 gets it from one conditional upsert,
  Postgres from a transaction-scoped advisory lock per workspace.

  Additive on the public surface throughout: four new operations, and two new response fields (`id`,
  `name`) on a projection consumers already tolerate unknown members of. OpenAPI `info.version` goes to
  1.25.0 and all four SDK clients, the MCP facade and the gatekeeper bindings pick the operations up
  from the same generation pass.

### Patch Changes

- Updated dependencies [eaab22a]
  - @cat-factory/contracts@0.268.0
  - @cat-factory/kernel@0.266.0

## 0.143.1

### Patch Changes

- Updated dependencies [74ea2bc]
  - @cat-factory/contracts@0.267.0
  - @cat-factory/kernel@0.265.0

## 0.143.0

### Minor Changes

- 1c8df4a: Record what the agent's CLI said about the tool servers it loaded, beside what the dispatch decided

  A step's tool-server record has answered one question since it landed: what the platform wired for
  the agent, and what it withheld and why. It cannot answer the other one. A server that passes every
  check, resolves its credential, survives the budget and reaches the container can still fail to come
  up there: a vendor endpoint that 500s, a pinned `npx` package that no longer resolves, a token the
  vendor revoked between dispatch and launch. In every one of those the prompt promises the agent a
  tool that never exists, and the only evidence was the agent mentioning it in prose, if it noticed.

  The claude-code CLI announces its resolved session before its first model call, naming the MCP
  servers it loaded with a status each, plus the flat list of tools it will expose. The harness reads
  that one event and publishes it on the job view; the engine folds it onto the same
  `step.toolServers` record the dispatch wrote, and the step detail renders it on the existing chips.
  Both halves are kept, never merged into one status: the platform withholding a tool and the CLI
  failing to start one are different faults for different people.

  The distinctions this is built out of are the whole point, because each one reads as a healthy
  server if it collapses:

  - **Not observed is not "nothing was loaded."** Codex's CLI publishes no such report, nor does any
    image older than this one, nor a runner pool whose manifest does not map the field. All of them
    leave the record's observed half ABSENT, and the surface then says nothing at all rather than
    accusing every wired server on every deployment one release behind.
  - **Started-with-no-tools is not started.** A server that connects and exposes nothing reaches the
    agent exactly like one that was never wired, and every other signal about it says healthy, so a
    zero tool count gets its own sentence and an uncounted one stays absent.
  - **A status this build cannot map is not a fault.** The CLI's status words are a third party's
    vocabulary; an unrecognised one records as `unknown` and is rendered neutrally, because painting
    it red would send an operator to debug a working integration each time a CLI adds a word.

  Nothing branches on an observation: this is evidence for a person, not a control signal.
  Correspondingly it rides all three poll dispositions rather than just the live one — a job short
  enough to settle between two polls is never seen running, and a job that fails is the one whose
  post-mortem needs this most.

  Runner-pool operators who proxy the executor-harness verbatim gain
  `response.toolServersPath` on the manifest; leaving it unset costs the diagnostic and never
  produces a false one. Ships with runner image 1.95.0.

  On the public surface this is one additive optional field, `observed` on a step's `toolServers` in
  `GET /api/v1/debug/runs/:runId` (spec `1.24.0`), so a consumer written against the previous version
  parses everything it already knew. The one rule it has to carry across is the first distinction
  above: an absent `observed` is "no observation was made", never "the CLI loaded nothing".

### Patch Changes

- Updated dependencies [1c8df4a]
  - @cat-factory/contracts@0.266.0
  - @cat-factory/kernel@0.264.0

## 0.142.0

### Minor Changes

- 6637bbd: Add GitLab Issues as a task source: import, search and setup check.

  `gitlab` joins `BUILTIN_TASK_SOURCE_KINDS`, so a shop that runs GitLab for both code and issues can
  link an issue onto a board block as agent context instead of connecting a second vendor beside its
  repositories. `GitLabIssuesProvider` stores no credentials of its own: it reads through the
  workspace's existing GitLab connection, the same credentialless shape GitHub Issues has. The
  recurring `bug-intake` schedule, the bug hunt, push intake and ticket writeback are the remaining
  slices ([`docs/initiatives/gitlab-issues-intake.md`](./docs/initiatives/gitlab-issues-intake.md)).

  The public-API `TaskSourceKind` enum gains a member (OpenAPI 1.25.0, SDKs regenerated). Additive on
  a closed vocabulary the clients already tolerate unknown members of, so a consumer built against
  1.24.0 keeps parsing every response it understood.

  Four internal shapes changed, none externally consumed:

  - `VcsClient` / `GitHubClient` gain an optional `searchProjectIssues(connection, ref, query)`.
    GitLab's global issue search accepts no project qualifier, so a repo scope cannot be expressed as
    query text there the way GitHub's `repo:` does; the scope is an argument instead, and the
    predicates ride a `ProjectIssueQuery` the vendor evaluates.
  - `TaskSourceProvider.fetchTask` takes `workspaceId`. A GitLab PAT connection is keyed on the
    workspace, not on the account owning the project, so without it the provider could only scan
    every connection on the deployment for one able to read the id.
  - `TaskSourceProvider` gains an optional `repoScope`, whose PRESENCE declares the source
    repo-backed. One member rather than a flag beside a matcher, because the same fact decides two
    things that must agree: that the source's search is handed a resolved repository, and that the
    workspace's imported rows narrow to one.
  - `TaskSourceState` gains `supportsIntake` and `ridesVcsProvider`, both derived from the registered
    provider: whether it implements the predicate search a schedule fires, and which VCS connection
    it authenticates through (so the settings panel can name the right remedy for an unavailable
    source instead of inferring one).

  Two live bugs are fixed on the way. A workspace connected to GitLab reported **GitHub Issues** as
  available (availability keyed on a connection EXISTING rather than on its provider, and both live in
  one row per workspace), so the source looked connected and its import resolved an empty projection.
  And the recurring-schedule form offered every connected source regardless of whether its provider
  could search on a schedule, which saved a schedule that could never fire.

  Three surfaces that hard-coded `github` are now asked of the registry, which is what makes a
  FOURTH source work rather than merely exist: the search route resolves a repo scope for any source
  declaring `repoScope` (a repo-backed source refuses a null one, so GitLab search was 422ing on
  every query), the imported-issue list narrows every repo-backed source's rows to the service's own
  repository, and the issue-tracker settings panel renders one card per registered source instead of
  one hard-coded card per built-in.

### Patch Changes

- Updated dependencies [6637bbd]
  - @cat-factory/contracts@0.265.0
  - @cat-factory/kernel@0.263.0

## 0.141.2

### Patch Changes

- Updated dependencies [be9b8dc]
  - @cat-factory/contracts@0.264.0
  - @cat-factory/kernel@0.262.2

## 0.141.1

### Patch Changes

- Updated dependencies [1025674]
- Updated dependencies [e5f7eb0]
  - @cat-factory/contracts@0.263.0
  - @cat-factory/kernel@0.262.1

## 0.141.0

### Minor Changes

- 8cbd518: Let a code-registered prompt fragment name a LIVING document.

  A `documentRef` on a deployment-registered fragment used to be refused at boot, because every
  document source authenticated per workspace and there was no deployment-wide credential to read one
  with. A deployment now configures its own (`DOC_SOURCE_<SOURCE>_<FIELD>`, the field names taken from
  each provider's existing connect-form declaration), and a `builtin`-tier `documentRef` resolves
  through a new `DeploymentDocumentResolver` port, version-probed and cached under one
  deployment-wide group so a hundred workspaces folding one standard cost one fetch and one
  invalidation.

  The deployment's own credentials are read from the environment and nothing else. `DOCUMENT_SOURCES`
  governs which sources a WORKSPACE may connect, and `DOCUMENTS_ENABLED` and the connection encryption
  key govern whether tenant connections are stored at all; none of the three has any bearing on a
  standard the deployment configured centrally, whose credentials live in plaintext variables and are
  never persisted. So setting `DOC_SOURCE_NOTION_API_TOKEN` is the whole configuration, with no
  unrelated prerequisite to discover.

  `github` is the exception and it is declared, not inferred: its credential is a workspace's App
  installation, so the new `deploymentScoped` source trait is false for it and both boot validation
  and the provider refuse the scope. Boot now refuses only a `documentRef` this deployment cannot
  serve, naming which of the two causes applies.

  An unreachable source still degrades to the fragment's registered body, but no longer silently: the
  fallback logs a warning naming the fragment, tier and source, because the prompt is byte-identical
  either way and nothing downstream could otherwise tell a stale standard from a current one.

  In mothership mode the credential stays on the mothership and the node reads the resolved body over
  `POST /internal/prompt-fragments/document-bodies`.

  `DocumentSourceProvider.fetchDocument` / `probeVersion` now take `workspaceId: string | null`, where
  `null` is the deployment scope. An internal interface with no external consumers.

### Patch Changes

- Updated dependencies [8cbd518]
- Updated dependencies [8cbd518]
- Updated dependencies [7a2730a]
  - @cat-factory/contracts@0.262.0
  - @cat-factory/kernel@0.262.0

## 0.140.2

### Patch Changes

- Updated dependencies [f7882cf]
- Updated dependencies [e6aa37d]
- Updated dependencies [aabfb4d]
  - @cat-factory/contracts@0.261.1
  - @cat-factory/kernel@0.261.0

## 0.140.1

### Patch Changes

- Updated dependencies [9d6bce0]
  - @cat-factory/kernel@0.260.0

## 0.140.0

### Minor Changes

- 24f76f1: Make the audit log readable, and make revoking a session actually end it

  **Breaking for existing sessions: everyone signs in again once after this deploys.** A session
  token now carries a `gen` claim, and one that carries none is refused rather than admitted. That is
  the deliberate choice: treating an absent claim as "current" would be a permanent bypass of the
  whole revocation mechanism, and it is the hole an attacker would aim at. The cost is a single
  re-login; the alternative is a dual-read path that never goes away. Internal wire shape, pre-1.0,
  per the repo's compatibility policy.

  Two enterprise loose ends, and they are the same story from both ends.

  The audit log has been WRITE-ONLY in the product since it landed. Privileged actions were recorded
  faithfully and there was no way to read them back: no route, no viewer, and no retention, so the
  one table designed to be kept for years was also the one growing without a bound. It now serves a
  keyset-paginated page to account admins and renders in an admin panel, as translated sentences
  composed from the row's machine-readable fields rather than from stored prose — which is what lets
  a row written today read correctly for somebody in another language years later, and what makes an
  action this build no longer declares render as "unrecognised" instead of splicing `undefined` into
  an operator's screen. Names are resolved at render time in one batched read per page, and a name
  that no longer resolves stays null so the id shows: the person being gone is exactly the thing the
  row is kept to record. A failed READ is rendered differently from an empty log at every layer,
  because an audit viewer that reports an outage as "nothing happened" tells an admin the reverse of
  the truth. Retention arrives with its own knob (`AUDIT_EVENT_RETENTION_DAYS`, default 730 days),
  which is the governance half of keeping the log in its own store: it cannot be shortened as a side
  effect of tuning a telemetry window, and the prune takes a cutoff and nothing else, so it can never
  be used to remove the record of one inconvenient thing.

  The other end is enterprise SSO, whose whole offboarding promise is "we disabled them in the
  identity provider and they lost access". A stateless signed session could not deliver that: group
  membership was already re-read on every sign-in, so a removed person could not get a NEW session,
  but the one they were already holding stayed valid until it expired. Each user row now carries a
  session generation that every token is stamped with, so ending every session a person holds is one
  write with nothing to enumerate. An SSO sign-in the directory refuses now cuts their live sessions
  as well as withholding a new one; an admin can do the same for a member who has left or lost a
  laptop (recorded in the audit log, naturally); and anyone can sign themselves out everywhere.

  An SSO refusal only ends existing sessions when the DIRECTORY is what refused. A refusal caused by
  a claim that never arrived (a dropped `groups` scope, a renamed claim name, a provider that stopped
  marking an address verified) still blocks the login, but withholds the revocation: those refusals
  are indistinguishable from "removed from every group", and they fire for everybody at once, so
  treating them as offboardings would turn one configuration regression into a deployment-wide forced
  sign-out.

  Two decisions worth knowing. A role change deliberately does NOT revoke: the RBAC gate re-reads
  roles on the next request and the token carries none, so coupling them would sign a person out of
  every board because their role on one was adjusted. And the check is a NEW read on a path that
  previously touched no store at all — served through the app cache with invalidation on every bump,
  which means the Worker (whose isolates share no invalidation bus, so the entry passes through
  there) pays a real per-request read. That is accepted rather than discovered: a cache with a TTL
  would go on admitting a bearer a peer isolate had already revoked, and "they lost access, within
  the minute" is not the claim an offboarding story can make.

  Still open, and stated so nobody assumes otherwise: run start/stop/retry are not yet audited. That
  half needs the mothership to derive the row from what it observes rather than accept it from a
  node's say-so, since a node cannot be allowed to write events that name their own actor — the
  design question is written up in `docs/initiatives/audit-log-and-session-revocation.md`.

### Patch Changes

- 964cfa6: Decide a merge-preset guard where the row lands, against the role granted there

  Review of the cross-home reparent guard found the same mistake it was closing, one layer up: the
  guard resolved against the ACTING board. On a board that mounts a service homed elsewhere, that is
  neither where the row lands nor where the role that governs it was granted, and `blockRepository.get`
  is scoped by physical `workspace_id`, so a run can only ever resolve a block under its HOME. The
  acting board therefore answers the question only when it happens to be the home.

  Both halves now resolve at the home. The LIBRARY: `addTask` judges against the workspace the row is
  about to land in and `updateBlock` against the one it lives in. Judged at the acting board, a task
  in a mounted foreign service had both sides of the swap collapse onto the acting workspace's default,
  so the guard could not refuse anything: clearing a strict pin on such a task was the same escape the
  drag was.

  The ROLE: the editor now travels as a `BlockEditAuthority`, resolved per workspace, and each side of
  a comparison is read against the tier that side's workspace granted. `refuseRiskPolicySelection`
  takes two sides, each carrying its own actor; a same-workspace swap (the picker, a `riskPolicyId`
  patch) passes the same actor to both. One pre-resolved actor was wrong in both directions at once:
  an admin of a third board skipped the check on two homes where they are a plain member, and a
  member of it was refused on roles they hold nowhere the decision applies. A workspace the editor cannot
  see resolves to the unattributed editor, deliberately: with no tier there they can admit no run
  under its policies, and reading absence as "unrestricted" would refuse a move into a service they
  are not a member of, naming a sandbox nobody would have escaped.

  Three more findings from the same review:

  - The moved subtree was filtered to `level === 'task'`, exempting the `initiative` blocks that start
    their own planning chains and resolve a preset of their own. It reads the declared
    `BLOCK_LEVEL_RUNS_PIPELINES` now, a total `Record<BlockLevel, boolean>`, so a level that becomes
    runnable fails the typecheck until it is classified rather than being silently exempt.
  - The guard resolved each pinned preset with a point read per pick, re-reading each workspace's
    default alongside every one of them: the N+1 this repo bans. It reads each side's library once and
    resolves in memory through the same `resolveRiskPolicy` the engine uses, so a hundred-task module
    costs two queries. `RiskPolicyRead` takes a typed target rather than a cache-key string, which is
    what lets a preloaded reader answer without parsing a key prefix back apart.
  - A refused drag reached the user as untranslated English: the claim that the SPA's existing mapping
    covered it was wrong, since the only mapping was the picker's client-side one, worded for someone
    holding a control this person never touched. The reason now maps to `board.toast.moveRefused.*`,
    translated in all ten locales, with the backend's prose kept as the last resort.

  Compatibility: `refuseRiskPolicySelection`'s input shape and the `BlockEditActor` parameter on the
  board writes both changed. Internal only, so no migration path: neither is on the public API
  surface, and no persisted shape moved.

- Updated dependencies [24f76f1]
- Updated dependencies [964cfa6]
  - @cat-factory/contracts@0.261.0
  - @cat-factory/kernel@0.259.0

## 0.139.0

### Minor Changes

- ae44914: Let a person ask a document source whether the copy on the board is still the current one

  Runs re-confirm every linked document against its source at dispatch, so an agent no longer builds
  from whatever import happened to store. The person deciding whether to START a run still could not
  see any of it: the board showed a title and an excerpt frozen at import time, so "is the frame I
  just edited the one the agents will read" was unanswerable without opening Figma and comparing by
  eye. The imported-documents list and a task's context panel now carry the `syncedAt` stamp and a
  member-tier action that runs the same probe → compare → re-import ladder on demand, answering with
  the refreshed row and what the check concluded.

  The manual path drops the cached verdict before it asks, and that is the reason it is a separate
  entry point rather than a second caller of the batch one. The 60-second cache exists so a
  pipeline's worth of step dispatches costs one round trip per document and so a source that is down
  is remembered as down instead of being re-probed by every dispatch; both are exactly wrong for a
  click, whose commonest cause is that the last answer reported an outage. Served from the cache, the
  button would report the very failure the person is retrying past and no amount of clicking would
  clear it.

  What a click may leave BEHIND in that cache is asymmetric, and the asymmetry is the whole safety
  property. A success is stored, so the dispatches that follow a manual refresh inherit it. A failure
  is not: the entry has just been dropped, so re-filling it with whatever one click found would let a
  person retrying past a flaky source install an `unreachable` verdict every dispatch reads for the
  rest of the TTL window, degrading the run path with a failure no dispatch ever observed and
  renewing it with each further click. For the same reason a click never increments
  `document.freshness_gap`: that counter measures runs handed a copy the source has moved past, and
  one person clicking through an outage could otherwise move a deployment-wide rate as far as they
  have patience for.

  A moved REVISION is no longer reported as a changed document. `DocumentFreshness.confirmed` carries
  a three-member `change` where it carried a `reimported` boolean, because a whole-file source
  routinely moves its token without changing anything a reader sees: a Figma file's version bumps on
  any edit anywhere in it, including frames a given document does not cover. That case now says so
  (`revision_only`), and the write that records the moved token no longer moves `syncedAt`, which
  means "when the body was last written" and would otherwise put a fresh timestamp on bytes nobody
  changed. INTERNAL BREAK: the boolean is gone rather than kept beside the enum.

  `syncedAt` and the verdict stay two facts. The stamp is when the body was last WRITTEN, and a
  refresh that finds nothing changed writes nothing, so folding the check into the stamp would either
  claim a write that never happened or leave a confirmation sitting on a row the source has since
  moved past. An absent verdict therefore means "nobody has asked", never "unknown": listing
  documents deliberately probes nothing, because confirming costs a round trip per page and a
  board-wide sweep is a rate limit waiting to happen. Both facts are rendered WITH their time, since
  each is a claim about a moment in the history of a page someone else is still editing and a moment
  stated without its time is read as "now". A verdict is also scoped to the BOARD it was asked on: the
  same file can be imported into two of them, and a verdict keyed by source and id alone would render
  one board's confirmation against another board's row that nobody had checked.

  Two shapes worth noting for a reviewer. The freshness vocabulary moved from kernel to
  `@cat-factory/contracts`, since this is the point at which a human reads the same conclusion the
  agent does and the backend does not localize prose; kernel keeps the agent-facing renderer and
  re-exports the types, so nothing importing them changes. And the refresh route takes the narrow
  `DocumentSourceKind` rather than a stored row's wider origin, so an `upload` is refused at the
  schema: a 200 carrying "not applicable" would leave a caller unable to tell "this document has no
  source" from "the check ran and found nothing to compare", which is the distinction the whole
  vocabulary exists to keep.

### Patch Changes

- Updated dependencies [ae44914]
- Updated dependencies [4be3510]
  - @cat-factory/contracts@0.260.0
  - @cat-factory/kernel@0.258.0

## 0.138.3

### Patch Changes

- Updated dependencies [11dae5b]
  - @cat-factory/contracts@0.259.0
  - @cat-factory/kernel@0.257.0

## 0.138.2

### Patch Changes

- Updated dependencies [6076cf1]
- Updated dependencies [2fdb08d]
- Updated dependencies [11a2966]
  - @cat-factory/kernel@0.256.0
  - @cat-factory/contracts@0.258.0

## 0.138.1

### Patch Changes

- Updated dependencies [00bff05]
  - @cat-factory/contracts@0.257.0
  - @cat-factory/kernel@0.255.1

## 0.138.0

### Minor Changes

- ab0c228: A pasted document link is judged before the task is saved, not after

  Attaching a page to a task accepted whatever text sat in the picker's box. The only thing that ever
  checked it was the IMPORT, and the import ran after the task had been created, so a link the source
  could not read produced a task that already existed, carrying context it never got, with the verdict
  arriving as a toast over a closed dialog. A Figma share link is where this bit hardest, because the
  Copy link button emits a title segment plus `?p=` / `&t=` tracking params on top of the frame's node
  id: that whole string was staged verbatim, and a node id the parser cannot read degrades silently to
  the WHOLE FILE, so "I attached this frame" and "I attached the entire design" looked identical right
  up until an agent read the wrong thing.

  `POST /document-sources/:source/resolve-ref` is the fix's spine: `DocumentImportService.resolveRef`
  is `import` with the fetch removed, and `import` now goes through it rather than parsing again, so
  the pre-flight and the import cannot disagree about which refs are usable. It spends no upstream
  call and needs no connection, which is what makes it cheap enough for the picker to call as the user
  types. It answers the canonical form the reference will be stored under, including a `canonicalUrl`
  the provider rebuilds from the id (a new optional `DocumentSourceProvider.canonicalUrl`, implemented
  by Figma, Zeplin and Notion). That method is optional because the absence is a real fact rather than
  a gap, and the two shapes of absence are worth keeping apart: Confluence needs the connection's site
  base URL and Linear the workspace slug, while GitHub docs has everything but the HOST, which is a
  deployment fact (a GitLab-backed deployment reaches that source through the VCS adapter, so a
  `github.com` link built from the id would be wrong for it and presented as the supported form the
  paste was trimmed to). All of them answer null, and the id itself is the canonical form there, which
  callers must render rather than read as a failed resolution.

  A reference the provider could only parse by DROPPING the frame it named says so on its own field.
  `parseRef` falling back to the whole file is right (nothing knows which frame a complex instance id
  meant, and Figma's Copy link emits one for any component instance), but the fallback is invisible: a
  valid id, a valid canonical URL, and a "trimmed to the supported form" note that reads the same
  whether tracking params were dropped or the whole design was swapped in for one frame. The new
  optional `DocumentSourceProvider.droppedScope` carries the discarded qualifier as pasted, and the
  picker gives it its own warning line, because a trim and a widening are opposite facts.

  A refusal names WHICH correction it needs, as a closed `details.reason` vocabulary with two members
  rather than one. `document_ref_unrecognized` means no link of this shape will work here and carries
  the format that would; `document_ref_claimed_by_other_source` means the link is perfectly good and
  aimed at the wrong source, and names the claimant so the picker can offer to switch with the text
  unchanged. Collapsing them would tell someone who pasted a valid Figma frame URL into a Notion-backed
  picker that their link is malformed. Claimants are searched host-PINNED first, through the same
  `orderSourcesByClaimConfidence` the prose-URL canonicaliser reads rather than a second copy of its
  two passes: a blind parser claims a shape, so registration order deciding would point a design link
  at Notion, and a confidence rule living in two places gets refined in one of them. The quoted input
  goes through `redactSecrets`, since a pasted link routinely carries a `?token=` the error envelope
  would otherwise echo into the logs. Both reason codes reach `/api/v1` through the public task-create
  attachment, so the surface version steps to `1.19.0` and `public-api.md` names them.

  The SPA half is the other side of one rule, not a second copy of it: the picker asks the backend
  rather than restating any provider's parse, and shows the canonical form on the row it is about to
  stage, saying when it trimmed and, separately, when the reference is WIDER than what was pasted. Only
  the source's own refusal blocks a paste: a resolve call that FAILED leaves the reference unjudged and
  still stageable with the import as the backstop, and an unknown reason value falls into that same
  bucket, because reading a 502 or an older backend's vocabulary as "your link is wrong" is the
  misattribution this surface exists to avoid, and an outage that made attaching impossible would be a
  worse failure than the one being fixed. Fetching moved ahead of the create too
  (`useContextLinking().resolvePending`, used by both the add-task and create-initiative forms): every
  attachment is imported before the block is written, all failures are reported together rather than
  one round trip at a time, and nothing is created while any of them is unresolved, so the correction
  is made with the form still open. That raises the bar on saying WHICH attachment is at fault, so a
  failed fetch is marked on the staged chip itself and not only in the toast, and the add-task form's
  issue-body pre-fetch records its cause instead of swallowing it (a tracker reference has no
  `parseRef` to pre-flight, so that attempt is its pre-flight). What stays after the create is the LINK
  step alone, whose realistic failure is a document another task already holds.

  Reviewing: the interesting part is the split between "the source refused this" and "we could not
  ask", since only the first may be shown to a user as a bad link, and the parallel split between a
  trim and a widening. Worth checking too that the picker stages the RESOLVED external id rather than
  the pasted text (there is a round-trip test for it: a provider whose bare-id branch were stricter
  than its URL branch would refuse the very reference the pre-flight approved), and that a task is
  genuinely not created when an attachment cannot be fetched. Nothing about the description-paste path
  changed: a URL named in prose still resolves best-effort against the imported corpus and still
  degrades to an info log when it matches nothing.

### Patch Changes

- Updated dependencies [ab0c228]
  - @cat-factory/contracts@0.256.0
  - @cat-factory/kernel@0.255.0

## 0.137.2

### Patch Changes

- Updated dependencies [ee6ce7c]
  - @cat-factory/kernel@0.254.0
  - @cat-factory/contracts@0.255.0

## 0.137.1

### Patch Changes

- Updated dependencies [16576d6]
  - @cat-factory/kernel@0.253.0
  - @cat-factory/contracts@0.254.0

## 0.137.0

### Minor Changes

- 5202fb9: An agent now builds against the current design, and is told how to read it

  A linked document was frozen at import time. `probeVersion` existed on every provider and had exactly
  one caller (the fragment-library body cache); nothing on the run path ever looked at the source again.
  So a Figma frame edited after import fed every later run the old markdown, with the run reading as
  perfectly healthy. For a requirements page that is an annoyance; for a design under active iteration
  it means the agent routinely builds the previous revision.

  The linked-context resolution path now re-confirms each document at dispatch, through the kernel
  `LinkedDocumentRefresher` port. The cost model is the design, because that path runs per STEP: probe
  the source's version, compare it against the token the stored body came from, and re-import only what
  actually moved. That comparison needed something to compare to, which the row did not have, so
  `documents.source_version` is new. It is part of the idempotent-reimport comparison even though no
  agent reads it: a Figma file version bumps on any edit anywhere in the file, so leaving a stale token
  on an unchanged body would re-download the whole design on every dispatch, forever. NULL covers three
  cases that all mean "cannot be proven current" and all self-heal on one re-import: an upload, a
  source exposing no version, a row predating the column.

  Three things bound the cost, each a different half of it. The new short-TTL `linkedDocumentVersion`
  cache holds the OUTCOME of the whole ladder rather than the body or just the probe, so a burst of step
  dispatches costs one round trip per document, concurrent dispatches of one document dedupe onto a
  single download, and a source that is DOWN is remembered as down instead of being re-asked by every
  dispatch for as long as the outage lasts (a cache loader that throws caches nothing, which is why the
  failure is a value). It has no refresh window, since the load already is the check. The workspace's
  connection is resolved ONCE per pass for the whole corpus through a new batched
  `resolveConnections`, not per document and again inside each probe. And the per-document fan-out is
  bounded, because a task can attach a corpus budget's worth of Figma frames and each miss expands into
  chunked per-frame node reads. Coherence is invalidation plus the TTL: connect/disconnect drops the
  workspace group, a manual import drops that document's entry. The entry stays enabled on the Worker's
  isolate-safe profile, since an external version token is neither our own mutable state nor in need of
  a bus to heal.

  The ladder also has to CONVERGE, which took one non-obvious hop: `reimport` records the caller's
  probed token when the source's own fetch exposes none. A provider may resolve its version best-effort
  inside `fetchDocument` (GitHub docs' commit sha degrades to null on a rate-limited request) while its
  cheap probe still answers, so the row was left holding null, mismatched the probe on every future
  dispatch, and re-downloaded the whole document forever while reporting "this source has no revision"
  about a source that plainly has one.

  Freshness reaches the agent as a header line, and it is a three-way verdict rather than a boolean.
  `confirmed` contributes `Revision: <token>`, so "which revision did this run build against" is
  answerable from the checkout afterwards. `not-applicable` renders nothing: an upload has no source to
  trail, so a staleness warning there would invent a problem. `unconfirmed` warns and names which of
  four gaps applies, because "reconnect the source", "wait out the outage", "this source has no revision
  to compare" and "this deployment cannot read the credential" are four different fixes and one merged
  "unknown" sends the reader at the wrong one. The last of those is mothership mode, not a defensive
  branch: a node with no main database cannot read a connection sealed with the mothership's key, so the
  read fails permanently and by design, and calling that an outage would send an operator hunting a
  Figma incident that does not exist. One renderer serves both surfaces a document reaches (the
  materialised `.cat-context/` file and the in-prompt injection an INLINE kind gets instead of a
  checkout), because a judge or reviewer scoring against a stale design is the same failure as a
  container agent building from one, and an omitted note reads exactly like a copy that was checked.
  Every gap also increments the new `document.freshness_gap` counter, dimensioned by reason and source:
  each of these conditions repeats per dispatch while it lasts, so the log line answers "what happened
  to this run" and only a rate answers "is this spreading". The refresh still never throws, so a source
  outage costs the run a stale body and a stated warning rather than the run, and the readability
  refusal now runs on the refreshed records, since a page emptied since import is the case most worth
  refusing. That
  includes the REQUIREMENTS REVIEW, the first step of the default pipelines and the one a human signs
  off on, which resolves its attachments through the same refresher rather than reviewing the
  import-time copy while the coder two steps later builds from the current one. A deployment with no
  refresher wired gets no verdict at all rather than a synthesised one: it did not conclude these bodies
  are unverifiable, it never asked.

  Separately, the one fragment that tells an agent how to consume design context was selected by nothing.
  Its `appliesTo` selector is a management-surface hint the run path never drove, it is in no seed pin
  set, and basic mode hides the per-task fragment picker — so the standard case, a designer links a frame
  and starts a run, executed with a design context file on disk and no instruction anywhere to honour it.
  The engine now folds it whenever the run's resolved context carries a design-origin document. The
  trigger is the document rather than the block type, which the retired selector got wrong in both
  directions (it missed a design linked to an unlabelled task and fired on a frontend task with no
  design), and that selector is DELETED rather than left beside the new rule: the deterministic
  selector and the management surface still read it, so leaving it would keep labelling the fragment
  frontend-only while the engine folded it for anything carrying a design. It rides the normal fold, so
  a workspace override still wins and the two-tier brief/full verbosity still applies. The flag settles
  off the corpus read rather than off the finished linked context, so the fragment fold (an LLM call,
  when a standard needs condensing) is not serialised behind a live source probe on every dispatch.

  Two hygiene fixes ride along, both about a claim over a pasted URL. `makeDocumentUrlResolver` now
  consults host-pinned parsers before host-blind ones instead of in registration order: Notion's
  `parseRef` claims any UUID-shaped run anywhere, so registered first it stole a Figma URL whose file key
  carried one, and the point lookup then searched the wrong key space and found nothing — a linked design
  reaching the agent as no context at all. And the two source traits that decide these things
  (`isDesignSource`, `isHostPinnedSource`) live in contracts off one exhaustive `Record`, because the SPA
  has to label a design source too and the run path reads them where no provider is reachable.

  Reviewing: the refresh sits on the hot path of every dispatch, so the thing to check is the ladder's
  short-circuits (an unchanged design must cost one cached round trip and no download, a failed one must
  not be retried per dispatch, and the second dispatch after a re-import must do nothing at all) rather
  than the verdicts. The re-import running INSIDE the cache loader is the deliberate part: it is what
  lets one entry bound the expensive half and dedupe concurrent dispatches, and its consequence is that
  a caller which deduped onto someone else's outcome re-reads the row rather than labelling the body it
  already holds with a revision it does not carry. The `sourceVersion` column is nullable on purpose and
  a backfill would be wrong: an empty string cannot be told apart from a source that genuinely has no
  version, and the two get different treatment.

### Patch Changes

- Updated dependencies [5202fb9]
  - @cat-factory/kernel@0.252.0
  - @cat-factory/contracts@0.253.0

## 0.136.2

### Patch Changes

- Updated dependencies [e845d65]
  - @cat-factory/kernel@0.251.0

## 0.136.1

### Patch Changes

- Updated dependencies [4c071ec]
  - @cat-factory/contracts@0.252.0
  - @cat-factory/kernel@0.250.0

## 0.136.0

### Minor Changes

- c9adc67: Refuse a blind run: the harness now tells the backend which job-body capabilities it parses

  An image older than a body capability does not reject the field, it ignores it. For most of the
  job body that degrades honestly, but a CAPABILITY is different: the backend composes the PROMPT,
  so a dropped `mcpServers` leaves the agent reading "you have these tools, prefer them over
  guessing" with no client wired, and a dropped `skills` leaves a claude-code run told a playbook
  "is installed for this step" that was never written. The harness CHANGELOG has documented this
  twice as an operator hazard, both times ending at the same wall: the backend has no way to know
  what image a self-hosted runner pool pins, so it could not be gated server-side. A blind run
  rather than a failed one, and the run that most needs a signal produced none.

  The handshake is a list of body field names the image reports on `/health` and on its job
  ACCEPTANCE. The acceptance is where it matters: the dispatch site is the only place the body it
  just sent is still in scope, and the last moment before the agent starts working from a prompt the
  body cannot back up. `RunnerTransport.dispatch` therefore returns an optional ack, forwarded by
  every transport that can see the harness's own response.

  The answer is deliberately THREE-STATE, and the middle state is the whole design. An image that
  reported nothing is not an image that reported "not this": every image between the capability
  landing and the handshake landing serves it perfectly and reports no list, so folding the two
  would refuse those runs on no evidence. So `unsupported` (the image said it cannot) refuses the
  dispatch and stops the job the harness already started, as an `UnavailableError` whose
  `runner_image_capability` reason makes the step a `preflight` fault rather than a container that
  died; `unknown` proceeds and is REPORTED as the deployment's own blind spot, on a warn line and a
  `container.capability_unknown` counter that should decay to zero as pools update. A body carrying
  no capability says nothing at all, which is most dispatches.

  Refusing the step is only half of it: the harness begins work on acceptance, so a refusal that
  merely throws leaves a full agent pass running against the repository, free to push a branch and
  open a pull request for a step the engine already failed. The refusal therefore STOPS the job,
  through a new `RunnerTransport.stopJob` and a new harness `DELETE /jobs/{id}` that aborts one job
  and waits for it to settle before answering. Never through `release`, which is a reclaim and means
  something different on every backend: on a per-run container it happens to kill the job, on a warm
  pool member it hands the container BACK with the agent still working in it, and on a self-hosted
  pool with no `release` template it does nothing at all.

  Not every backend can PROVE the job died, so the outcome is reported rather than assumed and the
  failure message says which of four it was: `stopped` (nothing is still running), `requested` (a
  pool cancel was accepted but cannot be verified), `unsupported` (no cancel path exists), `failed`.
  The last three also increment `container.blind_job_not_stopped`, dimensioned by the outcome,
  because each is a different operator fix. A backend that owns the container always reaches
  `stopped`, since a graceful abort that fails escalates to destroying it; on the local warm pool
  that escalation is also what keeps a member whose job could not be aborted off the idle list, where
  it still answers `/health` and the next run would lease a container with a live agent and a live
  checkout in it.

  A runner pool gets the handshake only when its manifest MAPS it: `response.dispatchCapabilitiesPath`,
  one line for a pool that proxies `POST /jobs` verbatim. Deliberately not read by name, because
  `capabilities` is an ordinary word for a scheduler to use about its own runners (`["gpu","docker"]`)
  and reading one of those as the harness's answer would narrow to an empty list and hard-refuse every
  capability dispatch against a perfectly current image. Unmapped lands in `unknown`, which is honest
  about a control plane this backend knows nothing about.

  OPERATORS: this bumps the runner image to `1.93.0`. A pool on an older image keeps working exactly
  as before; it simply reports no handshake, so tool-server and skill dispatches there are counted as
  unverifiable instead of confirmed. To get the check on a self-hosted pool, map
  `response.dispatchCapabilitiesPath` to `capabilities` and declare a `release` template so a refused
  run can actually be cancelled.

### Patch Changes

- Updated dependencies [3fbc87e]
- Updated dependencies [c9adc67]
  - @cat-factory/contracts@0.251.0
  - @cat-factory/kernel@0.249.0

## 0.135.0

### Minor Changes

- 6ccc104: A linked design now reaches the agent as a design, not as a list of frame names

  Four fidelity holes made the Figma context file thinner than the design it described, and the
  worst of them was silent.

  A whole-file link fetched `/files/:key?depth=2`, which returns the pages and their top-level frames
  with NO children. The renderer builds each frame's layout from those children, so a whole-file
  import degenerated to frame names and sizes: no layout, no text, nothing an implementer could
  build from. Only a node link (one frame) ever produced real content. The file endpoint cannot fix
  this by asking for more depth, because it jumps from "no children" straight to "the entire
  document", which blows the response cap on any real file. So the `depth=2` read became an OUTLINE
  read and the frames it names are fetched as subtrees, chunked so an oversize response costs its own
  frames rather than every frame. A frame whose chunk fails still renders from the outline, and both
  the frame cap and the failed reads are named in a new `### Notes` section: a bounded import must
  not read as the whole design. The per-frame node cap now sits under an import-wide budget, because
  a per-frame cap alone bounds nothing about an import that fans out over a dozen frames.

  Each cap gets its OWN note, because they are not interchangeable. A DEPTH cut is local to one
  branch and the walk must carry on; a node or text budget is exhaustion and must stop. Conflating
  the two is what made a branch nested past the cap drop every later sibling of every ancestor, so a
  frame whose first branch was deep rendered as that branch alone (auto-layout nests past six levels
  routinely, so this hit ordinary frames). The caps also ask the reader for different things: link a
  sub-frame, or import fewer frames. A depth cut now names how many nodes it left below, so it cannot
  read as a leaf, and one cut leaves ONE marker instead of one per unwinding ancestor.

  Text caps are stated too, in the section as well as the notes. The renderer DROPS an empty section,
  so a frame whose text the import budget refused was byte-for-byte a frame that contains no text:
  the exact silence the rest of this change exists to break. Components and tokens are bounded as
  well, since both grow with the design SYSTEM rather than with the frames imported and the layout
  budget says nothing about them. The component cap ranks by instance count, computed from what was
  observed, so what survives is what the design leans on; the token cap sorts by the rendered order
  first, so "N not listed" points at the tail the reader can actually see is missing.

  The layout tree carried name, type and size only, so every colour, type ramp, radius and stack
  direction was left for the model to invent. Each node's line now carries those facts in brackets,
  bounded by the tree's own caps because they are the same lines.

  Tokens came only from the variables API, which is Enterprise-gated. On every other plan the 403 was
  swallowed and the section simply vanished, which reads exactly like a design that defines no
  tokens. The published styles the file already ships (the `styles` map joined to the fills and text
  styles of the nodes referencing them) are now the fallback, and `DesignContext.tokenOrigin` states
  which source produced the section. The two are never merged: a merged section could not say where a
  value came from, and the plan gate itself is now stated even when neither source produced anything.
  Zeplin's own best-effort token read reports its failures the same way, for the same reason.

  Components were a bare list of names. An instance is now named by its component SET, since a
  variant's own component name is its property assignment ("Size=Large") and identifies nothing on
  its own, and every variant and property the design uses folds onto that component's note. That is
  the signal "reuse the existing component" needs to match against repo code.

  Zeplin's screens read asks for one more screen than it renders, so that a project with more screens
  than we import is detectable at all: asking for exactly the render cap makes a full page and a
  truncated one identical, which silently dropped the cap note in the one case it exists for.

  Watch the corpus budget when reviewing: richer renders mean larger bodies, and linked-context
  delivery is load-bearing (`context_documents_over_budget`). The cap constants carry the arithmetic
  that sizes them against it, so raising one means redoing that arithmetic rather than picking a
  bigger number. Every cap states what it dropped rather than shortening in silence.

## 0.134.1

### Patch Changes

- Updated dependencies [e7e27ee]
  - @cat-factory/contracts@0.250.0
  - @cat-factory/kernel@0.248.0

## 0.134.0

### Minor Changes

- eee42e9: Stop the parked-review question comment promising answer channels that do not work.

  Both faults are in the one line the whole comment exists to deliver, and both were invisible to the
  reader who would follow it: the bug REPORTER, who came in through the ticket and has no other
  surface.

  - **The API path it printed was a 404.** The comment said
    `POST …/decisions/requirements/items/<id>/reply`; the surface serves `…/findings/:itemId/reply`.
    The path now comes from the route contract's own `pathResolver`
    (`replyPublicRunFindingContract` / `replyPublicRunClarityFindingContract`), so the comment and the
    router cannot disagree again. The assertion that should have caught this had copied the same
    mistake, so it is now derived from the contract too.
  - **It offered a ticket reply where one cannot arrive.** The inbound path fails closed without a
    minted per-connection webhook secret, so a workspace that connected a tracker and imported tickets
    without ever minting one got a comment telling its reporter to type `@cat-factory answer …` at
    nothing. `IssueWritebackService` now establishes the fact from `taskConnectionRepository` (once per
    DISTINCT source across the block's linked issues, so several issues on one tracker cost one read)
    and the renderer offers only channels that work. Absent or unreadable counts as UNWIRED, because
    guessing the other way is the failure itself; the drop is logged once per claimed post with the
    operator's remedy.

  Two smaller corrections in the same area:

  - **A finding id from the OTHER review on the ticket is named as that**, not as a finding that does
    not exist. One ticket now carries both reviews' question comments, so answering both sets in one
    comment is the ordinary mistake; `no finding X` told a reporter an id printed on their own ticket
    was not real, where the true reason has a remedy. A typo still reads as a typo.
  - **`TrackerWebhookService.resolveReview` drops its single-candidate short-circuit.** The general
    tie-break chain already answers the one-review case, so the fast path only created a second route
    that could answer differently from the first.

  Also: `check:openapi` now distinguishes an ABSENT artifact from an unreadable one, since
  `pnpm gen:openapi` fixes the first and does nothing for the second.

  Breaks (both unreleased): `renderReviewQuestionsComment` takes a required `ReviewQuestionChannels`,
  and `IssueWritebackServiceDependencies` gains an optional `taskConnectionRepository`. Both facades
  pass it inside the block they already gate on that repository, so the wiring stays symmetric.

## 0.133.0

### Minor Changes

- 53cd697: Close three holes in `/api/v1` around a run that stops.

  - **A bug-triage question is now answerable from the ticket it was asked on.** The clarity gate's
    park echo rendered its findings as bare prose, so the ticket-comment reply grammar (which
    addresses a finding by id) could never reach it. Both review subjects now ride one id-carrying
    post path, and a comment naming a clarity finding drives the clarity review through the same
    service methods the app calls.
  - **`decisions: []` no longer means "we cannot say".** The decision list carries `unanswerable[]`,
    naming each wait this surface cannot answer — a human-review gate, a gate the deployment
    registered itself, an interviewer wired nowhere — with where its answer actually lives. It lists
    only waits that are live and genuinely beyond this surface: a finished run names nothing, and a
    wait the same response answers (a deployment gate that exhausted onto an ordinary approval) is
    never reported as one nobody here can answer.
  - **`GET /api/v1/me`** reports what the calling key may do, and **`GET /api/v1/openapi.json`**
    serves the deployment's own spec.

  Internal break: `IssueWritebackProvider.postQuestions` is gone (folded into `postReviewQuestions`,
  which now takes a subject), and `TrackerWebhookService` takes `reviewGateways` per subject in place
  of the single `reviewGateway`.

### Patch Changes

- Updated dependencies [53cd697]
  - @cat-factory/contracts@0.249.0
  - @cat-factory/kernel@0.247.0

## 0.132.0

### Minor Changes

- 6d3f784: Local mode takes its source-control token from the sign-in screen

  A local deployment with no `GITHUB_PAT` / `GITLAB_PAT` used to send a developer to the right
  token page and then have nowhere to put the result: the token had to go into `.env`, followed by
  a restart. The sign-in screen now accepts it directly, and it becomes the deployment's own
  credential (sealed on the machine under `ENCRYPTION_KEY`), live for the next dispatch, gate probe
  and repo read. `.env` still wins where it is set, and closes the browser flow.

  `@cat-factory/server` additionally exports `githubRepoOrigin`, the clone origin a dispatch already
  fell back to, so a facade whose own resolver handles only the non-GitHub case can delegate the
  GitHub half instead of restating the URL.

  Internal breaks in the affected packages: `VcsIdentityEntry.configuredToken` and
  `CoreDependencies.sharedStackCloneToken` are now getters, `buildGitLabEngineClient` takes a token
  or a getter, and the local facade's `createLocalGitHubClient` / `createLocalGitLabClient` take a
  token getter and always return a client (an unconfigured deployment REFUSES on use, naming the
  fix, rather than presenting no client at all).

### Patch Changes

- Updated dependencies [6d3f784]
  - @cat-factory/kernel@0.246.0
  - @cat-factory/contracts@0.248.0

## 0.131.1

### Patch Changes

- Updated dependencies [0937581]
- Updated dependencies [250b7dc]
  - @cat-factory/contracts@0.247.0
  - @cat-factory/kernel@0.245.0

## 0.131.0

### Minor Changes

- ec96387: Account audit log, slices 1 and 2: privileged tenancy actions are now recorded, with the store and the
  first real writers landing together.

  Until now nothing left a record of who did what: role changes, budget edits, invitations sent and
  revoked, board roster changes and access-mode flips all happened with the resulting STATE as the only
  evidence. `audit_events` (D1 ⇄ Drizzle, cross-runtime conformance) is an append-only log of them,
  written at the point each mutation commits, and the tenancy services in `@cat-factory/workspaces` are
  the first writers: account member add / role change, account budget and settings edits, invitation
  create / revoke / accept, and the workspace roster's add / role change / remove / access-mode flip.

  Four decisions worth knowing, because each has a wrong-looking alternative that reads as correct:

  **It gets its OWN store, and not for the reason telemetry has one.** An audit log looks append-heavy
  and therefore telemetry-shaped, but it is the mirror image: low-volume (admin actions, single digits
  per account per month, against telemetry's row-per-LLM-call) and long-retention where telemetry
  prunes at three days. What makes it a storage question is the run-lifecycle slice, after which this
  becomes the only table in the platform that grows monotonically with run volume AND wants a
  multi-year window; on a store with a hard 10 GB per-database ceiling that would put a years-deep
  trail in competition with live transactional state. Measured at ~500 B/row on Postgres (the index
  costing as much as the data, since the keyset carries `id` as its tie-break), so 1,000 runs/day is
  ~550 MB/year. It is a required `AUDIT_DB` D1 database on Cloudflare and an `audit` Postgres schema on
  Node. It is emphatically NOT in the telemetry store: that bucket is written and read on the LAPTOP in
  mothership mode, which would scatter the trail across nodes and leave it readable and deletable by
  the person it audits.

  **OPERATOR ACTION on Cloudflare**: `AUDIT_DB` is required, so a deployment must provision it
  (`wrangler d1 create cat_factory_audit`, then paste the id into its `wrangler.toml`;
  `db:migrate:remote` applies `audit-migrations` alongside the other lineages). Required means
  required, and not softly: the container build refuses an unbound binding, so a Worker deployed
  without it answers the misconfiguration screen on every request rather than running silently
  unaudited, and `/ready` reports `audit` so an operator reads which binding is missing. Per-PR preview
  environments provision and tear the database down automatically.

  **A row states VALUES, never a sentence.** An event carries `action` plus machine-readable
  `details` (`{"previousRole":"viewer","role":"admin"}`), and the viewer composes its copy from
  translated keys. Recording a ready-made English summary is the tempting shape and is wrong here for
  a reason peculiar to this store: rows are kept for years, so prose written today could never be
  re-rendered for a reader in another locale, and a persisted shape cannot be quietly changed later the
  way a wire shape can. `AUDIT_ACTION_DETAIL_KEYS` in contracts names each action's fields, so the
  writer and the viewer agree about the slots and a new action cannot ship with values the copy has no
  place for. For the same "closed but persisted" reason `targetType` is a picklist rather than a free
  string, and both vocabularies read back through guards derived from their own picklists: a member
  retired from the union arrives NAMED as retired (`{ retired: 'account.seat_reassigned' }`), never
  guessed onto a current member and never dropped, since a missing row is the one failure an audit log
  must not have.

  **The actor is a discriminated principal, and `system` is asserted rather than defaulted.** `user`,
  `apiKey` and `system` are three kinds, not a nullable user id, because "the engine did it" and "we
  lost track of who did it" are different facts and a log rendering them identically misattributes a
  human action to automation. Where no acting user resolves (only reachable under `AUTH_DEV_OPEN`, where
  the whole authorization model is bypassed) NOTHING is recorded rather than an event blaming the engine.
  `apiKey` is separate from the user who minted the key, so a leaked key is not indistinguishable from
  that person in the log.

  **`record` cannot FAIL the action it describes, but it is awaited.** The append runs behind
  `runBestEffort`, so a store outage costs the audit row and logs a warning, never the membership change
  the operator asked for. It is deliberately not fire-and-forget: an un-awaited write is discarded when
  a Worker isolate freezes after the response (the rule `http/waitUntil.ts` exists to state), so
  `record`-and-return would have recorded nothing on the primary runtime while every test driving a fake
  recorder went on passing. One store round-trip is worth strictly more than the milliseconds it costs
  an admin action. The READ has the opposite disposition and propagates: a viewer silently rendering an
  empty page when the store is down tells an admin the exact opposite of the truth.

  `CoreDependencies.auditRecorder` is REQUIRED, joining `logger` and `operationalMetrics` for the same
  reason and with the sharpest version of it: an un-wired audit log reads as "nobody changed anything",
  which is precisely the assurance it exists to give. A deployment that does not persist audit events
  passes kernel's `noopAuditRecorder`, which says so in code.

  INTERNAL BREAK: `WorkspaceMemberService.setRole`, `.remove` and `.setAccessMode` each take a trailing
  `actingUserId: string | null`, matching `.add`'s existing shape. Without it those three writes had no
  actor to attribute, and defaulting them to `system` would have been the misattribution above.
  `@cat-factory/server`'s controller supplies `c.get('user')?.id ?? null`.

  Still to come on this initiative: the paginated read endpoint and the admin viewer UI, run-lifecycle
  and API-key events, session revocation, and the retention sweep (so the table is unbounded until that
  slice lands).

- 4e4d1b4: OAuth for external MCP tool servers, so the OAuth-first hosted ecosystem (Linear, Atlassian,
  Figma, Slack's remote server) is reachable at all. A remote (`http`) declaration may now carry
  `oauth`: the `authorization_code` grant, which a `secrets.manage` holder completes once per board
  from the Infrastructure window, and `client_credentials`, which needs no human and covers an
  internal or partner server. Endpoints are discovered per the MCP authorization spec (RFC 9728 →
  RFC 8414 → OIDC discovery) with a declaration override, PKCE and the RFC 8707 `resource` indicator
  are always used, and the grant is sealed per (workspace, server) and refreshed on the dispatch
  path. The access token rides the job body's header channel only, never a prompt or the telemetry
  snapshot.

  Two new unavailability reasons (`oauth_not_connected`, `oauth_token_failed`) and the matching probe
  verdicts keep "nobody connected", "the connection stopped working" and "no credential configured"
  apart, since each sends an operator somewhere different. New table `mcp_oauth_grants` on both
  runtimes (D1 migration 0082 ⇄ a Drizzle migration), in the mothership `remote` bucket and in the
  workspace-delete cascade. Interactive grants need `MCP_OAUTH_REDIRECT_URL` set to the deployment's
  public app URL followed by `/mcp-oauth-callback` and `ENCRYPTION_KEY` for the sealed store; without
  either, an OAuth server is stated to its agent as unavailable rather than dispatched without a
  token.

  The vendor's redirect lands on the SPA, which re-presents the `code` and `state` to a session-gated
  `POST /mcp/oauth/complete`. A backend route receiving the redirect directly could not be gated:
  sessions are bearer tokens and a third-party browser navigation carries none, so it would have to
  sit outside the default-deny session gate, and the "same user who started the flow" and "still
  holds `secrets.manage`" checks would never execute. Routing it through the app is what makes both
  enforceable.

### Patch Changes

- Updated dependencies [ec96387]
- Updated dependencies [7f5ed08]
- Updated dependencies [4e4d1b4]
  - @cat-factory/contracts@0.246.0
  - @cat-factory/kernel@0.244.0

## 0.130.2

### Patch Changes

- Updated dependencies [10e7a15]
- Updated dependencies [ca213b1]
  - @cat-factory/contracts@0.245.0
  - @cat-factory/kernel@0.243.1

## 0.130.1

### Patch Changes

- Updated dependencies [d69115d]
  - @cat-factory/contracts@0.244.0
  - @cat-factory/kernel@0.243.0

## 0.130.0

### Minor Changes

- 3857ea4: Close the merge-preset selection escape hatch in the role-scoped merge policy

  ADR 0037 sandboxes a role's runs (`dryRunRoles`) and narrows what they may auto-merge
  (`classRulesByRole`), reading both off the merge preset the TASK selects, and concluded that a
  sandboxed member cannot un-sandbox themselves because editing a preset is admin-tier. That covered
  only one door. Which preset a task is under is `riskPolicyId` on the block patch: a plain
  `board.write`, member tier, on the same board. Re-pointing the task at a preset that sandboxes
  nobody was one PATCH or one click in the inspector's picker, and authoring a new task straight onto
  one was the same escape a door along, since a task that picks nothing is governed by the workspace
  default. Both built-in presets ship with empty `dryRunRoles`, so an open preset is always to hand.

  Gating preset selection behind `settings.manage` was the obvious fix and the wrong one: the preset
  library exists to be chosen from per task, and taking that from members would make every preset
  admin-only on deployments that authored no role policy at all. So the fix applies the feature's own
  narrow-only property one level up: a selection may not drop a restriction the SELECTOR's own role
  was under, either the sandbox or a class rule the ROLE LAYER narrowed. It deliberately does not
  compare the presets' base policy (ceilings, `autoMergeEnabled`, `classRules`), which says the same
  thing to every tier, so on a workspace whose presets treat every initiator alike, which is every
  built-in, the guard cannot refuse anything and selection behaves exactly as before.

  Worth reviewing: the refusal binds at `BoardService`, not in a controller, because `riskPolicyId` is
  writable at creation AND by patch and the escape is whichever door a caller reaches for. The rule
  itself lives in `@cat-factory/contracts` so the SPA's picker disables an option the engine would
  refuse rather than offering it and returning a 403. `resolveMergeClassRule` /
  `resolveRoleScopedMergeClassRule` moved from kernel to contracts for that reason; the engine imports
  them from there now.

  Internal break, per the pre-1.0 rule: every board-write entry point now requires the acting
  `BlockEditActor`. `BoardService.addTask` / `updateBlock` / `addServiceTask` and the `BoardWritePort`
  they satisfy, plus the methods that write blocks on a caller's behalf: `TaskLinkService`'s
  `createTaskFromIssue` / `spawnEpic`, `DocumentLinkService.spawn` and `BugHuntService.adopt`. Required
  rather than optional so a new call site cannot inherit an exemption from a default.

  The reason it reaches that far is the part worth reviewing. A service that hardcodes
  `UNATTRIBUTED_BLOCK_EDITOR` inside itself exempts every route above it while looking correct at the
  call site, which is how filing a tracker issue, spawning an epic, spawning a document's structure
  and adopting a hunted bug were all member-tier writes made under no tier. So the decision moves to
  the layer that can answer it: the acting tier is a fact about the REQUEST, services take it and
  never invent one, and `blockEditActor.coverage.spec.ts` classifies each site that NAMES an actor
  (rather than each site that calls a board write, which is what missed those four) as attributed or
  deliberately unattributed with a reason. None of them can carry a merge preset today, so there is no
  behaviour change; the point is that the next one to gain the field is judged rather than exempt.

### Patch Changes

- Updated dependencies [f775c1d]
- Updated dependencies [bac6776]
- Updated dependencies [3857ea4]
  - @cat-factory/kernel@0.242.0
  - @cat-factory/contracts@0.243.0

## 0.129.1

### Patch Changes

- 7cf3e70: Refresh the dependency tree and re-roll both runner images.

  **Registry deps** (direct ranges plus a full lockfile re-resolution, so transitives move to the newest
  release each declared range already admits):

  - **AI SDK family** (held to the major that pairs with `workers-ai-provider`): `ai@^7.0.47 → ^7.0.51`,
    `@ai-sdk/anthropic`/`@ai-sdk/openai@^4.0.27 → ^4.0.29`, `@ai-sdk/openai-compatible@^3.0.20 → ^3.0.22`,
    `@ai-sdk/provider@^4.0.4 → ^4.0.5`, `@ai-sdk/amazon-bedrock@^5.0.40 → ^5.0.42`.
  - **Runtime deps**: `hono@^4.12.33 → ^4.13.0`, `@hono/node-server@^2.0.12 → ^2.1.0`,
    `pg-boss@^12.26.4 → ^12.27.0`, `undici@^8.9.0 → ^8.10.0`, `ws@^8.21.1 → ^8.21.2`,
    `@aws-sdk/client-s3@^3.1101.0 → ^3.1102.0`, `nuxt@^4.5.0 → ^4.5.1`.
  - **Tooling**: `oxlint@^1.76.0 → ^1.77.0`, `oxfmt@^0.61.0 → ^0.62.0`, `publint@^0.3.22 → ^0.3.23`,
    `vitest@^4.1.8 → ^4.1.10`, `@cloudflare/workers-types@^5.20260801.1 → ^5.20260804.1`.

  **Runner images** (`@cat-factory/executor-harness` 1.92.1, `@cat-factory/deploy-harness` 0.2.10, with
  all six pinned tags synced):

  - Executor: Claude Code `2.1.220 → 2.1.221`, and the two lockstep Pi extensions
    `rpiv-todo`/`rpiv-web-tools` `2.3.1 → 2.4.0`. Pi stays at `0.83.0` and Codex at `0.146.0`, both
    already the latest. Claude Code `2.1.222` exists but was published inside the release-age window, so
    `2.1.221` is the newest version the supply-chain rule admits.
  - Deploy: `kubectl v1.36.3`, `helm v4.2.3` and `kustomize v5.8.1` are all already the latest, so the
    image moves only for the base re-pin below.
  - Both: the `node:26-trixie-slim` base re-pinned to the current multi-arch index digest.

  No `minimumReleaseAgeExclude` entries were added: every version above already satisfies the gate.

  **Majors**: none were available this sweep except `typescript@6 → 7` for the frontend, which stays on 6
  for the same reason as last time. `vue-tsc@3.3.9` still resolves its compiler through
  `require.resolve('typescript/lib/tsc')`, and TypeScript 7's `exports` map publishes no such entry, so
  the frontend typecheck would fail to resolve at all.

- Updated dependencies [7cf3e70]
  - @cat-factory/kernel@0.241.1

## 0.129.0

### Minor Changes

- e7867db: Run evidence and key provisioning on `/api/v1`, and a trajectory link on the PR report

  Everything the platform captured about a run was reachable only from a browser session. A consumer
  whose job is to JUDGE a run (a trial harness deciding whether to accept a change, an evaluation
  pipeline scoring a fleet) could scrape the fenced JSON block out of a pull-request body and read
  `/api/v1/debug/*`, and that was all: the captured screenshots were unreachable, and a run with no
  pull request (a headless job, a run that failed before it pushed) had no evidence surface at all.
  Getting a key at all still needed a browser.

  Three additions, all `/api/v1`:

  - **`GET /runs/:runId/report`** serves the engine's verification report: the SAME bundle it writes
    onto the pull request, composed on read by the same code, so the two can never disagree about
    what a run proved. It answers for runs that never opened a pull request, and it does not consult
    the `publishPrVerificationReport` opt-out, which is a statement about writing onto someone else's
    pull request rather than about reading your own evidence back.
  - **`GET /runs/:runId/artifacts`** and **`GET /artifacts/:artifactId/blob`** list a run's captured
    artifacts and stream their bytes, at `read` scope, with the content type clamped to the image
    allow-list exactly as the session-authed route does. An account with no blob backend gets a 503,
    never an empty list. The blob operation declares every media type it can answer with (the image
    allow-list plus an `application/octet-stream` fallback) rather than one standing in for the rest,
    so a client generated from the spec can switch on the response honestly.
  - **`GET|POST|DELETE /keys`** provisions keys headlessly at `admin` scope. Two enforced bounds make
    that safe: a key minted here can never reach the `admin` rung minting requires (so the chain is
    one link long), and revoking a key now revokes every key it minted, on this surface and in the
    app alike. Otherwise a leaked provisioning key would survive its own revocation.

  Refusals across the three evidence reads carry `error.details.reason`, so causes needing different
  reactions stay apart: `run_not_found`, `artifact_not_found`, `artifact_blob_missing` (the row
  outlived its bytes, which is a storage fault rather than a bad request) and
  `binary_artifact_storage_unconfigured`.

  The **PR verification report** gained the links a machine needs: `observability.trajectoryUrl` (the
  run's tool calls in the order the agents made them) and `observability.reportUrl` (this report,
  served live), both rendered in the prose as well as carried in the JSON, and both built from the
  deployment's public BACKEND url. Report payload version 5 → 6.

  Worth knowing when upgrading:

  - **The report shape is now part of the STABLE public surface.** It is served verbatim on
    `/api/v1`, so from here it grows additively and never renames or retypes in place.
  - **A new `created_by_key_id` column** on `public_api_keys` (D1 migration `0081`, its Drizzle
    mirror, plus an index), which carries the provenance of a headless mint and is what the
    revocation cascade follows. The app's key panel renders it, so a provisioned key no longer reads
    as one whose minter is unknown.
  - **The SDK chain learned binary responses.** An operation whose success body was neither JSON nor
    SSE previously generated as a method that returned NOTHING; the IR now marks it `binary`, each
    of the four transports hands the bytes back in its own idiom, and an unrecognised media type
    fails generation instead of silently discarding a body.
  - **A container wiring bug is fixed on both facades**: the HTTP layer's binary-artifact store
    resolver was built from account settings while the engine's came from `CoreDependencies`, so an
    override reached one side of the app and not the other.

### Patch Changes

- Updated dependencies [e7867db]
- Updated dependencies [00c4d94]
  - @cat-factory/contracts@0.242.0
  - @cat-factory/kernel@0.241.0

## 0.128.1

### Patch Changes

- Updated dependencies [c5a1a16]
  - @cat-factory/contracts@0.241.0
  - @cat-factory/kernel@0.240.0

## 0.128.0

### Minor Changes

- 289b3de: Disposer step, and a teardown that is proved rather than assumed

  A run's PR asserts a three-leg proof — the test environment came up, evidence was captured against
  it, and it was torn down again — and the third leg had two problems.

  Nothing closed it inside the run. Teardown happened only on the TTL sweep, a manual Destroy, a
  `human-test` resolution, or a re-provision supersede. The sweep fires long after the last step
  settled, so the report was published saying the environment was still live and corrected later
  through a back-channel, and only where a provisioning log is retained. TTL is a backstop; it
  cannot be a proof.

  Worse, the teardowns that did happen were never checked. Success was recorded whenever
  `provider.teardown()` returned without throwing, which is a different fact from the environment
  being gone: `HttpEnvironmentProvider` reports `torn_down` unconditionally, so a manifest with no
  `teardown:` request destroys nothing and still reports success, and a Kubernetes namespace
  `DELETE` returns while the namespace is still `Terminating`. The section could therefore render a
  green tick about an environment that was still running and still billing.

  So teardown now has two halves. A new optional `EnvironmentProvider.confirmTeardown` re-probes
  after the destroy call and the result is recorded as its own `teardown-verify` log row; only a
  probe that positively finds the environment gone counts as a reclaim. This is deliberately not
  folded into `status()`, whose implementations are all written to describe a LIVE environment — the
  generic provider with no `status:` template answers `ready` forever, and the compose mapping reads
  an empty project as `failed`, both of which are exactly inverted as teardown verdicts. The four
  outcomes stay distinct because each needs a different person: confirmed, still standing (the
  teardown was a no-op — fix the config and reclaim by hand), unverifiable (the provider has no way
  to tell you, and no retry will change that), and unconfirmed (transient; the next sweep re-probes).

  And a new `disposer` step, the deployer's counterpart, reclaims what the run provisioned wherever
  its author places it — after the automated tester, or after a human has finished with the live
  URL. It never fails the run: it commonly sits after `merger`, so an un-reclaimed environment is a
  recorded warning and an operator's job, not a failed pipeline. It is palette-addable rather than
  seeded into the built-in pipelines; seeding it is a follow-up that needs its own version bumps.

  Crucially it reclaims BY IDENTITY, not by re-resolving. The deployer now records which environment
  each frame got (`deployEnvs[frame].environmentId`) and the disposer tears down exactly that one.
  Re-resolving from `(block, frame)` reads correct and is not: that lookup falls back to the block's
  frame-less row, which is where the manual and `human-test` environments live, so a disposer running
  after a supersede, an operator's Destroy or a TTL sweep on a long run would have destroyed an
  environment the run never provisioned and recorded it as the frame's clean reclaim.

  The provisioning-log operation vocabulary is part of `/api/v1`, so `teardown-verify` is an
  ADDITIVE public-API change: the OpenAPI surface goes to 1.9.0 and the four SDK clients plus the
  MCP facade are regenerated from it. The SDKs tolerate unknown enum values by design, so an older
  client decodes the new row as a plain string rather than failing.

  One ordering detail is worth understanding, because getting it wrong made the whole feature
  unreachable while every unit test still passed. The hook that re-publishes the PR report on a
  teardown fires from the same place that writes the log rows, and its consumer RE-READS that log.
  Fired between the teardown row and the confirmation row it sees a teardown nothing has verified,
  publishes `unconfirmed`, and — being the last edge on an already-settled run — is never corrected.
  Both writes and the notification therefore happen in one method that takes the confirmation, and
  the regression test asserts the row count at hook time rather than the final rows, since only that
  can see the order.

  Two things to watch when reviewing. The report gains a `teardown: 'unconfirmed'` state, and
  because a missing verify row is treated as "not proved" rather than as a pass, runs whose
  teardowns predate this change will report unconfirmed rather than confirmed. That is a correction,
  but a visible one. And the confirmation applies to every teardown path, not just the new step, so
  a deployment whose provider config makes teardown a silent no-op will start being told so.

### Patch Changes

- Updated dependencies [dd90c1e]
- Updated dependencies [289b3de]
- Updated dependencies [dd90c1e]
- Updated dependencies [dd90c1e]
  - @cat-factory/contracts@0.240.0
  - @cat-factory/kernel@0.239.0

## 0.127.1

### Patch Changes

- Updated dependencies [4e5640d]
- Updated dependencies [a675c63]
  - @cat-factory/kernel@0.238.0
  - @cat-factory/contracts@0.239.0

## 0.127.0

### Minor Changes

- aa62acf: Warn about spend BEFORE the safeguard starts pausing runs. The budget gate was purely reactive:
  `isOverBudget` paused a run at the ceiling and a `budget_paused` card appeared, so the first
  signal a team got that their budget was running out was a pipeline stopping halfway through. The
  new forecast layer measures a trailing-window burn rate, projects the period total, and raises a
  `budget_threshold` notification once metered spend crosses 80% of the workspace or account budget,
  or is projected to overrun it before the period ends. Gating is untouched: the forecast is
  advisory, so a projection bug can cost a wrong card and never a paused or unpaused run.

  The burn rate divides by the span the ledger was actually OBSERVED over, not the nominal window.
  Without that, a workspace that started spending two hours ago is divided by seven days and reads
  as 1/84th of its real pace, which is exactly the runaway the alert exists to catch. Below six
  hours of history the projection is withheld rather than published as a number nobody should act
  on, and `insufficient-history` is reported as its own state rather than rendered as a calm zero.

  The card notifies once per crossing per period and re-arms at the period rollover. Its persisted
  state IS the card row, read back through a new `listLatestByType` that ignores card status
  deliberately: a crossed threshold stays crossed for the rest of the month, so reading only OPEN
  cards would re-alert every fifteen minutes the moment somebody tidied their inbox. Its title and
  body therefore name only stable facts (the threshold, the limit), never the live spend or burn
  rate, which would re-toast the inbox on every sweep. The sweep runs on both facades from the same
  shared driver and cadence; it is not behind an opt-in flag, because having configured a budget is
  the opt-in. The USER budget tier is deliberately not alerted on: a personal budget is not a fact a
  workspace-visible card may state, and there is no per-user inbox to raise it in.

  `budget_threshold` is Slack-routable (unlike `budget_paused`, which arrives too late to act on).

  Also adds two TCO axes to the Reports spend rollup: `repo` and `ticket`, grouping spend by the
  run's linked repository and by the tracker issue linked to the run's block. Both are one grouped
  query rather than a hand-written join against the database. A block legitimately linked to several
  tickets is attributed to one deterministically (the lowest `source:externalId` ref) rather than
  fanned out, which would have multiplied that block's cost by the number of tickets pointing at it
  and left the breakdown disagreeing with the window totals.

  The public API's notification-type enum gains `budget_threshold` (an additive change; OpenAPI
  `info.version` 1.3.0 → 1.4.0, SDK clients regenerated). It is NOT in
  `DEFAULT_NOTIFICATION_WEBHOOK_TYPES`: like the other operator-concern cards it ships only to
  webhooks that name it in their `types` filter.

### Patch Changes

- Updated dependencies [2c7d17d]
- Updated dependencies [aa62acf]
  - @cat-factory/kernel@0.237.0
  - @cat-factory/contracts@0.238.0

## 0.126.3

### Patch Changes

- Updated dependencies [99be350]
  - @cat-factory/contracts@0.237.0
  - @cat-factory/kernel@0.236.1

## 0.126.2

### Patch Changes

- Updated dependencies [c9c1dd3]
  - @cat-factory/contracts@0.236.0
  - @cat-factory/kernel@0.236.0

## 0.126.1

### Patch Changes

- Updated dependencies [6b9f696]
  - @cat-factory/kernel@0.235.1

## 0.126.0

### Minor Changes

- cec0c3e: Attach spec-sized requirements documents when creating a task over the public API.

  `/api/v1` had no way to give a run a specification. `description` caps at 2,000 characters because
  it is a task's own framing, echoed into every prompt; the 50,000-character `POST /jobs` brief drives
  inline pipelines that never touch a repository; and the app's own attach-a-document flow is
  session-authed. A headless caller holding a PRD could only paste a truncated version of it into a
  field and hope. `POST /api/v1/services/:serviceId/tasks` now takes an ordered `documents` list, each
  entry either NAMING a page in a connected document source (imported and attached, as `ticket`
  already does for a tracker issue) or CARRYING the text itself. The full body reaches agents exactly
  as a document a human attached does: materialised under `.cat-context/` for a container agent,
  folded into the prompt for an inline one.

  Carrying the text needed a document with no source behind it, so `DocumentOrigin` (`DocumentSourceKind`
  plus `upload`) is now what a stored row and its block/role links are keyed by, while everything a
  provider does stays typed against the narrow union. That keeps the missing `upload` provider a
  compile error rather than an `undefined` at whichever call site reaches for it first. An uploaded
  document has no origin URL, and every reader now renders that absence as nothing rather than as
  `Title ()` or a bare `Source:` line.

  One fix rode along, found by the cross-runtime assertion for the new origin rather than by
  reasoning: `urlMatchCandidates` used to hand back `['', '/']` for an empty needle, so `getByUrl`
  would match every row whose stored `url` is empty. Nothing produced such a row before uploads, and
  no caller passes an empty URL today, but "a lookup for nothing resolves to an arbitrary uploaded
  document, which the caller then hands an agent as the page a description pointed at" is not a trap
  to leave armed. It now returns null, and the four repositories that call it answer "no match".

  A document is now attached to at most ONE block, enforced where the link is written rather than at
  the new endpoint. `linkedBlockId` is a single column, so attaching a document another task already
  holds MOVED the link instead of copying it: the earlier task silently lost a document it was created
  with, and nothing in its next run reported the absence. That was reachable from the app's own
  picker too, which offers already-attached documents for re-use. `linkToBlock` now refuses with
  `document_already_linked` and the holder's id, the same rule and shape as one-task-per-ticket, with
  translated SPA copy. Two things keep it from wedging anything: a link naming a DELETED block is not
  a holder (so the guard heals rows left by past deletes), and `removeBlock` now detaches a doomed
  block's documents through the removal cascade, so new ones are not made. Only the link goes; the
  document survives its task.

  Attaching a list is one unit of work rather than a loop: `linkManyToBlock` asserts the block once,
  resolves the whole list through a new batched `DocumentRepository.listByRefs` and writes the links
  through a new `linkBlockMany` (both mirrored D1 ⇄ Drizzle, with cross-runtime assertions, plus
  `detachBlocks` for the cascade). The point method in a loop was three round-trips per document, ten
  of which re-read the same block.

  Worth watching in review: the creation is all-or-nothing. Everything refusable (an unconfigured
  source, an unparseable ref, a page the provider will not serve, an upload that renders to no
  readable text, a document another task holds) is refused before the board changes, and an
  attachment that fails after the task exists takes the task back off the board, because a task
  silently missing part of its spec is the failure this whole surface exists to prevent. Two ordering
  details carry that: uploads are written only after the whole list resolves (an import is idempotent
  on its ref, but every upload mints an id, so an eager write would leave one orphan per retry), and
  the rollback detaches by BLOCK rather than by the refs it resolved (a rollback can be running
  because one of those refs belongs to another task, and clearing it by ref would commit the very
  loss the guard just refused). The attach runs before the ticket claim so that rollback can never
  orphan a claimed ticket. Naming `documents` does not work in mothership mode yet, for the same
  reason `ticket` does not: the document write surface is still `pending` on the persistence
  allow-list, which the new `linkBlockMany`/`detachBlocks` join rather than widen.

### Patch Changes

- Updated dependencies [cec0c3e]
  - @cat-factory/contracts@0.235.0
  - @cat-factory/kernel@0.235.0

## 0.125.0

### Minor Changes

- 8cbf1a7: Manage the outbound notification webhook over `/api/v1`, so the whole integration surface is
  headless.

  `GET|PUT|DELETE /api/v1/notification-webhook` (`admin` scope) register, read and remove the one
  HTTPS endpoint a workspace pushes its notifications, run-lifecycle events and platform-health
  alerts to. Until now that endpoint could only be registered over the session-authed
  `/workspaces/:ws/notification-webhook`, so a deployment driven entirely by API keys had to put a
  human in a browser to switch on the very channel that exists because there is no browser: the
  delivery contract was headless and its enrolment was not.

  The routes delegate to the same `NotificationWebhookService` the session controller calls, so the
  SSRF guard on the endpoint, the keep-on-omit rule for every field and the one-row-per-workspace
  invariant are identical whichever surface writes. The signing secret stays write-only: `PUT`
  accepts one and the read reports only `hasSecret`, so an `admin` key can rotate it and can never
  learn the stored one.

  `PUT`'s `url` becomes optional, on both surfaces, so keep-on-omit is uniform across every field
  rather than every field but one. A mandatory re-send made the routine edit (subscribe to a family)
  carry a value the caller never meant to change, and a client re-sending a URL it cached before
  someone else rotated the receiver would silently redirect the workspace's deliveries back to the
  old endpoint while appearing to add a subscription. `url` is still required on the first `PUT`
  against a workspace with nothing registered, refused with `details.reason: "webhook_url_required"`.
  Relaxing a required field is additive, so no live caller changes.

  Additive on `/api/v1` (OpenAPI `info.version` 1.5.0; main took 1.4.0 for its own additive change
  while this branch was open). The four SDK clients gain a `webhook` resource
  (`get` / `set` / `delete`) and the MCP facade the matching `webhook_*` tools.

### Patch Changes

- Updated dependencies [8cbf1a7]
  - @cat-factory/contracts@0.234.0
  - @cat-factory/kernel@0.234.2

## 0.124.1

### Patch Changes

- Updated dependencies [ee6601e]
  - @cat-factory/contracts@0.233.0
  - @cat-factory/kernel@0.234.1

## 0.124.0

### Minor Changes

- 937d4af: Alert on a NAMED failure kind crossing its own rate, not just on one kind swamping the rest.

  `platform_health` could already say "nearly every failure shares one cause" (`failure_kind_dominant`,
  80% by default), which is a question about the shape of the distribution. It could not say "5% or
  more of failures are evictions", and no single ceiling can: 5% evictions is the container
  substrate failing one run in twenty, while 40% `rejected` is the product working as designed. Which
  kinds deserve their own ceiling, and where each sits, is a judgement about a particular deployment,
  so it is configuration rather than a threshold the platform picks: `PLATFORM_ALERTS_FAILURE_KIND_RATES`
  (`evicted=0.05:3,timeout=0.2`) sets the deployment's rules, and an account can replace them from the
  platform-alert settings panel. Nothing fires until an operator names a kind, so a deployment that
  configures none is byte-for-byte unchanged.

  Two things about the new condition are worth reviewing carefully. Its reason code is SHARED by every
  rule, so the firing KINDS now ride the `platform_health` card beside the reasons and are the other
  half of the card's dedup identity: without them, evictions subsiding while timeouts crossed the same
  rule is an unchanged firing set, and the card goes on naming the incident that ended. And each rule
  carries its own `minCount` (default 1), because the shared `minRuns` sample stops protecting anything
  at a low ceiling: five terminal runs with a single eviction is already 20%.

  A rule naming a kind the build does not produce is KEPT and reported, never dropped and never
  silently ignored: a typo and a retired kind are the same string, nothing can tell them apart, and
  either way an operator has armed a pager that reads exactly like a kind that never occurred. The
  same reasoning runs through the settings editor, which offers the current vocabulary, marks a
  stored unrecognised kind as such, and stops offering to add rules once every kind carries one.
  Config warnings are now emitted once per process rather than once per read, because the Worker
  re-derives its whole config on every invocation and a standing typo would otherwise log on each.

  Additive on `/api/v1`: OpenAPI `info.version` 1.4.0, a `failure_kind_rate_high` member on the
  notification payload's alert reasons, a `platformAlertFailureKinds` field beside it, and an optional
  `kind` on the platform-health webhook's conditions (the delivery id names it, so several rules firing
  at once no longer read as one code repeated). A stored rule names its kind as a plain string rather
  than the closed failure-kind picklist, deliberately: a rule surviving a kind's retirement must still
  parse, or one stale rule would take the account's whole settings row down with it and silently
  discard the model policy beside it. The settings panel offers the current vocabulary and marks an
  unrecognised stored kind as such rather than re-pointing it.

### Patch Changes

- Updated dependencies [937d4af]
  - @cat-factory/contracts@0.232.0
  - @cat-factory/kernel@0.234.0

## 0.123.6

### Patch Changes

- Updated dependencies [2580fee]
- Updated dependencies [eb4ca17]
  - @cat-factory/kernel@0.233.0
  - @cat-factory/contracts@0.231.0

## 0.123.5

### Patch Changes

- 1f14793: Documentation cleanup and consistency: neutral naming across docs, code comments,
  example fixtures and historical changelog entries, with the OpenAPI spec and
  generated SDK clients regenerated so their description strings match. No behaviour
  or API change.
- Updated dependencies [1f14793]
- Updated dependencies [2619d79]
  - @cat-factory/contracts@0.230.1
  - @cat-factory/kernel@0.232.0

## 0.123.4

### Patch Changes

- Updated dependencies [e7e4404]
  - @cat-factory/contracts@0.230.0
  - @cat-factory/kernel@0.231.0

## 0.123.3

### Patch Changes

- Updated dependencies [10e0341]
- Updated dependencies [10e0341]
  - @cat-factory/contracts@0.229.0
  - @cat-factory/kernel@0.230.0

## 0.123.2

### Patch Changes

- Updated dependencies [fccb1df]
  - @cat-factory/contracts@0.228.0
  - @cat-factory/kernel@0.229.0

## 0.123.1

### Patch Changes

- 437a0c6: Make the add-service and bootstrap surfaces provider-aware, so a workspace connected with a
  personal access token is no longer offered GitHub-App affordances it cannot use.

  `GitHubConnection` gains a required `method` (`app` | `pat`, reusing the `VcsConnectMethod`
  vocabulary the connect-options route already speaks). It is derived in
  `GitHubInstallationService` from the row's `appId`, which only the App connect path fills, since
  that one mapper reads back rows written by the App connect, the per-workspace PAT connect and
  local mode's auto-provisioner alike. The SPA gates the "grant the App access to this repo" link
  on it through a single `appInstallationManageUrl` helper; both modals previously built a
  `github.com/settings/installations/<id>` URL from any connection, which 404s for a GitLab PAT
  connection and for local mode's synthetic PAT-backed one.

  **Compatibility break (internal wire shape).** `method` is REQUIRED, not optional like the
  `provider` discriminator beside it, so a response without it fails client-side contract
  validation rather than being defaulted at each reader. That is deliberate: a client cannot decide
  what to offer from a value it never received, and an optional field would leave the two
  `toConnection` mappers free to forget it. A backend and an SPA from different releases are
  therefore not interchangeable across this change.

  The connect fan-out (which methods a deployment can serve) becomes one `VcsConnectSurfaces`
  component, replacing two copies and two hardcoded GitHub-App pickers: a GitLab-only deployment
  previously had no way to connect from the add-service or bootstrap modal at all.

  Add-service and bootstrap copy moves onto provider-parameterised `vcs.*` keys in all ten
  locales; three add-service keys no component referenced are dropped with it. Copy that renders
  before anything is connected reads a new `surfaceProvider` (the connected provider, else the only
  one the deployment could connect, else neutral) rather than `provider`, whose "what is connected"
  default named GitHub on a GitLab-only deployment.

  The bootstrap modal's manual "create the repository yourself" link is now WITHHELD on GitLab
  rather than pointed at `gitlab.com`: a deployment may be bound to any self-hosted instance and
  nothing on the wire names its web host yet, and a project created on the wrong instance looks
  like success until the bootstrap push cannot find it. The intro copy keys off the same value, so
  it no longer promises a one-click that isn't there.

  A connection row predating the multi-App tier has no `appId`, so it reads as `pat` and loses the
  grant-access link until the workspace reconnects.

- Updated dependencies [437a0c6]
  - @cat-factory/contracts@0.227.0
  - @cat-factory/kernel@0.228.1

## 0.123.0

### Minor Changes

- 43fd5c0: Route platform-health alerts to the workspace's outbound webhook as their own event family, so
  on-call tooling can be paged by the deployment watching itself.

  A workspace's registered endpoint gains an `alertEvents` filter beside `types` and `runEvents`,
  carrying `platform_health.firing` when the health sweep's set of tripped conditions changes and
  `platform_health.resolved` when it observes the account recover. Empty means none, like
  `runEvents`: subscribing a receiver to alerts is always explicit.

  The `platform_health` notification CARD could already be named in the `types` filter, and for a
  human overseer it still should be. It is not safe to page on: a card is re-delivered when a human
  acts on it or dismisses it, which is indistinguishable on the wire from the sweep clearing it
  because the deployment recovered. These edges come from the sweep's own verdict, and carry each
  condition's observed value and threshold (which the card deliberately omits, since its payload is
  its dedup identity).

  Each delivery is identified by `<cardId>:<event>:<transition>[:<reasons>]`, where the transition
  ordinal is counted on the card row itself. Neither simpler key works: a condition set recurs within
  one incident (`{A}` → `{A,B}` → `{A}`), so keying on the set drops the page saying it subsided,
  while keying on a timestamp pages twice whenever two of the deployment's sweepers observe one
  transition. `occurredAt` is the sweep's own observation of the transition rather than anything read
  off the card, whose `createdAt` is preserved across a re-raise and so names when the incident
  opened.

  Internal break: `NotificationWebhookRecord` gains a required `alertEvents` field, and the
  `notification_webhooks` table gains an `alert_events` column on both runtimes. Existing rows
  default to `[]`, so every registered endpoint keeps its current behaviour byte-for-byte.

  The `platform_health` notification payload gains an optional `platformAlertTransition`, which
  carries that ordinal and so also lets a caller reading `GET /api/v1/notifications` line a card up
  against the alert deliveries it received. That is an ADDITIVE public-API change: the OpenAPI
  `info.version` goes to 1.3.0 and the four SDK clients plus the MCP facade regenerate, with no
  existing field renamed, retyped or removed. A card written before this ships carries no ordinal and
  its next transition simply starts the count at 1.

### Patch Changes

- Updated dependencies [43fd5c0]
  - @cat-factory/kernel@0.228.0
  - @cat-factory/contracts@0.226.0

## 0.122.2

### Patch Changes

- Updated dependencies [0456066]
  - @cat-factory/contracts@0.225.0
  - @cat-factory/kernel@0.227.0

## 0.122.1

### Patch Changes

- Updated dependencies [f1a6cb3]
- Updated dependencies [cc17221]
- Updated dependencies [889a497]
- Updated dependencies [3605630]
  - @cat-factory/contracts@0.224.0
  - @cat-factory/kernel@0.226.0

## 0.122.0

### Minor Changes

- 36b1853: Ticket context is a first-class input to public task creation, and Jira ADF replies are read.

  `POST /api/v1/services/:serviceId/tasks` takes an optional `ticket` (`{ source, ref }`, where
  `ref` is a canonical issue key or a full issue URL). The platform imports that issue and ATTACHES
  it to the new task, the same linkage the app's own create-from-issue produces: each agent step
  re-reads the live issue as context, the writeback path posts a run's clarification questions onto
  it, a reply typed on the ticket resolves against the parked run, and the intake sweep treats the
  issue as taken. Before this a headless intake could only paste the issue into `description`, which
  kept the words and lost all of that.

  Additive on the wire (OpenAPI surface `1.0.0` → `1.1.0`; regenerated in all four SDKs). Two
  refusals are worth knowing about: the ticket is resolved BEFORE the task is created, so an unknown
  source or an issue the tracker will not serve leaves the board untouched rather than producing an
  unlinked task; and a ticket already linked to another task is a `409` carrying
  `details.reason: 'ticket_already_linked'` plus `details.taskId`, which is what lets a redelivering
  integration follow the existing task instead of filing a duplicate. That reason is now also
  emitted by the app's create-from-issue, which previously refused the same condition in prose only.

  One task per ticket now holds under CONCURRENCY, which is what redelivery actually produces. The
  read that refuses has already returned by the time a task is created, so `TaskRepository` gains
  `claimBlockLink` (a conditional write on `linked_block_id`, mirrored D1 and Drizzle with a
  concurrent conformance assertion) and both filing paths go through it. Previously two simultaneous
  filings of one issue both succeeded, and the second silently re-pointed the link, stripping the
  first task of the context it was created with. The headless filing additionally rolls its task
  back off the board when it loses, so retrying on the `409` cannot accumulate duplicates.

  Jira's ADF renderer is also bounded now. A comment body is external structure rather than something
  the vendor's editor produced, and a recursive walk over it was an unbounded stack and, on the
  Worker, an unbounded request budget. It renders under a node and depth budget far above any real
  document and states it when either is hit, rather than stopping where a reader would read the cut
  as the end of the text.

  Separately, Jira Cloud comment webhooks are read as Atlassian Document Format. Jira v3 sends
  comment bodies as an ADF document rather than a string, so every rich-text reply was dropped
  before it reached the review-reply grammar, and silently: an unparsed delivery is acked, so a
  reporter who answered a clarification question in Jira's own editor got nothing recorded and no
  acknowledgement saying so. The bodies now go through the import path's own `adfToMarkdown`, which
  gained the leaf nodes that carry their text in `attrs` (mention, emoji, status, smart link) so a
  name, a state or a link no longer vanishes out of the middle of a sentence.

### Patch Changes

- bbc51fa: Split the last six files above 1500 lines so oxlint's `max-lines` can reach its final target,
  where it matches `check-file-size.mjs`'s default budget.

  Every change is a behaviour-neutral move behind a thin delegate or a re-export, so no call site
  changed:

  - `ExecutionService` sheds the run-lifecycle surface (`start` / `retry` / `restartFromStep` /
    `resumePaused` / `cancel` / `stopRun` / `teardownForBlockTree`) to `RunLifecycleController` and
    the iteration-cap resolution to `IterationCapController`, built as one pair by
    `run-action-controllers.ts`.
  - `RunDispatcher` sheds the dispatch side of a step to `AgentDispatchController` and its
    dependency declarations to `RunDispatcherDependencies.ts`.
  - The provisioning detector's compose / stack-recipe half moves to `provision-detect.compose.ts`
    over a new shared `provision-detect.contract.ts`.
  - The Node schema's outbound model-provider credential tables move to
    `db/tables/model-credentials.ts`, re-exported.

  The extractions also stranded four private fields whose only readers moved out
  (`RunDispatcher`'s `resolveRunRepoContext` / `resolveProviderCapabilities` / `modelIdIsMetered`
  and `ExecutionService`'s `subscriptionActivations`). They were assigned and never read, which no
  typecheck reports, so they are deleted rather than left as write-only state.

- Updated dependencies [36b1853]
  - @cat-factory/contracts@0.223.0
  - @cat-factory/kernel@0.225.0

## 0.121.2

### Patch Changes

- Updated dependencies [413095f]
  - @cat-factory/contracts@0.222.0
  - @cat-factory/kernel@0.224.0

## 0.121.1

### Patch Changes

- Updated dependencies [04e44f8]
  - @cat-factory/contracts@0.221.0
  - @cat-factory/kernel@0.223.0

## 0.121.0

### Minor Changes

- 807e442: Let a deployment register its own task source in code. The source vocabulary is now
  `builtin picklist ∪ <namespace>:<name>`, matching the shape task types already use, so a
  deployment's provider on the app-owned `TaskSourceRegistry` is served by connect, import,
  search, bug hunt and webhook intake without a fork.

  The built-ins keep their bare ids, so no persisted row changes. A bare non-built-in id still
  fails validation, keeping a typo distinguishable from a registration.

  Issue-intake board scope gains an opaque `boardId` leg for registered sources; without it a
  registered source's board id fell through to the GitHub field.

- 175f78f: Security hardening round 2, P1: close SEC-3, SEC-4 and SEC-5 (docs/initiatives/security-hardening-round-2.md).

  - **Machine tokens are revocable (SEC-5).** Every `POST /auth/machine-token` mint is recorded on
    the new `machine_nodes` roster (kernel `MachineNodeRepository`; D1 migration
    `0077_machine_nodes.sql` ⇄ Drizzle `machineNodes`), the new shared machine gate
    (`verifyMachineRequest`) checks the revocation tombstone on every `/internal/*` machine surface
    plus the WS subscribe handshake, and the owner drives `GET /auth/machine-nodes` /
    `POST /auth/machine-nodes/:nodeId/revoke`. A revoked node id can never be re-minted and a
    foreign node id cannot be taken over, enforced by the roster WRITE itself (a guarded
    `ON CONFLICT ... WHERE`) so two concurrent mints of one id cannot leave a row whose owner did
    not mint it. A mothership with no roster wired refuses to mint at all, since an unrecorded token
    could never be revoked; a roster read that fails refuses the call rather than serving it, and on
    the WS handshake answers 503 (retry) rather than crashing the upgrade. Rows prune once past
    their latest signed `exp`.
  - **The password throttle is durable and spoof-resistant (SEC-4).** Attempts land in the new
    cross-replica `auth_attempts` ledger (kernel `AuthAttemptRepository`; D1 migration
    `0078_auth_attempts.sql` ⇄ Drizzle `authAttempts`) with a per-`ip:email` burst cap AND a per-IP
    aggregate that catches one-password-many-emails credential stuffing; the in-process Map remains
    only as the store-outage backstop. WHICH header carries the client address is a per-facade
    decision behind `ServerContainer.resolveClientAddress`: Node reads the socket peer, and
    `x-forwarded-for` (rightmost hop, `AUTH_TRUST_PROXY_HOPS` deep) only under the new
    `AUTH_TRUST_PROXY=true`; the Worker reads `cf-connecting-ip`, which is authentic only there.
    Addresses are normalised before keying (port stripped, non-IP refused, IPv6 bucketed to its
    /64). The 429 carries `details.reason: 'auth_attempts'` and `retryAfterSeconds`, and both a trip
    and a store outage are counted (`auth.throttle.limited`, `auth.throttle.store_unavailable`).
    Completes the durable-auth-rate-limiting initiative, now ADR 0032.
  - **Local-runner hosts are loopback-only by default (SEC-3). BEHAVIOUR BREAK:** registering or
    calling a locally-run model endpoint on a private-LAN host (RFC1918 / ULA / mDNS `.local`) now
    requires the operator opt-in `LOCAL_MODELS_ALLOW_LAN=true` on hosted deployments; single-tenant
    local mode defaults the opt-in on. The policy binds the write boundary, the test probe and every
    run-time redirect hop, so an existing LAN row on a hosted deployment is refused instead of
    silently serving an internal-network SSRF surface. Such a row is now also reported on the
    endpoint itself (`LocalModelEndpoint.urlBlockedReason`) and its models are withheld from the
    picker, so the failure surfaces in settings rather than mid-run.
  - **BEHAVIOUR BREAK (SEC-3):** a runner base URL may no longer carry a query string, a `#`
    fragment or `.`/`..` path segments, and `*.localhost` subdomains are no longer accepted (plain
    `localhost` still is). A base URL ending in `#` made the fixed `/models` and `/chat/completions`
    suffixes inert, which turned both server-side forwards into an arbitrary-path request against
    whatever listens on loopback; endpoint URLs are now composed through one validating helper
    rather than concatenated. Every refusal carries a machine-readable
    `LocalRunnerUrlReason` the SPA maps to translated copy.

- 807e442: Judge a pushed tracker issue against a schedule's intake scope, and let each dispatch mode decide
  what an unanswerable predicate means.

  The push matcher reported a boolean and failed OPEN on any field a delivery did not carry, which was
  correct for the queue mode it was written for: the fired run's vendor search re-checks every
  predicate, so the worst case is one no-op run. Per-ticket dispatch reused it with nothing downstream
  to re-check, where the same guess costs a real task block and a real agent run on a ticket nobody
  triaged.

  It now reports a verdict (`match` / `miss` / `unconfirmed`) and `dispatchAdmits` picks the
  disposition per mode: `queue` still fires on an unconfirmed predicate, `per-ticket` withholds and
  logs which predicate it could not confirm.

  Board scope is evaluated for the first time. `TrackerIssueEvent` carries the vendor board in the
  shape the intake config stores (a Jira project key, an `owner/repo` slug, a Linear team UUID), read
  from payloads the adapters already parse, so a per-ticket schedule scoped to one project no longer
  runs tickets from every project its connection can see. This tightens the queue mode too: a delivery
  from a board the schedule is not scoped to no longer fires it. That only ever spent a run which
  completed as "no matching open issues", so the change removes wasted runs rather than pickups.

  The schedule form locks on-demand while the tracker trigger is on, rather than only defaulting it,
  and both intake refusals carry a machine-readable reason mapped to translated copy.

### Patch Changes

- Updated dependencies [c8ba2cd]
- Updated dependencies [807e442]
- Updated dependencies [807e442]
- Updated dependencies [175f78f]
- Updated dependencies [807e442]
  - @cat-factory/contracts@0.220.0
  - @cat-factory/kernel@0.222.0

## 0.120.1

### Patch Changes

- Updated dependencies [1106c93]
  - @cat-factory/contracts@0.219.0
  - @cat-factory/kernel@0.221.1

## 0.120.0

### Minor Changes

- 3b88f66: Prove the test environment lifecycle on the pull request

  The PR verification report already listed which ephemeral environments a run stood up, but it
  could not show that anything was actually exercised against one, and its teardown verdict was
  unreachable in practice: the per-step environment projection stops being refreshed when the run
  settles, and the TTL sweep that reclaims the environment fires afterwards, so a report published
  by the step hook said "still live" forever about environments the platform had destroyed on
  schedule.

  The section is now the three-leg proof a reviewer needs: the environment came UP at a recorded
  time, evidence was CAPTURED from it while it was live, and it was TORN DOWN again. The dates come
  from the provisioning event log (the only store that records them), the middle leg from the
  tester's own report plus the screenshots it stored, and the verdict over the three is COMPUTED in
  code with every missing or contradictory leg named, never read off an agent's claim that it tested
  against a preview. The report links back to the captured evidence through a new `test-evidence`
  run deep link.

  Three distinctions are load-bearing. An empty timeline has four causes and they are not
  interchangeable, so it carries a machine-readable `gap` naming which: no log wired, a read that
  failed, a read too large to be complete, or a run that stood nothing up. Only the first is a
  statement about how the deployment is configured. The teardown verdict is decided by environment
  IDENTITY rather than by comparing a count of teardown rows to a count of ready frames, which is
  the form that survives a run replacing an environment mid-flight (the superseded one's teardown
  would otherwise balance the books while its replacement is still standing). And a tester that ran
  against local dependencies is kept apart from one that did not say where it ran: its artifacts are
  reported either way, but only a declared ephemeral run counts as evidence about the environment.

  The teardown leg is closed out of band: `EnvironmentTeardownService` notifies a best-effort hook
  from the one place that records a teardown attempt, wired to a new
  `ExecutionService.refreshVerificationReport`, so reclaiming an environment republishes the report
  that describes it. It fires on a FAILED attempt too, since a settled run has no step settlement
  left and an environment the provider refuses to reclaim has to reach the PR as an operator's job.

  Breaking: the report's JSON payload is version 4. `environments` gains `timeline`, `evidence`,
  `proof` and `gaps`, and its `teardown` picklist gains `failed`. The rendered section is retitled
  "Test environment lifecycle". External consumers pinned to version 3 must re-read the schema.

### Patch Changes

- Updated dependencies [f63145d]
- Updated dependencies [3b88f66]
  - @cat-factory/contracts@0.218.0
  - @cat-factory/kernel@0.221.0

## 0.119.0

### Minor Changes

- 7f86f07: Capability credentials get their operator surface: an Infrastructure-window tab rendering the
  checklist of what this deployment's registered tool servers and generative integrations ask for,
  joined to what this board has stored.

  It is a checklist rather than a blank key-value form because which keys exist is a property of the
  deployment's CODE: each row names who wants the value, whether it is required and when it was last
  set, so nobody reads the deployment's source to learn what to type. The three things an empty row
  can mean stay apart: nothing stored but the environment may still answer, a stored key nothing asks
  for any more (removable, and withheld while the declaration read is known to be short), and a
  declaration list that could not be read at all. `secrets.manage` hides the tab rather than disabling
  it, and so does having nothing to show, since a build registering no capability has no credential to
  type.

  Also new: `PUT /workspaces/:ws/capability-credentials/:key`, the per-key write the checklist
  performs. The whole-set PUT could not serve it: a client that never received the values can neither
  re-send the set nor express "leave the others alone", so filling in a second credential through it
  would have deleted the first. The whole-set write stays for an API caller declaring a set at once.

### Patch Changes

- 7f86f07: The capability-credential row is rev-guarded, closing two holes the per-key write opened. The row
  is ONE sealed blob holding the whole set, so a per-key save is read-modify-write over it; blind,
  two operators saving DIFFERENT keys would silently destroy each other's, with the loser's save
  still returning success. `put`/`remove` now ride a `compareAndSwap`/`deleteIfRev` pair (a new
  `rev` column on `capability_credentials`, both runtimes), reloading and re-applying on the
  winner's snapshot, 409 only on a pathologically hot row. The whole-set PUT stays a blind write:
  replacing whatever is stored is its semantics, and it bumps the stored rev in SQL so a concurrent
  per-key save's guard still trips.

  Also: a per-key save now stamps `updatedAt` on the touched key ONLY. "Last set" is a per-key fact
  the checklist renders per row, and the previous write re-stamped the whole set, falsifying every
  neighbour's date whenever any one key was saved.

- Updated dependencies [7f86f07]
- Updated dependencies [7f86f07]
  - @cat-factory/contracts@0.217.0
  - @cat-factory/kernel@0.220.0

## 0.118.1

### Patch Changes

- Updated dependencies [87161e8]
  - @cat-factory/contracts@0.216.0
  - @cat-factory/kernel@0.219.0

## 0.118.0

### Minor Changes

- 96ad850: Per-workspace capability credentials: the secrets a tool server or generative binary integration
  declares are now stored per TENANT, sealed at rest, instead of only being read off the deployment's
  environment.

  An environment variable is a single-tenant answer: one process serves many workspaces, so one
  variable served them all: every tenant's runs authenticated as whoever set it, no tenant could bring
  its own vendor account, and rotating one tenant's key was a redeploy that rotated everyone's. Every
  other credential in the platform is already a per-tenant sealed row; capabilities were the subsystem
  that had not caught up.

  New: `capability_credentials` (D1 + Postgres), `CapabilityCredentialsService`,
  `createWorkspaceToolSecretResolver` / `composeToolSecretResolvers`, and a `secrets.manage`-gated
  `/workspaces/:workspaceId/capability-credentials` surface that lists which credentials the
  deployment's registered capabilities DECLARE alongside which this workspace has stored. Deleting a
  board reclaims its stored credentials with the rest of its workspace-scoped rows.

  No behaviour change for an existing deployment: the environment resolver is composed BEHIND the
  store per key, so a workspace that has stored nothing resolves exactly as before. The SPA panel is
  the next slice; the API is usable now.

### Patch Changes

- Updated dependencies [96ad850]
- Updated dependencies [96ad850]
  - @cat-factory/contracts@0.215.0
  - @cat-factory/kernel@0.218.0

## 0.117.2

### Patch Changes

- Updated dependencies [4c26c01]
  - @cat-factory/contracts@0.214.0
  - @cat-factory/kernel@0.217.0

## 0.117.1

### Patch Changes

- Updated dependencies [924c6f9]
  - @cat-factory/contracts@0.213.0
  - @cat-factory/kernel@0.216.0

## 0.117.0

### Minor Changes

- 54d531d: Count the deployment's operational EVENTS, and let the health alerts see a dead one.

  The platform-observability projection answers "how are the runs doing" by aggregating
  `agent_runs`. It structurally cannot answer what an operator asks during an incident — how often
  container dispatch is failing, whether the sweeper is re-driving more than it was, whether a queue
  is draining — because none of those are rows in a table. A new kernel `OperationalMetrics` port
  counts them, and the OTLP platform exporter ships them as delta sums beside the existing gauges.
  Wired at the sweepers, the container seam, the trace sinks, the notification webhook and every
  app-cache read; `agent_runs` gained a persisted `redrive_count`, so "was this run re-driven three
  times?" is answerable after the process (or the isolate) that did it is gone.

  `platform_health` gained three conditions. The important one is zero-throughput: every existing
  condition divides by runs and goes silent at zero, so a deployment that stopped accepting work
  read identically to a quiet healthy one. Alongside it, a dominant-failure-kind condition (100%
  `evicted` and 100% `agent` produce the same failure rate and need opposite fixes) and one that
  alerts on the sweepers themselves, since a wedged sweeper makes every other signal stale without
  making any of them fire. A sweep pass reports its rate and its failure streak through ONE call
  (`SweepHealthTracker.recordFailure`), and the Worker drives its crons through a `SweepTick` that
  is the facade-symmetric twin of Node's `startSweeper` — so both runtimes cover the same set of
  sweepers, and the tick's counters are flushed after its passes have settled rather than before.

  Also: retention pruning is now isolated per table (one sick table used to abort the whole pass,
  indefinitely, and report zeroes indistinguishable from an empty table); `/ready` round-trips
  pg-boss's own connection instead of trusting a process-local boolean, and the Worker gained a
  bindings-probing `/ready`; and every pg-boss queue is created with a dead-letter sibling whose
  depth rides the `queue.depth` gauge under `state: dead_letter`, with an hourly sweep logging the
  source queue to go and look at.

### Patch Changes

- Updated dependencies [233e279]
- Updated dependencies [54d531d]
  - @cat-factory/contracts@0.212.0
  - @cat-factory/kernel@0.215.0

## 0.116.4

### Patch Changes

- Updated dependencies [87ed4f9]
  - @cat-factory/contracts@0.211.0
  - @cat-factory/kernel@0.214.1

## 0.116.3

### Patch Changes

- Updated dependencies [3435bd1]
  - @cat-factory/kernel@0.214.0

## 0.116.2

### Patch Changes

- Updated dependencies [70b4339]
  - @cat-factory/kernel@0.213.0

## 0.116.1

### Patch Changes

- 4ac6960: Refresh the dependency tree — direct and transitive — to the latest versions that satisfy the `minimumReleaseAge` supply-chain gate, staying within each dependency's compatible major.

  - **AI SDK family** (held to the major that pairs with `workers-ai-provider`): `ai@^7.0.37 → ^7.0.47`, `@ai-sdk/anthropic`/`@ai-sdk/openai@^4.0.2x → ^4.0.27`, `@ai-sdk/openai-compatible@^3.0.14 → ^3.0.20`, `@ai-sdk/provider@^4.0.3 → ^4.0.4`, `@ai-sdk/amazon-bedrock@^5.0.32 → ^5.0.40`.
  - **Runtime deps**: `pg-boss@^12.26.3 → ^12.26.4`, `@aws-sdk/client-s3@^3.1095.0 → ^3.1101.0`, `@nuxtjs/i18n@^10.5.0 → ^10.6.0`, `@vueuse/core@^14.3.0 → ^14.4.0`.
  - **Tooling**: `wrangler@^4.114.0 → ^4.118.0`, `@cloudflare/workers-types@^5.20260726.1 → ^5.20260801.1`, `oxlint@^1.75.0 → ^1.76.0`, `oxfmt@^0.60.0 → ^0.61.0`, `knip@^6.29.0 → ^6.31.0`, `turbo@^2.10.7 → ^2.10.8`, `vue-tsc@^3.3.8 → ^3.3.9`, `@playwright/test@^1.62.0 → ^1.62.1`, `@types/node@^26.1.1 → ^26.1.2`, `@types/pg@^8.20.0 → ^8.20.3`.

  No `minimumReleaseAgeExclude` entries were added: every bump above already satisfies the gate. The `@cat-factory/executor-harness` and `@cat-factory/deploy-harness` deps are deliberately untouched, since they feed the published runner images and bumping them is a separate image-bumping change. `hono`'s declared range therefore stays at `^4.12.32` (sherif requires one version workspace-wide, and the harness declares it) while the lockfile still resolves 4.12.33 within that range.

- Updated dependencies [f31c644]
- Updated dependencies [4ac6960]
- Updated dependencies [874d684]
  - @cat-factory/kernel@0.212.0
  - @cat-factory/contracts@0.210.1

## 0.116.0

### Minor Changes

- 769a3d9: Close the PR-deep-review parity gap on GitLab: `FetchGitLabClient` now implements
  `listChangedFiles`, `getPullRequestHeadRef`, `getPullRequestHeadSha` and `createReview`. All four
  are optional on the `VcsClient` port and every consumer degrades silently without them, so a
  GitLab deployment previously ran the review flow to completion while the merge track record
  classified every run `unknown` (never matching a per-class merge rule) and the selected findings
  never reached the merge request. Cross-provider conformance now asserts their presence.

  Two breaking shapes ride along, both because a provider that cannot answer must say so rather than
  answer zero:

  - **`GitHubChangedFile.additions` / `deletions` are now `number | null`.** Null means the host did
    not report a count — GitLab withholds the hunk the counts are derived from for an oversized diff,
    and these render straight into the reviewer's prompt, where `+0/-0` describes a file nobody
    touched. GitHub still reports a real `0` for a binary it cannot line-count, and the conformance
    suite pins both. A consumer folding null to `0` must now do so deliberately. GitHub's own mapper
    moves to `githubProjection.toChangedFileProjection` (`@cat-factory/integrations`) so the decision
    sits beside its GitLab counterpart rather than inline in the fetch client.
  - **`logger` is REQUIRED on the GitLab facade builders** (`buildGitLabEngineClient`,
    `buildGitLabConnectClient`, `registerGitLab`) and is kernel's `Logger` rather than a bespoke
    `{ warn }`. It was optional, and consequently no composition root passed one — leaving the page-cap
    truncation warning unreachable in production, on the very reads a review is sliced from. The local
    facade now builds its client through the shared `buildGitLabEngineClient` instead of assembling the
    same pair by hand, so it cannot miss the next thing that builder gains.

### Patch Changes

- Updated dependencies [769a3d9]
  - @cat-factory/kernel@0.211.0

## 0.115.0

### Minor Changes

- 73708cf: Close three of the gaps `backend/docs/security-model.md` lists against the agent write path.

  **`allowInitiatorPat` turns "govern your members' PATs" from advice into an enforced control, at
  two tiers.** A run's initiator's stored personal token outranks the deployment credential, and its
  scope is whatever that person granted it — so the blast radius of a compromised run was a property
  of whoever pressed start. Off, every run authenticates as the App installation and the initiator's
  token is never decrypted. All three mint sites (both facades' container dispatch and the engine's
  GitHub client) now route through one `createResolveRunInitiatorToken` decision, and an unreadable
  settings row fails closed to the App token.

  The per-workspace switch is edited with `settings.manage`, which a member elevated on one board
  holds — so it alone could not bind the case it exists for. An **account-wide floor** sits under it:
  effective = account permits AND workspace permits, with the account tier out of a board admin's
  reach. It ships UNSET, and that default is load-bearing rather than merely cautious — a personal
  token is the right credential for someone adopting cat-factory alone inside an org that has not,
  where there is no App installation to inherit and no account admin to ask. PAT support is
  unchanged for them.

  **A stored GitHub PAT's breadth is stated when it is tested or saved.** A classic token carrying
  `repo` is called out as reaching every repository its owner can push to; unused scopes are flagged;
  a token whose scopes GitHub does not report is reported as unknown rather than passing as narrow.

  **A branch-protection preflight says where the operator checklist's first item is missing.** On
  demand, the GitHub settings panel probes each linked repository's default branch and reports three
  states — a repo it could not reach is `unknown`, not "fine" — plus whether a protected branch's rule
  was actually readable, and how many repositories a probe cap left unchecked. It answers to
  `integrations.manage` and probes with bounded concurrency: unlike its sibling reads it spends the
  installation's GitHub rate limit, which the CI gate and the merger draw on for every run.

  It reads **rulesets as well as classic branch protection**. Rulesets are how protection is enforced
  org-wide and leave no classic rule behind, so a legacy-only probe reported the best-configured
  repositories as exposed — a false alarm on a panel whose only job is naming exposed ones. The rules
  endpoint also needs no admin, so a minimally-scoped App installation now gets real detail where it
  previously got `detailUnavailable`.

  The operator checklist now names **GitHub's own org-level PAT controls first**, since they bind
  every tool a member uses and cannot be undone by them — with the caveat that they are the wrong
  instrument for individual adoption, which is what ours are for. The residual-gaps list records
  GitHub App **user-to-server tokens** as the structural fix for an unbounded initiator token
  (`auth/GitHubOAuth.ts` already implements that flow for login), so the next iteration does not
  re-derive "a PAT cannot be narrowed" as permanent.

  BREAKING for anything constructing these directly: `RunInitiatorScope` now takes a
  `{ workspaceId, initiatedBy }` scope rather than a bare user id, `MintInstallationToken`'s run
  context carries `workspaceId`, and `PatPreferringAppRegistry` takes the composed token decision
  instead of a raw `ResolveUserGitHubToken`. `currentInitiator()` is removed in favour of
  `currentCredentialScope()`.

### Patch Changes

- Updated dependencies [73708cf]
- Updated dependencies [876ee2d]
  - @cat-factory/contracts@0.210.0
  - @cat-factory/kernel@0.210.0

## 0.114.4

### Patch Changes

- Updated dependencies [0a1170e]
  - @cat-factory/contracts@0.209.0
  - @cat-factory/kernel@0.209.0

## 0.114.3

### Patch Changes

- Updated dependencies [d320539]
  - @cat-factory/contracts@0.208.0
  - @cat-factory/kernel@0.208.0

## 0.114.2

### Patch Changes

- Updated dependencies [9e5f785]
  - @cat-factory/contracts@0.207.0
  - @cat-factory/kernel@0.207.0

## 0.114.1

### Patch Changes

- 8fbc0b5: Serve the repo-sourced Claude Skills library (ADR 0024) over the mothership-mode persistence RPC —
  catalog reads and the repo-sync surface alike — so a local node with no main database can list,
  sync and RUN a skill.

  This was not a blank panel. `skillResolver` is a hard dependency for a `skill` step (and for the
  declared `{ catalogSkillId }` capabilities of ADR 0029), so an un-routed skill catalog failed the
  dispatch, and it failed partially: a skill with no sibling resources resolved from the catalog
  alone while one with resources threw out of the resource fetch, so the feature read as wired. The
  sync half went remote too — unlike the prompt-fragment library, whose sync stays mothership-owned
  because "a mothership node has no GitHub client", a mothership node now reaches GitHub by token
  delegation, so its skill link/sync/unlink routes were live and broken rather than absent.

  Adds a `skillSource` scope rule: the sync methods carry a source id and nothing else, so nothing
  positional binds them; it resolves the source's owning account server-side (memoised, sharing its
  read with the dispatched call). The global `skillSourceRepository.listByRepo` — the push-webhook
  reverse lookup across every account — stays mothership-internal.

  Adds `accountFieldUpsert` alongside it, for a record-keyed write whose conflict key is the record's
  `id` rather than its `accountId`. `accountField` binds only the account a record DECLARES, which is
  sufficient only while the row is stored under that account — an `ON CONFLICT (id) DO UPDATE` that
  does not re-`SET account_id` instead writes whichever row already holds that id, under its own
  account. The new rule binds the stored row too, so a token scoped to one account can no longer name
  another's source id and repoint their link at a repo it controls (whose `SKILL.md` bodies the other
  tenant's next sync would fold into their catalog as agent instructions); an absent row is a create
  and still passes.

  A misconfiguration now also reports itself correctly: the persistence controller's per-request memo
  overrides are applied only for repositories the deployment actually wires, so a mothership without
  the library answers `... is not wired` instead of a scope 404 that reads as a missing row.

  `GitHubInstallationRepository` gains `listActiveForAccount`, the account-scoped form of the cron
  `listActive`. The account-tier installation lookup every repo-sourced library resolves its GitHub
  credential through read EVERY tenant's installations and filtered in JS — unexposable over an
  account-scoped machine API, and unbindable by any scope rule since the method takes no arguments.
  The narrowing ("bound to the account directly, or to one of its own boards") now runs in SQL on
  both runtimes, ordered so they pick the same row, and the resolver makes one query where it made
  two.

  Both ends of a mothership deployment must have the skill/fragment library enabled: the mothership
  reflects the skill repositories into its machine-API registry only when its own library is
  configured, exactly as it does for fragments.

- Updated dependencies [8fbc0b5]
  - @cat-factory/kernel@0.206.0
  - @cat-factory/contracts@0.206.1

## 0.114.0

### Minor Changes

- 5511cdc: Finish the foundational-services catalog: it now has a management surface, a way for a board to opt
  out of an inherited service, and push-driven freshness.

  The SPA gains an account-settings tab and an advanced-tier board panel: register a service with its
  uploaded API contracts, link a repo of service definitions (a folder of them, or an explicit file
  list for one named service), and — on a board — review the merged catalog an Architect is actually
  handed, expanding a contract document through the same lazy read a consumer dispatch makes. Opening
  the catalog still transfers no document body.

  A board opts out of an inherited account service through a new suppression sub-resource
  (`POST`/`DELETE /workspaces/:ws/foundational-services/:id/suppression`, plus a
  `GET /workspaces/:ws/foundational-service-suppressions` list read). It is
  deliberately not a delete: deleting removes the board's own registration and its documents, where a
  suppression destroys nothing and is reversible. Suppressing an id the catalog does not carry, or one
  the board registered itself, is refused rather than silently written.

  Repo sources now also refresh on a GitHub push webhook, alongside the periodic sweep — the same
  fan-out the skill library uses, cutting worst-case staleness from the sweep window to seconds. That
  matters more here than for skills: a stale API contract is handed to a coder as the interface to
  write against.

  Breaking: adds a `hardDelete` method to `FoundationalServiceRepository` and a `listByRepo` to
  `FoundationalServiceSourceRepository`, so an out-of-tree implementation of either port must
  implement them; `GitHubWebhookIngest` likewise gains `queueFoundationalResync`.

### Patch Changes

- Updated dependencies [5511cdc]
  - @cat-factory/contracts@0.206.0
  - @cat-factory/kernel@0.205.0

## 0.113.9

### Patch Changes

- Updated dependencies [1441041]
  - @cat-factory/contracts@0.205.0
  - @cat-factory/kernel@0.204.0

## 0.113.8

### Patch Changes

- Updated dependencies [0b52df7]
  - @cat-factory/contracts@0.204.0
  - @cat-factory/kernel@0.203.0

## 0.113.7

### Patch Changes

- Updated dependencies [9c6ce7a]
  - @cat-factory/kernel@0.202.0

## 0.113.6

### Patch Changes

- a7aae8a: Finish the `/api/v1` external surface: a workspace usage read, and an outbound run-lifecycle push
  so an integration stops polling.

  `GET /api/v1/usage` (a `read`-scope key) serves the current billing period as ONE resource: the
  METERED budget position the spend safeguard itself acts on — including `exceeded`, which is what
  pauses runs — plus the per-`(billing, vendor, provider, model)` breakdown behind it. Splitting it
  into two endpoints would let a caller render a breakdown against a budget read a period-roll apart.
  It reads through a new `SpendService.periodUsage`, which resolves ONE `periodStart` for both
  aggregates and still issues them concurrently: composing the response from `status()` +
  `usageBreakdown()` would have reintroduced the same skew inside one request, since each derives its
  own period from the clock.
  Rows keep their `billing` discriminator and are never summed for the caller: a `subscription` row's
  `costEstimate` is illustrative (a flat-rate plan bills nothing per token), so adding it to metered
  spend would report money nobody is billed for. Workspace tier only — the account and user budgets
  are cross-workspace, and a workspace-scoped key must never learn a sibling workspace's spend.

  The workspace's ONE registered outbound endpoint now also delivers run-lifecycle events —
  `run.started`, `run.completed`, `run.failed` — beside the notification cards it already carried,
  reaching the transport through a new kernel `RunLifecycleSink` port. This exists because the HAPPY
  path raises no notification at all: a pipeline whose `merger` merges its own PR settles with an
  empty inbox, which is exactly the outcome a CI system wants to hear about. Same row, same sealed
  secret, same SSRF guard, same retry budget: the retry/signature/redirect core moved to a shared
  `signedDelivery.ts` that both families drive, because everything interesting about a delivery is a
  property of the endpoint rather than the payload.

  **Subscribing is opt-in and empty means NONE**, deliberately the opposite of the sibling
  notification `types` filter — an endpoint registered for parked decisions must not silently start
  receiving an event per run — so an existing webhook keeps byte-for-byte its current behaviour until
  someone sets `runEvents`.

  Worth knowing when reviewing: the two edges hook different places on purpose. `run.started` fires
  from `handOffLiveRun`, the one funnel every start path ends with, and is announced LAST — after the
  block is committed and the durable runner has the run — so a slow or black-holing receiver costs the
  announcement and never the run. It is still exactly once, because the claim that precedes the
  hand-off (`insertLiveRunOrConflict`) is what mints a live run, and a start path added later inherits
  it since skipping the funnel would also skip `startRun`. The terminal edges fire from the engine's
  terminal-emit funnel, because a run reaches `done` from four independent sites and a hook at each
  would compile, pass, and drift the day a fifth is added — the cost is that a durable replay can
  re-emit a settled run, so delivery is **at-least-once** with a `<runId>:<event>` dedupe id in the
  body. **Dedupe on that id, not on the body**: a replay re-stamps `sentAt`/`occurredAt`, so two
  deliveries of one transition are not byte-identical even though everything a receiver routes on is.
  That is a considered departure from the platform's atomic-claim rule: unlike a merge or a posted
  review, a repeat here is collapsed by one id comparison, so it does not earn a claim table and the
  sweeper that would come with it.

  `docs/openapi.json` shrinks by ~17k lines in the same change, with no semantic difference beyond
  the new endpoint. The generator copied every component definition into a `$defs` block on each
  schema it inlined, so the whole component set was duplicated across ten operations and every new
  public DTO cost roughly ten times its size in the committed file. Those `$defs` resolved nothing —
  the refs are rewritten into `#/components/schemas` — and generation now asserts that every `$ref`
  names an emitted component, so a DTO that actually needs hoisting fails the build instead of
  shipping a dangling pointer.

  Schema: `notification_webhooks` gains a `run_events` JSON column (D1 migration 0072 ⇄ Drizzle),
  defaulting to `'[]'`. The webhook repository is now read on the run's terminal path, so it is
  allow-listed for mothership mode (`get`/`put`/`delete`, workspace-scoped) — an un-routed method
  there would have surfaced only as a webhook that silently never fires, since both delivery paths
  are best-effort by contract.

- Updated dependencies [54e6a45]
- Updated dependencies [08e9bcc]
- Updated dependencies [a7aae8a]
  - @cat-factory/contracts@0.203.0
  - @cat-factory/kernel@0.201.1

## 0.113.5

### Patch Changes

- 16fd126: Split the six files over 2,000 lines along cohesive seams so the oxlint `max-lines` ceiling can
  drop to its floor: the engine's human decision surface into `StepDecisionController`, the
  dispatcher's running-poll branch tree and one-shot engine steps into `PollRunningController` /
  `OneShotStepController`, the Worker composition root into model-resolver / executor-deps /
  vcs-identity modules, provisioning auto-detection's Kubernetes half into its own module, and the
  Node schema's tenancy tables into `db/tables/identity.ts`. Every extraction is a behaviour-neutral
  move behind unchanged public surfaces.

## 0.113.4

### Patch Changes

- Updated dependencies [8c40f33]
  - @cat-factory/kernel@0.201.0

## 0.113.3

### Patch Changes

- Updated dependencies [9d303f0]
  - @cat-factory/contracts@0.202.0
  - @cat-factory/kernel@0.200.0

## 0.113.2

### Patch Changes

- Updated dependencies [0bffe55]
- Updated dependencies [1cd9d73]
  - @cat-factory/contracts@0.201.0
  - @cat-factory/kernel@0.199.0

## 0.113.1

### Patch Changes

- Updated dependencies [d9789f9]
  - @cat-factory/kernel@0.198.0
  - @cat-factory/contracts@0.200.0

## 0.113.0

### Minor Changes

- 123ac6f: Make a PR review's finished slices durable while it runs, and let a review stuck mid-flight be resumed for only the slices that never came back.

  The reviewer fans a large diff out across parallel subagents, then folds their findings into one structured output at the very end. Until that output arrives the step holds nothing but progress counts: `prReview.slices` and `prReview.findings` are both `[]`, because `coercePrReview` runs exactly once, from the terminal result. So the entire review lived in the container's memory until its last second, and anything that killed it first — the inactivity or max-duration watchdog, an evicted container, a wedged aggregation — threw away every completed slice and left a re-run from zero as the only option.

  The measured incident makes the cost concrete: 18m05s wall clock and 25.46M input tokens, of which the final **196 seconds** were a single silent turn generating the findings JSON. During that window all nine task-list entries read complete, `findings` was still empty, and `lastActivityAt` had frozen — because the heartbeat is fed by tool-call events and subagent transcript growth, and a long single completion produces neither. A run in that state is indistinguishable from a wedged one, and nothing could recover it: `ProgressGuard` needs a tool call to evaluate anything, the inactivity watchdog is reset by any subagent transcript byte, and the 60-minute max-duration kill discards the work instead of saving it.

  The persistence half reads what was already on the wire and being discarded. A subagent's dispatch and its terminal `tool_result` both appear on the parent stream (only its intermediate turns don't), and the slice tracker was matching that `tool_result` purely to flip a `done` flag while dropping the report inside it. It now captures that report — bounded, credential-scrubbed — and publishes the whole set on the job view as each slice lands, so the engine can fold it onto `prReview.sliceReviews` continuously rather than at the finish line.

  On top of that, `POST /executions/:id/pr-review/resume` re-dispatches a review still in `reviewing` for only the unfinished slices, handing the resumed agent the already-captured reports as `.cat-context/pr-prior-review.md` and telling it to fold their findings into its aggregate rather than re-review them. Which slices remain is derived from what the platform observed — the captured reports plus the previous attempt's task list, the only place a planned-but-never-dispatched slice is named — never from the caller.

  Notes for reviewers:

  - The channel is a **whole-value latest publish**, not the drain-on-read that `followUps` and `spans` use. Those can afford to lose a poll window; this one carries the work being protected, so a dropped poll response must cost nothing. The fold is correspondingly monotonic: it never demotes a `completed` slice back to `in_progress` and never drops a report the incoming set omits, because a resumed container's tracker knows only the slices IT dispatched and forwarding that verbatim would erase the previous attempt's reports — which are the whole point.
  - **A resume bumps `prReview.resumeAttempts`, and that feeds the step's dispatch epoch.** This is the sharpest thing to check. A container-reusing transport (a warm local pool, a self-hosted runner pool) re-attaches to a known job id rather than re-running, and the reviewer step carries none of the loop counters (`test`/`gate`/`ralph`) the epoch is otherwise derived from — so without this term every resume would mint the same job id and hand the recovery straight back to the wedged job it was meant to replace.
  - **The prior-review context file is emitted by `AgentContextBuilder`, not by a preOp** beside the reviewer's existing three. Two reasons, the second decisive: the state rides the STEP, which `RepoOpContext` deliberately does not carry (it hands ops the block-scoped run context and a `RepoFiles`); and a preOp runs only once a run repo RESOLVES, which this file needs no part of, so gating on it would silently turn a resume back into a from-zero re-review wherever repo context is unwired. The alternative considered was widening `RepoOpContext` with the step — rejected as handing every op full mutable step state to serve one field. `injectedContextFiles` therefore has two producers now, and `RunRepoOpsController` APPENDS rather than assigns.
  - **`sliceReviews` is cleared once an aggregation CONSUMES the reports, but not when the reviewer returned neither slices nor findings.** Clearing there would destroy the only record of the finished slices while recording the run as a clean PR — the exact loss this channel prevents, wearing a pass as a disguise. That is also why a partial aggregation cannot strand reports: a resume is refused unless the review is still `reviewing`, so by the time findings land the reports are either folded in or deliberately retained.
  - **`reviewedHeadSha` is preserved across a resume rather than re-stamped.** It records the head the findings were computed against, and the completed slices' findings were computed against that tree. The cost is a wider drift window on a long resume, which the `post` resolution already absorbs by folding drifted findings into the summary; re-stamping would silently re-enable inline anchoring on lines that may since have shifted.
  - **The resume control is deliberately not gated on a staleness heuristic.** `lastActivityAt` freezes on a long silent turn, so the platform cannot tell a wedged review from a quiet-but-working one, and hiding the control until it thinks it can would put it out of reach in exactly the case that motivated it.
  - Wire-shape changes, no compatibility shims (pre-1.0 policy): `prReviewStepStateSchema` gains a required-with-default `sliceReviews` and `resumeAttempts` plus an optional `resumePendingSlices`, so every construction site supplies the first two. Existing rows read as an empty list / zero.
  - A **runner-pool** deployment maps the channel through a new `sliceReviewsPath` on the response manifest. A pool that leaves it unset keeps the old all-or-nothing behaviour, and unlike the other latest-value paths that is not merely a lost live view: without it a pool-backed review has nothing for the resume to work from. Local and Cloudflare container transports forward the job view verbatim and needed no change.

  Still unaddressed, and deliberately: the frozen heartbeat itself. A long single completion produces no stream events at all, so a run in its aggregation tail still reads as wedged. A synthetic beat would defeat the inactivity watchdog outright — the only thing that kills a genuinely hung agent — and real token deltas need `--include-partial-messages` plus a rework of the call aggregator's `message.id` folding. Until then the captured reports are the tell (every slice `completed` with `findings` still empty means aggregating, not stuck), and the resume is the escape hatch either way.

### Patch Changes

- Updated dependencies [123ac6f]
  - @cat-factory/contracts@0.199.0
  - @cat-factory/kernel@0.197.0

## 0.112.0

### Minor Changes

- 99412e2: Report infrastructure that is configured but DEAD, live — the reachability watcher deferred out of
  the `cat-factory supervise` PR (#1527), plus the wire contract and the banner it produces for.

  The infra-setup banner could only say "you never set this up". A provider that WAS set up and has
  since died looked identical to a healthy one, because the projection asks whether a connection ROW
  exists, not whether anything answers. That gap is how an outage sits unnoticed for a day: every
  testing agent fails while the board reports a perfectly healthy setup.

  ## The watcher

  `sweepInfraReachability` is a runtime-neutral sweep (Worker cron ⇄ Node interval, exactly like
  `sweepPlatformHealth`). For each board it probes the SAVED environment-provider and runner-pool
  connections through new `probeSavedConnection` methods — distinct from `testConnection`, which
  answers "would this config work" for an operator at a form and asserts config safety. Re-running
  that safety assertion against an already-persisted connection would report it as an outage the
  moment a deployment tightened its URL policy, so the probe makes none.

  Opt-in (`INFRA_REACHABILITY_WATCH`): it is the one sweep that makes an outbound call per workspace
  per pass, to infrastructure the deployment does not own. That cost profile is the operator's call.

  FOUR probe results, deliberately not two, because they need four dispositions. A probe that ANSWERED
  `ok: false`, or did not answer inside the per-probe budget, is an outage. A probe that THREW, or that
  could not be asked at all (a de-registered backend kind, an unparseable config), is INDETERMINATE and
  leaves the recorded state exactly as it was — a throw is a LOCAL fault (an unresolvable connection, a
  secret bundle that would not decrypt), and blaming the operator's cluster for our own missing key is
  the "never infer a cause from the presence of an error" trap. An area with NOTHING REGISTERED is
  neither: it is knowably not an outage, so the recorded failure is forgotten while announcing nothing
  (the honest next state is the `not_defined` setup gap the snapshot recomputes, not a "recovered"
  push). Collapsing those last two — as a `ConnectionTestResult | null` return forced — meant an
  operator who fixed a dead runner pool by UN-REGISTERING it kept the open card forever, escalating
  red, since nothing but a probe clears a record only a probe writes.

  The watcher probes exactly the areas the snapshot projection would NAG about, through the one shared
  `infraSetupAreaApplies` predicate. Gating on "is the module wired" (which the projection does not)
  was strictly looser: `agentExecutorRequiresRunnerPool` is unset on Cloudflare and false on local
  mode, so a dead-but-optional runner pool raised a card, paged Slack and pushed `unreachable` for an
  area whose banner the projection then refused to render — an outbound probe cost paid to report
  something nobody could see on reload.

  `INFRA_REACHABILITY_INTERVAL_MS` now means the same thing on both facades. The Worker's `scheduled`
  tick fires every 2 minutes for every backstop it drives, so the operator's only lever on the one
  sweep that calls out per workspace did nothing there; the sweep now runs only on the tick that opens
  a new interval window — pure arithmetic on the cron's aligned timestamp, so it stays stateless in a
  fresh isolate.

  ## Where the last-observed state lives

  The contract requires publishing on TRANSITION only, which needs durable prior state — a Worker cron
  tick runs in a fresh isolate, so in-memory would re-announce every ongoing outage every pass. Rather
  than a table, the state is the workspace's open `infra_unreachable` notification and its
  `payload.unreachableAreas`, the same way the platform-health sweep uses its card's `platformAlerts`
  set. That card is already durable, already runtime-symmetric, already routed for mothership mode and
  already read by the board snapshot — so the sweep needs one batched `listOpenByType` and the
  projection folds the same record with no extra query and no probe on the board-load path. An
  operator also gets an inbox card and a Slack route for the outage, which is the right surface for it
  anyway.

  The per-area probe REASON is not persisted there: it varies between passes, and any content change
  re-delivers the card, so it would re-toast the inbox for the whole outage. It rides the live
  transition instead — which is when someone is actually looking — and the banner RENDERS it, since a
  refused connection, a rejected token and a timeout need different fixes and the generic body cannot
  tell them apart. Absent after a reload, so it is an addition to the copy rather than the only thing
  that explains the card.

  ## The wire contract and the banner

  - `infraSetupStatusSchema` gains **`unreachable`**, riding the existing setup projection rather than
    a second "your infra is broken" surface: the consequence is identical to `not_defined` (a class of
    agents cannot run) and the same operator surface fixes it, so the banner, deep-link and i18n are
    reused.
  - `isInfraSetupHealthStatus` + `INFRA_SETUP_HEALTH_STATUSES` mark it a HEALTH state, and the banner
    honours the difference: the other three statuses are stable operator decisions, so they offer a
    permanent per-user "don't notify me again"; applying that to an outage would let one click silence
    every future occurrence. An outage is session-dismissible only and it re-nags on recurrence. BOTH
    dismissals are keyed by the CLAIM (area + kind), never by the area alone, because the two cards an
    area can raise say different things about it: silencing "you haven't configured this" must not also
    silence the outage card raised after the operator configures it and the provider then dies.
  - `applyInfraSetupTransition` (contracts) is the ONE rule about which prior state a probe verdict may
    overwrite — only a `configured` area may become `unreachable` — and both delivery paths fold
    through it: the backend's snapshot projection and the SPA store's live patch. The live patch used
    to assign unconditionally, so a pushed `unreachable` rendered a red "check that the service is
    running" banner over a `not_applicable`/`not_defined` area, which then vanished on the next reload.
    A banner that contradicts the projection is worse than a late one.
  - `WorkspaceEvent` gains **`infraSetup`**, carrying the area, the new status and the probe's reason,
    which the SPA applies as a targeted one-field patch. A coarse refresh would pay the whole snapshot
    aggregate for a one-field delta.

  ## Also fixed

  `FanOutEventPublisher` delegates method-by-method, so any event it does not name is silently dropped
  for every deployment wiring the in-org fan-out — nothing throws, the browser just never updates.
  `kaizenGradingChanged` was already being dropped that way. Both it and the new `infraSetupChanged`
  now forward, and a structural test reflects `NoopEventPublisher`'s surface so the next added event
  fails there instead of in production. `NoopEventPublisher` is in turn pinned to
  `Required<ExecutionEventPublisher>`, which closes the remaining hole: every publisher method is
  OPTIONAL, so a new event added to the port compiled fine with no implementation anywhere and would
  have slipped past a guard that reflected an incomplete Noop.

### Patch Changes

- Updated dependencies [99412e2]
  - @cat-factory/contracts@0.198.0
  - @cat-factory/kernel@0.196.0

## 0.111.2

### Patch Changes

- Updated dependencies [1904eb8]
  - @cat-factory/kernel@0.195.0

## 0.111.1

### Patch Changes

- Updated dependencies [f9db6a6]
  - @cat-factory/kernel@0.194.0

## 0.111.0

### Minor Changes

- be7fe66: Let a deployment declare its infra dependencies in code: `startNode`/`startLocal` take
  `seedSharedStacks`, and a compose layer can now be an inline document or a file in another repo.

  A `StackRecipe`'s and a `SharedStack`'s `composeFiles` entries are now `ComposeFileRef`s — a bare
  in-repo path (unchanged, still the common case) or an explicit `ComposeSource`: `inline` (the
  compose document itself) or `repo` (a path in another `owner/name`, read without cloning it). A
  stack whose layers are all inline / foreign owns no repository, so `SharedStack.cloneUrl` is
  nullable.

  An `inline` layer may name where it is materialized, and that path is host-escape guarded on every
  path that accepts one: a layer that would land outside the checkout is refused when the shared
  stack is SAVED (`details.reason: 'compose_layer_escapes_checkout'`) and again before any layer is
  read or written, alongside the recipe path's existing pre-daemon check.

  Breaking (pre-1.0): `SharedStack.cloneUrl` is `string | null` rather than `string`, and
  `composeFiles` entries widen from `string` to `string | ComposeSource`. D1 migration `0070`
  rebuilds `shared_stacks` to relax the `clone_url` NOT NULL; the Drizzle mirror does the same. No
  data changes — every existing row keeps its clone URL and its plain-path layers.

### Patch Changes

- Updated dependencies [be7fe66]
  - @cat-factory/contracts@0.197.0
  - @cat-factory/kernel@0.193.0

## 0.110.5

### Patch Changes

- Updated dependencies [83fd037]
  - @cat-factory/kernel@0.192.0
  - @cat-factory/contracts@0.196.0

## 0.110.4

### Patch Changes

- Updated dependencies [7248b72]
- Updated dependencies [449d856]
  - @cat-factory/contracts@0.195.0
  - @cat-factory/kernel@0.191.0

## 0.110.3

### Patch Changes

- Updated dependencies [4ecb25c]
  - @cat-factory/kernel@0.190.0

## 0.110.2

### Patch Changes

- Updated dependencies [7ed2bc0]
  - @cat-factory/contracts@0.194.0
  - @cat-factory/kernel@0.189.0

## 0.110.1

### Patch Changes

- Updated dependencies [85efc27]
- Updated dependencies [9794c19]
  - @cat-factory/contracts@0.193.0
  - @cat-factory/kernel@0.188.0

## 0.110.0

### Minor Changes

- 57e1195: Install a service's dependencies into the checkout before the agent's first turn.

  Agents opened a fresh shallow clone and saw manifests, not dependencies — they could read that a
  library was depended upon but not what it exposed, so they guessed at APIs, re-derived type shapes
  sitting on disk, or declined work they could have done. A service frame can now declare one
  install command (autodetected alongside its validation checks) that the harness runs against the
  checkout before the agent starts.

  It shares the `validation_configs` row with the pre-PR checks so resolution costs no extra
  round trip, but the two are threaded onto the job body under deliberately different rules: the
  checks ride only a PR-opening coding dispatch, the install rides every dispatch that gets a
  checkout — reviewers and architects most of all. Either may be declared without the other.

  Every harness mode with a checkout runs it (coding, in-place fixing, multi-repo coding, both
  explore paths, conflict resolution), through one shared seam that also keeps whatever the install
  materialises out of the agent's commits — a repo whose `.gitignore` misses its dependency
  directory would otherwise open a pull request containing the whole tree.

  The install is never a gate: a failure becomes a note in the agent's prompt and the run continues.
  The note rides every agent pass, so a validation or reproduction repair round does not spend
  itself reinstalling a tree that is already there.

  Bumps the runner image (harness `src/**`) and adds a nullable `dependency_install` column to
  `validation_configs` on both runtimes.

### Patch Changes

- Updated dependencies [57e1195]
- Updated dependencies [5b19dab]
  - @cat-factory/contracts@0.192.0
  - @cat-factory/kernel@0.187.0

## 0.109.6

### Patch Changes

- Updated dependencies [e087b40]
  - @cat-factory/contracts@0.191.0
  - @cat-factory/kernel@0.186.0

## 0.109.5

### Patch Changes

- Updated dependencies [0eacaa2]
  - @cat-factory/contracts@0.190.0
  - @cat-factory/kernel@0.185.1

## 0.109.4

### Patch Changes

- Updated dependencies [1fa8ef7]
  - @cat-factory/kernel@0.185.0

## 0.109.3

### Patch Changes

- Updated dependencies [f0be8a7]
  - @cat-factory/kernel@0.184.0

## 0.109.2

### Patch Changes

- Updated dependencies [a8cc6b2]
  - @cat-factory/contracts@0.189.0
  - @cat-factory/kernel@0.183.0

## 0.109.1

### Patch Changes

- Updated dependencies [ac832b9]
  - @cat-factory/contracts@0.188.0
  - @cat-factory/kernel@0.182.0

## 0.109.0

### Minor Changes

- 22d82ac: Autodetect pre-PR validation checks from a service's repository.

  The service inspector's pre-PR validation panel gains a "Detect" button backed by
  `GET /workspaces/:ws/services/:blockId/validation-checks/detect`. It reads the repo root
  through the existing checkout-free `RepoFiles` seam and suggests check commands from what
  the repo declares — npm/composer scripts, Make/just/Task targets, and the tool configs
  checked in beside them — across node, python, go, rust, maven, gradle, dotnet, ruby, php,
  elixir and the three generic task runners.

  The endpoint writes nothing: suggestions land in the panel's unsaved rows and the operator
  saves them as before, so an unconfigured service still behaves exactly as it did.

### Patch Changes

- Updated dependencies [22d82ac]
  - @cat-factory/contracts@0.187.0
  - @cat-factory/kernel@0.181.0

## 0.108.1

### Patch Changes

- Updated dependencies [e18cfa2]
- Updated dependencies [01d4b6c]
  - @cat-factory/kernel@0.180.0

## 0.108.0

### Minor Changes

- b75a08a: Stamp every `llm_call_metrics` row with the run PHASE that spent it and its TURN ordinal, so a
  run's token burn can be attributed to the slice that caused it — the agent's own edit loop, a
  pre-PR validation repair round, a reproduction-proof repair round — instead of piling into one
  figure per agent kind (token-burn instrumentation, slice 2).

  The phase comes from whoever owns the boundary, never from a downstream guess: the harness's job
  registry stamps it on each streamed call as it is emitted, and the Pi path — whose calls are
  metered server-side by the proxy — carries it on the URL Pi is pointed at
  (`${proxyBaseUrl}/phase/<phase>`, rewritten per pass), since Pi makes those requests from a config
  with no per-request header to set. The proxy therefore serves completions on a second, optional
  phase-tagged path; the plain path is unchanged and its calls are recorded as unattributed.

  The backend advertises that route on the job body (`proxyPhasePath`, the same shape as
  `webSearch`) and the harness tags the URL only when told, so an image paired with an older backend
  — a runner pool pins its own harness image, and `LOCAL_HARNESS_IMAGE` overrides the recommended
  pin — falls back to the plain path instead of posting every model call to a 404.

  `LlmCallMetric` gains `phase: string` (`''` = unattributed, a real slice of the rollup rather
  than a dropped row) and `turnIndex: number | null` (the harness's job-scoped `seq`; NULL where the
  producing channel has no turn concept, so a proxied call is never faked into "turn 0").
  `HarnessCallMetric` gains an optional `phase`, read leniently off a runner pool's envelope.
  Both telemetry stores gain the two columns (D1 `0004_llm_call_phase_turn` ⇄ a Drizzle migration);
  existing rows keep the unattributed default and are not backfilled — the table is pruned to a
  3-day window, so they churn out on their own.

### Patch Changes

- Updated dependencies [b75a08a]
  - @cat-factory/contracts@0.186.0
  - @cat-factory/kernel@0.179.0

## 0.107.3

### Patch Changes

- 9d965c9: Make linking living fragments from GitHub work from a pasted URL end to end, and explain the
  link button whenever it is inert.

  Three field-reported failures on one surface, fixed together:

  - **Pasting a full GitHub URL into the repo picker found nothing** ("no repositories found
    for <url>"): the picker's realtime search feeds the provider's tokenized name search, which a
    URL never matches. Contracts gains a pure `parseRepoWebUrl` (GitHub `tree`/`blob`/`raw` and
    GitLab `/-/` shapes, subgroups included), and `GitHubSyncService.listAvailableRepos` now
    collapses a pasted URL to its `owner/name` slug AND resolves that slug with a direct
    `getRepo` point-read merged ahead of the search results — a reachable repo resolves even when
    the provider's search misses it.
  - **Bulk-import by directory URL**: the Documents tab takes a pasted GitHub file or folder URL,
    resolves the repo by slug (no search dependency), opens the tree browser at that folder, and
    the browser's multi-file mode gains per-file checkboxes plus a select-all row — so a whole
    directory of documents can be checked and linked as living fragments in one action.
  - **"Link as living fragment" disabled with no explanation**: the button now states, beside it,
    exactly what is missing (no source chosen / no repository / no files ticked / empty ref).
  - **Account-tier repo sources failed with "No GitHub installation is available for this
    scope"** even when the repo was browsable: the account-scope resolver matched only
    `installation.accountId`, which is null for a per-workspace PAT connect and a GitHub account
    id for local PAT mode's synthetic rows. The shared `createTierInstallationResolvers`
    (`@cat-factory/agents`, wired by both facades for fragments AND skills) now falls back
    through the account's own boards, via the new `WorkspaceRepository.listByAccount` (D1 ⇄
    Drizzle, conformance-asserted, and proxied in mothership mode under the `account` scope rule).

- Updated dependencies [9d965c9]
  - @cat-factory/contracts@0.185.0
  - @cat-factory/kernel@0.178.0

## 0.107.2

### Patch Changes

- Updated dependencies [58e06a2]
  - @cat-factory/contracts@0.184.0
  - @cat-factory/kernel@0.177.0

## 0.107.1

### Patch Changes

- Updated dependencies [65b87c1]
- Updated dependencies [df48cb0]
  - @cat-factory/contracts@0.183.0
  - @cat-factory/kernel@0.176.0

## 0.107.0

### Minor Changes

- b30cc6e: Make the three LLM input-token classes orthogonal in telemetry: `promptTokens` is now FRESH
  (uncached) input only, with `cacheReadTokens` and `cacheWriteTokens` carried beside it, so total
  input is their sum. A cache read is priced ~0.1x base input and a cache write 1.25-2x, so the old
  lumped `cachedPromptTokens` made a run re-writing its prefix every turn indistinguishable from one
  riding a warm cache.

  BREAKING (telemetry only, no migration path by design): `cachedPromptTokens` is dropped from
  `llmCallMetricSchema`, `llmCallActivitySchema`, `stepMetricsSchema` and the metrics export, and
  `cached_prompt_tokens` is dropped from both telemetry stores. `HarnessCallMetric.cachedInputTokens`
  becomes `cacheReadTokens` + `cacheWriteTokens`, and `inlineResult.usage` gains the same split.
  `llm_call_metrics` is pruned to a 3-day window, so rows carrying the old inclusive `prompt_tokens`
  semantics churn out on their own; `cacheHitRate` is now `(read + write) / (fresh + read + write)`
  and no longer needs its clamp. `cachedTokensFromUsage` is replaced by `readInputTokenClasses`,
  which returns all three classes from one usage payload (reconciling the inclusive and exclusive
  provider shapes internally, so no caller has to know which it is holding), and
  `ProxyCallObservation.cachedPromptTokens` becomes `inputTokens: InputTokenClasses`.

### Patch Changes

- Updated dependencies [b30cc6e]
  - @cat-factory/contracts@0.182.0
  - @cat-factory/kernel@0.175.0

## 0.106.0

### Minor Changes

- c47eb66: Confine every GitHub issue search to one repository, and refuse an unscoped one.

  `/search/issues` carries no scope of its own: a query with no `repo:` qualifier returns whatever
  the credential can reach. Under a GitHub App installation token that is the installation's own
  repos, so an unscoped query looked harmless — but under a PAT (local mode, and any per-workspace
  PAT connection) the same query searches every public repository on GitHub, and the issue picker
  offered strangers' issues as if they were the service's own. The repo scope is now required by
  construction rather than supplied by each caller: `buildGitHubIssueSearchQuery` takes a mandatory
  scope, `GitHubIssuesProvider.search` refuses a call without one, and the search endpoint's
  `blockId` is a required field. `buildGitHubIntakeQuery` gets the same treatment — a `bug-intake`
  schedule with no repository configured now fails its fire loudly instead of scanning all of public
  GitHub and importing whatever it found.

  The kernel port carries that requirement: `TaskSourceProvider.search`'s `scope` is now a REQUIRED
  parameter with a NULLABLE value (`TaskSearchRepoScope | null`). A repo-less source (Jira, Linear)
  states its `null`; a caller can no longer reach an unscoped search by omitting the argument, which
  is a typecheck failure. Repo-less provider implementations are unchanged — they declare fewer
  parameters.

  A reference naming ANOTHER repository is no longer resolved into the results either, so search
  results are exactly the service's own issues. Linking such an issue still works: paste its URL and
  the picker's "attach by reference" row imports it directly, which never rode the search path. A
  reference that DOES name the scoped repo is now normalised to the scope's casing before it becomes
  an external id: GitHub lookup is case-insensitive but an external id is stored verbatim, so
  `Owner/Repo#1` and `owner/repo#1` used to import as two projection rows for one issue.

  The `reason` codes these refusals carry are declared in `@cat-factory/contracts`
  (`TASK_SOURCE_READ_REASONS`) and imported by both the emit sites and the SPA, so renaming one
  fails the typecheck instead of silently degrading the SPA to the backend's untranslated prose.
  `boards_unsupported`, which the bug hunt already relied on as a bare literal on both sides, joins
  the same union.

  Wire break (pre-1.0, no migration): `POST /workspaces/:ws/task-sources/:source/search` now requires
  `blockId`, and a search from a service frame with no linked repository is refused with
  `reason: 'repo_not_linked'` rather than silently widened.

- 5abcb9e: Drain the remaining silent promise drops in the backend and stop them regrowing. Every
  `.catch(() => {})` in `backend/packages` and `backend/runtimes` now goes through
  `runBestEffort`, so a swallowed failure leaves one `warn` naming the operation with its cause
  attached, and `scripts/check-silent-catch.mjs` fails CI on a new one (a drop that genuinely needs
  no report annotates itself with `// silent-catch-ok: <reason>`). The guard counts every spelling
  of an empty handler, including a body holding only a comment — which caught two further drops:
  the mothership event relay (`HttpMachineEventClient.publish`, which additionally now treats a
  REFUSED publish as a failure rather than a delivery, so an expired machine token stops reading as
  success) and the web-search query recorder.

  `RepoOpContext` gains a required `logger`, which closes the spec-promotion hole: a tester run that
  verified requirements but promoted none used to be indistinguishable from one that had nothing to
  promote. `RunDispatcher`, `DeployerStepController` and `InitiativeLoopService` gain the logger they
  previously had no way to report through — so an issue-writeback drop, a leaked provisioning lease
  and a permanently-failing initiative tick are all visible now. `ExecutionWorkflow` binds its run
  correlation once with `logger.child` and scrubs its poll-failure causes with `redactSecrets`.

### Patch Changes

- Updated dependencies [c47eb66]
- Updated dependencies [5abcb9e]
  - @cat-factory/contracts@0.181.0
  - @cat-factory/kernel@0.174.0

## 0.105.0

### Minor Changes

- bead6df: Stop two ways a run could sit wedged with nothing left to move it.

  A self-hosted runner pool that lost a job now says so. A poll that 404s (or 410s), and a scheduler
  status that names a reclaimed runner (`evicted` / `preempted` / `oomkilled` / `node_lost` / …), are
  read as the RUNNER going away rather than the job failing, so the step is re-dispatched instead of
  burning the run's whole ~70-minute poll budget and dying `timeout`. A job-level failure vocabulary
  (`error` / `cancelled` / `timeout` / …) and a success vocabulary (`completed` / `succeeded` / …)
  likewise end the poll loop honestly; a status word that matches nothing still keeps the driver
  waiting, since wrongly killing a live run is the worse mistake. A pool is asked to route stickily
  by job id, so an eviction recovery now dispatches under a FRESH id (as the deploy path already
  did) — reusing it would have routed the retry back to the job whose runner just died, making the
  recovery a no-op for pool-backed runs.

  A manifest that defines no `release` template — or no status path — reports the gap on its
  connection test in Settings, and logs it once at registration. Each gap crosses the wire as a
  code, so the SPA renders translated copy rather than backend prose.

  The merge-review and pipeline-complete notifications are now raised BEFORE the block flips to
  `pr_ready`. Raising second meant that if the card failed to raise, the run failed but the task was
  already sitting in `pr_ready` with an empty inbox: a PR-ready task with no review action and
  nothing to re-drive it.

  Breaking for anyone importing them directly: `runnersLogic.mapJobState` is replaced by
  `runnersLogic.classifyJobStatus`, which returns `{ state, evicted? }`;
  `runnersLogic.manifestWarnings` and `RunnerBackendProvider.warnings` return
  `{ code, message }` objects rather than strings. The `(container evicted or crashed)` wording every
  transport had copied is now kernel's `CONTAINER_EVICTION_ERROR`.

### Patch Changes

- Updated dependencies [bead6df]
  - @cat-factory/contracts@0.180.0
  - @cat-factory/kernel@0.173.0

## 0.104.0

### Minor Changes

- 68f0edd: Add the Bug hunt: pick a connected tracker and one of its boards, get its open and unassigned bugs
  rated on impact against implementation complexity, and confirm one candidate to adopt it as a bug
  task running the standard bug-fix pipeline. The interactive counterpart of the recurring bug-triage
  schedule; it persists nothing of its own.
- 6dbd864: Introduce a central, pino-backed structured logger behind a kernel `Logger` port, so the whole
  domain engine can log — previously only `@cat-factory/server` and the runtime facades could, which
  forced the domain packages to swallow failures silently.

  - **New**: `Logger` / `noopLogger` / `createRecordingLogger` (`@cat-factory/kernel`,
    `ports/logging.ts`), and `runBestEffort` / `describeError` (`shared/best-effort.ts`) as the
    replacement for `.catch(() => {})`. `@cat-factory/server` exports `createPinoLogger`,
    `parseLogLevel`, `setLogLevel` and `getLogLevel` alongside the process-wide `logger`.
  - **`LOG_LEVEL`** is now honoured (`process.env` on Node/local, a wrangler var on the Worker);
    it was previously read from a global nothing ever assigned.
  - **Node/local** register `unhandledRejection`/`uncaughtException` guards and subscribe to
    pg-boss's `error` event (an unhandled one on an EventEmitter throws). The guards add the
    structured line only — both still exit non-zero, matching what Node already did (since Node 15
    an unhandled rejection is raised as an uncaught exception), so process lifetime is unchanged.

  **Breaking (pre-1.0, no shims):**

  - The logger's calling convention is now **message-first**: `logger.warn(msg, fields)`, not pino's
    `logger.warn(fields, msg)`. `Logger` is the kernel port type, no longer pino's own.
  - Every ad-hoc logger interface is **removed**, not deprecated: `PrReportLogger`,
    `PlatformMetricsSweepLogger`, `GitHubDocsLogger`, `OtelLogger`, `OtlpLogger`, `LangfuseLogger`,
    `ResetLogger`, `InfraSetupLogger`, `PlatformHealthSweepLogger`, `KeyFingerprintLogger`,
    `GateWiringLogger`, `DriveLogger`, `PropagatorLogger`. Every `logger?:` dependency now takes the
    kernel `Logger`.
  - `@cat-factory/node-server` no longer exports `pinoKeyFingerprintLogger` (the shapes match, so the
    bridge is gone). `@cat-factory/orchestration`'s `Core` gains a required `logger`.
  - **`CoreDependencies.logger` is REQUIRED**, not optional. A facade or harness assembling the bag
    by hand must pass one (`noopLogger` if it does not care) or it will not typecheck — the guard
    that would have caught the Worker shipping with no logger wired at all.

  Also fixes `MergeTrackRecordService.classify` losing the repo identity when `listChangedFiles`
  throws, which permanently broke external-merge attribution for that record.

### Patch Changes

- Updated dependencies [68f0edd]
- Updated dependencies [71ea4ec]
- Updated dependencies [6dbd864]
  - @cat-factory/contracts@0.179.0
  - @cat-factory/kernel@0.172.0

## 0.103.3

### Patch Changes

- Updated dependencies [9d8fe9b]
  - @cat-factory/contracts@0.178.0
  - @cat-factory/kernel@0.171.0

## 0.103.2

### Patch Changes

- Updated dependencies [cf2779a]
  - @cat-factory/contracts@0.177.0
  - @cat-factory/kernel@0.170.0

## 0.103.1

### Patch Changes

- Updated dependencies [1947062]
  - @cat-factory/contracts@0.176.0
  - @cat-factory/kernel@0.169.0

## 0.103.0

### Minor Changes

- 1c12289: Add a built-in **Cloudflare Workers preview** environment backend (provision type `cloudflare`,
  infra engine `cloudflare`, backend kind `cloudflare`).

  It stands up a per-PR Cloudflare Worker by driving the target repository's OWN preview workflow
  over the VCS Deployments API — create a deployment, read its statuses for readiness, post an
  `inactive` status to tear down. That is three plain HTTPS calls, so it works identically on every
  facade, including the Cloudflare Worker one that has neither a Docker daemon nor a filesystem.
  Building a Worker needs a CI runner no facade has; the repository already has one.

  This replaces the hand-pasted `remote-custom` manifest that shipped in `deploy/preview/cloudflare`,
  and it is not only ergonomics — each of the manifest's limits was structural:

  - it pinned ONE `owner/repo` and one workers.dev subdomain into JSON the operator had to
    substitute by hand. The backend resolves the repository per run from the service frame, so one
    handler serves every repository in the workspace.
  - it could not observe readiness. The statuses endpoint returns an array whose shape the generic
    response mapping cannot extract a URL from, so a `status` request would have mapped the URL
    back to `null` — the manifest therefore had to assert `ready` the moment the deployment record
    existed. The native backend reports `provisioning` until the workflow actually succeeds, and
    every reconcile point converges on the real state.
  - it rendered a missing `{{input.pullNumber}}` as an empty string, so a run with no open pull
    request (a blueprint-only pipeline, the environment self-test) provisioned an environment named
    `pr-` at a URL nothing would ever answer, recorded as `ready`. The backend refuses that run with
    a message saying why.

  It also pre-flights (`validateRepo`) that the target repository actually carries a preview
  workflow, so a missing one is a legible failure at the start rather than an environment stuck
  `provisioning` until its TTL.

  `ProvisionType` and `InfraEngine` each gain a `cloudflare` member. Both are closed unions guarded
  by exhaustive `Record`s in the SPA, so a consumer switching on either will fail its typecheck
  until it handles the new member.

### Patch Changes

- Updated dependencies [1c12289]
  - @cat-factory/contracts@0.175.0
  - @cat-factory/kernel@0.168.0

## 0.102.2

### Patch Changes

- Updated dependencies [55747c5]
  - @cat-factory/contracts@0.174.0
  - @cat-factory/kernel@0.167.1

## 0.102.1

### Patch Changes

- Updated dependencies [cab85c5]
  - @cat-factory/contracts@0.173.0
  - @cat-factory/kernel@0.167.0

## 0.102.0

### Minor Changes

- 8afa4ae: Inbound tracker webhooks: push-driven issue intake, and answering a parked requirements review
  from the ticket.

  Two asymmetries in the task-source layer close together, because they share a transport.

  **1. Intake was pull-only.** An issue entered the system when a recurring `bug-intake` schedule
  fired or a human imported it, so intake latency was the schedule interval and every idle poll cost
  a tracker API call. A new receiver — `POST /webhooks/tasks/:source/:workspaceId` — copies the
  GitHub VCS webhook path step for step: verify HMAC over the RAW body before any parse, ack 202
  fast, hand the parsed event to the facade's queue (a Cloudflare Queue on the Worker ⇄ the pg-boss
  `tracker.sync` queue on Node), and fall back to inline handling when neither is bound.

  **2. The question loop was half-duplex.** `postReviewQuestions` already posted a parked review's
  findings onto the linked issue, each with its stable id — but answers could only arrive in-app or
  over `/api/v1/runs/:runId/decisions`, so a reporter who lives in Jira had to switch surfaces.
  Those ids were designed for exactly this reply path; it is now built. This completes slice 2b of
  `docs/initiatives/headless-clarification-loop.md`.

  **A qualifying issue event FIRES the matching schedule; it does not re-implement intake.** The
  tempting shape — "the event names an issue, so import and link it" — forks a second intake path
  that would drift from `BugIntakeService`'s predicate handling, batched dedup, replace-link, pickup
  mark and block seeding. Instead a pure `issueEventMatchesIntake` predicate decides whether the
  event qualifies for a schedule's `issueIntake` config, and a match calls the same `fire` the cron
  sweeper calls. Consequences, all deliberate: the fired run may pick a **different, older** issue
  than the one that triggered it (intake is oldest-first fair queueing — the webhook drains the queue
  promptly, it does not reorder it); overlap protection is inherited, so a burst of deliveries cannot
  start a second run over a parked one; and the trigger is **non-forced**, so an on-demand schedule is
  never webhook-fired and an individual-usage model still refuses — `force` is the human run-now lever
  and a webhook has no human present. The predicate deliberately **fails open** on a field the payload
  omits: a false positive costs one no-op run, a false negative costs silent intake latency.

  **The recurring schedule is unchanged and stays on** as the reconciliation sweep for missed
  deliveries — the same webhook + sweeper duality as GitHub sync + `sweepStuckRuns`. Push is the fast
  path, never the only path.

  **Ticket replies use an explicit grammar, never natural-language guessing:**

  ```
  @cat-factory answer <itemId> <free text to end of line>
  @cat-factory dismiss <itemId>
  @cat-factory proceed | stop | extra-round
  ```

  Only lines whose first token is the trigger are interpreted, so a human can answer and discuss in
  one comment; an `answer` continues onto following lines until the next trigger. A comment with no
  trigger line is ignored entirely. Every mutation routes through the SAME service methods the SPA
  and `PublicDecisionController` call (`RequirementReviewService.replyToItem` / `setItemStatus`, then
  `executionService.requirementsReview.{incorporate,proceed,resolveExceeded}`), so the park's
  CAS/approval-id arbitration and the task's merge-preset knobs apply identically — there is no
  parallel mutation path into the engine. A reply that leaves nothing open auto-incorporates, and the
  issue gets a follow-up comment naming what was applied, what is still outstanding, and what was
  rejected and why.

  **Configuration is per connection and needs no new table.** The webhook secret rides the
  connection's existing sealed credential bag, managed through
  `GET|POST|PATCH|DELETE /workspaces/:ws/task-sources/:source/webhook` (behind `integrations.manage`)
  and returned exactly once. `POST` mints or rotates; `PATCH` edits the reply allow-list WITHOUT
  rotating, because tightening that list is what an operator does when a tracker turns out to be more
  public than they thought and answering it with a silently rotated secret would take deliveries down
  until they re-pasted it into the vendor. The workspace rides the URL path because a tracker delivery carries no
  installation id to resolve one from, and scanning every workspace's connections for one whose
  secret verifies would be a deployment-wide N+1 on every unauthenticated POST. **An unconfigured
  secret fails closed** — an empty HMAC key is one an attacker also has.

  Reply text is untrusted third-party input, and on a public repo anyone can write it. Three layers:
  the platform's own comments are refused first — by the vendor bot flag where there is one, and by
  a structural marker check everywhere, since Linear flags no bots and the default allow-list admits
  any author (an acknowledgement that could re-enter its own ingest is an unbounded comment loop, not
  a duplicate: each carries a fresh comment id, so the ingest claim cannot stop it). Then the
  connection's optional `webhookReplyAllow` list — an
  unauthorized reply is dropped **silently**, with no follow-up, because replying would confirm the
  hook exists and hand an attacker an oracle. Reply text becomes `item.reply`, the same field the SPA
  writes, capped and `redactSecrets`-scrubbed before it persists; the grammar has no verb reaching
  outside the review. Everything rendered back crosses kernel's `hostMarkdown` boundary, exactly like
  the PR verification report.

  Idempotency is an atomic claim on a new `tracker_comment_ingests` table
  (`(workspace, source, externalId, commentId)`, D1 ⇄ Drizzle), taken **before** anything is applied
  — every tracker redelivers and every queue retries, so without it one reporter comment would answer
  the same finding twice. It copies the `review_question_posts` design verbatim, including its answer
  to "what if the claimer dies": a `failed` row is re-claimable, `applied` is terminal, and a
  `pending` one is re-claimable once abandoned. A claim that ERRORS propagates rather than being read
  as "already ingested" — the apply is idempotent precisely so the queue can retry it, and swallowing
  the error would drop a reporter's answer while reporting a successful dedup. Both stores are pinned
  by a new cross-runtime parity
  suite, alongside conformance assertions that drive the whole receiver → gateway → service chain on
  each facade.

  Providers own their vendor parsing behind a new optional `TaskSourceProvider.webhook` capability
  (Jira, Linear and GitHub Issues ship one), exactly as VCS providers own theirs; a source without it
  never receives deliveries. Design, decisions and the per-slice checklist:
  `docs/initiatives/tracker-webhook-intake.md`.

### Patch Changes

- Updated dependencies [8afa4ae]
  - @cat-factory/contracts@0.172.0
  - @cat-factory/kernel@0.166.0

## 0.101.4

### Patch Changes

- Updated dependencies [200fb4d]
  - @cat-factory/kernel@0.165.1

## 0.101.3

### Patch Changes

- 323b6cf: Surface the provider's failure reason on a poll-time environment failure. `EnvironmentProvisioningService.refreshStatus` built its status patch without `lastError`, so when a reconcile flipped an env to `failed` (a provider reporting the verdict on `provisioned.error` rather than throwing — e.g. an ephemeral environment that fails to check out its branch), the reason was dropped: the env-detail surface and the environment self-test showed a generic "provisioning failed" / "status: failed" instead of the real cause. `refreshStatus` now persists `lastError` (from `provisioned.error`, cleared once not failed — mirroring the create path) and records the same reason on the failure-transition provisioning-log entry.

## 0.101.2

### Patch Changes

- Updated dependencies [f0e9bab]
  - @cat-factory/contracts@0.171.0
  - @cat-factory/kernel@0.165.0

## 0.101.1

### Patch Changes

- 640cadd: Judges: a registry seam for deployment-authored rubric evaluators that can block or bounce a run.

  Three engine paths already shared one shape — an LLM produces a structured assessment, the engine
  compares it to a per-task threshold, and the run advances, parks or escalates (requirements
  auto-pass, the `merger`, `on-call`). That latent "verdict gate" family is now promoted into a
  **fourth step-taxonomy bucket**: agents / polling gates / one-shot engine steps / **judges**.

  A judge step runs an LLM assessment of the run's work against a **rubric**, and the engine
  compares the verdict's score to the task's merge preset before disposing: advance, park for a
  human, **bounce** the producing step with the findings as its rework brief, or fail the run.
  Adding one is a registry entry, not a copy of the machinery — the same promise `registerGate`
  makes for polling gates.

  - **`JudgeRegistry`** (`@cat-factory/kernel`, app-owned + empty by default) threaded through
    `CoreDependencies.judgeRegistry` beside `gateRegistry`. A registration supplies only its
    differentiators: the rubric, an optional `parseVerdict`, `threshold`/`attemptBudget` read off
    the preset, `onFail` (`park` / `bounce` / `fail`) and `bounceTargets`.
  - **One generic driver** in the engine owns the state machine, threshold comparison, park,
    bounce budget, persistence and emission. All live state rides `step.judge` — no side table, so
    it is runtime-symmetric by construction.
  - **No per-facade wiring**: the verdict producer is an injectable `JudgeAssessor` whose default
    is built from the model-provider dependencies every facade already wires. An
    absent/disabled assessor makes every judge step a **pass-through**, so existing pipelines are
    byte-for-byte unchanged.
  - Two new merge-preset knobs, `judgeMinScore` (default 0.7) and `judgeMaxBounces` (default 1),
    mirrored D1 ⇄ Drizzle. The built-in presets' seed version bumps to 5, so existing workspaces
    are advised to reseed.
  - A rubric's per-workspace override is an ordinary **prompt-library fragment**
    (`JudgeRubric.fragmentId`), so the feature adds no rubric storage.
  - The verdict is a first-class section of the **PR verification report**, rendered through the
    `hostMarkdown` helpers and scrubbed like every other model-authored field.
  - A parked verdict is answerable from the SPA's new judge window **and** from
    `POST /api/v1/runs/:runId/decisions/judge/resolve` — both call the same service method.

  The `merger` is deliberately NOT rewritten onto this: it owns terminal block status and a real,
  credential-bearing merge, and stays a privileged built-in. See
  `docs/initiatives/judge-registry.md`.

- Updated dependencies [583fc80]
- Updated dependencies [640cadd]
  - @cat-factory/contracts@0.170.0
  - @cat-factory/kernel@0.164.0

## 0.101.0

### Minor Changes

- 968a214: Bugfix reproduction proof — the harness verification phase (Phase B)

  The container now RUNS the reproduction declaration Phase A threaded to it, so a bugfix run
  carries captured evidence that the defect was real instead of the model's own claim that it was.
  Between the agent settling and the pull request opening, the harness runs the declared check
  against two trees of the same clone and computes the verdict from the exit codes:

  - **`reproduced`** — red on the pre-fix tree, green on the tree the PR opens from. The only shape
    that is proof.
  - **`inconclusive`** — every other shape (green at base ⇒ the check does not demonstrate the
    defect; red at both ⇒ the change does not fix it, or the environment is broken), recorded
    honestly with both captured outputs and a one-line note saying which.

  **Symmetry is the safety property.** A non-zero exit at the base proves nothing on its own — a
  missing toolchain, an uninstalled dependency, or an unrelated pre-existing breakage all produce
  one. Both phases therefore run in freshly-created `git worktree` checkouts with the SAME setup
  command and the byte-identical declared test files (applied path-by-path onto the base tree, never
  a whole-tree checkout, which would drag the fix across and green it). An environmental defect
  fails both and is reported as `inconclusive`, never as proof. Red-for-the-wrong-_reason_ is not
  detected — both outputs ride the report precisely so a human can see why the base was red.

  **A failed verification is a REPAIR, not a run failure.** The captured output goes back to the
  agent — with an explicit rule against weakening the reproduction — while budget remains, and
  exhausting it degrades to `inconclusive` with the PR still opening. Deliberately a different
  disposition from pre-PR validation, which opens nothing: a red check means the WORK is broken; an
  unproven reproduction means the EVIDENCE is weak, which is a reviewer's call. A setup failure
  spends no repair rounds at all, since the agent cannot change a setup command it did not declare.

  Also in this slice:

  - The verdict reaches the engine both LIVE (`RunnerJobView.reproductionReport`, republished with a
    fresh timestamp each round so a failed verification is visible while the loop still runs) and
    terminally, on the success path, the failure path, and through a self-hosted runner pool (a new
    `reproductionReportPath` response-manifest mapping, so a pool-backed run is not left with a
    silently missing section).
  - The proof runs BEFORE the pre-PR validation loop, so validation stays the last thing to touch
    the tree and "only a green checkout opens a PR" is preserved unconditionally.
  - Per-job by construction: the worktree root is a fresh `mkdtemp` and every command, cwd and
    environment arrives as an argument, so two concurrent bugfix runs on the ONE local-native host
    process cannot check out over each other's base trees — which would surface as a false verdict
    on a pull request, not a crash. Pinned by a concurrency test.
  - A declared test file that was never `git add`ed is reported as such (the proof runs against
    committed trees, and the push would miss it too) instead of yielding a verdict computed without
    the reproduction in it.

  What the verdict will and will not claim:

  - **A green pre-fix tree no longer blames the test when the tree is not actually fix-free.** A
    resumed run's pre-fix tree is the work branch as it stood when the pass started — which, after a
    mid-run eviction, already carries that same step's committed partial fix. The check then passes
    there for a reason unrelated to the test, so the proof probes (on a green base only, memoised)
    whether the tree carries non-test work, reports that instead of "your test does not demonstrate
    the defect", and spends no repair round. An unavailable answer degrades to the plain diagnosis.
  - **Declared test paths are refused for git pathspec magic** (`:(glob)`, `*`, `?`, `[…]`) as well
    as traversal, in both the engine's sanitizer and the harness's own. `--` stops a path being read
    as a revision but not as a pathspec, so a glob would apply most of the final tree onto the base
    worktree and green it — turning a good reproduction into a false "the test does not capture the
    defect", from model-authored input.
  - **Two identical failures read as an environment problem, not an ineffective fix**, and two
    timeouts read as a watchdog kill. Neither is evidence for "the change does nothing".
  - **A timed-out tree spends no repair round**, joining setup failures and the prior-work base: in
    all three the agent is not what is wrong, so a round can only add cost.
  - **The phase carries a wall-clock ceiling** (`REPRODUCTION_TOTAL_BUDGET_MS`, 45m) on top of the
    attempt budget. Attempts multiply two full tree runs each, and the phase's own heartbeat
    deliberately stops the job inactivity watchdog from firing, so nothing else bounded it.
    Exceeding it settles `inconclusive` with its own note — a cost limit, never a verdict.
  - **The `repro-test` prompt now states that both runs happen in a fresh checkout** and that
    `setupCommand` is required when the tests need an install or build to run there. Omitting it is
    the most common way the proof ends up proving nothing.

  Both pre-PR verification phases now spawn through one shared `runCapturedCommand` seam (watchdog,
  abort handling, exit-code conventions, scrub-then-bound capture) instead of two near-verbatim
  copies, and the capture keeps a small margin so a secret straddling the rolling cut is still whole
  when it is scrubbed.

  Unconfigured means unchanged: no `reproduction` on the job body ⇒ the harness's existing path,
  byte for byte.

  Runner image bumped to `1.59.0`. The PR-report section that renders this is Phase C.

  Design + phase checklist: `docs/initiatives/bugfix-reproduction-proof.md`.

### Patch Changes

- Updated dependencies [968a214]
  - @cat-factory/contracts@0.169.0
  - @cat-factory/kernel@0.163.1

## 0.100.2

### Patch Changes

- 829a905: Refresh dependencies (direct + transitive) and bump the coding-agent CLIs baked into the
  runner image.

  - **Runner image (`@cat-factory/executor-harness`, image tag `1.57.0`)**: Pi
    `0.80.6 → 0.82.1`, Claude Code `2.1.207 → 2.1.220`, Codex `0.144.1 → 0.145.0`, and the
    two Pi extensions `@juicesharp/rpiv-todo` / `@juicesharp/rpiv-web-tools`
    `1.20.0 → 2.1.0`. The todo extension's v2 tool result keeps the `details.tasks[]` shape
    (`subject` + `pending`/`in_progress`/`completed`/`deleted` status) that
    `parseTodoProgress` reads, so live subtask progress is unaffected. The image pins in
    `deploy/backend` (`package.json` + `wrangler.toml`) and
    `RECOMMENDED_HARNESS_IMAGE` are synced to the new tag.
  - **Workspace dependencies**: refreshed the whole lockfile within the declared ranges, so
    transitive dependencies move up too. Direct bumps include `ai` 7.0.37, `@ai-sdk/*`
    (anthropic 4.0.21, openai 4.0.20, amazon-bedrock 5.0.32), `hono` 4.12.32,
    `@hono/node-server` 2.0.12, `pg-boss` 12.26.3, `undici` 8.9.0, `wrangler` 4.114.0,
    `@cloudflare/workers-types`, `@cloudflare/vitest-pool-workers` 0.18.8,
    `@aws-sdk/client-s3` 3.1095.0, `@playwright/test` 1.62.0 and `turbo` 2.10.7. Every
    version picked is the newest that already satisfies the `minimumReleaseAge` supply-chain
    gate, and the AI-SDK family stays inside the majors that pair with `workers-ai-provider`
    (`ai@^7`, `@ai-sdk/*@^4`). No third-party entries were added to
    `minimumReleaseAgeExclude`. The frontend's `typescript@^6` pin is left alone (Nuxt /
    `vue-tsc` toolchain).

- Updated dependencies [829a905]
- Updated dependencies [829a905]
  - @cat-factory/kernel@0.163.0

## 0.100.1

### Patch Changes

- Updated dependencies [c95600b]
  - @cat-factory/contracts@0.168.0
  - @cat-factory/kernel@0.162.0

## 0.100.0

### Minor Changes

- df9ca7d: Merge track record: reviewer-effort tags, deterministic change-class classification, and
  per-class auto-merge rules on merge presets.

  The merge decision no longer runs purely on the `merger` agent's self-assessment. Every merge
  decision now persists one row in a new `merge_track_records` table (full D1 ⇄ Drizzle parity)
  carrying the run's **change class**, the merger's scores, the outcome (`pending_review` →
  `auto_merged` / `human_merged` / `external_merged` / `rejected`), and a nullable **reviewer-effort
  tag** (`none` / `minor` / `major`). Per-class rollups are single SQL aggregates behind
  `GET /workspaces/:ws/merge-track-records/rollups`.

  - **Classification** is deterministic backend TypeScript over ONE VCS call (`RepoFiles.listChangedFiles`
    → the pure `classifyChangedFiles`), so it needs no harness change or runner-image bump and works
    identically on a GitLab deployment. Classes are risk-ranked (`docs` < `test` < `dependency` <
    `config` < `source` < `schema`) and a mixed diff takes the highest-ranked class present. An
    unreadable diff yields `unknown`, which never matches a per-class rule.
  - **Per-class rules** on a merge preset: `always` auto-merge, `never` auto-merge, or fall back to the
    score ceilings — resolved with `autoMergeEnabled: false` as the master switch a rule can never
    override.
  - **Effort capture** at the existing decision points: `POST /notifications/:id/act` takes an optional
    `reviewEffort` (one-tap confirm-and-tag, preselected from whether the run's PR review recorded
    findings), `POST /workspaces/:ws/merge-track-records/:id/effort` tags out of band, and a PR merged
    directly on the provider is detected from the webhook ingest and nudged with a dismissible
    `merge_tag_request` card. Tagging is never mandatory: an untagged merge records a null tag.
  - Classification and record writes are **best-effort side channels** — a failure in any part of this
    feature can never fail or block a merge.

  A merge decision's record carries the run's **provider-neutral repo identity** (`repoId` +
  `provider`), captured from the run-repo resolution the classification already performs. That is what
  makes a record attributable: external-merge detection can only look a record up by
  `(repoId, prNumber)`, since a webhook delivery knows nothing else about the run.

  **BREAKING (backend API):** `RepoTarget` (`@cat-factory/server`) and `RunRepoContext`
  (`@cat-factory/kernel`) gain a required `repoId` plus an optional `provider`, in the neutral
  `VcsRepoRef` vocabulary. Both are produced in exactly one place each, so a deployment that builds
  its own `ResolveRepoTarget` / `ResolveRunRepoContext` must supply the id; the compiler points at
  every site.

  A contract route whose request body is ALL-optional now mounts the new `optionalJsonBody`
  middleware (`@cat-factory/server`). A declared `requestBodySchema` otherwise makes the transport
  REQUIRE a body — the validator reads `c.req.json()` before the schema is consulted — so a route that
  merely gained an optional field would start rejecting the body-less calls it had always accepted.
  `POST /blocks/:blockId/merge` and `POST /notifications/:id/act` keep working with no body at all.

  **BREAKING (wire shape):** `RiskPolicy` gains a required `classRules` field (a partial map from
  change class to `thresholds` / `always` / `never`). Per the pre-1.0 policy there is no dual-read
  shim: persisted rows take the `'{}'` column default, which resolves to "use the score ceilings" for
  every class — i.e. byte-for-byte the previous behaviour — but any external consumer of the preset
  wire shape must account for the new field. The built-in preset seeds bump to version 4, so existing
  workspaces are offered a reseed. `notificationTypeSchema` also gains `merge_tag_request`, and
  `MergeDecision.reason` gains `class_auto_merge` / `class_requires_review`; both are closed unions a
  consumer may be switching on exhaustively.

### Patch Changes

- Updated dependencies [df9ca7d]
  - @cat-factory/contracts@0.167.0
  - @cat-factory/kernel@0.161.0

## 0.99.0

### Minor Changes

- 600a8ad: Headless clarification loop: questions out to the linked tracker issue (slice 2a). When a run
  started through `/api/v1` parks its requirements review on open findings, its questions can now
  be posted onto the task's linked GitHub/Jira/Linear issue — each rendered with the stable finding
  id that `POST /api/v1/runs/:runId/decisions/requirements/items/:itemId/reply` takes — so the
  clarification reaches whoever requested the work instead of waiting in an inbox nobody headless
  can see.

  Opt-in per workspace via the new `writebackQuestionsOnPark` tracker setting, with the usual
  per-task `trackerQuestionsOnPark` override; both are exposed in the issue-tracker settings panel
  and the task inspector alongside the existing PR-open/PR-merge writeback toggles. Tasks started in
  the app are deliberately unaffected: the echo fires only for runs whose recorded intake origin is
  `public-api`, and their clarification surface remains the in-app review window.

  The post is driven from the durable execution driver, whose steps replay, so it is made idempotent
  by an atomic claim on a new workspace-scoped `review_question_posts` table keyed by
  `(workspace, review, iteration, issue)` — taken before the comment is attempted, so neither a
  replay nor a crash mid-post can double-post onto an issue a human is reading. A failed post is
  recorded with its error and retried on the next replay rather than being swallowed, and a claim
  abandoned by a poster that died mid-post is re-takeable after `REVIEW_QUESTION_POST_CLAIM_TTL_MS`
  so that iteration's questions are not silently lost. The park is committed before the outbound
  call, so a slow or unavailable tracker can never delay the state change that makes the run
  answerable.

  The comment body is model-authored text landing on a host-parsed (often public) surface, so it is
  rendered through the same untrusted-text boundary as the PR verification report — auto-link
  triggers defused so a finding cannot notify a real account or cross-link an unrelated issue, code
  fences balanced, and secrets scrubbed. That boundary moved from `@cat-factory/orchestration` into
  `@cat-factory/kernel` as the `hostMarkdown` namespace to serve both consumers.

  Breaking (pre-1.0, no migration): `TrackerSettings` gains a required `writebackQuestionsOnPark`
  field and `IssueWritebackProvider` gains a required `postReviewQuestions` method, so a deployment
  with its own implementation of either must add them; `ReviewQuestionPostRepository.claim` takes a
  claim window rather than a bare timestamp; and the `commentOnGitHubIssue` writeback seam must now
  THROW when it cannot resolve the target issue instead of returning quietly (returning is the
  seam's promise that the comment landed). New tables/columns are created by the Cloudflare D1
  migration `0062` and the generated Node Drizzle migration.

### Patch Changes

- Updated dependencies [600a8ad]
  - @cat-factory/kernel@0.160.0
  - @cat-factory/contracts@0.166.0

## 0.98.0

### Minor Changes

- 3949f82: GitLab connect UI (GitLab UI-parity slice 2b). A workspace can now connect GitLab from the
  product: the source-control panel and the connect onboarding gate render a personal-access-token
  field (`components/vcs/GitLabConnect.vue`) alongside — or instead of — the GitHub App
  installation picker, showing the upstream validation error inline when a token is rejected.

  Which surfaces appear comes from a new provider-neutral capability route,
  `GET /workspaces/:ws/vcs/connect-options`, which reports what the deployment actually wired
  (`github/app`, `gitlab/pat`, both, or neither) — previously the SPA could not tell, so a
  GitLab-only deployment still offered an App picker it could not serve. The `github` store probes
  it with the connection and exposes `canConnectGitHubApp` / `canConnectGitLabPat` /
  `soleConnectProvider` / `provider`, and `disconnect()` now routes to the connected provider.

  Panel/onboarding chrome (title, icon, connection line, disconnect copy) is provider-aware:
  brand labels/icons/token URLs are shared `Record<VcsProvider, …>` constants in
  `app/utils/vcs.ts` (lifted out of `LoginScreen.vue`), and prose moved to a provider-parameterised
  `vcs.*` i18n namespace in all 10 locales. **Breaking (SPA catalog):** the GitHub-App-specific
  `github.onboarding.title` / `github.onboarding.intro` and `github.panel.confirmDisconnect` /
  `github.panel.toast.disconnected` keys are replaced by `vcs.onboarding.*` / `vcs.panel.*`, so a
  deployment overriding those keys must rename them.

### Patch Changes

- Updated dependencies [3949f82]
  - @cat-factory/contracts@0.165.0
  - @cat-factory/kernel@0.159.1

## 0.97.0

### Minor Changes

- 1f8ca48: Let a deployment declare environment-handler seeds so infra handlers are registered programmatically instead of via the SPA.

  A deployment can now pass `seedEnvironmentHandlers` (a list of `RegisterHandlerInput`) to `start()` / `startLocal()`. The server idempotently ensures each seed's `environment_connections` handler exists for **every existing workspace at boot** (a best-effort, fire-and-forget backfill over `workspaceService.list(null)`) and for **each newly-created workspace** (`WorkspaceService.create`), so a service's declared provision type resolves a handler with no manual Infrastructure → Test environments step. Seeding is idempotent (a handler already present for a `(provisionType, manifestId)` is skipped) and per-seed fault-tolerant (a bad seed is logged and skipped, never crashing boot or workspace creation).

  New: the `EnvironmentHandlerSeeder` kernel port, the deployment-neutral `createEnvironmentHandlerSeeder` (`@cat-factory/integrations`), a late-bound `getEnvironmentHandlerSeeder` dependency on `WorkspaceService`, an `environmentHandlerSeeder` handle on the container, and the exported `backfillEnvironmentHandlerSeeds` runtime helper.

### Patch Changes

- Updated dependencies [1f8ca48]
  - @cat-factory/kernel@0.159.0

## 0.96.0

### Minor Changes

- 5a58b9d: Pre-PR validation: configurable check commands run in the container before a PR is opened.

  A service frame can now declare validation commands (install / lint / test / build). After the
  coder settles, the executor-harness runs them against the checkout **before** opening a pull
  request; a failure is handed back to the agent with the captured output and the loop retries
  under a per-service attempt budget (default 3). Only a passing checkout opens a PR — an
  exhausted budget fails the step with the last captured output and opens nothing, so broken
  lint/tests never become public PR churn.

  - New per-service config store (`validation_configs`, D1 ⇄ Drizzle) resolved up the frame chain,
    managed via `GET|PUT|DELETE /workspaces/:ws/services/:blockId/validation-checks` and a new
    service-inspector panel.
  - The resolved commands ride the job body (no transport-specific wiring), so this works
    identically on the Cloudflare container, a self-hosted runner pool, and local container/native.
  - Command output is truncated and secret-scrubbed, surfaced live on the step while the repair
    loop runs and persisted on `PipelineStep.validation` for observability.
  - Unconfigured services are unaffected: no commands resolved, no loop, no job-body field.

  BREAKING for self-hosted runner pools only: a pool that wants the LIVE repair-loop view should
  map the new `validationReportPath` in its response manifest (the terminal result envelope is
  forwarded without any manifest change).

  Review follow-ups in this PR:

  - The check loop now feeds the run's inactivity watchdog. `JOB_INACTIVITY_MS` (default 10 min) is
    tighter than a single command's own watchdog (default 15 min), so a legitimately slow
    `install`/`test`/`build` previously aborted the whole run as "inactivity" instead of reporting a
    validation failure.
  - Repair prompts now name any NEW files left un-`git add`ed. The checks run against the working
    tree but only tracked edits are pushed, so an unadded file could take the loop green on work the
    pull request would never contain.
  - Checks resolve from the service frame the engine already walked to, instead of re-deriving it —
    removing two block reads from every agent dispatch.

### Patch Changes

- Updated dependencies [5a58b9d]
  - @cat-factory/contracts@0.164.0
  - @cat-factory/kernel@0.158.0

## 0.95.0

### Minor Changes

- 55e0a85: Headless clarification loop over the public API (slice 1). A run started through `/api/v1`
  can now include the requirements-review loop instead of being refused at admission: a new
  `/api/v1/runs/:runId/decisions` surface lists a run's parked human decisions (review findings
  with stable item ids, iteration/cap, the incorporated document; the proposed implementation
  forks) and answers them — reply, dismiss, incorporate, re-review, proceed, resolve-exceeded,
  choose a fork. Every route delegates to the SAME service methods the SPA controllers call, so
  the park's optimistic-concurrency arbitration and the task's merge-preset knobs apply
  identically whichever surface answers first.

  **Breaking:** the public-API scope ladder gains a `decide` rung between `write` and `admin`
  (`read ⊂ write ⊂ decide ⊂ admin`). Answering a parked decision — and starting a headless run
  on a pipeline that can park at all — requires it; a `write` key sees exactly the previous
  behaviour, refusal included. Existing keys keep their stored scope, so a `write` key that
  should now answer decisions must be re-minted as `decide`.

  Also in this slice: `POST /api/v1/jobs/:id/cancel` (an abandoned park can always be cleared,
  so the in-flight cap stays recoverable — there is deliberately no run-killing park timeout);
  a `decision` frame on both public SSE streams, which now stay open across a park; a new
  per-workspace outbound **notification webhook** (`GET|PUT|DELETE
/workspaces/:ws/notification-webhook`) delivered HMAC-signed as a `NotificationChannel`
  alongside in-app and Slack, so a headless caller learns of a park by push rather than
  polling; and `ExecutionInstance.intakeOrigin` (`ui` | `public-api`), recorded so slice 2 can
  push clarification questions to a tracker issue for headless-origin runs only. A UI-started
  task's behaviour is unchanged throughout.

  The webhook endpoint is held to the same SSRF guard as the other operator-supplied-URL
  integrations, at both boundaries: registration rejects a private/internal/cloud-metadata host,
  and delivery goes through the shared `safeFetch` so the guard re-runs on every redirect hop
  (a public endpoint cannot 302 the signed body at an internal target). Two new optional env
  vars, `NOTIFICATION_WEBHOOK_ALLOW_URL_HOSTS` / `NOTIFICATION_WEBHOOK_ALLOW_HTTP_URLS`, widen
  it for a receiver on an internal host or a developer's `localhost`; they are scoped to
  webhooks alone, so they never widen the runner-pool or environment guard. One delivery is
  bounded by a total wall-clock budget rather than an attempt count, because the notification
  fan-out is awaited by the engine step that raises it. The webhook counts as an EXTERNAL
  notification channel, so under mothership mode the mothership — which holds the key its
  signing secret is sealed with — is the side that delivers it.

  Also exported: `assertSafePublicUrl`, the provider-neutral URL guard now shared by the
  environment, runner-pool and notification-webhook integrations (previously an
  environment-labelled private function), so an SSRF bypass is fixed in one place for all of
  them.

  See `docs/initiatives/headless-clarification-loop.md`.

### Patch Changes

- Updated dependencies [55e0a85]
  - @cat-factory/kernel@0.157.0
  - @cat-factory/contracts@0.163.0

## 0.94.1

### Patch Changes

- Updated dependencies [ecd68c5]
  - @cat-factory/contracts@0.162.0
  - @cat-factory/kernel@0.156.0

## 0.94.0

### Minor Changes

- 7c6bd77: Per-workspace GitLab PAT connect flow (backend, GitLab UI-parity slice 2a). A hosted
  deployment can now connect a workspace to GitLab by pasting a personal access token: the
  token is validated against the account's identity, sealed at rest (a new `access_token`
  column on `github_installations`, mirrored across D1 + Drizzle), and the workspace's repos
  are browsed / linked / synced through the SAME GitHub-shaped projection surface. A new
  `ProviderRoutingGitHubClient` routes each installation-keyed call to the App or GitLab client
  by the connection's stored provider, so a deployment can serve GitHub App and GitLab PAT
  workspaces side by side. New endpoints: `GET|POST|DELETE /workspaces/:ws/gitlab/connection`
  (503 until GitLab connect is wired). The connect UI is a follow-up slice.

### Patch Changes

- Updated dependencies [7c6bd77]
  - @cat-factory/kernel@0.155.0
  - @cat-factory/contracts@0.161.0

## 0.93.0

### Minor Changes

- 696da88: Finish the registry-DI migration: normalize the observability-provider registry to the same
  app-owned class shape as the other registries. `ObservabilityProviderRegistry` is now a class
  (`register`/`get`/`kinds`) and `defaultObservabilityRegistry()` a factory that pre-loads the
  Datadog adapter, replacing the interim `Partial<Record<kind, factory>>` record — a breaking
  change to the exported surface (pre-1.0, no shim). Each facade now injects
  `defaultObservabilityRegistry()` into `RegistryReleaseHealthProvider`. The initiative's every
  module-global plugin registry is now app-owned DI; the tracker is converted to
  `backend/docs/adr/0028-registry-di.md`.

### Patch Changes

- 239788a: Security hardening (round 2, SSRF/injection batch):

  - **SEC-2** — the inline model-provider path now routes local-runner endpoints through the
    redirect-revalidating `fetchLocalRunner` (an optional `fetch` on `openAiCompatibleResolver`), so
    an inline LLM call can't be 302'd to the cloud-metadata endpoint. Matches the proxy path.
  - **SEC-7** — the Confluence document provider reuses the shared `safeFetch`, which strips the
    Basic-auth header and body on a cross-origin redirect (the local copy that kept them is removed).
  - **SEC-9** — explicit `bodyLimit` backstops on the unauthenticated `/github/webhooks` and
    `/vcs/:provider/webhooks` raw-body reads (25 MB) and the LLM proxy `/v1/chat/completions` route
    (32 MB), so an anonymous/session caller can't pin memory before the HMAC/session check.
  - **SEC-10** — the initiative `slug` wire field is constrained to a lower-kebab grammar, so no
    `/`/`..` segment can reshape a committed `docs/initiatives/<slug>/…` path.
  - **`/vcs` fail-closed fix** — `/vcs` is added to the auth gate's `PUBLIC_PREFIXES`, so the
    provider-neutral VCS webhook receiver is reachable on an auth-enabled deployment (it verifies its
    own per-provider signature/token, like `/github`).

- Updated dependencies [0e2799e]
- Updated dependencies [239788a]
  - @cat-factory/kernel@0.154.2
  - @cat-factory/contracts@0.160.1

## 0.92.1

### Patch Changes

- 770f926: Upgrade the Vercel AI SDK family to v7 (paired with `workers-ai-provider@4`) and refresh the rest of the dependency tree within the supply-chain release-age gate.

  - **AI SDK v7 / Cloudflare Workers AI**: `ai@^6 → ^7`, `@ai-sdk/openai`/`@ai-sdk/anthropic`/`@ai-sdk/provider` `^3/^4 → ^4`, `@ai-sdk/openai-compatible@^2 → ^3`, `@ai-sdk/amazon-bedrock@^4 → ^5`, and `workers-ai-provider@^3 → ^4`. This is now possible because `workers-ai-provider@4` accepts `ai@^7` peers, lifting the pin that previously held the family at v6. The only code change required is reading the AI SDK v7 usage shape (`usage.inputTokenDetails.cacheReadTokens` in place of the removed `usage.cachedInputTokens`).
  - **Dependency sweep**: within-range refresh of the tree plus targeted bumps of `@cloudflare/workers-types@^4 → ^5` (aligns with the `wrangler@4` peer), `@opentelemetry/exporter-*-otlp-http@^0.220 → ^0.221` (lockstep with the `@opentelemetry/*@2.10` SDKs), and `oxfmt`, `undici`, `pg-boss`, `@nuxtjs/i18n`, `happy-dom`, `vue-tsc`, `wrangler` and others to their latest release-age-compliant versions. The `@cat-factory/executor-harness` runner-image deps are deliberately untouched.

- Updated dependencies [770f926]
  - @cat-factory/kernel@0.154.1

## 0.92.0

### Minor Changes

- 93496b0: Stream per-call LLM telemetry while a run is in flight, and stop losing the cause of death when a local container dies mid-run.

  A `pr-reviewer` run whose container died 18 minutes in surfaced no slices and no calls — not a subagent-handling regression, but three separate gaps that together made the run unfalsifiable: its telemetry was never written, its container logs were deleted before anyone could read them, and the error it did report described a symptom of the cleanup path rather than the failure.

  - **Per-call telemetry now streams.** The harness buffers each model call as its CLI yields it and drains it on the next poll (`RunnerJobView.callMetrics`, drain-on-read like `spans`/`followUps`); `ContainerAgentExecutor.pollJob` records it immediately. It previously arrived only on the terminal `RunnerJobResult.callMetrics`, so a run that died mid-flight reported ZERO calls no matter how many tokens it had spent — precisely the run worth inspecting. Subagent calls stream too, which matters most: that is where a long review spends its tokens and where the parent stream goes quiet. A call whose tokens are not final yet is the one exception: a CLI that reports only a cumulative total is costed at the end (`attributeCumulativeUsage`), and since a streamed call is already recorded, such a call is withheld until it is complete rather than stored as a zero-token row.

  - **Recording a call twice is now a no-op instead of a duplicate row.** Each metric carries a job-scoped `HarnessCallMetric.seq` stamped by the harness and stable across both channels, so the live drain and the terminal list mint the same `<jobId>-hc-<seq>` id, and `LlmCallMetricRepository.record` ignores an id it already holds (`onConflictDoNothing` on Drizzle, `ON CONFLICT(id) DO NOTHING` on D1 — targeted at the id, so neither store silently swallows a genuinely malformed row). First write wins deliberately — an upsert would recompute a row's stored prompt delta against a chain tip that has since moved on. The executor also skips re-offering a call the live drain already stored, so the terminal write costs one round-trip per NEW call instead of re-walking the whole list. A self-hosted runner pool opts into the live channel with the new `callMetricsPath` response mapping.

  - **A promptless call can no longer break the prompt-delta chain.** `latestChainTip` now ignores rows with `messageCount === 0` (a subagent call carries no re-sendable request transcript). Those interleave with the parent's calls in record order now that telemetry streams live, and a tip that can't be chained onto made every following parent call store its whole prompt instead of a delta — losing the compression the chain exists for on exactly the subagent-heavy runs it matters most for.

  - **An exited container no longer blocks its own replacement (local mode).** `DockerRuntimeAdapter.endpoint()` let `docker port`'s non-zero exit ("no public port '8080/tcp' published for …") escape, but `find()` returns exited containers by design and `resolve()` reads an endpoint-less container as absent. The throw therefore skipped the remove-and-recreate recovery in `dispatchPerRun` and surfaced that CLI line as the run's recorded cause of death. A dead container now resolves to `undefined` per the port contract; a fault against a still-RUNNING container still throws, so the spin-up path keeps its fail-fast diagnostic.

  - **A container that dies mid-run leaves a post-mortem.** The poll now captures the container's exit state (new `ContainerRuntimeAdapter.exitState()`, including whether the runtime OOM-killed it) plus a tail of its own logs onto the failed view's `detail`, and the engine carries that through `recoverContainerEviction` onto the recorded failure. `release()` removes the container as the run settles, so this was the only surviving record of why the harness process went away — and it was being thrown away. Container logs were previously captured only on the spin-up path, never for a container that died after a healthy start. Since a re-dispatch also removes the dead container, the FIRST death's post-mortem is retained on the step (`PipelineStep.firstEvictionDetail`) and folded into the failure alongside the last one — with a crash budget of 1, the first death is usually what explains the run. The text is secret-scrubbed before it is persisted.

  Not addressed here: a PR review's `slices` are still written only when the reviewer job completes, so a killed review still shows none. That is a work-product persistence change, not an observability one.

### Patch Changes

- Updated dependencies [93496b0]
  - @cat-factory/kernel@0.154.0
  - @cat-factory/contracts@0.160.0

## 0.91.2

### Patch Changes

- Updated dependencies [15249df]
  - @cat-factory/contracts@0.159.0
  - @cat-factory/kernel@0.153.0

## 0.91.1

### Patch Changes

- 8254367: Lint tightening: ratchet oxlint `complexity` from 40 to its step-2 target of 30.

  Refactored every function above complexity 30 along cohesive, behaviour-neutral seams (helper
  extractions / options-object bundles), including the god-file offenders: the Worker
  `buildContainer` registry resolution → a `container-registries.ts` sibling, `RunDispatcher`'s
  settled-poll branch tree → a new `PollCompletionController`, and `ExecutionService.stepInstance`'s
  re-entrancy predicate → a `reentrancy.logic.ts` sibling (both of which also shrink their host
  god-files). The executor-harness image tag is bumped (harness `src/**` changed).

## 0.91.0

### Minor Changes

- 2323df1: Enable/disable + pinned default for the two credential pools (subscription tokens and
  direct-provider API keys).

  A pool can hold several credentials "for the same thing" — several subscription tokens per
  (workspace, vendor), or several API keys per (scope, provider). Previously the only lever was
  delete, and selection was pure usage-aware rotation. Now each credential carries two lifecycle
  flags, editable via a new `PATCH` endpoint (`{ enabled?, isDefault? }`):

  - **Enable / disable** — a disabled credential stays in the pool (still listed and
    re-enablable) but is never leased and no longer makes its vendor/provider "configured", so
    the model picker and pipeline-start guard treat an all-disabled provider as unconfigured.
  - **Pinned default** — one credential per group can be pinned as the preferred one; it is
    leased in preference to usage-aware rotation. At most one default per group (setting one
    clears the prior), and a disabled default is ignored (leasing falls back to rotation among
    the remaining enabled credentials).

  New wire fields `enabled` / `isDefault` on `apiKeySchema` + `vendorCredentialSchema`; new
  `PATCH /workspaces/:ws/vendor-credentials/:id`, `PATCH …/api-keys/:id` (workspace + `/me` +
  account scopes). Persisted as `enabled` / `is_default` columns mirrored across all three stores
  (D1, Drizzle/Postgres, and the local `node:sqlite` credential store), with the lease/list
  queries filtering disabled and ordering the default first. The **LLM Vendors** UI gains a
  default toggle + an enable/disable switch per credential. A new cross-runtime conformance suite
  asserts the enable/disable + default behaviour against every store.

  This is an additive, backwards-compatible schema change: existing credentials read as enabled
  and not-default, so behaviour is unchanged until an operator opts in.

### Patch Changes

- Updated dependencies [2323df1]
  - @cat-factory/contracts@0.158.0
  - @cat-factory/kernel@0.152.0

## 0.90.0

### Minor Changes

- 71bd63f: Review adherence reports + per-agent effort self-assessment, surfaced in run details.

  - **Best-practice fragments are now fed granularly.** Each selected best-practice standard is
    folded into an agent's system prompt as its OWN delimited, labelled block (carrying a stable
    id and its human title) instead of one `\n\n`-joined blob, so an agent can tell the standards
    apart and cite one by title. Fragment titles are threaded end-to-end (resolver → resolved
    fragments → prompt composer).
  - **Code + PR review agents report best-practice adherence.** The `reviewer` companion and the
    `pr-reviewer` now return a `fragmentAdherence` list — per standard, a 1..10 rating of how well
    the reviewed change/PR adheres plus the issues that standard surfaced — recorded on the step
    (`PipelineStep.fragmentAdherence`) and surfaced in run details + the PR-review window. When no
    best-practice standards were reachable, the reviewer states so explicitly.
  - **Every container agent reports effort.** Each container agent is asked to write a short effort
    self-assessment (how hard the work was, what reduced its effectiveness, the key obstacles) to a
    sentinel file the harness lifts onto the result; the engine records it (`PipelineStep.effortReport`)
    and it is shown in run details. Flows through both runtimes (verbatim on Cloudflare/local, coerced
    on the self-hosted runner pool). Requires the bumped executor-harness image.
  - **Fragment management UI.** The fragment editor gains an "auto-generate title" button (an inline
    LLM call) and inline editing of a hand-authored fragment's title / summary / body / tags.

### Patch Changes

- Updated dependencies [71bd63f]
  - @cat-factory/contracts@0.157.0
  - @cat-factory/kernel@0.151.0

## 0.89.0

### Minor Changes

- 3c7d62b: Custom test-infrastructure providers can now define autodetection. A `custom` manifest type may
  declare an optional `detect(ctx)` hook (`RegisteredCustomManifestType`) that recognizes the
  provider from a repo's shape (multi-file signatures via the new kernel probe primitives), locates
  its manifest, and extracts a config seed. `detectServiceProvisioning` runs the selected type's
  hook, arbitrates across every registered type's hook when none is selected
  (`detectCustomProviderAcrossTypes`), and falls back to custom arbitration as a last resort after
  the kubernetes/compose sweep.

### Patch Changes

- Updated dependencies [3c7d62b]
- Updated dependencies [3c7d62b]
  - @cat-factory/contracts@0.156.0
  - @cat-factory/kernel@0.150.0

## 0.88.18

### Patch Changes

- Updated dependencies [916278b]
  - @cat-factory/contracts@0.155.0
  - @cat-factory/kernel@0.149.0

## 0.88.17

### Patch Changes

- Updated dependencies [1bcb223]
  - @cat-factory/kernel@0.148.5

## 0.88.16

### Patch Changes

- 91ea6b7: observability: forward the container agent's liveness heartbeat so a quiet-but-alive run stops looking wedged.

  A long, output-less phase — a `pr-reviewer` reading hundreds of files, say — advances the harness heartbeat but not its subtask counts. That heartbeat was dropped at the transport boundary: `ContainerAgentExecutor.pollJob` forwarded phase/progress/follow-ups but never `view.heartbeatAt`, so `agent_runs.updated_at` only moved on a progress change. A live-but-quiet run was indistinguishable from a wedged one to the DB, the stale-run sweeper (keys off `updated_at`), and the UI (a client clock off `startedAt`, not a server liveness signal). This is the observable-heartbeat gap ADR 0026 P3 named (its D2.1/D3 restored progress + the watchdog heartbeat, not the observable one).

  `RunnerJobView` now carries `heartbeatAt` (Cloudflare/local cast the harness view verbatim; the runner pool maps an optional `heartbeatPath`), `pollJob` forwards it as the running `AgentJobUpdate.lastActivityAt`, and the engine folds it onto the step's new `lastActivityAt` **throttled** (`shouldPersistActivity`, a 20s window well under the 5-min sweeper lease) — so a live-but-quiet run keeps `updated_at` fresh while a wedged run's frozen heartbeat correctly lets it go stale. The field rides the step JSON, so both runtimes persist it with no migration. The SPA surfaces "active Ns ago" in `StepRunMeta` (and thus the PR-review window), distinct from the elapsed clock. No harness change (the `heartbeatAt` field already exists), so no image bump.

- Updated dependencies [91ea6b7]
  - @cat-factory/contracts@0.154.2
  - @cat-factory/kernel@0.148.4

## 0.88.15

### Patch Changes

- Updated dependencies [3999941]
  - @cat-factory/kernel@0.148.3

## 0.88.14

### Patch Changes

- 021f2a0: Surface + remediate ENCRYPTION_KEY drift (ADR 0026 D6.2/D6.3), building on the D6.1 fingerprint
  and typed `SecretDecryptError`.

  - A new `SealedSecretInventory` kernel port (`listSealed` + `drop`) is implemented per runtime
    (D1 + Drizzle, asserted by `defineSealedSecretInventorySuite`) over `environment_connections`
    and `observability_connections`. Adding a source is a change to the inventory pair, never the
    sweep.
  - `sweepKeyDriftAndRaise` (runtime-neutral) attempts a decrypt of every sealed secret, buckets by
    `reason`, and raises ONE `key_drift` notification per affected workspace — listing the affected
    credentials by source / id / label / reason / seal time (never the value), de-duped on that set
    and auto-cleared when a workspace recovers. It runs at Node boot and on the Worker's daily cron.
  - Remediation (D6.3) is explicit + per-secret: the `key_drift` card's action drops every credential
    it lists, and a `pnpm --filter @cat-factory/node-server key-drift:drop` operator CLI drops one.
    Both flip the owning connection to needs-re-entry (env → soft-delete, observability → row delete)
    and state that restoring the previous ENCRYPTION_KEY recovers the values instead — never automatic.
  - Adds the `key_drift` notification type (contracts) + its inbox card copy across all locales.

- Updated dependencies [021f2a0]
- Updated dependencies [021f2a0]
  - @cat-factory/contracts@0.154.1
  - @cat-factory/kernel@0.148.2

## 0.88.13

### Patch Changes

- Updated dependencies [a14fe03]
  - @cat-factory/contracts@0.154.0
  - @cat-factory/kernel@0.148.1

## 0.88.12

### Patch Changes

- Updated dependencies [8053837]
  - @cat-factory/contracts@0.153.0
  - @cat-factory/kernel@0.148.0

## 0.88.11

### Patch Changes

- Updated dependencies [511076d]
  - @cat-factory/kernel@0.147.3

## 0.88.10

### Patch Changes

- Updated dependencies [7f54858]
  - @cat-factory/contracts@0.152.2
  - @cat-factory/kernel@0.147.2

## 0.88.9

### Patch Changes

- 26f7c18: Lint ratchet: `max-statements` from its pinned baseline (157) down below 60 (no behavioural
  change).

  Every function above 50 statements is split along a cohesive seam so the `.oxlintrc.json`
  `max-statements` ceiling can drop from 157 to 50. All extractions are behaviour-neutral (moved
  code verbatim into well-named helpers, destructured at the top so the remaining bodies are
  unchanged; verified by the package unit suites and the cross-runtime conformance suites on real
  Postgres/workerd in CI):

  - **`createUiModals`** (`app/stores/ui/modals.ts`, 157): the flat bag of modal refs + open/close
    handlers is grouped into cohesive sub-factories (`createHealthAdvisoryModals`,
    `createDocumentTaskModals`, `createIntegrationPanelModals`, `createSettingsModals`,
    `createInfraModals`, `createAiOnboardingModals`, `createMiscModals`) composed behind the shared
    hub came-from markers; the returned public surface is unchanged.
  - **the LLM proxy handler** (`server/modules/llmProxy/LlmProxyController.ts`, 108): the workers-ai
    ceiling, the in-process dispatch, upstream resolution (local runner vs the DB-backed key pool),
    and the response relay are extracted into `applyWorkersAiCeiling` / `dispatchInProcess` /
    `resolveUpstreamTarget` / `relayUpstream` behind a per-call `ProxyCallContext`.
  - **`registerCoreControllers`** (`server/app.ts`, 77): the controller mounts split into
    `registerRootControllers` / `registerWorkspaceControllers` / `registerWebhookControllers`
    (exact mount order preserved).
  - **`resolveAuxiliaryRepos`** (`server/agents/ContainerAgentExecutor.ts`, 75),
    **`checkEntityCallScope`** (`server/persistence/rpc.ts`, 63), and the screenshot handler
    (`server/modules/artifacts/HarnessArtifactController.ts`, 51) are split along their existing
    seams.
  - **`provisionRecipe`** (`integrations/modules/compose/ComposeEnvironmentProvider.ts`, 94):
    decomposed into `preflightRecipe` / `readRecipeComposeFiles` / `materializeRecipeEnvFiles` /
    `runComposeBuildAndUp` / `runRecipeStepsAndGate` / `resolvePreviewUrl`. `bringUp`
    (`SharedStackService.ts`, 60), `buildKubernetesRecommendation` /
    `detectFrontendConfig` (`environments/*-detect.logic.ts`, 58/52) split similarly.
  - **`buildNodeContainer`** (`node/container.ts`, 63), the stale-run sweeper `tick`
    (`node/execution/pgBossRunner.ts`, 54), `bootServer` (`node/server.ts`, 53), and
    `buildLocalContainer` (`local/container.ts`, 51) extract cohesive sub-builders / sweeper
    closures.
  - **the coder container callbacks** (`executor-harness/src/coding-agent.ts`, 67/63) extract
    `prepareCodingCheckout` / `finalizeCodingRun` / `prepareMultiRepoCheckouts` /
    `pushMultiRepoLegs`. The harness image tag is bumped accordingly.
  - **orchestration**: `createCore` (`container.ts`, 71), the `RunDispatcher` step handlers
    (66/60), `SandboxRunService` (59), and `CompanionController` (56) split along cohesive seams.

## 0.88.8

### Patch Changes

- 972a1bd: Lint ratchet: complete `max-params` (20 → 6, its final target; no behavioural change).

  Refactored every function above the target from a long positional list to a bundled
  argument, walking the `.oxlintrc.json` ceiling down 20 → 10 → 8 → 6:

  - **DI builders → dependency objects:** the Node `buildNodeContainerExecutor`
    (`NodeContainerExecutorDeps`), the Worker `selectAgentExecutor` / `buildContainerExecutor`
    (a shared `WorkerExecutorDeps`), `buildResolveTransport`, and `selectEnvConfigRepairer`.
  - **Loop-invariant step context → one object:** the deployer fan-out (`DeployerFanOut`
    threaded through `advanceDeployerFrames` / `settleDeployerFrame` / `settleDeployerFailure` /
    `completeDeployerStep`), the companion `applyAssessment` grading bundle, the Tester
    `failTester` failure bundle, and the gate `dispatchGateHelper` helper bundle.
  - **`ExecutionService.start(...)` trailing options → `RunStartOptions`** (new
    `runStartOptions.ts`, keeping `ExecutionService.ts` under the `max-lines` ceiling), updated
    at every call site.
  - **Callback / identity bundles:** `GitHubSyncService.syncResource` handlers,
    `RequirementReviewService.runWriterForChunk` (resolved model + grounding),
    `EnvironmentConnectionService.runProviderValidate` repo target, `SkillSourceService.syncSkillDir`
    dir descriptor, and the executor-harness `streamCli` CLI descriptor.

  The executor-harness bump republishes the runner image (its `streamCli` refactor touches
  `src/**`); the three image-tag pins + `RECOMMENDED_HARNESS_IMAGE` are synced to `1.50.1`.

## 0.88.7

### Patch Changes

- 492d0a2: Lint ratchet: complete `max-depth` (5 → 4, its final target; no behavioural change).

  Refactored the 18 depth-5 sites down to ≤ 4 by hoisting the innermost loop bodies into
  helpers along cohesive seams:

  - Extract a shared `parseSubtasks` into `@cat-factory/kernel` (`domain/subtasks.logic.ts`)
    and replace the four duplicated row→domain copies in the D1 and Drizzle bootstrap /
    env-config-repair repositories (removing the 4× duplication as well as the depth).
  - Split the two Worker `ExecutionWorkflow` poll loops (`drivePollLoop` / `driveGatePollLoop`
    - a shared `pollOnce`), the benchmark harness's per-task fixture dispatch, the seed-dump
      child scan and the env-config bootstrap commit/PR path in `@cat-factory/integrations`, the
      Workers-AI assistant tool-call conversion, and the OTEL conformity metric fold into helpers.
  - Lower `max-depth` to `4` in `.oxlintrc.json`.

- Updated dependencies [492d0a2]
  - @cat-factory/kernel@0.147.1

## 0.88.6

### Patch Changes

- Updated dependencies [a10bfdf]
  - @cat-factory/kernel@0.147.0

## 0.88.5

### Patch Changes

- Updated dependencies [f2b25ba]
  - @cat-factory/kernel@0.146.0
  - @cat-factory/contracts@0.152.1

## 0.88.4

### Patch Changes

- Updated dependencies [e679977]
  - @cat-factory/contracts@0.152.0
  - @cat-factory/kernel@0.145.1

## 0.88.3

### Patch Changes

- Updated dependencies [9450415]
  - @cat-factory/contracts@0.151.0
  - @cat-factory/kernel@0.145.0

## 0.88.2

### Patch Changes

- 2138e45: GitHub doc fragments/context can now be linked from any repository the workspace
  can actually read, not only ones whose owner matches the workspace's GitHub
  installation account. `GitHubDocsProvider` dropped its preemptive owner-string
  guard: every read already rides the workspace's own installation/PAT token, and
  GitHub scopes that token to what it may read, so tenant isolation is enforced by
  the token itself — a foreign tenant's private repo still 404s at the read. The
  guard was also blocking legitimate reads (a public guidelines repo owned by
  another account, or a PAT that spans accounts in local mode), which raised a
  confusing "outside this workspace's installation" error for a repo the token
  could genuinely reach.

## 0.88.1

### Patch Changes

- Updated dependencies [54c44bb]
  - @cat-factory/contracts@0.150.0
  - @cat-factory/kernel@0.144.0

## 0.88.0

### Minor Changes

- a53bbf7: Attach repo files as task context via a repository picker. When a repo-backed
  document source (GitHub / GitLab) is selected in the context-document picker, the
  user now searches for a repository (reusing the shared server-side repo search),
  then picks one or more files from it — either by searching the whole tree by path
  or by browsing it with the monorepo directory browser, which now supports
  multi-pick in file mode. Backed by a new recursive repo-tree read (`listTree` on
  the VCS/GitHub client ports, `GET /github/repos/:id/files`) so file search is a
  single cached call per repo instead of walking the tree level-by-level.

### Patch Changes

- 009bc97: Surface the real cause when a task attachment can't be linked, instead of a bare
  "1 attachment could not be linked".

  - The context-linking path no longer swallows the error: `linkPending` now returns
    each failure with the server's own message, HTTP status, backend code, and the backend
    `details` bag, and the add-task toast shows the specific reason (e.g. a GitHub
    permission/visibility error) with a one-click "Copy details" button that puts a full
    diagnostic report on the clipboard (including the upstream GitHub status, kept distinct
    from the mapped HTTP status).
  - `GitHubDocsProvider` classifies a failed doc read (403 no-access, primary/secondary
    rate-limit, 404/not-found, other) into a specific, actionable domain error carrying the
    repo coordinates + HTTP status, and logs it with full context — so a permission problem
    is no longer masked as an opaque 500 and is diagnosable server-side.
  - `GitHubApiError` now retains the `rateLimited` (`x-ratelimit-remaining: 0`) signal
    structurally, so a GitHub PRIMARY rate-limit (reported as a 403, not a 429) is
    classified as a rate-limit rather than a spurious "missing read access" permission error.
  - Added a reusable `copyAction` toast-action helper on `useCopyToClipboard`.

- Updated dependencies [0abcf31]
- Updated dependencies [6709dc4]
- Updated dependencies [a53bbf7]
  - @cat-factory/contracts@0.149.0
  - @cat-factory/kernel@0.143.0

## 0.87.0

### Minor Changes

- 5771e05: Make GitHub available as a document source automatically once the GitHub App (or PAT) is
  installed, and let a task be authored with no source connected yet without losing entered
  data.

  - **GitHub docs are now implicitly connected.** A new optional
    `DocumentSourceProvider.resolveImplicitConnection(workspaceId)` port method lets a source
    that rides an out-of-band credential report itself connected without a stored marker row.
    `GitHubDocsProvider` implements it against the workspace's installed App (present ⇒
    connected), and `DocumentConnectionService.listConnections` / `getConnection` /
    `requireConnection` honour it (a stored credentialed connection still wins and is never
    duplicated). This mirrors how the GitHub-issues task source is already available the moment
    the App is installed, so GitHub docs no longer need a separate "connect" step and can be
    searched / imported / linked as task context right away.

  - **Document reads are now tenant-scoped.** `DocumentSourceProvider.fetchDocument` /
    `probeVersion` take the `workspaceId` (like `search` already did), and `GitHubDocsProvider`
    resolves the installation to read with via `getByWorkspace` — requiring the doc's owner to
    match the workspace's own installation account — instead of a deployment-wide scan by owner.
    A crafted `owner/repo:path` external id can therefore no longer reach another tenant's repo
    through a different workspace's installation token.

  - **Connect a source inline from the new-task form.** In the add-task modal the "Context
    documents" / "Context issues" sections previously showed a disabled Attach button when no
    source was connected. They now offer a "Connect a source" action that opens the source's
    connect modal over the task form — both are root-mounted with independent open flags — so
    the user's in-progress title/description/context is preserved instead of being lost to a
    navigation away.

### Patch Changes

- Updated dependencies [5771e05]
  - @cat-factory/kernel@0.142.0

## 0.86.6

### Patch Changes

- Updated dependencies [f34ddf1]
  - @cat-factory/kernel@0.141.0

## 0.86.5

### Patch Changes

- 6ad20d0: Fix the N+1 in linked-context resolution: `AgentContextBuilder` batch-resolves the tracker
  issues a task's description names explicitly via a new `TaskRepository.listByRefs` port
  method (one chunked-`IN` read per source, keyed by `(source, externalId)` refs) instead of a
  `taskRepo.get` point-read per reference inside `Promise.all`. Implemented on both facades (D1
  `D1TaskRepository` ⇄ Drizzle `DrizzleTaskRepository`) with a cross-runtime conformance
  assertion. The `'jira'`/`'github'` source literals are de-hardcoded out of the engine into
  `extractReferences`' typed `taskRefs`, the single place a reference shape binds to a task
  source.

  The new port method is also added to the mothership persistence-RPC allow-list
  (`@cat-factory/server`), since `AgentContextBuilder` invokes `listByRefs` on every
  container-agent dispatch — without the entry a no-Postgres mothership node fails every run
  with `unknown_method`.

- Updated dependencies [6ad20d0]
  - @cat-factory/kernel@0.140.1

## 0.86.4

### Patch Changes

- Updated dependencies [9b3b85e]
  - @cat-factory/kernel@0.140.0
  - @cat-factory/contracts@0.148.1

## 0.86.3

### Patch Changes

- efa3345: chore(deps): in-range dependency sweep + transitive upgrade and dedupe

  Update all dependencies within their existing semver ranges across the
  workspace (including the harness packages), run a transitive upgrade and
  `pnpm dedupe`, and re-adopt `@modular-vue/journeys@1.2.0` now that its neutral
  engine (`@modular-frontend/journeys-engine@1.8.0`) is published.

  - The Vercel AI SDK stays on `ai@6` / `@ai-sdk/*@3`: the newest
    `workers-ai-provider` (3.3.1) still peer-requires `ai@^6`, so a v7 bump
    remains blocked (moves within the pinned majors only).
  - `@modular-frontend/core` is pinned to a single `0.3.0` via a pnpm override:
    the 1.8.0 journeys engine hard-depends on `0.3.0` while the sibling
    `@modular-vue/*` bindings still range `^0.2.0`, which otherwise bundles two
    copies and splits the `JourneyRuntime` type. 0.3.0 is a strict superset
    (adds `discard`). Drop the override once the bindings widen their peer range.
  - `@cat-factory/executor-harness` runtime deps (`hono`, `@hono/node-server`)
    moved within range, so the runner-image tag is bumped and the three pins are
    re-synced (image publish/deploy is a maintainer follow-up).

- Updated dependencies [efa3345]
  - @cat-factory/kernel@0.139.3

## 0.86.2

### Patch Changes

- Updated dependencies [1f5f5bc]
  - @cat-factory/contracts@0.148.0
  - @cat-factory/kernel@0.139.2

## 0.86.1

### Patch Changes

- 7c3d245: Workspace RBAC (slice 7): close the enforcement side doors.

  - **`/me/environment-handlers/:workspaceId`** — this per-user infra-override surface is mounted
    at `/` and previously bypassed the workspace gate entirely (any signed-in user could address any
    workspace id). It now resolves access through the SAME shared `loadWorkspaceAccess` the gate uses
    and requires `runs.execute`: a caller with no access at all gets a 404 (existence stays hidden,
    exactly as the gate hides a board), while a caller who sees the board but lacks the capability
    gets a 403. Authorization runs before the local-only service-availability 503, so the verdict is
    identical on every facade regardless of whether the handler service is wired.
  - **WS event-stream ticket gains `userId`** — the ticket minted at `POST …/events/ticket` now
    carries the minting user for audit. Verification stays membership-blind (the claim is never
    consulted on upgrade); it is provenance only, absent in dev-open.
  - **`public_api_keys.created_by_user_id`** (both runtimes: D1 migration `0054` ⇄ Drizzle column) —
    a minted public-API key records the acting user for audit + UI attribution, surfaced on the wire
    (`PublicApiKey.createdByUserId`) and in the API-tokens panel ("created by …"). Minting is already
    gated under `secrets.manage` (slice 6). A key is a workspace-scoped SERVICE credential that
    intentionally outlives its minter's access — the column is never an authorization input (no FK),
    so revocation stays an explicit admin action.

  The cross-runtime RBAC conformance suite gains assertions for the side-door 404/403 and the
  `created_by_user_id` round-trip on both stores.

- Updated dependencies [7c3d245]
  - @cat-factory/contracts@0.147.1
  - @cat-factory/kernel@0.139.1

## 0.86.0

### Minor Changes

- bae59a7: Platform-operator observability: threshold alerting (initiative slice 5). A periodic,
  runtime-symmetric sweep (Worker cron ⇄ Node interval) evaluates each account's aggregate
  run-health projection — the same read the operator dashboard renders, so no new SQL — against
  operator-configured thresholds (failure rate, p99 run duration, live backlog depth) and raises a
  new `platform_health` notification through the existing NotificationChannel seam (in-app + Slack)
  when one is crossed, auto-clearing when the account recovers. The card de-dupes on the firing
  reason set, so a persistently-unhealthy deployment re-notifies only on state change, not every
  sweep. Opt-in via `PLATFORM_ALERTS=true` (thresholds/window/interval tunable via
  `PLATFORM_ALERTS_*`). Adds block-less `NotificationRepository.findOpenByType` (single-workspace
  dedup) and `listOpenByType` (batched across workspaces, so the sweep avoids a point-read per
  workspace) lookups (D1 ⇄ Drizzle + conformance) and threads `platform_health` through the Slack
  transport and the SPA notification inbox (routable/action labels localized in all 10 locales).

### Patch Changes

- Updated dependencies [bae59a7]
  - @cat-factory/contracts@0.147.0
  - @cat-factory/kernel@0.139.0

## 0.85.4

### Patch Changes

- 60c0a1e: Stuck-run audit — Group B (invisible parks): make the two remaining silent-park cases
  discoverable and stop a recurring fire from discarding a human-parked run.

  - **F3 — spend-pause now raises a notification.** A run paused by the spend safeguard is
    invisible to the sweeper and has no auto-resume, so the paused board badge used to be its only
    signal. A new workspace-scoped `budget_paused` notification type is now raised on pause (one card
    per workspace, de-duplicated) and cleared on `resumePaused`, surfacing the pause in the inbox
    where the escalation sweep can flag it. Informational (`act` marks it read; the human raises the
    budget then resumes from the spend panel).
  - **F7 — the "waiting for a decision" card is no longer masked by a stale card.**
    `ensureWaitingNotification`'s non-clobbering guard is scoped to the parked run's `executionId`, so
    a leftover `pipeline_complete`/`merge_review`/… card from a PRIOR run can no longer stand in for a
    new `blocked` run's only recovery signal. A richer card for the same run still wins.
  - **F10 — a recurring pipeline no longer clobbers a `blocked` prior run.** The overlap guard now
    treats `blocked` (a human-parked review/decision gate) as live alongside `running`/`paused`, so
    the next cadence fire is skipped instead of orphaning the parked run's durable driver.

- Updated dependencies [60c0a1e]
  - @cat-factory/contracts@0.146.0
  - @cat-factory/kernel@0.138.1

## 0.85.3

### Patch Changes

- Updated dependencies [c47dfe1]
  - @cat-factory/contracts@0.145.0
  - @cat-factory/kernel@0.138.0

## 0.85.2

### Patch Changes

- Updated dependencies [5924903]
  - @cat-factory/contracts@0.144.0
  - @cat-factory/kernel@0.137.1

## 0.85.1

### Patch Changes

- 74c21ab: feat: repo-sourced Claude Skills — freshness automation (slice 4)

  Keep a running pipeline from ever executing a stale skill, without the management
  surface having to resync by hand (docs/initiatives/repo-skills.md, final slice):

  - **Push-webhook fan-out.** A verified `push` webhook to a repo that skill sources are
    linked to now enqueues a targeted `skill-source-resync` job per affected source, so its
    skills are refreshed shortly after the upstream change. One indexed
    `SkillSourceRepository.listByRepo(owner, name)` lookup (new port method, D1 ⇄ Drizzle
    with a conformance assertion; the `skill_sources(repo_owner, repo_name)` index was
    already in place) drives the fan-out; the enqueue rides the existing GitHub-sync queue
    through a new `GitHubWebhookIngest.queueSkillResync` seam (Cloudflare Queue ⇄ Node
    pg-boss), and the async consumer runs `SkillSourceService.sync` for the one source
    (a source unlinked between enqueue and processing is swallowed, not retried forever).
  - **Dispatch-time self-verifying probe.** At skill-step dispatch, `SkillRunResolver` now
    probes the source dir's head commit; if it advanced since the last sync it re-syncs so
    the run uses current instructions. It never fails the run — any probe/re-sync error
    degrades to the last-synced record (a run may be at most one push behind, never broken),
    and it's a no-op on the common unchanged path (one `latestCommitSha` read).

  Together with the push fan-out this is the layered freshness story: the webhook keeps the
  account catalog warm, and the dispatch probe is the correctness backstop for deployments
  with no sync queue (local/dev) or a missed delivery. Backend-only; no harness/image change.

- Updated dependencies [74c21ab]
  - @cat-factory/kernel@0.137.0

## 0.85.0

### Minor Changes

- f5ddc02: Public API: per-key permission scopes + task deletion.

  Inbound public-API keys now carry a `scope` on the `/api/v1` surface — an inclusive ladder
  (`read` ⊂ `write` ⊂ `admin`) the controller enforces per endpoint: reads need `read`,
  non-destructive mutations (create/start/stop/retry/edit a task, start an initiative run)
  need `write`, and destructive operations need `admin`. A valid key whose scope is too low
  gets `403 insufficient_scope` (distinct from the `401` an unknown key gets).

  This unblocks the first destructive endpoint: `DELETE /api/v1/tasks/:taskId` (admin-scoped)
  deletes a task and its run history, completing the Tier-1 task lifecycle.

  The workspace token UI gains a scope selector on create; a minted key defaults to `write`.

  Breaking (pre-1.0, external surface): `publicApiKeySchema` gains a required `scope` field
  and the `public_api_keys` table gains a `scope` column (D1 ⇄ Drizzle). Existing keys backfill
  to `write` — they keep every capability the surface shipped before scopes existed but do not
  auto-gain the new destructive power, which must be minted `admin` explicitly.

### Patch Changes

- Updated dependencies [f5ddc02]
- Updated dependencies [576f2e0]
  - @cat-factory/contracts@0.143.0
  - @cat-factory/kernel@0.136.0

## 0.84.12

### Patch Changes

- Updated dependencies [720539f]
  - @cat-factory/kernel@0.135.0
  - @cat-factory/contracts@0.142.0

## 0.84.11

### Patch Changes

- Updated dependencies [e618bf5]
  - @cat-factory/contracts@0.141.0
  - @cat-factory/kernel@0.134.1

## 0.84.10

### Patch Changes

- 54e117e: GitLab UI parity (pre-slice): carry a `provider` VCS discriminator on the repo/connection
  projection.

  The GitLab-parity SPA work (provider-aware labels, icons, host/URL shapes) needs a
  `provider: VcsProvider` (`'github' | 'gitlab'`) it can read off the data. This adds that
  field to the `GitHubRepo` / `GitHubConnection` / `GitHubAvailableRepo` wire types and the
  kernel `GitHubInstallation`, and persists it symmetrically on both runtimes' projection
  tables (D1 migration `0051_vcs_provider.sql` + a Drizzle migration + both sets of mappers).
  The tables keep their GitHub names — the entity-rename fold is separate, acknowledged Phase-1
  work.

  `provider` is a per-connection fact: a connection records it (`GitHubInstallationService.connect`
  → `'github'`; local mode's `AutoProvisioningInstallationRepository` → the deployment's provider,
  `'gitlab'` for a GitLab-PAT deployment), and the repos reached through it inherit it (the sync
  service stamps `installation.provider`, the bootstrapper and CLI `linkRepo` stamp their own).
  Rows written before the column default to `'github'`. A cross-runtime conformance suite
  (`defineVcsProviderSuite`) asserts the round-trip on both stores. No SPA behaviour changes yet;
  this unblocks the presentation-switch slices.

- Updated dependencies [32a0720]
- Updated dependencies [54e117e]
- Updated dependencies [be6e109]
  - @cat-factory/contracts@0.140.0
  - @cat-factory/kernel@0.134.0

## 0.84.9

### Patch Changes

- Updated dependencies [6564507]
  - @cat-factory/kernel@0.133.0
  - @cat-factory/contracts@0.139.0

## 0.84.8

### Patch Changes

- Updated dependencies [b12d7a8]
  - @cat-factory/contracts@0.138.0
  - @cat-factory/kernel@0.132.0

## 0.84.7

### Patch Changes

- Updated dependencies [5b1cbbf]
  - @cat-factory/kernel@0.131.0
  - @cat-factory/contracts@0.137.0

## 0.84.6

### Patch Changes

- Updated dependencies [1869ad3]
  - @cat-factory/contracts@0.136.0
  - @cat-factory/kernel@0.130.0

## 0.84.5

### Patch Changes

- Updated dependencies [06a094a]
  - @cat-factory/contracts@0.135.0
  - @cat-factory/kernel@0.129.2

## 0.84.4

### Patch Changes

- Updated dependencies [6108525]
  - @cat-factory/kernel@0.129.1

## 0.84.3

### Patch Changes

- Updated dependencies [995249b]
  - @cat-factory/kernel@0.129.0
  - @cat-factory/contracts@0.134.0

## 0.84.2

### Patch Changes

- Updated dependencies [9e9127f]
  - @cat-factory/contracts@0.133.0
  - @cat-factory/kernel@0.128.1

## 0.84.1

### Patch Changes

- Updated dependencies [d68e3a8]
- Updated dependencies [b414f34]
  - @cat-factory/kernel@0.128.0
  - @cat-factory/contracts@0.132.0

## 0.84.0

### Minor Changes

- a552283: PR deep-review: park a review run on its findings for a human to select which to act on.

  The read-only `pr-reviewer` no longer finishes a review task the moment it returns. Its
  sliced, prioritized findings are now recorded onto the run's `pr-reviewer` step
  (`step.prReview`) and the run PARKS for a human to visually SELECT which findings matter
  through a dedicated multi-select window (findings grouped by slice, severity badges), then
  resolve. A `pr_review_ready` inbox card (routable to Slack) is raised on park. A clean PR
  (no findings) passes through and finishes as before.

  All review state rides the step (no side table), so D1 ⇄ Drizzle parity is free; a
  cross-runtime conformance assertion covers the park → select → resolve loop. The two
  terminal resolutions — feed the selected findings to a Fixer, or post them as inline PR
  review comments — are the tracked follow-up; this ships the slicing → park → multi-select
  loop with a neutral `finish` resolution.

### Patch Changes

- Updated dependencies [a552283]
  - @cat-factory/contracts@0.131.0
  - @cat-factory/kernel@0.127.0

## 0.83.3

### Patch Changes

- Updated dependencies [55cae97]
  - @cat-factory/contracts@0.130.0
  - @cat-factory/kernel@0.126.0

## 0.83.2

### Patch Changes

- d38d6c2: Make the local Kubernetes deploy runner explicit and its misconfiguration loud.

  - **local-server (BREAKING for `LOCAL_DEPLOY_RUNTIME`):** `LOCAL_DEPLOY_RUNTIME` no longer
    defaults to `native`. It is unset ⇒ deploy stays unwired (the normal "no Kubernetes test
    environments" state); set explicitly to `native` or `container` to wire it. A mode set WITHOUT
    its mandatory companion variable (`LOCAL_DEPLOY_HARNESS_ENTRY` for `native`,
    `LOCAL_DEPLOY_IMAGE` for `container`) — or an unrecognised value — now BREAKS boot with an
    actionable config error instead of warning and silently degrading to an unwired deploy that
    only failed mid-run. `native` was the more brittle, higher-privilege mode, so it must be chosen
    deliberately rather than fallen into.
  - **integrations:** the `deploy_runner_unwired` provisioning failure message now spells out each
    facade's exact setting and, for local mode, both modes' companion variables and how they differ.
  - **cli:** `cat-factory init` and `cat-factory env` now document the three `LOCAL_DEPLOY_*`
    variables in the generated `.env` (and the scaffolded `.env.example`), commented out — deploy is
    unused by default, and no companion var is written active since a lone mode breaks boot.

## 0.83.1

### Patch Changes

- 5fa0a8e: perf(github): fix the slow add-service repo picker search on the local (workspace-PAT) path

  The "add service from repo" typeahead stalled for seconds per keystroke when local mode's
  `GITHUB_PAT` backed the picker: `PatGitHubClient.searchInstallationRepos` re-walked the
  PAT's entire `GET /user/repos` set — up to 20 SEQUENTIAL pages — on every search request,
  with nothing cached (the counterpart viewer-PAT branch was already fixed, but the
  workspace-credential branch kept its own older serial walk).

  - `PatGitHubClient.listInstallationRepos` now delegates to the shared
    `FetchGitHubClient.listReposForToken` walk (page 1 reveals the page count via
    `Link: rel="last"`, the remaining pages fetch concurrently — ~2 round-trips instead of
    up to 20 serial ones) and re-stamps the rows as workspace-wide (`linkedVia: 'app'`).
    Note the enumeration cap is now the shared walk's 10 pages (1000 repos, flagged
    `truncated`) instead of the old silent 20.
  - New `AppCaches.patInstallationRepos` slice (grouped/keyed by installation id, 60s TTL;
    pass-through on the Worker's isolate-safe profile): the picker typeahead filters a
    cached complete enumeration in memory instead of re-walking `/user/repos` per
    keystroke. The blank browse-all stays live/uncached. The local PAT is env-fixed per
    boot, so there is no swap-write to invalidate on — the short TTL is the coherence
    story, mirroring `viewerRepos`.
  - `GitHubSyncService.listAvailableRepos` now runs its three independent reads (the
    tracked-projection list, the App-side lookup, the viewer-PAT expansion) as one
    concurrent wave instead of serially, so a cold PAT enumeration no longer stacks on top
    of the App lookup's latency.

- Updated dependencies [f7e7139]
- Updated dependencies [5fa0a8e]
  - @cat-factory/contracts@0.129.0
  - @cat-factory/kernel@0.125.0

## 0.83.0

### Minor Changes

- ca9ea20: Make Kubernetes provisioning auto-detection work across monorepo layouts, and stop it
  false-positive-detecting a service's source directory as a deploy target.

  The detector (`detectKubernetesProvisioning`) previously treated ANY YAML with a
  `kind` + `apiVersion` as a Kubernetes manifest, and only looked for shared per-service
  manifest slices as immediate children of a short, flat root list (`deploy`/`k8s`/
  `kubernetes`/`manifests`/…). On a real Kustomize monorepo (source nested two levels deep,
  a Backstage `catalog-info.yaml` in every service dir, manifests under
  `deployment/k8s/base/services/<svc>` + `overlays/<env>/<svc>`) that produced two failures:
  it confidently recommended deploying the service's SOURCE folder as "raw manifests" (the
  `catalog-info.yaml` decoy), and it never found the real shared manifests. This reworks the
  heuristics to be layout-agnostic while staying deterministic and checkout-free:

  - **Manifest classifier.** A YAML doc counts as a manifest only when its API group is
    Kubernetes-shaped — core / `*.k8s.io` / kustomize / a known operator-CRD group — and NOT
    on a non-Kubernetes denylist (Backstage `backstage.io`, …). This kills the source-dir
    false positive across every Backstage-catalogued repo, and correctly disambiguates a
    Kustomize `Component` from a Backstage `Component`.
  - **Kustomize Component awareness.** A `kind: Component` slice isn't independently
    deployable; when it's the chosen source the detector resolves and recommends the overlay
    that aggregates it (via `components:`), or keeps it with a clear warning when none does.
  - **Generalized monorepo slice discovery.** A bounded, layered breadth-first search descends
    from a broadened set of deploy roots (adds `deployment`/`ops`/`gitops`/`argocd`/`flux`/…)
    THROUGH the structural layers (`base`/`services`/`apps`/`overlays/<env>`/`components`) to
    find THIS service's slice however deep it's nested, matching by exact / case-insensitive /
    affix (`<prefix>-<svc>`) name. Only the service's own matched slice(s) are surfaced —
    no more flooding the picker with every sibling — and a same-named terraform `infra/<svc>`
    sibling is not mistaken for a manifest slice.
  - **Escape hatches** (deployment `ENVIRONMENTS_DETECTION_CONVENTIONS`): `manifestDirs` adds
    house-named deploy roots, and `serviceManifestPaths` pins explicit `{service}`/`{env}`
    path templates that resolve the service→manifests mapping deterministically before the
    heuristic search — a one-line config that makes an exotic layout resolve exactly.

  Existing behaviour for colocated / simple layouts is unchanged. The stack-recipes pilot
  golden was regenerated: the consumer's Backstage `catalog-info.yaml` no longer produces a
  spurious "Kubernetes manifests also exist" note (the intended, documented drift).

## 0.82.0

### Minor Changes

- e5cd022: Speed up the "add service from an existing repo" picker's typeahead, which stalled for
  ~17s per keystroke when a broad personal access token (PAT) backed the results.

  The personal-repo branch re-walked the viewer's entire `GET /user/repos` set — up to ten
  sequential GitHub pages — on every keystroke and only applied the query as an in-memory
  filter afterwards, with nothing cached. Three changes:

  - **Cache the enumeration.** New `AppCaches.viewerRepos` slice (grouped/keyed by user id):
    the picker's typeahead now filters a cached complete set in memory instead of forcing a
    fresh full walk per keystroke. Invalidated when the user's stored `github_pat` changes;
    a short (60s) TTL backstops repos created straight on GitHub. Pass-through on the Worker's
    isolate-safe profile (external state, not self-verifying), so it caches on Node/local
    where the PAT picker is the primary flow.
  - **Parallelize the cold walk.** `FetchGitHubClient.listReposForToken` reads page 1, learns
    the page count from its `Link: rel="last"` header, and fetches the remaining pages
    concurrently — turning ~10 serial round-trips into ~2.
  - The blank browse-all path (and its fail-closed access-projection refresh) is unchanged and
    stays uncached.

  No repos are dropped: a literal GitHub `/search/repositories` call was deliberately avoided
  because it can't reproduce the enumeration's `owner,collaborator,organization_member`
  affiliation scope and would bury a low-star private repo in global results.

### Patch Changes

- Updated dependencies [e5cd022]
  - @cat-factory/kernel@0.124.0

## 0.81.20

### Patch Changes

- 6c4bcef: chore(environments): use neutral illustrative naming in shared custom-deployment-provider code and UI

  Shared framework code and UI should carry neutral, self-contained examples. Replaced
  every illustrative reference (comments, the `manifestId` placeholder/help text, config-file examples) with
  neutral wording (`.deploy.yml`, `my-preview-template`, "a native custom env backend").
  Behaviour is unchanged.

- Updated dependencies [6c4bcef]
  - @cat-factory/contracts@0.128.2
  - @cat-factory/kernel@0.123.3

## 0.81.19

### Patch Changes

- 90a7fb3: Parallelize the real-time fan-out publisher and the GitHub sync fan-out (performance
  optimizations tracker items 12 & 14).

  Two hot paths forwarded independent work serially. Both now run their independent forwards
  concurrently; no behaviour or wire-shape change.

  - **Item 14 — `FanOutEventPublisher`:** a live change to a service mounted on N boards
    re-published the event to each mounting workspace with a `for (…) await inner.x(ws)` chain
    (N serial Durable Object round-trips per state transition on the Worker). Each method now
    `Promise.all`s the per-target forwards, so a shared service pays one round-trip's latency,
    not N. The forwards were already independent and best-effort.
  - **Item 12 — `GitHubSyncService`:** `syncRepo` fetched its branches / PRs / issues / commits
    serially and fanned each projection out to the linking workspaces one-at-a-time. The four
    independent cursor resources (each on its own installation-scoped cursor, no cross-kind
    ordering) now fetch+upsert in one concurrent wave (checks still waits on the branch head it
    needs), and each resource's per-workspace projection writes fan out via `Promise.all` — so a
    repo shared by N workspaces costs one write's latency per resource, not N. The data-scaled
    `resyncWorkspace` (per repo) and `backfillInstallation` (per workspace) loops move from
    serial to **bounded** concurrency via `p-map`, deliberately capped (4 repos / 3 workspaces in
    flight) so a large installation backfills in parallel without an unbounded burst of concurrent
    GitHub reads tripping the provider's secondary rate limits.

  Also standardizes bounded-concurrency fan-out on `p-map` instead of hand-rolled limiters: the
  existing in-tree `mapLimit` in `readServiceSpec` (`@cat-factory/server`) is replaced with `p-map`
  too, so there's one blessed helper. The `@cat-factory/agents` `Semaphore` stays (it is a shared
  FIFO permit/mutex, not a bounded map — `p-map` doesn't cover that shape); only its comment is
  corrected.

  Pure orchestration changes in the shared packages (used identically by both runtime facades);
  no persistence or conformance surface. Pinned by new unit tests for the concurrent forwards and
  the concurrent resource wave / workspace fan-out / bounded loops.

## 0.81.18

### Patch Changes

- Updated dependencies [2ce396d]
  - @cat-factory/kernel@0.123.2
  - @cat-factory/contracts@0.128.1

## 0.81.17

### Patch Changes

- Updated dependencies [2c7ca2e]
  - @cat-factory/kernel@0.123.1

## 0.81.16

### Patch Changes

- e4c5abe: Type the harness failure-cause wire and consolidate its classifiers (error-message initiative I4).
  The kernel now owns the structured cause vocabulary — `HARNESS_FAILURE_CAUSES` /
  `HarnessFailureCause` / `isHarnessFailureCause` / `failureKindFromHarnessCause`
  (`kernel/src/domain/harness-failure.ts`), kept in step by hand with the dependency-free container
  payloads (executor-harness `FailureCause` plus deploy-harness `DeployFailureCause`, hence the
  `deploy` member) — and the three job-view ports carry the union instead of a bare string
  (`RunnerJobView.failureCause`, the failed `AgentJobUpdate` variant, `PreviewView.failureCause`).
  The mapper's internal `Record<HarnessFailureCause, 'timeout' | 'agent'>` is the drift guard: a new
  union member without a mapping fails the typecheck.

  The three per-flow copies of the cause switch are deleted in favour of that one kernel mapper:
  orchestration's `agentFailureKindFromCause` (a module export of `job.logic.ts`, now removed —
  `RunDispatcher` calls the kernel mapper), the bootstrapper's `bootstrapFailureKindFromCause`, and
  the repairer's `repairFailureKindFromCause`. Each flow keeps its own error-string regex purely as
  the no-cause fallback. `HttpRunnerPoolProvider` now narrows the pool's dot-path-mapped cause
  through `isHarnessFailureCause` (an unknown free-form value degrades to the regex fallback instead
  of riding the wire untyped), and the conformance `FakeAgentExecutor.pollFailCause` option is typed
  to the union. Container eviction stays outside the union (a transport signal —
  `RunnerJobView.evicted`). No executor-harness image bump: the harness sources are untouched.

- Updated dependencies [e4c5abe]
  - @cat-factory/kernel@0.123.0

## 0.81.15

### Patch Changes

- 1e684b7: Add a "Test environment creation" diagnostic to the service inspector. A developer can now
  run the whole ephemeral-environment lifecycle against a throwaway branch — create branch →
  provision → tear down → delete branch — and see the live stage plus the final success/failure
  (and the stage it failed at), with guaranteed cleanup even on error.

  Modelled as a durable, observable run (its own `environment_test_runs` table on both facades)
  driven by a Cloudflare Workflow on the Worker and pg-boss on Node, with live `envTest` events
  pushed to the SPA. Adds the `RepoFiles.deleteBranch` port method (implemented once in the shared
  server layer) so the throwaway branch is reclaimed through the existing checkout-free seam.

  The always-cleans-up contract is enforced on every path: the branch is persisted before
  dispatch (a dispatch failure can't orphan it), a failed deploy view releases the runner and
  finalizes so cleanup tears down partial infra, a stop mid-provision aborts the in-flight
  deploy job, and the run's synthetic environment-registry row is always reclaimed. The
  provisioning config is pinned on the run record at dispatch, terminal writes are guarded
  (`updateIfRunning`, first-writer-wins vs the stop button), and both runtimes gain an env-test
  stale-run sweep plus self-finalization on poll-budget exhaustion so a run whose driver dies
  can never show `running` forever. The SPA store reconciles snapshots and live events by
  `updatedAt` so a stale refresh can't regress or drop a run's state.

  Schema change (no backwards-compatible migration, per project policy): a new
  `environment_test_runs` table is added to both the D1 (`0050_environment_test_runs.sql`) and
  Postgres/Drizzle schemas.

- Updated dependencies [1e684b7]
- Updated dependencies [1e684b7]
  - @cat-factory/contracts@0.128.0
  - @cat-factory/kernel@0.122.0

## 0.81.14

### Patch Changes

- 2a13ece: Route `AccountSettingsService.resolve` through the app cache seam (performance initiative item 8).
  The service's legacy homebrew 30s `{ value, expiresAt }` `Map` — the anti-pattern CLAUDE.md names
  explicitly — is replaced by a new `accountSettings` `AppCaches` slice (grouped and keyed by account
  id, holding the decrypted `ResolvedAccountSettings`). `resolve` now reads through it and `write`
  invalidates the account's entry after the upsert commits, so an integration-credential change is
  coherent across replicas (the invalidation bus carries only keys, never the decrypted secrets, so
  plaintext still never leaves the process). `ResolvedAccountSettings` moved to the kernel
  account-settings port (the caching port now names it) and is re-exported from
  `@cat-factory/integrations`, so its consumers are unchanged. Pass-through on the Worker's
  isolate-safe profile (our own mutable D1 state, no cross-isolate bus); both facades wire the slice.
- Updated dependencies [2a13ece]
  - @cat-factory/kernel@0.121.8

## 0.81.13

### Patch Changes

- 3ce997d: Structured container-eviction signal (error-message initiative I1). A container eviction is now
  carried on a typed `RunnerJobView.evicted` field (`'crash'` | `'transient'`, the new
  `ContainerEvictionKind`) minted by every runner transport (Cloudflare, the shared local
  `harnessHttp`, the local container/pool/process/native-routing transports, and Kubernetes/EKS),
  forwarded through `AgentJobUpdate`, and read by the execution / bootstrap / env-config-repair
  consumers via the new `evictionKindOf` extractor. The `(container evicted or crashed)` sentinel +
  the transient marker are PRESERVED as the fallback for an older producer, so nothing that still
  matches the string breaks — the structured field is simply the load-bearing signal now, replacing
  the regex as the primary classification channel.
- Updated dependencies [3ce997d]
  - @cat-factory/kernel@0.121.7

## 0.81.12

### Patch Changes

- Updated dependencies [67dccb6]
  - @cat-factory/kernel@0.121.6

## 0.81.11

### Patch Changes

- f8f1aa8: Update workspace dependencies (direct + transitive) to the newest versions published before the
  `minimumReleaseAge` supply-chain cutoff. No source changes — dependency ranges + the lockfile only.

  - Refreshed direct deps to their newest cooldown-compliant releases: `wrangler` 4.110.0, `hono`
    4.12.29, `vitest` / `@vitest/coverage-v8` 4.1.10, `oxlint` 1.73.0, `knip` 6.26.0, `msw` 2.15.0,
    `pg-boss` 12.26.0, `sherif` 1.13.0, `turbo` 2.10.4, `vue-tsc` 3.3.7, `@types/node` 26.1.1,
    `@nuxtjs/i18n` 10.4.1, `@aws-sdk/client-s3` 3.1085.0.
  - `typescript` moved off the `7.0.1-rc` prerelease to the stable `7.0.2` release across every
    package that used the RC (the TS-6 world — the frontend layer and the two runner harnesses —
    stays on `^6.0.3`).
  - Vercel AI SDK family held to the `ai@6`-compatible majors that `workers-ai-provider@3.3.1` peers
    require (`ai` 6.0.224, `@ai-sdk/anthropic|openai|provider` on 3.x, `@ai-sdk/openai-compatible` on
    2.x, `@ai-sdk/amazon-bedrock` 4.x) — no v7/v5 major bumps.
  - Coding (`executor-harness`) and deploy runner harnesses updated too, including the pinned
    in-container coding-agent CLIs (Pi 0.80.6, Claude Code 2.1.207, Codex 0.144.1; the Pi todo /
    web-tools extensions stay at their lockstep 1.20.0). Their image tags and the three
    hand-maintained pins were bumped in lockstep, so the runner images must be re-published +
    deployed for the new tags to roll out.

- Updated dependencies [f8f1aa8]
  - @cat-factory/contracts@0.127.1
  - @cat-factory/kernel@0.121.5

## 0.81.10

### Patch Changes

- e68c958: feat(errors): UI-first remedies for runner-backend / runner-pool / Datadog failures (D2/D3/D4)

  Continues the error-message-coverage initiative through Section D — runtime provider failures now
  name their fix (the UI location first) and link the relevant docs, instead of surfacing a terse,
  opaque condition.

  - **D3 — `No runner backend available for workspace 'X'`** (both the Node and Cloudflare transport
    resolvers) now throws a `ConflictError` carrying the machine `reason` `agent_backend_unconfigured`
    instead of a plain `Error`. Synchronously it is a clean 409; on the async dispatch path
    `classifyDispatchFailure` lifts the reason onto the run's `AgentFailure`, so the SPA renders the
    existing "Agent backend not configured" title + jump (no new locale keys) rather than the
    misleading "container failed to start". The remedy names the UI path first (Settings → Self-hosted
    runner pool) and links `backend/docs/runner-pool-integration.md` via the new `DOCS.runnerPool`
    entry. The load-bearing `No runner backend available for workspace '<id>'` prefix is preserved.
  - **D2 — runner-pool provider errors** (`RunnerPoolApiError`: a scheduler non-2xx, a missing
    manifest secret, an OAuth-token rejection) now append a shared UI-first remedy naming where the
    pool is registered / re-tested, while preserving the raw `<method> → <status>` / `Missing secret`
    detail ahead of it (still greppable + still matched by the transport's DispatchError re-wrap).
  - **D4 — Datadog auth failure**: a `401`/`403` from the Datadog API now appends a UI-first remedy
    pointing at Integrations → Observability connection (the keys are UI-configured — no env var for
    this connection), preserving the raw `HTTP <status>` diagnostic. A non-auth status (5xx / mapping
    error) is unchanged.

  `@cat-factory/integrations` keeps its own `docs.ts` (repo-doc + vendor-URL helpers) since it sits
  below the server layer and cannot import `@cat-factory/server`'s `config/docs.ts`.

## 0.81.9

### Patch Changes

- 4810353: Structured, elaborated container/runner dispatch failures (error-message coverage initiative,
  items D1/I2). A `dispatch()` rejection used to throw a bare `Container dispatch failed (HTTP n)`
  string that named the symptom but not the cause, and downstream consumers decided "was this a
  dispatch failure?" by regex-matching `/dispatch failed/i` — so error IDENTITY rode a string, and a
  self-hosted-pool fault (`Runner pool … → <status>`, a different wording) fell through and was
  mislabelled a `preflight` error.

  - **I2** — new kernel `DispatchError` (`domain/dispatch-errors.ts`) carries the HTTP `status` as a
    structured field, thrown by every transport `dispatch()`: `CloudflareContainerTransport`,
    `KubernetesRunnerTransport`, the local `postHarnessJob` (both local transports), and
    `RunnerPoolTransport` (which re-wraps the pool provider's `RunnerPoolApiError`, carrying its
    status). `BootstrapService`, `EnvConfigRepairService`, and the execution engine
    (`classifyDispatchFailure`) now classify via `instanceof` / the `isDispatchFailure` extractor,
    with the legacy `/dispatch failed/i` message shape kept only as a fallback. This fixes the pool
    dispatch fault being mislabelled `preflight`.
  - **D1** — a 404 from the harness `/jobs` route (the deployed executor-harness image predates the
    route because its tag was never bumped, so new containers run stale code) now elaborates with the
    stale-image cause + the republish-under-a-fresh-tag remedy and a link to the release rules. The
    raw `<label> dispatch failed (HTTP n): <body>` first line is preserved verbatim (still greppable,
    still matched by the fallback regex); the cause + remedy is only appended.

  No behaviour changes beyond error message text and failure classification. No executor-harness
  image change (the dispatch signal is minted by in-repo transports).

- Updated dependencies [4810353]
  - @cat-factory/kernel@0.121.4

## 0.81.8

### Patch Changes

- Updated dependencies [edad6e6]
  - @cat-factory/kernel@0.121.3

## 0.81.7

### Patch Changes

- 3b3bdc8: Elaborate credential-decryption failure messages (error-message coverage initiative, items
  E1/E2). A wrong personal-subscription password and a corrupt/truncated stored secret used to
  surface as opaque Web Crypto errors instead of an actionable remedy.

  - **E1** — `WebCryptoPersonalSecretCipher.open` (`@cat-factory/server`) now wraps the AES-GCM
    authentication failure the same way the system cipher already wraps a rotated-key failure: the
    opaque `DOMException` ("The operation failed for an operation-specific reason") becomes "The
    personal password does not match the one this subscription was sealed under — re-enter it, or
    remove and re-add the subscription.", preserving the original as `cause`.
    `PersonalSubscriptionService.unlock` keeps its `wrong_password` reason (the 428 flow the SPA
    drives) and now carries a clean, self-sufficient message rather than nesting the raw cipher
    text in parentheses.
  - **E2** — the malformed-envelope guards in both ciphers (`WebCryptoSecretCipher.decrypt` and
    `WebCryptoPersonalSecretCipher.open`) now name the likely causes (truncated/corrupted column,
    or a value written under a different scheme/key) and the re-enter/re-seal remedy, instead of a
    terse `Invalid secret envelope`. The integrity-check failure (magic prefix absent after a
    successful GCM decrypt) is distinguished from a wrong password as corruption/tampering. The
    envelope parse (structure check + base64url decode) is wrapped as a unit, so a corrupt/undecodable
    segment inside an otherwise well-structured envelope also yields the actionable message rather
    than leaking a bare `atob` `InvalidCharacterError`.

  Also fixes a test-config gap: `@cat-factory/server`'s vitest `include` omitted the co-located
  `src/**/*.test.ts` unit tests (the crypto ciphers, provider capabilities, …), so those suites
  silently never ran; the glob now covers both `test/*.spec.ts` and `src/**/*.test.ts`.

  No behaviour changes beyond error message text.

## 0.81.6

### Patch Changes

- Updated dependencies [d1a4129]
  - @cat-factory/contracts@0.127.0
  - @cat-factory/kernel@0.121.2

## 0.81.5

### Patch Changes

- Updated dependencies [473e849]
  - @cat-factory/kernel@0.121.1

## 0.81.4

### Patch Changes

- Updated dependencies [f4482c7]
  - @cat-factory/kernel@0.121.0

## 0.81.3

### Patch Changes

- Updated dependencies [22a4d9e]
  - @cat-factory/kernel@0.120.0

## 0.81.2

### Patch Changes

- Updated dependencies [a5dcf7d]
  - @cat-factory/kernel@0.119.0

## 0.81.1

### Patch Changes

- Updated dependencies [5072999]
  - @cat-factory/contracts@0.126.0
  - @cat-factory/kernel@0.118.1

## 0.81.0

### Minor Changes

- 4f936de: Add the optional implementation-fork decision phase on the Coder step. Before the Coder
  writes code, a read-only `fork-proposer` explore agent can aggressively surface the materially
  different ways to implement a task; the run parks for a human to pick a proposed fork or enter
  their own approach, and the chosen approach is folded into the Coder's prompt as a binding
  directive. The phase is gated per-task by a tri-state (`auto`/`always`/`off`) and, in `auto`,
  by an estimate gate on the workspace risk policy (`riskPolicy.forkDecision`, disabled by
  default). All state rides the run's coder step (`step.forkDecision`), so it is
  runtime-symmetric across the Cloudflare and Node facades (D1 ⇄ Drizzle: the new
  `merge_threshold_presets.fork_decision` column). This slice ships propose → park → choose →
  Coder plus the single-path auto-advance; grounded chat about the forks lands in a follow-up.

  Breaking: the built-in merge-threshold preset catalog version is bumped (Balanced /
  Manual review only → v3) to seed the new `forkDecision` gate; workspaces are advised to reseed.
  The `build` Coder prompt is bumped to v4 and a new `fork-proposer` v1 prompt is added.

### Patch Changes

- Updated dependencies [4f936de]
  - @cat-factory/contracts@0.125.0
  - @cat-factory/kernel@0.118.0

## 0.80.6

### Patch Changes

- Updated dependencies [127fe3e]
  - @cat-factory/contracts@0.124.1
  - @cat-factory/kernel@0.117.6

## 0.80.5

### Patch Changes

- Updated dependencies [774908c]
  - @cat-factory/kernel@0.117.5

## 0.80.4

### Patch Changes

- Updated dependencies [08a7da2]
  - @cat-factory/contracts@0.124.0
  - @cat-factory/kernel@0.117.4

## 0.80.3

### Patch Changes

- Updated dependencies [6b968bb]
  - @cat-factory/kernel@0.117.3

## 0.80.2

### Patch Changes

- Updated dependencies [eeadc97]
  - @cat-factory/kernel@0.117.2
  - @cat-factory/contracts@0.123.1

## 0.80.1

### Patch Changes

- cb7fd14: Validate the personal-subscription password cache against an 8h expiry buffer on every
  gated action (start / confirm / retry), so the user is prompted to re-enter early — while
  they are present at the action — instead of the key lapsing mid-pipeline and surfacing as a
  broken run that asks for a retry.

  - Frontend (`@cat-factory/app`): a cached key with under 8h of runway left is withheld on
    the first attempt of a gated action, so the server's existing `428 credential_required`
    gate re-challenges and the modal refreshes the full window. The mid-run confirm actions
    (resolve decision / approve step / request changes / resolve-exceeded) now flow through
    the same `withCredential` prompt path as start/retry.
  - Backend (`@cat-factory/server`): **behavior change** — the run-interaction endpoints
    (resolve decision / approve / request changes / resolve-exceeded) now hard-gate for
    individual-usage runs (mint a fresh activation via `personalGateForRun`, 428 when the
    password is needed but absent/withheld) instead of a silent best-effort re-mint, so an
    early re-entry can be surfaced mid-run. The `remintActivations` helper is removed.
  - `@cat-factory/integrations`: removed the now-unused `PersonalSubscriptionService.refreshActivations`.
  - `@cat-factory/kernel` + the runtime facades (`@cat-factory/worker`, `@cat-factory/node-server`,
    `@cat-factory/local-server`): dropped the now-dead `SubscriptionActivationRepository.refresh`
    port method and its D1 / Drizzle / SQLite implementations — its only caller
    (`refreshActivations`) is gone, so activations are now only ever minted at full TTL via
    `activateForRun`, never TTL-extended in place.

- Updated dependencies [cb7fd14]
  - @cat-factory/kernel@0.117.1

## 0.80.0

### Minor Changes

- be54a32: Subscription quota-cycle tracking, Part B1 (usage-and-quota-tracking): model "how much of a
  subscription's quota cycle is left" for the flat-rate harnesses (Claude Code / Codex / GLM /
  pooled Kimi & DeepSeek), which the spend ledger excludes.

  Adds the `SubscriptionQuotaProvider` port + `SubscriptionQuotaCycleRepository` and the
  `subscription_quota_cycles` table (mirrored across D1 and Drizzle/Postgres), plus
  `RegistrySubscriptionQuotaProvider` — a vendor-neutral composite (mirroring
  `RegistryReleaseHealthProvider`) that folds each finished subscription run's tokens into rolling
  `5h` + `weekly` windows anchored at first observed use, and reports the cycle either from a real
  per-vendor adapter or the MODELED fallback (persisted counters measured against per-vendor config
  ceilings). The adapter registry is empty today — the real Claude/GLM reads land in Part B2 (an
  executor-harness image bump), so every vendor currently reports modeled. `ContainerAgentExecutor`
  records usage for BOTH pooled runs (scope = the leased pool token) and personal runs (scope = the
  run initiator); it's wired into every facade, and covered by a cross-runtime conformance suite.
  Modeled numbers are illustrative and NEVER billed — the metered-only spend gate is unchanged.

### Patch Changes

- Updated dependencies [be54a32]
  - @cat-factory/kernel@0.117.0

## 0.79.3

### Patch Changes

- Updated dependencies [51869b8]
  - @cat-factory/kernel@0.116.0

## 0.79.2

### Patch Changes

- Updated dependencies [a51a498]
  - @cat-factory/kernel@0.115.1

## 0.79.1

### Patch Changes

- Updated dependencies [b83bcc8]
- Updated dependencies [b83bcc8]
- Updated dependencies [a0c6934]
  - @cat-factory/contracts@0.123.0
  - @cat-factory/kernel@0.115.0

## 0.79.0

### Minor Changes

- 0f3c88b: feat(testing): sealed sensitive test credentials, delivered to the Tester out of band

  Add a SEALED per-service store for sensitive testing credentials (e.g. a third-party API
  token a Tester needs), the sibling of the non-sensitive test-credential pools. Values are
  encrypted at rest by the facade `SecretCipher` (info tag `cat-factory:test-secrets`, mirroring
  `observability_connections`) and delivered to the Tester container **out of band**: decrypted at
  dispatch, carried on a dedicated job-body field the agent-context snapshot allow-list omits, and
  injected by the harness as container environment variables the agent reads (`$KEY`). The tester
  prompt advertises only each secret's key + description (never the value). Per service frame,
  resolved up the frame chain like release-health config; mirrored across both runtimes (D1 +
  Drizzle) with a cross-runtime conformance assertion.

  New API: `GET|PUT|DELETE /workspaces/:ws/services/:blockId/test-secrets` (values write-only).

  This is Slice C of the tester-environment-access initiative; the Test Data Seeder agent
  (Slice D) is a tracked follow-up. See docs/initiatives/tester-environment-access.md.

### Patch Changes

- Updated dependencies [0f3c88b]
  - @cat-factory/contracts@0.122.0
  - @cat-factory/kernel@0.114.0

## 0.78.8

### Patch Changes

- Updated dependencies [ed77be6]
  - @cat-factory/kernel@0.113.0
  - @cat-factory/contracts@0.121.2

## 0.78.7

### Patch Changes

- 7ee2530: Internal cleanup: prune dead/needless exports flagged by knip (no runtime behaviour
  change). ~110 findings resolved — genuinely-dead symbols deleted (e.g. the unused
  `ENVIRONMENT_ANALYSIS_PIPELINE_ID` / `INITIATIVE_BREAKDOWN_PIPELINE_ID` pipeline-id
  constants, `isCiStatusProviderWired`, `parseApiKeyProvider`, unused re-export members of
  the runtime facade barrels), and the `export` keyword dropped from symbols only used
  inside their own module (repository classes, config constants, helper types). Also tidied
  stale `knip.jsonc` baseline entries (removed no-longer-needed `ignore` / `ignoreDependencies`
  and dead entry-glob patterns).

  The residual knip warnings are now all DELIBERATE: the neutral `VcsClient` port type
  re-export barrel, the Worker config-type barrel, the `providerEndpoints` base-URL group,
  and a couple of types that must stay exported for declaration emit. Since backwards
  compatibility is a non-goal pre-1.0, the removed exports (which nothing imported) are
  dropped outright rather than deprecated.

- Updated dependencies [7ee2530]
  - @cat-factory/kernel@0.112.1

## 0.78.6

### Patch Changes

- Updated dependencies [f25d5e2]
  - @cat-factory/kernel@0.112.0

## 0.78.5

### Patch Changes

- Updated dependencies [9aa9e19]
  - @cat-factory/contracts@0.121.1
  - @cat-factory/kernel@0.111.1

## 0.78.4

### Patch Changes

- Updated dependencies [63f7881]
  - @cat-factory/kernel@0.111.0
  - @cat-factory/contracts@0.121.0

## 0.78.3

### Patch Changes

- Updated dependencies [bcc843d]
  - @cat-factory/kernel@0.110.1

## 0.78.2

### Patch Changes

- Updated dependencies [a2db337]
  - @cat-factory/contracts@0.120.0
  - @cat-factory/kernel@0.110.0

## 0.78.1

### Patch Changes

- Updated dependencies [8319e52]
  - @cat-factory/kernel@0.109.1

## 0.78.0

### Minor Changes

- 8728bf7: Capture per-run diagnostics on `agent_runs` for after-the-fact investigation. Each run now
  records a `diagnostics` object (riding in the run's `detail` JSON, like `notes`/`frontendBindings`)
  with the most recent container-step dispatch context — `agentKind`, resolved `model`, the `repo`
  (owner/name/baseBranch/provider), the **execution backend** (`local-native` vs `local-container`
  vs `runner-pool` vs `cloudflare-container` — the datum that distinguishes a native host-process run
  from a sandboxed container), and the control-plane host `platform`. The backend is reported by the
  runner transport (a new optional `RunnerTransport.backend` / `RunnerJobView.backend`, stamped by
  the shared job client; the native/container router stamps its per-job leg).

  Also preserves the harness's fine-grained failure `cause` (`git` / `api` / `no-usable-output` /
  `no-changes`) on the failure's machine-readable `reason` instead of collapsing it to the coarse
  `agent` kind — so a push/clone failure reads as `git`, not a generic agent error, without grepping
  the transcript. No schema migration (the diagnostics ride in the existing `detail` column; the
  cause rides on the existing `failure.reason`); mirrored across both runtimes with a cross-runtime
  conformance round-trip assertion.

### Patch Changes

- Updated dependencies [8728bf7]
- Updated dependencies [7157908]
  - @cat-factory/contracts@0.119.0
  - @cat-factory/kernel@0.109.0

## 0.77.8

### Patch Changes

- Updated dependencies [f1906cb]
  - @cat-factory/kernel@0.108.0

## 0.77.7

### Patch Changes

- Updated dependencies [44fafa4]
  - @cat-factory/kernel@0.107.0

## 0.77.6

### Patch Changes

- Updated dependencies [89c861a]
  - @cat-factory/kernel@0.106.0

## 0.77.5

### Patch Changes

- 2d97812: Initiative presets — slice 6 (docs-refresh pilot): deterministic documentation-layout
  autodetection.

  - **agents** (`presets/docs-refresh/docs-detect.logic.ts`): a new pure `detectDocsLayout(reader)`
    heuristic — the checkout-free repo probe behind the docs-refresh preset's form prefill (its
    `detect` hook lands in slice 8). Over a narrow `DocsRepoReader` (a `RepoFiles` satisfies it
    structurally) it proposes the preset's placement DEFAULTS without a clone: the docs root
    (`docs`/`doc`/`documentation`), the diagrams + business-rules subfolders (known dir-name
    heuristics under the detected root), a monorepo flag (workspace manifest / `package.json`
    `workspaces` / conventional `packages`|`apps`|`services`|`libs` dirs), a `per-service` vs `root`
    placement decision (sampled from whether most packages carry their own docs), and an
    `hasExistingMermaid` hint for the analyst.
  - Deterministic, memoized, bounded by a hard read budget, and TOTAL — it never throws and never
    rejects, so an unwired GitHub / a partial or unreadable repo simply yields the conventional
    defaults (a prefill must never block create). Detected values are non-binding FORM DEFAULTS; a
    user edit wins and the analyst confirms placement at planning time.
  - **kernel** (`shared/repo-scan.logic.ts`): extracts the checkout-free scan primitives the repo
    auto-detectors share — `joinRepoPath` + the budgeted, memoized `BudgetedRepoScanner` (over a
    `CheckoutFreeRepoReader`) — into one home, so a fix to path normalization / caching / budget
    lands once instead of drifting across copies.
  - **integrations**: the service-provisioning (`provision-detect`) and frontend-config
    (`frontend-detect`) detectors now consume the shared kernel primitive instead of their own
    private `joinPath` + `Scanner` copies — a behaviour-neutral refactor (the shared `exhausted`
    uses the precise "a read was actually skipped" semantics both had converged toward).

- Updated dependencies [2d97812]
- Updated dependencies [b35e1a0]
  - @cat-factory/kernel@0.105.0
  - @cat-factory/contracts@0.118.0

## 0.77.4

### Patch Changes

- 8f7af8e: Make ephemeral-environment provisioning DETECTION more universal — so it adapts to repos that
  follow different conventions than the stack-recipes pilot (different names, paths, tech stack). The
  changes are additive in the sense that detection can only ever surface MORE — it never removes or
  changes an existing detection, and a repo with no monorepo service-container dirs resolves exactly
  as before. Note the one behavioural change below: the env-template scan now also looks one level into
  `services/*`/`apps/*`/`packages/*`, so a monorepo that keeps per-service templates there will now
  surface them as low-confidence, user-confirmed `recipe.envFiles` where it previously surfaced none.

  - **Injectable detection conventions (deployment config).** A deployment can extend the built-in
    compose file names/dirs, seed dirs, and env-template dirs via the `ENVIRONMENTS_DETECTION_CONVENTIONS`
    JSON env var, threaded additively (built-ins always win; canonical compose names stay
    highest-priority) through `CoreDependencies.detectionConventions` into BOTH the service-provisioning
    detector (`EnvironmentConnectionService`) and the shared-stack detector (`SharedStackService`). New
    `parseDetectionConventions` + `EnvironmentsConfig.detectionConventions` (`@cat-factory/server`,
    parsed by both facades) and the exported `DetectionConventions` type (`@cat-factory/integrations`).
  - **Env-template detection now scans one level into monorepo service-container dirs** (`services/*`,
    `apps/*`, `packages/*`), so a per-service `*-dist`/`.example` template outside the compose dir (the
    pilot's documented `services/app/` gap) is surfaced — still bounded by the existing read budget.
    This is on by default (not gated behind conventions), so any monorepo with a compose file AND
    per-service templates newly gets those as `recipe.envFiles`; they are low-confidence and confirmed
    in the wizard before anything is materialized.
  - **The environment setup wizard elevates the "run deep analysis" nudge** when a repo ships its own
    imperative bring-up CLI/Makefile the deterministic scan can't read (`@cat-factory/app`), pointing the
    user at the LLM analyst — the intended universality mechanism for stack-specific imperative steps.

- 8f7af8e: Stack-recipes-and-shared-stacks slice 9 (pilot): add the sanitized pilot fixtures, golden
  detection tests, reference recipe/shared-stack configs, and the upstream-drift-alarm script
  (`pilot:golden`) under `@cat-factory/integrations`. No runtime `dist` change — this pins the
  deterministic provisioning detector's output against a faithful, sanitized snapshot of the
  initiative's acceptance repos and doubles as an upstream-drift alarm.

  Rename the pilot's placeholder consumer from `acme-main` to `acme-monolith` across the
  fixtures, goldens, reference configs, tests, and docs (and the drift script's live-clone env
  var `ACME_MAIN_DIR` → `ACME_MONOLITH_DIR`) for a clearer name; still fully sanitized, no
  upstream names.

## 0.77.3

### Patch Changes

- Updated dependencies [4a3e536]
  - @cat-factory/contracts@0.117.0
  - @cat-factory/kernel@0.104.4

## 0.77.2

### Patch Changes

- Updated dependencies [18a9cb5]
  - @cat-factory/contracts@0.116.1
  - @cat-factory/kernel@0.104.3

## 0.77.1

### Patch Changes

- Updated dependencies [bc77f89]
  - @cat-factory/contracts@0.116.0
  - @cat-factory/kernel@0.104.2

## 0.77.0

### Minor Changes

- 802fc05: Deployer run-start config gate: when a pipeline includes an enabled `deployer` step, validate the service's ephemeral-environment provisioning (the in-repo "what/where") AND the workspace's infra handler (the "how") are complete + correct BEFORE starting, and — best-effort — probe the resolved deployment integration's live connection. A gap now fails loudly at start with an actionable, deep-linked toast (fix the service config / configure the handler / re-test the connection) instead of an async failed environment (or a silent docker-compose no-op) mid-run.

  - New pure decision logic (`decideDeployerConfig` / `deployerServiceConfigIssues` / `hasEnabledDeployerStep`) drives a new `ExecutionService` start guard shared by start/retry/restart.
  - New `EnvironmentProvisioningService.testProvisioning` probes the already-saved handler's connection; `canProvision` now honors the run initiator's local per-user handler overrides. The run initiator is threaded through every handler-resolution path — the new gate, the Tester infra gate, and the deployer's own dispatch decision — so a valid override-only local compose setup resolves identically at start and at provision time (a run that passes the gate provisions instead of silently no-opping).
  - New wire conflict reasons `deployer_service_provisioning_incomplete` and `deployer_connection_test_failed`; `provision_type_unhandled` toasts now carry a "Configure infrastructure" jump.

### Patch Changes

- Updated dependencies [802fc05]
  - @cat-factory/contracts@0.115.0
  - @cat-factory/kernel@0.104.1

## 0.76.0

### Minor Changes

- 37d1517: Cache the checkout-free `RepoFiles` reads an agent's pre/post-ops run against a run's
  branch (caching-layer initiative, slice 4). A new `AppCaches.repoFiles` group cache serves
  the `getFile`/`listDirectory` idempotency byte-compares the `blueprints`/`spec-writer`
  post-ops issue every run and durable-driver replay, replacing a live GitHub contents-API
  round-trip per file. It is wired only on the `makeResolveRunRepoContext` (pre/post-op) path;
  the environments repo-validation and doc-quality reads stay live.

  - Grouped per `(installation, owner, repo, branch)` via the new kernel `repoFilesCacheGroup`
    helper and keyed per path (`f:`/`d:` prefixes), so one branch's reads drop together.
  - Self-verifying: each entry remembers the branch head sha it reflects, so an entry entering
    its refresh window re-validates with a single cheap `branchHeadSha` compare (bump on an
    unmoved branch, background reload otherwise) instead of re-fetching every file. A sha-pinned
    read is immutable (no probe). The head sha a cold batch stamps is read once per branch
    (memoised), so caching N files costs one extra head read, not N.
  - Coherence: the owning `commitFiles` self-invalidates the branch group after it commits, and
    the `push` webhook drops a branch it saw move out-of-band (an agent container's git push or a
    human PR-branch edit). Stays enabled on the Worker's isolate-safe profile (like the
    document-body cache, the head-sha probe re-validates without a cross-isolate bus) and in local
    mode (single-node, so `commitFiles` self-invalidation is already fully coherent).

### Patch Changes

- Updated dependencies [6198b08]
- Updated dependencies [37d1517]
  - @cat-factory/contracts@0.114.0
  - @cat-factory/kernel@0.104.0

## 0.75.1

### Patch Changes

- Updated dependencies [14eac27]
  - @cat-factory/contracts@0.113.0
  - @cat-factory/kernel@0.103.0

## 0.75.0

### Minor Changes

- ecbcbec: Add repo autodetection to the shared-stacks definition screen. A new **Autodetect** button on
  the shared-stack form reads the repo at the entered clone URL — checkout-free, over the
  workspace's VCS connection (no clone, no host daemon) — and prefills the compose-shaped fields
  from a non-binding recommendation the user reviews before saving:

  - **`composeFiles`** — the base compose file plus any `<stem>.override.ya?ml` auto-merge family
    (the common single self-contained `docker-compose.yml` case resolves to just that one file).
  - **`managedNetworks`** — the `external: true` networks the compose references, which a shared
    stack is responsible for creating + owning (the `acme-net` shape). A self-contained stack that
    defines its dependencies internally declares no external network, so this stays empty.
  - **`composeProfiles`** — the `COMPOSE_PROFILES` the file declares.
  - A suggested **name** from the repo basename (only when the field is empty).

  New wire contract `POST /workspaces/:ws/shared-stacks/detect` (`detectSharedStackContract` +
  `sharedStackRecommendationSchema`), served by `SharedStackService.detect`, which reuses the
  deterministic compose scan (`detectSharedStack`) the environment provisioning detector already
  runs. Detection is a pass-through (`detected: false`) when no VCS connection is wired, and a
  genuine read fault surfaces as an actionable error. Nothing is persisted.

### Patch Changes

- Updated dependencies [ecbcbec]
  - @cat-factory/contracts@0.112.0
  - @cat-factory/kernel@0.102.0

## 0.74.0

### Minor Changes

- fdba1ea: Shared stacks now declare their own preflight `prerequisites` (the slice-6 follow-up in the
  stack-recipes-and-shared-stacks initiative). A `SharedStack` carries a
  `prerequisites: PreflightRef[]` — the same machine-prerequisite vocabulary a consumer recipe
  declares — and `SharedStackService` re-runs those checks at the START of every bring-up
  (before clone / networks / `up`), streaming one provisioning-log step per check and failing fast
  with copy-paste remediation when a REQUIRED check is red (a non-required one is advisory). This
  closes the acme-shared-services M-rows (mkcert CA / hosts entries / ECR login) for the shared
  stack itself, not just per-PR consumer recipes.

  The probes are host-bound (local facade); a stack that declares `prerequisites` on a deployment
  with no host-probe runtime fails loudly rather than silently skipping a declared safety gate,
  mirroring the compose provider's `runPreflights` seam. Persistence is fully symmetric: a new
  `prerequisites` text-JSON column mirrored D1 (`0042_shared_stacks_prerequisites.sql`) ⇄ Drizzle,
  asserted by the cross-runtime shared-stack conformance round-trip. Pre-1.0, no data migration —
  existing rows default to `[]` (no prerequisites), unchanged behaviour.

### Patch Changes

- Updated dependencies [fdba1ea]
  - @cat-factory/contracts@0.111.0
  - @cat-factory/kernel@0.101.2

## 0.73.6

### Patch Changes

- 6a701ef: Make a failed Kubernetes apiserver connection test actionable instead of dumping the raw
  `apiserver responded 401: {"kind":"Status",…}` body. A shared
  `apiServerConnectionFailureMessage` helper now maps the auth verdicts to a human message: a
  **401** is explained as an authentication failure (expired / no-longer-recognised token, NOT
  RBAC) with the two common local-cluster causes — a short-lived `kubectl create token` token
  (default 1 hour) that aged out, or a recreated/reinstalled cluster whose token-signing keys
  rotated and invalidated every earlier token — plus the fix (mint a fresh long-lived token and
  paste it in). A **403** is explained as an RBAC denial naming the attempted operation. Wired
  into both `testConnection`s (the `kubernetes` environment provider and the Kubernetes runner
  transport); any other status keeps the raw `status: body` shape.

## 0.73.5

### Patch Changes

- 10787c4: Make the "environment provisioning failed" surface actionable when no deploy runner is wired.

  - **Backend, provider-agnostic message:** the `EnvironmentProvisioningService` error for a
    render-needing config with no `deployJobClient` no longer hardcodes Kubernetes tooling (it
    reaches for any provider that needs a container-backed deploy). It names the runtime-neutral
    transport remedies (a self-hosted runner pool, `LOCAL_DEPLOY_RUNTIME`, or the Cloudflare
    `DeployContainer` binding) or using a config that provisions without a deploy container.
  - **Structured failure reason:** `AgentFailure` gains an optional machine-readable `reason`
    (JSON column — no migration), and this condition carries `deploy_runner_unwired`
    (`EnvironmentFailureReason` in contracts) from the thrown `ValidationError` through the
    deployer-step failure path onto the run's failure, so the SPA can act on the cause without
    string-matching prose. Adds `getErrorReason` to the kernel error helpers.
  - **Frontend, precisely-gated guidance:** the board's `AgentFailureCard` shows a "Configure…"
    deep-link on `environment`-kind failures whose destination follows the cause: a
    `deploy_runner_unwired` failure on a non-local deployment links to Infrastructure → **Agent
    containers** (`runner-pool`) — where the deploy runner/pool is actually wired, so the button no
    longer dead-ends on the Test-environments tab that can't fix it — while every other environment
    failure keeps linking to Infrastructure → **Test environments** (`environment`). The
    Kubernetes+local env-var hint (`LOCAL_DEPLOY_RUNTIME` + `LOCAL_DEPLOY_HARNESS_ENTRY` /
    `LOCAL_DEPLOY_IMAGE`) is shown ONLY for the `deploy_runner_unwired` reason, in local mode, and
    for a `kubernetes` provision — so a docker-compose / transient / future non-K8s failure never
    shows inaccurate guidance.

- Updated dependencies [10787c4]
  - @cat-factory/contracts@0.110.1
  - @cat-factory/kernel@0.101.1

## 0.73.4

### Patch Changes

- Updated dependencies [f596090]
  - @cat-factory/contracts@0.110.0
  - @cat-factory/kernel@0.101.0

## 0.73.3

### Patch Changes

- Updated dependencies [9ea1e77]
  - @cat-factory/contracts@0.109.0
  - @cat-factory/kernel@0.100.0

## 0.73.2

### Patch Changes

- Updated dependencies [e66accb]
  - @cat-factory/contracts@0.108.1
  - @cat-factory/kernel@0.99.1

## 0.73.1

### Patch Changes

- 9cc02a0: Surface a real, actionable error when "auto-detect" (test-infra provisioning / frontend config)
  can't read the repository. Before, a genuine read fault (revoked App access, missing
  `Contents: read`, a rate limit, or a token-mint/transport error) was either masked as a
  misleading "nothing found" or escaped as an opaque 500, and the SPA discarded whatever the
  backend said and showed a fixed "Could not read the repository to detect provisioning." line.

  Now the checkout-free detectors record a genuine (non-404) reader throw and raise a
  `RepoReadError` when they detected nothing because of it; the environments service maps that to a
  `ValidationError` naming the repo and the underlying reason, with provider-aware guidance to check
  repository read access and rate limits (a GitHub-specific "Contents: read" hint only when the
  detect input pinned GitHub, a GitLab `read_repository` hint for GitLab, neutral otherwise — so a
  GitLab deployment isn't told to fix a GitHub-only permission). The inspector's Detect affordance
  surfaces the server's real message, and distinguishes the client-only "this frame's repo isn't in
  the connected repos" case with its own `inspector.detectRepoUnresolved` copy instead of the generic
  read-failure line.

## 0.73.0

### Minor Changes

- 1afa003: Make the **Deployer the single environment provisioner** and fix environment-lifecycle
  correctness so a `kubernetes`/`custom` service can no longer dead-end inside the Tester.

  - **Deployer in every tester/human-test built-in pipeline.** A type-aware `deployer` is seeded
    before the first tester / human-test / playwright step in the 12 relevant built-ins. It
    provisions `kubernetes`/`custom`, a `docker-compose` service with a resolvable compose handler,
    or an undeclared service on a workspace with a legacy connection, and is a fast **no-op** for
    `infraless`/frontend frames (and for `docker-compose` with no compose handler configured yet) — so
    the injection is safe everywhere. Touched built-ins get a `version` bump (reseed offer).
  - **Docker-compose provisions through the Deployer** (single-provisioner direction) whenever a
    compose handler resolves; the Tester then targets that provisioned env (`testerInfraSpec` already
    prefers a provisioned URL for any type). Until the shared-stacks compose-connection setup wizard
    lands, docker-compose with no handler stays a Deployer no-op and the Tester falls back to its
    in-container compose bring-up (no regression). See the initiative trackers for the full
    centralization owed once the wizard ships.
  - **`human-test` no longer self-provisions.** The gate READS the environment the upstream Deployer
    provisioned (the one env is shared by the AI tester + the human), and its recreate / fix-loop /
    pull-main rebuild now **loops back to the Deployer** to re-provision, rather than standing up its
    own env. No deployer before it (an infraless service) ⇒ the gate degrades to manual mode.
  - **Fail-fast run-start guard.** Starting a `kubernetes`/`custom` pipeline whose enabled chain
    reaches a tester/human-test with no enabled `deployer` before it is now refused with an actionable
    `deployer_required_before_tester` conflict (new `ConflictReason`) instead of the silent
    ephemeral-with-no-coordinates dead-end inside the Tester.
  - **Environment teardown correctness.** Superseding a provisioned env now tears the old infra down
    when the new provision targets a DIFFERENT provider identity (a config-change namespace switch, a
    provider/type change, or the `infraless` flip) — best-effort, with the TTL reaper as the backstop
    — instead of only tombstoning the registry row. Teardown + status now resolve the provider from
    the env RECORD's stored provision type/engine (the handler that stood it up), not the
    workspace-primary handler.
  - **Named-gate pipeline authoring.** Built-in pipelines are authored with `definePipeline` +
    named-step specs (`{ kind, gate, enabled }`) instead of fragile index-aligned `gates`/`enabled`
    boolean arrays, so a gate is declared on its step by name and inserting a step can't shift a flag
    onto the wrong one. The persisted wire shape is unchanged.
  - Frontend: a `deployer` palette/step metadata entry (renders as "Deployer" rather than a generic
    agent) and the localized `deployer_required_before_tester` conflict title.

  Breaking (pre-1.0, acceptable): persisted built-in pipeline copies are offered a reseed to gain the
  deployer step; a `kubernetes`/`custom` pipeline that previously relied on the Tester dead-ending is
  now refused at launch until a Deployer is added or the service is set to docker-compose/infraless.

### Patch Changes

- Updated dependencies [1afa003]
- Updated dependencies [f91b99d]
  - @cat-factory/kernel@0.99.0
  - @cat-factory/contracts@0.108.0

## 0.72.1

### Patch Changes

- eef8612: fix(runners): forward subscription-harness `callMetrics` through the runner-pool result mapper

  The Node self-hosted runner-pool transport (`HttpRunnerPoolProvider.coerceRunnerResult`)
  rebuilds a finished job's result from a fixed allow-list and never copied `callMetrics`, so
  a Claude Code / Codex run dispatched to a pool recorded zero rows in `llm_call_metrics` — the
  Cloudflare and local transports return the harness view verbatim and were unaffected. Coerce
  and forward `callMetrics` (validating each entry) so pool-backed subscription runs are
  observed identically, restoring runtime symmetry.

- Updated dependencies [bf31df7]
  - @cat-factory/contracts@0.107.0
  - @cat-factory/kernel@0.98.0

## 0.72.0

### Minor Changes

- 6f9d935: Stack recipes & shared stacks (slice 6): preflight prerequisite checks with guided remediation.

  A stack recipe can now declare machine `prerequisites: PreflightRef[]` — automated PROBE + human REMEDIATION checks for the inherently-manual one-time machine setup a complex compose repo needs (docker daemon reachable, free disk / RAM, container-registry login state, VPN reachability, mkcert CA, hosts-file entries, an env-file secrets marker). They are re-run at provision start: a failing REQUIRED check fails the provision fast with its copy-paste remediation in the provisioning log, instead of a mystery deep inside a 40-image pull (a non-required check is advisory — a warning). A `POST /workspaces/:ws/preflights/run` endpoint runs an arbitrary set of checks for the setup wizard's live re-check.

  - Contracts: `PreflightCheckId` / `PreflightParams` / `PreflightRef` / `PreflightResult` (`preflights.ts`) + `prerequisites` on `stackRecipeSchema`; the `runPreflightsContract` route.
  - Kernel: the runtime-bound `PreflightHostProbes` seam + `PreflightProbeOutcome`, and a `runPreflights` seam on `ProvisionEnvironmentRequest`.
  - Integrations: `PreflightService` (runtime-neutral orchestration over the probe seam) + provision-start enforcement in `ComposeEnvironmentProvider`.
  - Server: `PreflightController`.
  - Local facade: `createDockerPreflightProbes` (the host probes over the docker CLI + `node:*`), wired only where the compose runtime is (a Docker-family host daemon). The probes are runtime-bound (local facade only, the documented compose exception); the declaration + API are runtime-neutral and the recipe rides the existing `provisioning` blob, so there is no migration. On the Worker / plain Node the preflight API 503s and a recipe that declares prerequisites fails loudly at provision.

### Patch Changes

- Updated dependencies [6f9d935]
  - @cat-factory/contracts@0.106.0
  - @cat-factory/kernel@0.97.0

## 0.71.0

### Minor Changes

- dd6df12: feat(environments): attach per-PR compose stacks to their shared stacks (shared-stacks slice 5)

  Wire a stack recipe's `sharedStackRefs` + `externalNetworks` through to the per-PR consumer
  environment, so a complex compose repo can reach the long-lived shared infra it depends on (the
  acme `acme-net` shape). This is the provider-integration slice of the stack-recipes initiative.

  - **Provider-before-consumer bring-up.** `SharedStackService.ensureRefsUp(workspaceId, refs)`
    brings each referenced shared stack up (via the idempotent `ensureUp`) IN ORDER and returns the
    deduped union of the Docker networks they own — or a blocking `error` (never a throw) for a
    missing ref, a failed bring-up, or a deployment with no host daemon. It is exposed to the compose
    provider as the new `ProvisionEnvironmentRequest.ensureSharedStacks` seam (a kernel
    `SharedStackEnsureResult`), bound in `EnvironmentProvisioningService.buildProvisionRequest`.
  - **External-network attach.** `ComposeEnvironmentProvider.provisionRecipe` ensures the shared
    stacks up (streaming one `shared stacks (N)` provisioning-log step) and then attaches the per-PR
    project to `externalNetworks ∪ managedNetworks` via a new pure `attachExternalNetworks` folded
    into `prepareRecipeComposeFiles`: each network not already declared external across the merged
    `-f` layers is declared top-level `{ external: true }` and joined by every service (preserving
    the implicit `default` connectivity; skipping a `network_mode`-pinned service). The attach
    reasons about the MERGED stack (all `-f` layers together), not each layer in isolation, so it
    never re-adds `default` to a service the base intentionally scoped, never lands `networks` on a
    service whose `network_mode` sits in another layer (which compose rejects at `up`), and refuses —
    rather than silently overwrites — a requested network whose name collides with a project-owned
    network in the recipe.
  - Execution stays local-facade-bound (the documented compose runtime-binding exception); the recipe
    rides the existing persisted `provisioning` blob, so there is no migration. A recipe that
    references shared stacks on a deployment without the lifecycle wired fails loudly.

### Patch Changes

- Updated dependencies [5490103]
- Updated dependencies [e5b9462]
- Updated dependencies [dd6df12]
  - @cat-factory/contracts@0.105.0
  - @cat-factory/kernel@0.96.0

## 0.70.1

### Patch Changes

- Updated dependencies [accb8ec]
  - @cat-factory/contracts@0.104.0
  - @cat-factory/kernel@0.95.0

## 0.70.0

### Minor Changes

- cd435d1: Shared stacks (stack-recipes-and-shared-stacks initiative, slice 4): a workspace-scoped,
  long-lived compose stack a per-PR consumer environment attaches to over an external network
  (the acme-shared-services shape). Adds the `SharedStack` contract + `SharedStackRepository`
  port, the D1 ⇄ Drizzle `shared_stacks` table with a cross-runtime conformance round-trip, a
  `SharedStackService` lifecycle (CRUD everywhere + host-Docker `ensureUp`/`teardown` on the local
  facade, reusing the compose recipe-runner), the `GET|POST|PATCH|DELETE /workspaces/:ws/shared-stacks`
  (+ `ensure-up`/`teardown`) controller, and a "Shared stacks" panel in the Infrastructure window.
  Bringing a stack up is local-facade-bound (host daemon), the documented compose exception to
  runtime symmetry; persistence stays fully symmetric.

### Patch Changes

- Updated dependencies [cd435d1]
  - @cat-factory/contracts@0.103.0
  - @cat-factory/kernel@0.94.0

## 0.69.1

### Patch Changes

- 77bc73c: Update dependencies to the latest versions within the supply-chain release-age
  window. The Vercel AI SDK family stays within the `ai@6` / `@ai-sdk/*` majors
  that `workers-ai-provider@^3` peers require (`ai@6.0.219`,
  `@ai-sdk/anthropic@3.0.92`, `@ai-sdk/openai@3.0.80`,
  `@ai-sdk/openai-compatible@2.0.56`, `@ai-sdk/provider@3.0.13`,
  `@ai-sdk/amazon-bedrock@4.0.128`). Other bumps include `@hono/node-server`,
  `pg-boss`, `undici`, `markdown-it`, `@aws-sdk/client-s3`, `@clack/prompts`,
  `@types/node`, and eligible transitive dependencies. `@cloudflare/workers-types`
  is held at `4.x` because `wrangler@4` peers on `^4`.
- Updated dependencies [77bc73c]
- Updated dependencies [076d02f]
  - @cat-factory/kernel@0.93.0
  - @cat-factory/contracts@0.102.0

## 0.69.0

### Minor Changes

- 029a689: feat(environments): stack-recipe execution engine (shared-stacks initiative, slice 3)

  Teach the Docker Compose environment provider to run a declarative STACK RECIPE — the imperative
  bring-up of a complex multi-repo/multi-service stack (the acme-main pilot) expressed as data.
  The recipe is service-owned (`ServiceProvisioning.recipe`, landed slice 1) and now reaches the
  provider: `resolveProviderForType` folds it into the compose handler's `providerConfig.recipe` at
  provision time (the compose analogue of merging a kube `manifestSource`), so the provider keys
  purely on the persisted, merged config. Runtime-bound to the local facade (needs a host daemon) —
  the documented compose exception to runtime symmetry; the contracts + persistence stay symmetric.

  - **Multi-`-f` layering + profiles + env files** — `recipe.composeFiles` are read, `{{var}}`-
    rendered, host-escape-checked and port-neutralized per layer (concurrent per-PR stacks never
    collide), then written beside their originals in the checkout and passed as ordered `-f`s;
    `recipe.composeProfiles` drives `COMPOSE_PROFILES`; `recipe.envFiles` materialize committed
    templates into their gitignored targets before `up` (`.env.dev.local-dist` → `.env.dev.local`).
  - **Setup-step runner** — ordered `setupSteps` after `up -d` (no `--wait` — readiness is the
    recipe gate, since these stacks rarely declare healthchecks): `compose-exec` (composer install,
    migrations, cache warmup; seed import pipes a `.sql` dump via stdin), `copy-file`, `wait-http`,
    `wait-file` (container `test -f` or checkout), and the opt-in `host-command` (refused unless the
    workspace handler sets `allowHostCommands`). Each step has its own timeout budget.
  - **Terminal health gate** — `compose-healthy` (default, poll `ps`), `http`, or `compose-exec`
    (e.g. `bin/console monitor:health`), polled until it passes or its budget elapses.
  - **Per-step provisioning log** — the provider streams a `recordStep` entry per step (env file,
    `up`, each setup step, health gate) into the environment provisioning log, so the "View logs"
    drawer shows which step is running / died. Any step's failure tears the half-up stack down for a
    clean retry and surfaces the step's own error as the deployer step's `lastError`.

  New optional `ComposeRuntime` seams (implemented by the local docker-CLI runtime): `compose`
  stdin-streaming, `copyCheckoutFile`, `checkoutFileExists`, `hostCommand`. All compose safety lines
  carry over (host-escape guard on every recipe path, `include:`/cross-file `extends`/`privileged`
  refused). Fixture-driven unit tests cover the new pure helpers and the provider recipe flow
  (layering, env files, steps, stdin seed, HTTP gate, host-command opt-in, failure teardown).
  Recipe `teardownSteps` execution is deferred (the recipe schema carries them; `down -v` remains
  the teardown for now).

### Patch Changes

- 029a689: chore(environments): genericize the stack-recipes pilot name in code + fixtures

  Replace the real company name used as the stack-recipes pilot with the neutral `acme`
  placeholder across the code comments and detection test fixtures (`acme-main`, `acme-net`,
  `deployment/acme-db-dummy/*.sql`, …). Behaviour-neutral: the detection fixtures rename both
  the input and the expected assertion in lockstep, so the golden tests are unchanged.

- Updated dependencies [029a689]
- Updated dependencies [029a689]
  - @cat-factory/contracts@0.101.1
  - @cat-factory/kernel@0.92.0

## 0.68.0

### Minor Changes

- f6399cf: feat(environments): stack-recipe detection (shared-stacks initiative, slice 2)

  Extend the deterministic, checkout-free provisioning detector (`provision-detect.logic.ts`) to
  recognize the STACK RECIPE a complex `docker-compose` repo implies (the acme-main pilot),
  populating the recommendation shape slice 1 added. Still non-binding — nothing is applied beyond
  the pre-selected base layers; the wizard (slice 7) confirms.

  - **Compose-file layering** — a bare `dev.yml` base is now recognized, and a base file's
    `<stem>.override.ya?ml` auto-merge sibling is layered into `recipe.composeFiles` while
    OS-specific overrides (`dev.wsl.override.yml`, `dev.mac.override.yml`) are surfaced as opt-in
    `composeFileCandidates` annotated with `os` (never auto-layered).
  - **External networks** — a top-level `networks:` entry flagged `external: true`
    (or `external: { name }`) → `recipe.externalNetworks` + a nudge to bind it to a shared stack
    (no `sharedStackRefs` fabricated — stacks arrive in slice 4).
  - **Env-file materialization** — committed `*-dist` / `*.example` / `*.dist` config templates
    beside the compose file / in the service's config dirs → `recipe.envFiles` template→target pairs
    (`.env.dev.local-dist` → `.env.dev.local`, `.split.yaml.dist` → `.split.yaml`); non-config
    templates like `README.dist` are ignored.
  - **Profiles** — the union of services' `profiles:` labels → default-off `profileCandidates`
    (opt-in groups; never written into `recipe.composeProfiles`).
  - **Seed dumps** — `*.sql` under seed-ish dirs (`deployment/`, `seed/`, …, one level deep) →
    low-confidence `seedDumpCandidates`, fullest-dump pre-selected, wizard-confirmed into a seed step.
  - **Repo-CLI hint** — a `bin/*console*` CLI / `Makefile` / `justfile` / `Taskfile` → the report-only
    `repoCliHint` (the nudge toward the slice-8 environment analyst). Detection never parses shell.

  The compose-doc semantics (`extractExternalNetworks`, `extractComposeProfiles`) live in
  `compose-environment.logic.ts` so the compose provider (slice 5) reuses the same predicates. When a
  repo is not recipe-shaped, the recommendation is byte-for-byte the simple single-file output as
  before. Fixture-driven unit tests cover each extension plus a combined acme-main-shaped repo.

## 0.67.1

### Patch Changes

- Updated dependencies [2e4d883]
  - @cat-factory/contracts@0.101.0
  - @cat-factory/kernel@0.91.0

## 0.67.0

### Minor Changes

- 773695b: feat(documents): workspace-linked template + exemplar documents per DocKind (doc-task WS1 items 2–4)

  A workspace can now point a document kind at its OWN template and example documents, reusing
  the existing documents integration end-to-end (no new fetch machinery). A single `role`
  (`template` | `exemplar`) + `docKind` tag on the projected `documents` row — sitting alongside
  the block-scoped `linkedBlockId` anchor — models both:

  - **Template** (singular per kind): its parsed section headings REPLACE the built-in skeleton
    for that kind. Resolved through one shared seam (`resolveDocTemplate`) that BOTH the
    doc-authoring prompts (via the engine-resolved `block.docTemplateBody`) and the `doc-quality`
    gate provider go through, so the writer and the gate never check against different sections.
  - **Exemplars** (multi-valued per kind): "good examples to emulate" surfaced to the author
    agents alongside a new set of built-in curated exemplars.

  The `documents` table gains nullable `role`/`doc_kind` columns (D1 migration ⇄ Drizzle schema +
  generated migration), with new `DocumentRepository` role methods mirrored across both stores and
  asserted by the cross-runtime conformance suite. The Node facade's Drizzle migration is the
  merge node that collapses the two pre-existing divergent snapshot leaves. New workspace-scoped
  routes (`GET`/`POST /document-role-links`, `POST /document-role-links/remove`) back a
  per-DocKind template/exemplar management panel in the Integrations hub (i18n in all 8 locales).

  Breaking (pre-1.0, acceptable): the `documents` projection wire shape gains `role`/`docKind`
  fields; stale rows simply carry nulls.

### Patch Changes

- Updated dependencies [773695b]
  - @cat-factory/contracts@0.100.0
  - @cat-factory/kernel@0.90.0

## 0.66.1

### Patch Changes

- Updated dependencies [3981bbb]
  - @cat-factory/contracts@0.99.0
  - @cat-factory/kernel@0.89.1

## 0.66.0

### Minor Changes

- 48f9d97: Add opt-in AWS EKS runner + environment backends as a new standalone package
  `@cat-factory/eks`. An EKS cluster's apiserver is a standard Kubernetes apiserver, so the
  package reuses the native Kubernetes transport/provider from `@cat-factory/integrations`
  verbatim and only supplies the EKS differentiator: a short-lived SigV4-presigned STS (IAM)
  apiserver token, minted with WebCrypto (no runtime AWS SDK dependency).

  - `@cat-factory/contracts`: new first-class `{ kind: 'eks' }` runner + environment backend
    variants (`eksRunnerConfigSchema` / `eksProvisionConfigSchema`), the shared
    `eksClusterFieldsSchema` (`region` / `clusterName` / optional `stsHost`, now shape-validated),
    and the AWS secret-key constants. `'eks'` is now a reserved backend kind. `ProviderConfigField`
    gains `number` / `checkbox` / `textarea` field types, and `ProviderDescriptor` gains
    `configTemplate` / `values` so a native backend's typed config renders as a generic form.
  - `@cat-factory/integrations`: `KubernetesApiClient` gains an optional async token-provider
    seam (behaviour-preserving for the existing Kubernetes backend). `RunnerBackendProvider` gains
    an optional `form` descriptor (the shared apiserver fields live once in
    `kubernetesLogic.KUBERNETES_RUNNER_FORM_FIELDS`), so the Kubernetes/EKS runner backends
    self-describe their connect form.
  - `@cat-factory/node-server` + `@cat-factory/worker`: register the EKS backends by reference on
    BOTH facades (symmetric with the native `kubernetes` backend they extend; a pass-through until
    a workspace connects an `eks` backend). A real EKS cluster's private-CA apiserver is only
    reachable from a runtime that can pin a custom CA (Node/local) — the same constraint a
    private-CA `kubernetes` connection already carries, rejected up front at registration on the
    Worker rather than failing silently.
  - `@cat-factory/app`: the runner-pool connect form is now rendered generically from the backend
    descriptor for every backend kind (built-in `kubernetes`, opt-in `eks`, and custom native
    kinds) — the hardcoded `KubernetesRunnerForm.vue` was removed and the SPA no longer knows which
    optional backends exist. See `docs/initiatives/descriptor-driven-infra-forms.md` for the
    remaining env-axis + manifest-editor work.

### Patch Changes

- Updated dependencies [cfcb6c7]
- Updated dependencies [48f9d97]
  - @cat-factory/kernel@0.89.0
  - @cat-factory/contracts@0.98.0

## 0.65.3

### Patch Changes

- Updated dependencies [f4c321e]
  - @cat-factory/kernel@0.88.0

## 0.65.2

### Patch Changes

- Updated dependencies [13a284f]
  - @cat-factory/kernel@0.87.0

## 0.65.1

### Patch Changes

- Updated dependencies [102c049]
  - @cat-factory/contracts@0.97.0
  - @cat-factory/kernel@0.86.1

## 0.65.0

### Minor Changes

- 49b498a: Bug-triage pipeline, Phase D — issue-intake foundations (ports + persistence).

  The plumbing the upcoming `bug-intake` step (Phase E) drives: a predicate search across the
  three task-source vendors, the per-schedule intake configuration, the "taken by cat-factory"
  pickup writeback, and the replace-link that keeps a recurring block's issue context from
  accumulating across fires. No engine step yet — this phase is ports, vendor implementations,
  and persistence only.

  - **`TaskSourceProvider.searchIssues` + `IssueIntakeQuery`** (kernel port): open issues on one
    vendor board matching every predicate (title fragment / labels / issue type), oldest-first,
    deduped against the already-worked exclusion list. Predicates are pushed into the vendor
    query wherever expressible — Jira compiles ONE JQL (`statusCategory != Done`, `issuetype`,
    `labels`, `summary ~`, `issuekey NOT IN`, `ORDER BY created ASC`; excluded ids validated
    against the key shape so a malformed id can't inject), GitHub compiles search qualifiers
    (`repo:` `is:open` `type:` `label:` `in:title`, the title fragment quoted as a literal phrase
    so it can't inject a qualifier) with the API's `created-asc` sort (a new `order` param on
    `GitHubClient.searchIssues`, honoured by the GitLab-backed client too) and filters the
    exclusion list case-insensitively from a bounded, paged overscan, Linear compiles a GraphQL
    `IssueFilter` (team, state type not completed/canceled, per-label `labels.some`,
    `title.containsIgnoreCase`) asked for oldest-created-first, also paged so a run of
    already-worked issues at the front can't starve the pickup.
  - **`PipelineSchedule.issueIntake`** (contracts + both runtimes, kept symmetric): the
    schedule-scoped intake config (`source`, per-vendor `board` scope, `predicates`, the GitHub
    `inProgressLabel`) as a new `pipeline_schedules.issue_intake` JSON column — D1 migration
    `0038_schedule_issue_intake.sql` ⇄ Drizzle schema + generated migration — parsed/serialized
    by shared `@cat-factory/server` mapper helpers so the column can't drift, accepted on
    schedule create/update (PATCH is tri-state: omitted = unchanged, null = clear), and pinned
    by a cross-runtime conformance round-trip. Requiring it when the pipeline carries a
    `bug-intake` step is Phase E's schedule validation.
  - **`IssueWritebackProvider.onIssuePickedUp`**: comments "Taken by cat-factory" (+ run link)
    on the block's linked issue(s) and marks them in-progress — Jira transitions into the
    `indeterminate` status category (`pickDoneTransition` generalized into
    `pickTransitionByCategory`), Linear transitions to the team's `started` state (the Linear
    state pickers generalized into `pickStateIdByType`), GitHub applies the schedule's
    `inProgressLabel` (default `in-progress`) via a new `GitHubClient.applyIssueLabel` that
    creates the label — with the required colour — when absent.
    Best-effort per issue like the existing hooks, and deliberately NOT gated on the workspace
    writeback settings — claiming the issue is intake semantics. Wired in both facades.
  - **`TaskLinkService.replaceForBlock`** + `TaskRepository.unlinkAllFromBlock`: detach every
    issue linked to the reused block in ONE batched write (D1 ⇄ Drizzle), then link the newly
    picked issue — so linked context never accumulates across recurring fires.

- 49b498a: Bug-triage pipeline, Phase E — the `bug-intake` engine step (engine + SPA).

  The recurring bug-triage pipeline's inbound entry point: each scheduled fire pulls ONE matching
  open issue from the schedule's configured tracker board, claims it, and seeds the reused block
  from it so every downstream step works that bug. Consumes the Phase D foundations
  (`searchIssues`, `issueIntake`, `onIssuePickedUp`, `replaceForBlock`); no harness change, no
  image bump.

  - **`bug-intake` engine step** — a non-LLM one-shot step (the inbound dual of `tracker`),
    registered as a `StepHandler` in the engine so it never reaches a container. It resolves the
    schedule's `issueIntake` config by block, searches the source (predicates pushed into the
    vendor query), dedupes against every already-worked issue in ONE batched projection read,
    picks the oldest match, imports + **replace-links** it onto the block, rewrites the block's
    title/description from it, and posts the best-effort "taken by cat-factory" pickup writeback.
    The read-and-claim logic lives in a new provider-neutral `BugIntakeService`
    (`@cat-factory/integrations`), wired into the engine only when task sources are configured.
  - **No-match no-op** — when nothing qualifies (or no task source is wired), the run completes
    SUCCESSFULLY with every remaining step marked `skipped` (there is nothing to fix) and no
    notification — the outcome is visible in the schedule's run history. A scoped early-complete
    that reuses the existing skip/finalize machinery, not a new gate archetype.
  - **Schedule validation** — `RecurringPipelineService.create`/`update` now require an
    `issueIntake` config, pointed at a connected task source, whenever the pipeline carries an
    enabled `bug-intake` step (validated at both boundaries, including clearing the config on an
    existing bug-intake schedule) — otherwise every fire would silently no-op.
  - **SPA** — `RecurringPipelineModal.vue` gains an issue-intake section (source picker from the
    connected task sources, per-vendor board field, and the title/labels/issue-type predicates)
    shown when the picked pipeline has a `bug-intake` step, with i18n across all locales.
  - **Conformance** — intake pickup (a matching issue is imported, linked and seeds the block),
    the no-match no-op (the run completes with the remaining steps skipped), and the
    missing-config rejection are asserted on every runtime against a fake task source.

  Review fixes folded in:

  - The no-match no-op now finalizes the reused block `done` DIRECTLY instead of via
    `finalizeBlock`, which for a mergerless bug-triage pipeline would have flipped the block
    `pr_ready` and raised a spurious `pipeline_complete` "confirm + merge the PR" notification for a
    PR that does not exist. The conformance no-match test now asserts the `done` status and that no
    notification is raised.
  - Schedule intake validation now checks `TaskConnectionService.isOffered` (available AND enabled)
    rather than `isEnabled`, which defaults ON for a never-connected source and so would have waved
    through intake from a source with no connection to search.
  - `PipelineService.update` now rejects enabling a `bug-intake` step on a pipeline whose attached
    schedules carry no `issueIntake` config (the pipeline-edit dual of the schedule-attach guard).
  - Reseeding the reused block on pickup also clears the previous fire's `peerPullRequests` so a new
    bug doesn't inherit a prior bug's connected-repo PRs.
  - `RecurringPipelineModal.vue`'s bug-intake detection now respects the per-step `enabled` mask,
    mirroring the backend, and the literal `owner/name` / `bug` / `in-progress` placeholder examples
    are inlined in the component rather than living (and being mistranslated) in the message catalog.

- 49b498a: Bug-triage pipeline, Phase F — structured, multi-repo investigation + clarification.

  The `bug-investigator` is upgraded from a thin prose role into a STRUCTURED, read-only,
  multi-repo `container-explore` kind whose triage drives the downstream `clarity-review` gate,
  and the gate learns to seed itself from that triage instead of running its own first LLM pass.
  Same kind id, so the existing `pl_bugfix` preset inherits the upgrade.

  - **Structured `bug-investigator`** (`@cat-factory/agents`): registered via the public
    `registerAgentKind` seam (the `security-auditor` shape) with a lenient valibot
    `bugInvestigation` schema — `clarity` (`clear` | `needs_clarification`), `summary`, ranked
    `rootCauseHypotheses`, `affectedRepos`, `suggestedReproductions`, and `questions`
    (non-empty only when clarification is needed). Its structured object lands on `step.custom`
    (rendered by the stock `generic-structured` view); a built-in post-completion resolver renders
    a prose digest onto `step.output` so downstream steps read the investigation via `priorOutputs`.
    The old prose ROLE entry is removed.
  - **Read-only multi-repo checkouts** (`@cat-factory/server` + `@cat-factory/executor-harness`,
    image bump): the multi-repo fan-out gate now also fires for `bug-investigator`, and the
    container-explore job body threads `peerRepos` + the multi-repo prompt section. The harness
    gains a read-only `runMultiRepoExplore` path — it clones the primary repo PLUS every connected
    involved-service repo as SIBLING checkouts, runs the agent once at the workspace root, and
    makes NO edits / commits / PR (a read-only peer carries no `newBranch`/`pr`) — so a
    cross-service bug is traced across every repo it touches. `PeerRepoSpec.newBranch` is now
    optional (present for the coding fan-out, absent for the read-only one).
  - **Clarity gate seeding + auto-pass** (`@cat-factory/orchestration`): when a structured
    investigator ran upstream, the `clarity-review` gate seeds DETERMINISTICALLY from its triage —
    no reviewer LLM — auto-passing on `clarity === 'clear'` (advance, no human park, no
    notification) and seeding one blocking finding per `question` on `needs_clarification` (park
    for a human, exactly as an LLM reviewer pass would). Because the seed needs no model, the gate
    now activates whenever the clarity store is wired, and the review/incorporate/re-review LLM
    paths degrade gracefully when unwired. Mirrors the requirements-review auto-pass pattern.
  - **Tracker echo on park** (`@cat-factory/kernel` port + `@cat-factory/integrations`): a new
    best-effort `IssueWritebackProvider.postQuestions` echoes the open questions as a comment on
    the block's linked tracker issue when the gate parks — answers still arrive in-app (the tracker
    comment is an echo, not a channel). Not gated on the workspace writeback settings, and a
    tracker outage never fails the run.
  - **Conformance**: a two-facade suite drives the investigator → clarity gate flow — `clear`
    auto-passes straight through to the next step with the digest recorded, and
    `needs_clarification` parks one finding per question then resumes on dismiss-all + proceed.

  The runner image is bumped for the read-only multi-repo explore path; the three hand-maintained
  image-tag pins are synced.

- 49b498a: Service connections Phase 3 — multi-repo coding. The implementer now fans a cross-service
  change out across every connected involved-service repo, not just the task's own. A new
  `resolveRepoTargets` resolves the task's own repo PLUS each involved service's repo, deduped
  by repo (two services in one monorepo collapse into a single checkout with both
  subdirectories noted; a service co-located in the primary's own repo rides the own-service
  PR). `ContainerAgentExecutor` builds a `peerRepos` job body + a "Multi-repo workspace" prompt
  section for the `coder` kind and works at the repo root so it can reach every involved
  subtree. The executor-harness clones each peer repo as a SIBLING checkout under one workspace
  root, runs the agent once across all of them, and opens one PR per repo it actually changed.
  The own-service PR stays on `block.pullRequest`; the peer PRs are recorded on the new
  `block.peerPullRequests` (`AgentRunResult.peerPullRequests` → engine → JSON column, mirrored
  on D1 + Drizzle), with an `allPullRequests(block)` helper for the multi-repo-aware readers.
  Peer clone URLs are host-allowlisted exactly like the primary. Bumps the runner image
  (`peerRepos` job field + sibling-checkout flow).

### Patch Changes

- Updated dependencies [49b498a]
- Updated dependencies [49b498a]
- Updated dependencies [c20a69a]
- Updated dependencies [49b498a]
- Updated dependencies [49b498a]
  - @cat-factory/contracts@0.96.0
  - @cat-factory/kernel@0.86.0

## 0.64.0

### Minor Changes

- 1f6d9fc: Cache the workspace GitHub repo projection through the app caching seam
  (caching-layer initiative, slice 3). A new `AppCaches.repoProjection` group cache
  (grouped and keyed by workspace id) serves the whole-projection re-list that the
  block→repo resolver (`buildResolveRepoTarget`) runs on every agent dispatch and
  every durable poll tick, replacing a live `repoProjectionRepository.list` per
  resolution with a per-workspace cached read.

  Coherence is invalidation-driven: every projection write drops the workspace
  group after it commits — `GitHubSyncService` (repo link / monorepo-flag / the
  exact-set write + tombstone / the link-time full re-stamp, fanned out per
  workspace), `BoardService.addServiceFromRepo` (the monorepo-flag write on the
  import-existing-repo path), `WebhookService` (the `installation_repositories`
  removed tombstone), and `ContainerRepoBootstrapper` (projecting a freshly
  bootstrapped repo). `GitHubSyncService.syncRepo` only invalidates on a `full`
  (link-time) pass — an incremental resync re-stamps `syncedAt` alone, which the
  resolver never reads, so invalidating there would only churn the cache. The
  installation lookup and the tree-depth-bounded block ancestry walk stay live, so
  a block reparent or a service repo-link change needs no cache invalidation.

  The cache is pass-through on the Cloudflare Worker's isolate-safe profile (our own
  mutable D1 state, no cross-isolate invalidation bus), so the Worker reads the
  projection live. Local mode is likewise pass-through: it seeds the projection via
  the out-of-process `link-repo` CLI and runs single-node with no invalidation bus,
  so an in-memory TTL'd entry could serve a pre-link projection. So the cache is
  active on the multi-node-capable Node facade only. Absent a cache (tests /
  harnesses) every resolve lists live, unchanged.

### Patch Changes

- Updated dependencies [1f6d9fc]
  - @cat-factory/kernel@0.85.0

## 0.63.0

### Minor Changes

- e5ddaa4: Cache document-backed prompt-fragment bodies through the app caching seam
  (caching-layer initiative, slice 2). A new `AppCaches.fragmentDocumentBody`
  group cache serves a living fragment's external Confluence/Notion/GitHub/Figma/
  Zeplin/Linear body, replacing the hand-rolled `DEFAULT_DOCUMENT_FRAGMENT_TTL_MS`
  in `FragmentLibraryService`: a run reads the cached body instead of blocking on a
  live page fetch, and an entry entering its refresh window runs the source's cheap
  version probe — keeping the cached body when the page hasn't moved, reloading in
  the background when it has.

  To support the probe, `DocumentContent` now carries an opaque `version` token and
  `DocumentSourceProvider`/`DocumentContentResolver` gain a `probeVersion` method
  (metadata-only, strictly cheaper than a full fetch), implemented across all
  document providers. The self-verifying cache stays enabled on the Cloudflare
  Worker (bounded staleness via the probe), unlike the mutable-state fragment
  catalog.

  Behavior change (pre-1.0, no back-compat): the durable `prompt_fragments.body` is
  now the offline fallback + management-view content, refreshed only by an explicit
  create/refresh; the live run-time body flows through the cache. Without a cache
  wired, a run serves the persisted body and does not re-resolve live.

### Patch Changes

- Updated dependencies [e5ddaa4]
  - @cat-factory/kernel@0.84.0

## 0.62.1

### Patch Changes

- Updated dependencies [9bac054]
  - @cat-factory/kernel@0.83.0

## 0.62.0

### Minor Changes

- 6c1efd1: Docker Compose ephemeral envs: opt-in build-from-source mode.

  The Docker Compose environment backend was checkout-free / image-pull only and hard-rejected
  `build:`, host bind mounts, relative `env_file`, and `privileged`, so an app repo that builds
  its own images (e.g. a .NET + Angular + SQL Server stack) could not become a per-PR preview env.

  A new opt-in `build` mode (workspace handler `providerConfig.build`, mirrored advisory
  `ServiceProvisioning.composeBuild`) clones the PR head into a per-project working tree, writes
  the isolation-safe rewritten compose beside the original inside the checkout, and runs
  `docker compose build` + `up --wait`. In build mode `build:`, in-checkout relative bind mounts,
  and relative `env_file`s are honored. Image mode is unchanged and remains the default.

  Host-escape refusal is uniform across EVERY path-bearing reference, not just bind mounts: bind
  sources, `env_file`s, the `build:` context, and top-level `secrets:`/`configs:` `file:` sources are
  all run through `escapesCheckout`, which now also catches UNC/backslash-absolute paths, a
  separator-buried `../` source (`sub/../../../etc`, previously mis-read as a named volume), and an
  unresolved `${VAR}` interpolation (expands to an arbitrary host path at runtime). `include:` and
  cross-file `extends: { file }` are refused outright in both modes — the daemon merges those files
  from disk, so their services would otherwise slip a privileged container / host bind / pinned port
  past the parse-based guard. `privileged: true` stays refused.

  The `ComposeRuntime` seam gains optional `checkout`/`writeCheckoutFile` (implemented in the local
  facade via a shallow, token-authenticated git clone); `ProvisionEnvironmentRequest` gains a LAZY
  `clone` resolver (a thunk) invoked only by the build-mode provider that actually needs a working
  tree — so image-mode compose / custom / k8s-sync provisions no longer mint a short-lived VCS token
  they never use (reusing the deploy clone-target seam, memoized so one provision never mints twice).
  Build mode registers only on the docker-family local runtime — the documented runtime-bound
  exception. Build timeout is separate from the health-wait bound (`buildTimeoutMinutes`).

  Auto-detection is now content-aware: a compose stack that declares `build:` is detected and
  recommended in build-from-source mode (previously it was recommended blindly and then failed at
  provision time).

  The compose environment connect form gains an "Image source" selector (pull pre-built vs build
  from source) and a build-timeout field; the misleading "image-based stacks only" copy is removed.

### Patch Changes

- Updated dependencies [6c1efd1]
  - @cat-factory/contracts@0.95.0
  - @cat-factory/kernel@0.82.0

## 0.61.0

### Minor Changes

- 6edcce0: Personal-PAT repo access + fail-closed board redaction, and removal of the legacy repo→block link.

  - **Expand the repo picker with your own PAT (all facades).** A user's stored GitHub PAT
    (`user_secrets` kind `github_pat`) now surfaces repos it can reach beyond the workspace's GitHub
    App grant — even on the hosted Cloudflare/Node facades. Linking one creates a **personal service**
    (`GitHubRepo.linkedVia === 'user_pat'`); runs against it already use the initiator's PAT.
  - **Fail-closed frame redaction.** A service frame backed by a repo linked via another member's PAT
    is hidden from members who can't reach it: the board snapshot scrubs the frame to just its
    internal id + a "Permission denied" placeholder and drops its subtree. Access is a fail-closed
    per-user projection (`github_user_repo_access`), refreshed when a user enumerates their PAT repos
    and cleared when they remove their PAT — no live GitHub call on the snapshot path.
  - **New:** `github_repos.linked_via` column + `github_user_repo_access` table (mirrored D1 ⇄
    Drizzle, with a cross-runtime conformance suite); kernel `UserRepoAccessRepository` port and
    optional `GitHubClient.listReposForToken`/`getRepoForToken`; `Block.accessDenied` +
    `GitHubAvailableRepo.personal` wire fields.

  **Breaking (pre-1.0, no migration):** the legacy `github_repos.block_id` repo↔frame link is removed
  — the account-owned `Service` (`getByFrameBlock` → `repoGithubId`) is now the SOLE repo↔frame
  linkage. `RepoProjectionRepository.linkBlock` and `GitHubRepo.blockId` are gone; `resolveRepoTarget`
  now requires a `serviceRepository`; the `RepoBootstrapper` port's `linkRepoToBlock` is replaced by
  `projectBootstrappedRepo` (the caller binds the frame's `Service`). Existing rows' `block_id` is
  dropped; repos remain reachable through their `Service`.

### Patch Changes

- Updated dependencies [6edcce0]
  - @cat-factory/contracts@0.94.0
  - @cat-factory/kernel@0.81.0

## 0.60.2

### Patch Changes

- Updated dependencies [ef57cb1]
  - @cat-factory/contracts@0.93.0
  - @cat-factory/kernel@0.80.0

## 0.60.1

### Patch Changes

- Updated dependencies [1d738f7]
  - @cat-factory/contracts@0.92.0
  - @cat-factory/kernel@0.79.1

## 0.60.0

### Minor Changes

- 47a2975: Initiatives slice 3 — the execution loop.

  An approved initiative plan now RUNS: a new `InitiativeLoopService` drives each `executing`
  initiative — reconciling its spawned tasks, spawning the next wave just-in-time, and completing
  the initiative once every tracker item settles.

  - **The loop** (`orchestration/modules/initiative/InitiativeLoopService.ts`): per-initiative
    `tick` = reconcile (fold each spawned task block's status back onto its item — done + PR link /
    `pr_open` / `blocked` + deviation, one batched block read, no N+1) → complete (all items settled
    → initiative + anchor block `done`, tracker re-commit, notify) → spawn (create task blocks for
    the eligible `pending` items — current phase, deps met, phase not halted — up to the concurrency
    cap, each pipeline chosen by the policy's estimate→pipeline rules). Spawning is CLAIM-FIRST (a
    rev-CAS write records the pre-generated block id before any side effect), so a concurrent ticker
    never orphans a double-spawn. A per-service task-limit conflict leaves the item `pending` for the
    next sweep; a missing pipeline (deleted after ingest) records a deviation + notification and
    blocks the item — the sweep never throws.
  - **Blocked = halt the phase, notify.** A blocked item stops new spawns in its phase (and keeps the
    phase current, so the initiative never advances past it) and raises the new `initiative`
    notification type; in-flight siblings finish. A human retries/skips the item to unblock.
  - **Both cron seams + terminal pokes.** `runDue` is wired into the Worker `scheduled` handler and a
    Node one-minute interval sweeper (symmetric). A settling child run pokes its owning initiative's
    loop immediately (`RunStateMachine.emitInstance` on a terminal run, `ExecutionService.finalizeMerge`
    on a merge), so work advances without waiting for the next sweep.
  - **Controls.** Pause / resume / cancel endpoints + `InitiativeService` CAS transitions; the sweep
    skips a non-`executing` initiative. The tracker window gains a live progress bar and the inspector
    the loop controls (`initiative.inspector.pause/resume/cancel`, all locales).
  - **`listExecuting()` now returns `{ workspaceId, initiative }[]`** (the entity carries no workspace
    id) — mirrored in the D1 + Drizzle repos and asserted, with the persisted loop-state round-trip,
    by the cross-runtime conformance suite.

  No new persistence (the `initiatives` table already exists on both facades) — so no D1/Drizzle
  migration and no executor-harness image bump.

### Patch Changes

- Updated dependencies [47a2975]
  - @cat-factory/contracts@0.91.0
  - @cat-factory/kernel@0.79.0

## 0.59.0

### Minor Changes

- b928904: Service connections Phase 2 — multi-env provisioning. A `deployer` step now fans out over
  the task's own service frame PLUS each connected involved-service frame, provisioning one
  ephemeral environment per frame (dispatched provider-before-consumer, parked between), each
  keyed per `(blockId, frameId)` so the fan-out no longer clobbers itself. Already-ready peers
  are injected into a later provision as `{{input.peerEnvUrls}}`, the agent context gains
  `involvedServices` (title + connection description + the peer's live env URL, read-time
  stale-filtered), and the Tester infra spec gains a `peerEnvironments` map so a cross-service
  integration test can reach a peer's real environment.

### Patch Changes

- Updated dependencies [b928904]
  - @cat-factory/contracts@0.90.0
  - @cat-factory/kernel@0.78.0

## 0.58.1

### Patch Changes

- Updated dependencies [7fa7578]
  - @cat-factory/contracts@0.89.0
  - @cat-factory/kernel@0.77.0

## 0.58.0

### Minor Changes

- 55661f4: Add a public, key-authenticated external API (`/api/v1`) whose first use-case is "break down an
  initiative": an external system picks a public, inline pipeline and posts a brief, and the platform
  runs it headlessly and persists the result in the DB for asynchronous retrieval (poll
  `GET /api/v1/jobs/:id` or stream `GET /api/v1/jobs/:id/events` over SSE). Nothing is committed to
  GitHub — the run uses an inline agent (`initiative-breakdown`) with no container/repo.

  - Inbound public-API keys (`public_api_keys`, mirrored D1 ⇄ Drizzle) are revocable and stored as a
    one-way peppered hash (`HMAC-SHA256(secret, ENCRYPTION_KEY)`) — never plaintext, never
    recoverable. Managed per-workspace via `GET|POST|DELETE /workspaces/:ws/public-api-keys`; the raw
    key is shown once on create.
  - Runs are anchored on a headless `internal` block excluded from every board projection, so the
    external runs never appear in the UI.
  - Requires `ENCRYPTION_KEY` (the HMAC pepper); the surface 503s when unconfigured.

### Patch Changes

- Updated dependencies [55661f4]
  - @cat-factory/contracts@0.88.0
  - @cat-factory/kernel@0.76.0

## 0.57.2

### Patch Changes

- Updated dependencies [ca5c3e8]
  - @cat-factory/contracts@0.87.0
  - @cat-factory/kernel@0.75.0

## 0.57.1

### Patch Changes

- Updated dependencies [b216fdc]
  - @cat-factory/kernel@0.74.0
  - @cat-factory/contracts@0.86.0

## 0.57.0

### Minor Changes

- 7fd6a19: Import-from-repo picker: find and link accessible repos in realtime instead of enumerating the whole installation and filtering in memory. The old path listed every installation repo (capped at a bounded page count) then substring-filtered client-of-the-cap — so on a wide App install a repo beyond that window returned "no matches" for a repo you actually had access to, and every keystroke re-fetched all pages. Two new `GitHubClient` primitives fix it end to end: `searchInstallationRepos` issues one bounded, account-scoped GitHub search per query, and `getRepoById` point-reads the picked repo by id when linking it (so a repo surfaced by search from beyond the enumeration cap links instead of spuriously 409-ing). Blank-query browse-all is unchanged; PAT (local) and GitLab connections filter their bounded token listing. When an installation has no resolvable account to scope the GitHub search to, the App adapter filters its own bounded listing rather than running an unscoped global search (which would surface arbitrary, unlinkable public repos).

### Patch Changes

- Updated dependencies [7fd6a19]
  - @cat-factory/kernel@0.73.0

## 0.56.5

### Patch Changes

- Updated dependencies [0ac0dc4]
  - @cat-factory/contracts@0.85.0
  - @cat-factory/kernel@0.72.0

## 0.56.4

### Patch Changes

- Updated dependencies [36f4cf6]
- Updated dependencies [b78adf5]
  - @cat-factory/contracts@0.84.0
  - @cat-factory/kernel@0.71.0

## 0.56.3

### Patch Changes

- Updated dependencies [e0aab3f]
  - @cat-factory/contracts@0.83.0
  - @cat-factory/kernel@0.70.2

## 0.56.2

### Patch Changes

- 0d51638: Harden three server-side SSRF surfaces:

  - **Local-runner allow-list** no longer treats a DNS hostname that merely starts with `fc`/`fd`
    (e.g. `fc2.com`) as a private IPv6 ULA — the ULA/loopback tests are now gated behind an
    "is IPv6 literal" check and the classification reuses the vetted kernel `ip-host` primitives.
  - **Runner-pool provider** (`HttpRunnerPoolProvider.execute`/`oauthToken`) and the shared
    `probeConnection` now follow redirects by hand and re-run the SSRF guard on every hop, so a
    permitted scheduler host can't 302 the secret-bearing dispatch body to an internal/metadata
    target. Factored the per-hop `safeFetch` + capped-read helpers into a shared module reused by
    the environment provider. `safeFetch` additionally drops the request body and strips
    credential headers (`authorization`/`cookie`/`proxy-authorization`) on any **cross-origin**
    redirect hop, so a permitted host also can't bounce the secrets to a _different_ public host
    (re-establishing the cross-origin credential stripping the platform `fetch` would have done,
    which the manual `redirect: 'manual'` follower had bypassed).
  - **Account-configured SearXNG web-search URL** is now validated (public host, http/https, no
    private/internal/metadata target) both at the write boundary and with per-hop revalidation on
    fetch.

- 0d51638: Secret-handling hardening:

  - **LLM telemetry** (`LlmObservabilityService`) now scrubs credential shapes from the
    prompt/response/reasoning bodies AND the `errorMessage` with a shared `redactSecrets`
    (promoted to `@cat-factory/kernel`, reused by the provisioning-log path) BEFORE anything is
    stored or fanned out to an external trace sink (Langfuse). `errorMessage` is kept as
    diagnostic metadata even when bodies are dropped and is fanned out ungated, so it is
    scrubbed too (an upstream 4xx/5xx string can echo an auth header). Prompt/response/reasoning
    body capture is additionally gated on the per-workspace `storeAgentContext` toggle (numeric
    telemetry is always recorded). Also fixed a latent O(n²) regex backtrack in the URL-userinfo
    redaction rule that a large prompt could trigger.
  - **Signed tokens** (`HmacSigner`) now derive an independent HKDF-SHA256 subkey per audience
    (`session`/`oauth-state`/`llm-proxy`/`ws`/`machine`), so a token class is cryptographically
    isolated rather than sharing one raw HMAC key. Key derivation is bounded to that fixed
    audience set — `verify` selects the key from the token's attacker-controlled claimed `aud`
    before the MAC check, so an unrecognised (or absent) audience falls back to the raw-secret
    base key rather than deriving+caching a fresh subkey, preventing an unbounded key-cache /
    per-request-HKDF DoS from a flood of junk-audience tokens. Breaking: any tokens signed before
    this change no longer verify (pre-1.0, no migration — clients re-authenticate).

- Updated dependencies [0d51638]
  - @cat-factory/kernel@0.70.1

## 0.56.1

### Patch Changes

- Updated dependencies [eb67d40]
  - @cat-factory/kernel@0.70.0

## 0.56.0

### Minor Changes

- 5ce03c6: Frontend-config inspector: add repo autodetection, a frontend-directory field, clearer serve-mode
  help, and collapsible field groups.

  - **Detect from repo**: a new deterministic, checkout-free detector proposes a frontend config
    (package manager from the lockfile, install command, build script + output dir from
    package.json/framework markers, serve mode/script, and backend-binding env-var names from dotenv
    examples). Exposed as `POST /workspaces/:ws/environments/detect-frontend-config`
    (`detectFrontendConfig` on the environments connection service) and surfaced in the panel as a
    non-binding preview the user reviews and applies (backend bindings are appended, never
    overwriting existing service links).
  - **Frontend directory**: `FrontendConfig.directory` scopes a monorepo frontend's build/serve to a
    subdirectory (threaded into the harness job-body builder).
  - **Serve mode**: replaced the single hint with per-mode descriptions and a note distinguishing it
    from the separate env-injection axis.
  - **Grouping**: the panel's fields are now collapsible sections (Build / Serve / Mocking / Env
    injection / Backend bindings / Preview), collapsed by default.

### Patch Changes

- Updated dependencies [5ce03c6]
  - @cat-factory/contracts@0.82.0
  - @cat-factory/kernel@0.69.8

## 0.55.0

### Minor Changes

- 05d1b08: refactor(integrations): app-own the user-secret-kind registry (registry DI migration)

  Migrates the per-user secret KIND registry off its module-global `Map` onto an app-owned
  instance, the next slice of the registry-DI initiative (see
  `docs/initiatives/registry-di-migration.md`). The composition root now owns the registry and
  injects it, so a deployment-registered custom kind is seen by reference regardless of module
  identity — the same footgun-free pattern as the environment/runner backend registries.

  - New `UserSecretKindRegistry` class (`register`/`get`/`list`) + `defaultUserSecretKindRegistry()`
    pre-loaded with the built-in `github_pat` kind, added to `BackendRegistries` /
    `createBackendRegistries()`. `UserSecretService` reads the injected registry.
  - **Breaking:** the free `registerUserSecretKind` / `getUserSecretKind` / `listUserSecretKinds`
    exports are removed (pre-1.0, no back-compat). The built-in kind is now the exported
    `githubPatUserSecretKind` handler, registered into the default registry.
  - Wired symmetrically into the Worker + Node facades (local inherits via `buildNodeContainer`);
    the cross-runtime conformance suite asserts a programmatically-registered custom kind is
    described identically on every runtime.

### Patch Changes

- Updated dependencies [7f9d215]
  - @cat-factory/kernel@0.69.7

## 0.54.3

### Patch Changes

- Updated dependencies [4a7a3f1]
  - @cat-factory/contracts@0.81.3
  - @cat-factory/kernel@0.69.6

## 0.54.2

### Patch Changes

- 6243bea: Scope the "create task from a GitHub issue" picker's already-imported list to the
  target service's repo. The quick-pick list of imported issues was filtered only by
  source and free text, so it leaked in issues from every repo in the workspace even
  though the live search was already repo-scoped. `listTasks` now accepts an optional
  `blockId` that resolves the service's linked repo (via the same `resolveRepoTarget`
  the search uses) and drops GitHub issues from other repos; repo-less sources (Jira,
  Linear) are unaffected. The picker fetches its own repo-scoped list rather than
  reading the shared workspace-wide store.
- Updated dependencies [6243bea]
  - @cat-factory/contracts@0.81.2
  - @cat-factory/kernel@0.69.5

## 0.54.1

### Patch Changes

- 2a91615: Frontend↔backend ephemeral-stack wiring (slice 6a of the frontend-preview initiative):

  - **Reverse CORS origin injection.** A `deployer` step now passes `inputs.frontendOrigins` — the
    comma-joined browser origins (`http://localhost:<servePort>`) of every `frontend` frame that
    binds the service being provisioned (the reverse of the frontend's `backendBindings`). A
    backend manifest folds it into its CORS allow-list via `{{input.frontendOrigins}}` (HTTP-manifest
    provider) or `{{frontendOrigins}}` (Kubernetes native adapter, flat scope), so an ephemeral
    frontend can reach an ephemeral backend. Derivation is automatic (`frontendOriginsForService`,
    a single workspace block-list read — no N+1); the CORS env-var mapping stays operator-authored,
    and the backend must be re-provisioned to pick up a newly-linked frontend. The served port is
    resolved through the shared `resolveFrontendServePort` (contracts) — the same reserved-port
    sanitization the harness infra spec uses — so a `servePort` set to a reserved in-container port
    (8080/8089) injects the port the app is actually served on (4173), not the raw value.
  - **Binding-resolution correctness.** `resolveFrontendBindings` now dedupes a repeated `envVar`
    deterministically (last non-empty binding wins, matching the injected env map) instead of leaving
    it to insertion order. New `duplicateBindingEnvVars` predicate (contracts) surfaces the collision
    for the inspector + run-start notes (a follow-up slice); it is advisory, not a schema reject
    (bindings persist per-blur with an allowed empty `envVar`).

  Runtime-neutral (all facades). The inspector visibility panel + run-detail projection (6b) and the
  deterministic local preview host port (6c) are tracked follow-ups in
  `docs/initiatives/frontend-preview-ui-testing.md`.

- Updated dependencies [2a91615]
  - @cat-factory/contracts@0.81.1
  - @cat-factory/kernel@0.69.4

## 0.54.0

### Minor Changes

- 67d3876: feat(github): search available repos server-side in the "add service from repo" picker.
  The picker no longer prefetches the entire installation repo list on open (slow for a wide
  App install or PAT with hundreds of repos, and it blocked filtering until the whole list
  loaded). Instead the user types at least 3 characters and the (debounced) query is sent to
  `GET /github/available-repos?q=…`, which returns only the `owner/name` matches. The `q`
  param is optional, so the repo-link management panel's browse-all is unchanged. The now-moot
  manual "refresh list" button is removed (each search hits GitHub live).

### Patch Changes

- Updated dependencies [67d3876]
  - @cat-factory/contracts@0.81.0
  - @cat-factory/kernel@0.69.3

## 0.53.2

### Patch Changes

- 63cf6de: Performance: batch reads, parallelize independent awaits, and push work into SQL on hot paths.

  - `GET /workspaces/:id` (the board-load endpoint) now fetches its ~15 independent snapshot
    ingredients concurrently instead of serially, so its latency is the slowest read rather
    than the sum of every round-trip; the create-workspace route parallelizes its spend +
    infra-setup reads the same way.
  - Agent-context reference lookups (Jira keys / GitHub refs / URLs) run concurrently on the
    per-step dispatch path; run-start model-default resolutions run concurrently per agent kind.
  - New batched port methods, mirrored on both runtimes with conformance coverage:
    `BlockRepository.findByIds` (cross-workspace dependency resolution — one chunked query
    instead of a point-read per id, also allow-listed for mothership mode),
    `NotificationRepository.escalateStaleOpen` (the escalation sweep is now one
    `UPDATE … RETURNING` statement instead of a load-filter-upsert loop), and
    `GitHubInstallationRepository.listByInstallationIds` (connect-UI annotation).
  - GitHub webhook fan-out resolves linked workspaces via the existing batched
    `linkedWorkspaces` read instead of a per-workspace point-read on every delivery.
  - The Node Drizzle GitHub projections write chunked multi-row upserts (matching the D1
    twins' `db.batch`) instead of one round-trip per row, and their list reads run
    `ORDER BY`/`LIMIT` in SQL (NULLS LAST for D1 parity) instead of sorting full result
    sets in JS.
  - `autoStartDependents` hoists the invariant workspace-pipeline read out of its loop and
    stops re-fetching blocks it already holds.
  - Session/WS-ticket/machine-token verification reuses a memoized `HmacSigner` per secret,
    so `crypto.subtle.importKey` no longer runs on every request (`signerFor` export).
  - The Cloudflare Workflows drivers (execution / bootstrap / env-config-repair) build the
    DI container once per wake instead of once per `step.do` poll tick.

- Updated dependencies [d7f6e1c]
- Updated dependencies [63cf6de]
  - @cat-factory/kernel@0.69.2
  - @cat-factory/contracts@0.80.1

## 0.53.1

### Patch Changes

- Updated dependencies [120de05]
  - @cat-factory/contracts@0.80.0
  - @cat-factory/kernel@0.69.1

## 0.53.0

### Minor Changes

- dcc8b32: Browsable frontend preview — transport dispatch + `PreviewService` + controller + stop (slice 5c of
  the frontend-preview + in-context UI-testing initiative,
  docs/initiatives/frontend-preview-ui-testing.md).

  Wire the harness `preview` mode (slice 5b) end to end: a `frontend` frame can now be built and
  served on a HOST-reachable URL for a browsable preview, and stopped again. New pieces:

  - A new optional `PreviewTransport` kernel port — the per-runtime half that publishes a served
    app's port to an ephemeral host port and keeps the container alive past the build job. The local
    facade wires the real one over its Docker/Podman/OrbStack/Colima/Apple adapter (a second
    published port read back with `docker port` / the container IP); the Worker never wires it.
  - A runtime-neutral `PreviewService` (start / get / stop) that persists the running preview like an
    ephemeral `environments` row keyed by the `frontend` frame (reusing the existing table + soft-delete
    stop path — no new migration), plus a `PreviewController` mounting
    `GET|POST|DELETE /workspaces/:ws/frames/:frameId/preview`, gated server-side on the
    `frontendPreview.supported` capability (503 on the Worker).
  - The cross-runtime conformance suite drives the full start → serve → stop lifecycle on both Postgres
    runtimes with a fake transport, pinning the ephemeral-env-row persistence parity.

  Notes:

  - `frontendPreview.supported` now tracks whether a preview transport is actually wired: a stock Node
    build (runner pool, no host-port-publish primitive) advertises `false`, so the SPA never offers a
    Start button that would 503; local mode (and any facade injecting a `previewTransport`) advertises
    `true`.
  - Preview rows share the `environments` table but carry a dedicated `preview` discriminator (outside
    `provisionTypeSchema`), so the environment subsystem filters them out of its generic listing +
    block-resolution paths — a preview never leaks into the deployer-env UI or tester env resolution.
  - `PreviewService.get` re-polls a `ready` preview so a vanished/evicted container stops reporting a
    stale, unreachable URL (it flips to `failed`); a healthy preview whose URL merely can't be
    re-derived keeps its authoritative persisted URL.

  Local/node differentiator; the SPA surface (the clickable URL + a stop button on the frame inspector)
  lands in slice 5d. The harness is unchanged (no runner-image bump).

### Patch Changes

- Updated dependencies [dcc8b32]
  - @cat-factory/contracts@0.79.0
  - @cat-factory/kernel@0.69.0

## 0.52.2

### Patch Changes

- Updated dependencies [16ee6cc]
  - @cat-factory/contracts@0.78.1
  - @cat-factory/kernel@0.68.1

## 0.52.1

### Patch Changes

- Updated dependencies [16621f8]
  - @cat-factory/contracts@0.78.0
  - @cat-factory/kernel@0.68.0

## 0.52.0

### Minor Changes

- 9b26ff1: feat(frontend): key a deployer's ephemeral env by its service FRAME so a live `service` binding
  resolves (slice 4b of the frontend-preview + in-context UI-testing initiative,
  docs/initiatives/frontend-preview-ui-testing.md).

  A `frontend` frame's `service` binding names a service FRAME id, but a `deployer` keyed its
  ephemeral env only under the task `block_id` it ran on — so `resolveFrontendConfig`'s
  `handle === serviceBlockId` match never hit and a live-service binding fell back to WireMock even
  when the backend's env was up (the deferred keying gap slices 3/4 flagged).

  The env now also records the resolved service `frame_id` (the deployer's block walked up to its
  enclosing frame), and the frontend binding resolution matches handles on THAT. The task-keyed
  `block_id` — and the same-block deployer→tester env projection that reads it — is unchanged; this
  is an additive column, not a re-key.

  - **New `frame_id` column** on `environments`, mirrored D1 (`0030_environment_frame_id.sql`) ⇄
    Drizzle (`environments.frame_id` + generated migration), threaded through `EnvironmentRecord`,
    the `EnvironmentHandle` wire shape, and both registry repos.
  - **Keying**: `RunDispatcher.deployerProvisionArgs` resolves the service frame id via the shared
    frame walk and passes it on `ProvisionArgs.frameId`; the provisioning service persists it on both
    the provisioned and the failed-record paths.
  - **Resolution**: `AgentContextBuilder.resolveFrontendConfig` indexes the single `listHandles` read
    by `handle.frameId` (still one batch read, no per-binding point read), so a `service` binding
    resolves to its live ephemeral URL — and the frontend UI-test infra gate is satisfied instead of
    refusing the run.
  - **Conformance**: a new cross-runtime assertion provisions a service frame's env via a `deployer`,
    then a UI-tester run against a frontend bound to that frame STARTS (the mirror of the existing
    no-live-service refusal), pinning both the `frame_id` D1 ⇄ Drizzle round-trip and the
    frame-keyed resolution.

- f21279e: Warn when required infrastructure is undefined. The workspace snapshot now carries an
  `infraSetup` projection (computed server-side in `WorkspaceController` from whatever the
  deployment actually wired) that tracks three areas explicitly as `not_defined` /
  `configured` / `not_applicable`:

  - **Ephemeral environments** (all runtimes that wire the environments integration) —
    `not_defined` when no environment provider connection is registered, so testing agents
    that need a live environment can't run.
  - **Agent executor** (stock/remote Node only — Cloudflare has built-in per-run containers, and
    local mode runs agents in per-run HOST containers) — `not_defined` when no self-hosted runner
    pool is registered, so NO container agents can run. This area fires only where the pool is the
    SOLE executor (the new `agentExecutorRequiresRunnerPool` container flag, set by the Node facade
    when it uses the default pool transport); Cloudflare and local both wire the runner surface but
    keep a built-in executor, so the pool is optional there and the area is `not_applicable` — a bare
    `!!container.runners` check would otherwise falsely nag on every local deployment.
  - **Binary storage** (remote Node only — Cloudflare binds R2, local defaults to a filesystem
    store) — `not_defined` when the account selected no content-storage backend, so UI
    screenshots / reference images have nowhere to live.

  The SPA surfaces each `not_defined` area as a loud, per-area setup banner with a deep-link
  into the relevant configuration. Dismissing a banner asks whether to hide it just for this
  session (re-nags next load) or permanently — "I'm OK with the limitations, don't notify me
  again" — the latter persisted per-user in localStorage.

  The advisory top-of-board banners (AI-readiness, provider-config, infra-setup) now render in a
  single shared, click-through column so concurrent prompts on a fresh deployment stack vertically
  instead of drawing on top of each other. The `RunnerPoolConnectionService` and
  `EnvironmentConnectionService` gain a `hasConnection` presence probe (no secret decrypt) that the
  projection uses on the hot board-load path.

  Each area probe is additionally bounded by a timeout and its swallowed faults are logged, so a slow
  or misconfigured backend read degrades that area to `not_applicable` (advisory-only, never 500s or
  stalls the board load) while staying diagnosable. The banner's permanent-dismissal `localStorage`
  key + the infra-setup area list are exported from `@cat-factory/contracts`
  (`INFRA_SETUP_DISMISSED_STORAGE_KEY` / `INFRA_SETUP_AREAS`) so the SPA and the e2e seed share one
  source of truth, and the stacked banner cards announce through a single polite live region instead
  of one assertive alert each.

### Patch Changes

- ab7d589: feat(infra): view, retest and safely edit a stored Kubernetes test-environment connection

  The Test-environments Kubernetes handler previously only offered a delete: opening the edit form
  cleared the write-only ServiceAccount token, so "Test connection" on a saved connection always
  failed auth (no token) and re-saving a non-secret tweak silently wiped the stored token.

  - Backend (`EnvironmentConnectionService` + `EnvironmentUserHandlerService`, runtime-neutral):
    `testHandler` now falls back to the SAVED handler's stored secret, so an established connection
    can be tested (or a non-secret field edited and tested) without re-entering the token; a
    freshly-typed value still overrides it. Saving a handler now PRESERVES stored secrets the
    operator left blank (a blank/omitted secret means "keep it") and replaces them only when a new
    value is supplied. Shared `overlaySecrets` helper; no schema change.
  - Frontend: the Kubernetes engine form shows when a token is already saved, makes the token
    optional on edit ("leave blank to keep"), and enables Test against the stored token. The
    handler list now frames each entry as an established connection with a prominent connected
    checkbox and an inline Test-connection button.

- Updated dependencies [9e93fe8]
- Updated dependencies [9b26ff1]
- Updated dependencies [e0aa45e]
- Updated dependencies [f70c273]
- Updated dependencies [edf4e69]
- Updated dependencies [f21279e]
- Updated dependencies [6c51e31]
  - @cat-factory/contracts@0.77.0
  - @cat-factory/kernel@0.67.0

## 0.51.4

### Patch Changes

- Updated dependencies [762fe66]
  - @cat-factory/contracts@0.76.0
  - @cat-factory/kernel@0.66.1

## 0.51.3

### Patch Changes

- Updated dependencies [fb53662]
  - @cat-factory/kernel@0.66.0
  - @cat-factory/contracts@0.75.0

## 0.51.2

### Patch Changes

- Updated dependencies [6f95aff]
  - @cat-factory/contracts@0.74.0
  - @cat-factory/kernel@0.65.0

## 0.51.1

### Patch Changes

- d4d4cbc: Make credential-decryption failures actionable and isolate them.

  Previously, a stored secret sealed under a rotated/regenerated `ENCRYPTION_KEY` surfaced as
  the opaque Web Crypto `OperationError` ("The operation failed for an operation-specific
  reason") with no context — e.g. an inline requirements-review run failed at step 0 with that
  bare message and no detail, because the reviewer leases + decrypts the workspace's provider
  API keys before any LLM call (outside its own error-wrapping).

  - `WebCryptoSecretCipher.decrypt` now rethrows an actionable error on an AES-GCM auth failure,
    naming `ENCRYPTION_KEY` and the likely key-rotation cause, preserving the original as `cause`.
  - `ApiKeyService.lease` wraps a decrypt failure with the offending provider + key id.
  - `createScopedModelProviderResolver.forScope` no longer lets ONE provider's undecryptable key
    sink the whole scoped provider: it registers a deferred-failure resolver for that provider, so
    calls targeting a different, healthy provider still resolve and only a call that actually needs
    the broken provider fails (with the real cause).

## 0.51.0

### Minor Changes

- 3643708: Custom manifest types can now declare an optional `defaultManifestPath` and `fixerPrompt`.
  A `custom` service prefills its manifest path from the type's default on selection, and
  "Detect from repo" resolves the path monorepo-aware (keep an accurate current value; else
  the exact default within the service subtree/repo root; else, for a bare filename, one level
  deep; else pre-fill the default location). A new **Generate / fix manifest** button (shown
  only when the type defines a `fixerPrompt`) dispatches the fixer coding agent — reusing the
  durable `env-config-repair` run — to create the manifest at the entered path or fix it when
  invalid, after best-effort `validateRepo`. Adds the `default_manifest_path` / `fixer_prompt`
  columns to `custom_manifest_types` on both runtimes (D1 + Drizzle).

### Patch Changes

- Updated dependencies [3643708]
  - @cat-factory/contracts@0.73.0
  - @cat-factory/kernel@0.64.0

## 0.50.2

### Patch Changes

- Updated dependencies [70e321b]
  - @cat-factory/contracts@0.72.0
  - @cat-factory/kernel@0.63.4

## 0.50.1

### Patch Changes

- b744822: Surface a Kubernetes environment that can't finish provisioning instead of leaving it spinning up forever.

  Two gaps let a misconfigured ephemeral-environment (bad/insufficient ServiceAccount token, missing RBAC, or a rollout that never completes) sit at `provisioning` indefinitely with nothing shown in the run's "Infrastructure attempts":

  - `KubernetesEnvironmentProvider`'s status read mapped **every** non-OK apiserver response — including `401`/`403` — to `provisioning`. A credential/permission error never self-heals, so the env never left "spinning up". It now throws a clear error on `401`/`403` (caught + logged by `refreshStatus`, after which the human-test gate degrades to manual mode) while transient `5xx`/`429` still keep polling.
  - `EnvironmentProvisioningService.refreshStatus` only recorded a provisioning-log entry when the status read **threw**, so a reconciliation that flipped the env to `failed` without throwing (e.g. a rollout that exceeded its progress deadline, or a vanished namespace) left the "Infrastructure attempts" drawer empty. It now records a `failure` entry on the transition into `failed`.

- c40736e: Simplify the Kubernetes integration module internally (behaviour-preserving).

  - Remove the unused `isSupportedKind()` export from `kubernetes-environment.logic.ts`.
  - Drop the `KubernetesEnvironmentProvider`'s private `renderImage()`, which duplicated the
    shared `renderTemplate()`, and derive the per-PR namespace + template vars once through a
    single `provisionContext()` helper reused by `provision`, `buildProvisionJob`, and
    `finalizeProvision`.
  - Collapse the repeated apiserver GET/parse and "by name, else first in list" logic in the
    status/URL reads behind two small `getJson`/`getByNameOrFirst` helpers.
  - Share the custom-TLS runtime-support check between the runner and environment backends via
    a new `assertCustomTlsSupported()` in `kubernetes.logic.ts`.

  No functional or wire-shape changes; covered by the existing unit suite.

## 0.50.0

### Minor Changes

- 77c6842: Broaden the provisioning auto-detector and make it monorepo-aware with user-selectable candidates.

  - **More layouts recognized.** Compose detection now covers override/env-variant names
    (`compose.override.*`, `docker-compose.override.*`, `docker-compose.{prod,dev}.*`) and files nested
    under `deploy/` / `docker/` / `.docker/` / `compose/`. Kubernetes detection adds common roots
    (`charts`, `chart`, `helm`, `kustomize`, `.kube`, `infra`, `infrastructure`, `infra/manifests`,
    `deploy/k8s`, `deploy/kubernetes`, `config/k8s`, `ops`, `gitops`, `.deploy`) and nested wrapper
    subdirs (`overlays`, `base`, `helm`, `charts`, `kustomize`).
  - **Monorepo-aware.** When scoped to a service subdirectory, the detector checks both the colocated
    service folder AND the repo's root shared-deploy dirs (`deploy/<svc>`, `k8s/<svc>`,
    `manifests/services/<svc>`, …), matching the service's slice by its directory basename. Unrelated
    slices are not surfaced when colocated manifests already win, and a name-matched slice with no
    confirmable manifests is only pre-selected when it actually matches the service name (never a
    fabricated pick at an arbitrary directory).
  - **Choose instead of silent auto-pick.** The recommendation now surfaces `serviceDirCandidates`
    (which root-shared monorepo slice), `manifestRootCandidates` (which k8s root when several resolve),
    and `composeServiceCandidates` (which compose service) alongside the existing overlay candidates, each
    rendered as a selectable chip in the service inspector's "Detect from repo" panel.

  The recommendation's new fields are optional; nothing is persisted by detection. The compose service key
  is advisory (surfaced as a candidate/note only) — it is not written onto the service provisioning.

### Patch Changes

- Updated dependencies [77c6842]
  - @cat-factory/contracts@0.71.0
  - @cat-factory/kernel@0.63.3

## 0.49.0

### Minor Changes

- 79a0f48: Wire the programmatic custom provision-type catalog (`CustomManifestTypeRegistry`)
  into every facade so a code-registered `custom` manifest type is actually visible.
  Previously a deployment/provider package could register a custom manifest type, but
  no runtime constructed or injected the registry, so `listCustomTypes` always saw an
  empty registered set — the type never appeared in the infrastructure custom-type
  editor or the per-service provisioning picker.

  `customManifestTypeRegistry` now belongs to `BackendRegistries` (built by
  `createBackendRegistries()`), and the Cloudflare + Node facades thread it into
  `createCore` (local inherits via `buildNodeContainer`). A deployment registers a
  type by reference — `registries.customManifestTypeRegistry.register({ manifestId,
label, … })` — exactly like a custom environment/runner backend. The cross-runtime
  conformance suite now asserts a registered type surfaces in the handlers bundle
  (`source: 'registered'`) on both runtimes.

## 0.48.2

### Patch Changes

- 2e1354f: Improve the Kubernetes per-type engine configurator:

  - **k3s feedback** — picking the `local-k3s` engine now prefills the engine form's loopback
    defaults (API server `https://127.0.0.1:6443`, label, skip-TLS) and shows a hint banner that
    explains the prefill and how to mint a ServiceAccount token, instead of leaving the form
    unchanged. Switching back to `remote-kubernetes` clears those local-only defaults. k3s/k3d/kind
    share the same loopback defaults, so they remain one preset rather than separate options.
  - **Test connection** — the Kubernetes engine form (workspace + per-user override) gains a working
    "Test connection" button. A new `POST /workspaces/:ws/environments/handlers/test` endpoint lowers
    the engine config to a backend config and reaches the apiserver with the supplied token (nothing
    persisted), reusing the existing connection-probe path. Reported as `{ ok, message }`.

- Updated dependencies [2e1354f]
  - @cat-factory/contracts@0.70.1
  - @cat-factory/kernel@0.63.2

## 0.48.1

### Patch Changes

- 66a8c71: Fix Kubernetes provisioning auto-detection missing manifests nested under a `deploy/`
  or `deployment/` wrapper.

  `findKubernetesRoot` only inspected each candidate directory directly, so a standard
  helm/kustomize layout that lives one level deeper (e.g. `deployment/k8s/{base,overlays}`,
  as in `kibertoad/simpler-service3`) was reported as `infraless`. The detector now descends
  one level into a `k8s` / `kubernetes` / `manifests` child of any candidate wrapper dir and
  evaluates that as the manifest root, so the nested overlay tree, renderer, namespace, and
  image overrides are detected correctly.

## 0.48.0

### Minor Changes

- b4c7e60: Provisioning auto-detection now prioritizes the option matching the user's selected
  provision-type tab.

  The "Detect from repo" affordance sends the currently-selected tab (`kubernetes` vs
  `docker-compose`) as a new optional `prefer` field on `POST /environments/detect-provisioning`.
  The detector honors it: on the `docker-compose` tab a compose file wins when present (even if
  Kubernetes manifests also exist, surfaced as a low-confidence "switch to kubernetes" hint),
  falling back to the other kind when the preferred one isn't found. With no preference (or any
  non-compose tab) it keeps the historical kubernetes-first order, so existing behavior is
  unchanged unless a caller opts in.

### Patch Changes

- Updated dependencies [b4c7e60]
  - @cat-factory/contracts@0.70.0
  - @cat-factory/kernel@0.63.1

## 0.47.1

### Patch Changes

- Updated dependencies [f568a8c]
  - @cat-factory/kernel@0.63.0
  - @cat-factory/contracts@0.69.0

## 0.47.0

### Minor Changes

- 41203db: Per-service provision types (slice 11): auto-detect a recommended Kubernetes provisioning
  config from a service's repo.

  A deterministic, pure-TS heuristic detector reads a service's repo checkout-free over the
  `RepoFiles` port and proposes a NON-BINDING recommended provisioning config. High-confidence
  facts are inferred deterministically (renderer from a `kustomization.yaml`; the URL source from
  the manifest kinds — `Ingress`/`Gateway`/`HTTPRoute`/`LoadBalancer Service`; a pinned namespace;
  `generatorEnvFile` secret injections with keys read from a `.env.example`; image overrides
  defaulting the tag to `{{branch}}`); ambiguous ones (which `overlays/*` is the ephemeral one,
  helm releases from a `helmfile.yaml`/`Chart.yaml`) are surfaced as candidates with a hint
  rather than guessed. The user always confirms/edits — nothing is applied silently.

  - Contracts: `provisioningRecommendationSchema` + `detectServiceProvisioningSchema` +
    `detectServiceProvisioningContract` (`POST /workspaces/:ws/environments/detect-provisioning`).
  - `EnvironmentConnectionService.detectServiceProvisioning` runs the detector over the
    workspace-bound `RepoFiles`; new `provision-detect.logic.ts` with unit tests.
  - Frontend: a "Detect from repo" affordance in the service inspector's test-infra section that
    prefills `block.provisioning` + surfaces the per-field confidence notes, overlay candidates,
    and engine-level URL/namespace suggestions; new i18n keys across all 8 locales.

  No migration (detection is pure repo introspection — nothing persisted).

### Patch Changes

- Updated dependencies [41203db]
  - @cat-factory/contracts@0.68.0
  - @cat-factory/kernel@0.62.4

## 0.46.0

### Minor Changes

- cb9e2e3: Per-service provision types (Phase 2, slice 10): facade wiring for the async, container-backed
  Kubernetes deploy lifecycle + the local-mode native-CLI deploy transport. A `deployer` step whose
  manifests need rendering (kustomize/helm/Gateway-API) now stands its environment up in a real
  deploy container (or, locally, the host CLIs) on every runtime — slice 9's `deployJobClient` /
  `resolveDeployCloneTarget` seams are no longer unwired. The synchronous raw-manifest REST path is
  unchanged.

  - **Cloudflare Worker**: a new `DeployContainer` Durable Object (per-run, the separate
    deploy-harness image — `kubectl`/`kustomize`/`helm`) bound as `DEPLOY_CONTAINER`, with its
    `[[containers]]` block + binding + a `v4` migration in both wranglers and the class exported from
    the worker entry. The `image: 'deploy'` dispatch routes here while agent jobs stay on
    `ExecutionContainer`. `selectDeployDeps` wires a deploy-dedicated `RunnerJobClient` (over the
    deploy namespace) + `resolveDeployCloneTarget` when the binding + GitHub App are present.
  - **Node**: wires the default pool-backed `deployJobClient` (`new RunnerJobClient(resolveTransport)`)
    - a `resolveDeployCloneTarget` built from the App token mint, both overridable by a sibling facade.
      The self-hosted runner pool now forwards the `image` dispatch option (the generic
      `RunnerPoolTransport` + `HttpRunnerPoolProvider` expose it as a first-class `{{input.image}}`
      variable, and the native Kubernetes runner config gains an `imageDeploy` variant) so a pool pulls
      the deploy-harness image for `image: 'deploy'`.
  - **Local**: a new `NativeCliDeployTransport` (`LOCAL_DEPLOY_RUNTIME=native|container`). `native`
    (default) runs the deploy harness as a host process driving the developer's own
    `kubectl`/`kustomize`/`helm`; `container` runs the deploy image per job, keyed by its own job id so
    it never collides with the run's agent container. The clone target is inherited from Node's default
    (PAT mint + GitLab-aware origin).
  - **Shared**: `@cat-factory/server` exports `makeResolveDeployCloneTarget` (compose a deploy clone
    resolver from a repo-target walk + token mint, with a per-facade clone-URL override).
  - **Conformance**: the cross-runtime suite drives the engine's async render path on every facade —
    it forwards the provider's `deploy` kind + `image: 'deploy'` option through the wired client, polls
    a stubbed view, and finalizes — asserting the finalized record round-trips through each facade's
    real registry repo to an identical `ProvisionedEnvironment` on D1 and Postgres. (The per-facade
    transport selection is out of this runtime-neutral suite's scope; only local's selection has a
    dedicated unit test today.)

### Patch Changes

- Updated dependencies [cb9e2e3]
  - @cat-factory/contracts@0.67.0
  - @cat-factory/kernel@0.62.3

## 0.45.0

### Minor Changes

- 1e55e77: Per-service provision types (Phase 2, slice 9): the async, container-backed deployer lifecycle.
  A `deployer` step can now stand an environment up in a deploy container (real
  `kubectl`/`kustomize`/`helm`) — dispatch the job, park the run, poll it, and finalize the
  outcome — instead of only the synchronous in-Worker REST path. The synchronous raw-manifest
  path is unchanged.

  - `EnvironmentProvisioningService` gains the async lifecycle alongside `provision()`:
    `startProvision(args, ref)` resolves the provider and either provisions SYNCHRONOUSLY (raw
    manifests — returns a final `completed` handle) or, when the provider's
    `asyncProvision.buildProvisionJob` returns a job, DISPATCHES a `deploy`-kind job and persists
    a `provisioning` env record (so run details show the env spinning up), returning `dispatched`
    with the job ref. `pollProvisionJob` polls the deploy job's view; `finalizeProvision` maps a
    terminal view into the env record (a `failed` view → a `failed` env carrying the harness
    error); `releaseProvisionJob` reclaims the runner. Two new optional deps wire the transport:
    `deployJobClient` (the facade's `RunnerJobClient`, typed structurally so integrations stays
    runtime-neutral) and `resolveDeployCloneTarget` (the VCS-specific manifests-repo clone URL +
    ref + short-lived token). Unwired ⇒ a render-needing config fails loudly; the synchronous path
    is unaffected. The shared `provision()` internals (`resolveProvision` /
    `buildProvisionRequest` / `provisionSync` / `recordProvisioned` / `captureProvisionFailure`)
    were extracted so the sync and async paths can't drift.
  - `RunDispatcher.runDeployerStep` now dispatches via `startProvision` and parks on `awaiting_job`
    for an async deploy job (re-attaching on replay via `step.jobId`); a new `pollDeployerJob`
    branch in `pollAgentJob` drives the deploy poll — surfacing live container/subtask progress,
    recovering a container eviction by re-dispatching a fresh deploy job within the same budgets as
    the agent path, and finalizing a terminal view into the step result. The infraless no-op and
    the legacy single-connection fallback are unchanged. The deploy job ref is DETERMINISTIC (run
    id + deployer kind + eviction epoch, via the new `deployer.logic.ts` helpers) so a Workflows
    replay re-attaches instead of dispatching a duplicate container; a status-read failure during
    the poll propagates to the driver (so its `jobPollFailureTolerance` fast-fail applies, matching
    `pollAgentJob`) rather than being swallowed; and a non-eviction terminal failure marks the
    deploy container `errored`.
  - `CoreDependencies` threads `deployJobClient` + `resolveDeployCloneTarget` into
    `createEnvironmentsModule`'s provisioning service (optional). The facades wire them in slice 10,
    so both runtimes share the identical (unwired) behaviour for now — nothing dispatches a deploy
    job until slice 10's facade wiring + deploy-dispatch conformance lands.

  Review fixes folded into the slice:

  - On a successful async deploy, `completeDeployerStep` now re-projects the environment, so the
    deployer step's Environment panel shows the final `ready` env + URL instead of staying stuck on
    the dispatch-time `provisioning` snapshot.
  - A terminal deploy job (done or a genuine failure) now releases its runner via
    `releaseProvisionJob`, so the one-shot deploy container is reclaimed instead of idling out its
    `sleepAfter` window / leaking a self-hosted pool slot (the agent path's `stopRunContainer`,
    run-id keyed + final-step only, never covered the separately dispatched deploy job).
  - The `provisioning` env record `startProvision` writes after dispatch is now best-effort: a failed
    projection write no longer propagates (which the caller turns into a terminal, non-retried failure
    that would strand the live deploy container).
  - The deployer step now PINS its resolved provisioning config (`PipelineStep.deployProvisioning`) at
    dispatch, so the poll/finalize maps the job against the config the container was built from rather
    than a fresh frame read a person may have edited mid-flight (e.g. flipping to `infraless`).
  - The deploy container's terminal `errored` stamp now keys off the RESOLVED env status, so a `done`
    view the provider maps to a failed env (harness exited 0, namespace missing) no longer shows the
    container "up".
  - The eviction-recovery + subtask-progress logic shared with `pollAgentJob` is extracted into
    `recoverContainerEviction` / `applySubtaskProgress`, so the eviction budgets, the "still
    evicting…" wording, and the progress-fraction math live in one place for both paths.

### Patch Changes

- Updated dependencies [1e55e77]
  - @cat-factory/contracts@0.66.1
  - @cat-factory/kernel@0.62.2

## 0.44.1

### Patch Changes

- Updated dependencies [ecf4cc1]
  - @cat-factory/contracts@0.66.0
  - @cat-factory/kernel@0.62.1

## 0.44.0

### Minor Changes

- 858799e: Per-service provision types (Phase 2, slice 8): the `KubernetesEnvironmentProvider` render
  path. The provider now implements the `asyncProvision` capability — it builds a
  container-backed deploy job (real `kubectl`/`kustomize`/`helm`) for any config the in-Worker
  REST path can't handle, and maps the harness outcome back into a `ProvisionedEnvironment`.

  - `buildProvisionJob` returns a `deploy`-kind job (`image: 'deploy'`) when the source needs
    rendering (`renderer: 'kustomize'`) or declares helm releases / image overrides / secret
    injections, and `null` (use the synchronous REST `provision()` path) for plain raw
    manifests. Every template is rendered and every `secretRef` is resolved backend-side, so
    the job body the harness receives carries concrete values only.
  - `finalizeProvision` maps the harness's `DeployOutcome` (namespace / url / status) onto a
    `ProvisionedEnvironment`; a failed job becomes a `failed` environment carrying the error.
  - The native REST `status()` path gained the Gateway-API URL resolvers — `gatewayStatus`
    (prefer a concrete listener hostname over the assigned address) and `httpRouteStatus` (the
    route's own hostname, else the parent Gateway's address read in the parentRef's namespace)
    — so a kustomize/Gateway env resolves its URL on ongoing status polls. REST teardown/status
    are otherwise unchanged.
  - Contracts: a `kubernetesProvisionConfigSchema` (the combined cluster + URL + manifest source
    config PLUS the render inputs) is what the deploy adapter consumes; `EnvironmentConnectionService`
    merges the service's render inputs (image overrides, per-environment helm releases, secret
    injections) with the workspace engine config (shared helm releases) at provision time.
  - Kernel: `DeployCloneTarget` + `DeployProvisionInputs` (the clone coordinates + git token + job
    ref the stateless provider can't derive itself) on `ProvisionEnvironmentRequest`, supplied by
    the provisioning service before dispatch.
  - Deploy harness: when per-PR isolation is NOT requested, the harness now reads the namespace the
    built manifests actually declare (an overlay's own `namespace:`) and ensures / monitors /
    reports / tears down THAT namespace instead of the backend's per-PR default — so an
    overlay-pinned (shared) namespace no longer leaves an empty namespace behind with no URL and a
    wrong-target teardown. Image tag bumped to `0.2.2`.
  - A new optional `rolloutTimeoutSeconds` on the kube engine config is forwarded to the deploy
    job (the harness's per-Deployment rollout wait); `buildDeployJobSpec` now fails fast when the
    cluster `apiToken` secret is unset instead of dispatching an unauthenticated job. Same-named
    shared/per-env helm releases are merged by name (service overrides engine — no double install).

  The async deployer lifecycle (dispatch/poll/park) and facade wiring follow in slices 9–10, so
  nothing dispatches a deploy job yet; this slice adds + unit-tests the provider methods.

### Patch Changes

- Updated dependencies [f9678df]
- Updated dependencies [858799e]
  - @cat-factory/contracts@0.65.0
  - @cat-factory/kernel@0.62.0

## 0.43.0

### Minor Changes

- 9bb75b0: Per-service provision types (slices 3 + 4): the deployer engine step + run-details recording,
  and the per-type handler controllers + container wiring.

  Slice 3 — engine step:

  - The `deployer` step now resolves the SERVICE frame's declared `provisioning` and routes to the
    workspace handler for its type (merging the service's manifest source). A service declaring
    `infraless` records a no-op step output (nothing provisioned); an undeclared service falls
    through to the legacy single-connection path. The resolved provision type + engine are recorded
    on the `EnvironmentRecord` (success and failed paths) and surfaced on the step output
    (`Provision type:` / `Engine:` lines + `model: environment:<engine>:<providerId>`).
  - `EnvironmentProvisioningService.provision` gains an `initiatedBy` arg and a
    `resolveUserHandlerOverrides` seam: in local mode the run initiator's per-user handler
    overrides layer over the workspace handlers.

  Slice 4 — controllers + wiring:

  - New per-type infra handler HTTP surface on `EnvironmentController` (workspace-scoped): a batched
    `GET …/environments/handlers` bundle (handlers + custom-type catalog), `POST …/handlers`,
    `PATCH …/handlers/:provisionType/secrets`, `DELETE …/handlers/:provisionType`, plus custom-type
    CRUD (`PUT|DELETE …/environments/custom-types/:manifestId`).
  - New **local-mode-only** `EnvironmentUserHandlerController` mounted at the root
    (`GET /me/environment-handlers/:workspaceId`, `PUT|DELETE …/:provisionType`), backed by the new
    `EnvironmentUserHandlerService`. The service + per-user overrides are wired ONLY by the local
    facade (Worker/Node 503 the controller and ignore user overrides), enforced purely by container
    wiring.
  - `customManifestTypeRepository` is wired on all three facades (workspace catalog CRUD);
    `environmentUserHandlerRepository` only on the local facade.
  - The handler validation/lowering is extracted to a shared `buildInfraHandlerFields` helper used by
    both the workspace and per-user stores. Cross-runtime conformance asserts the per-type handler
    CRUD + custom-type CRUD + the `infraless` deployer no-op on every facade.

### Patch Changes

- Updated dependencies [9bb75b0]
  - @cat-factory/contracts@0.64.0
  - @cat-factory/kernel@0.61.1

## 0.42.1

### Patch Changes

- Updated dependencies [15c5894]
  - @cat-factory/contracts@0.63.0
  - @cat-factory/kernel@0.61.0

## 0.42.0

### Minor Changes

- f383515: Per-service provision types (slice 2c — tester collapse). **Breaking:** the per-task/per-service
  `local` vs `ephemeral` Tester toggle is gone. A service's declared `provisioning` config now
  drives the Tester's infra entirely, so these are removed (BC is a non-goal — stale rows/columns
  are simply dropped):

  - the `Block` fields `defaultTestEnvironment`, `testComposePath`, `noInfraDependencies` (folded
    into `provisioning.type` / `provisioning.composePath`) — dropped from the contract, the shared
    block mapper, and the D1 (`0026_drop_tester_env_columns.sql`) + Drizzle block columns;
  - the `tester.environment` agent-config descriptor (`@cat-factory/agents`) and its prompt/job-body
    consumers — the Tester's run mode is now derived from the service's provision type;
  - the `delegateTestEnvToProvider` workspace setting (+ its D1/Drizzle column) and the local-facade
    `resolveTesterFallbackDefault` / `resolveRequireEnvironmentProvider` wiring.

  The start-time Tester gate is rewritten: it passes for an `infraless` (or undeclared) service,
  refuses a `docker-compose` service on a runtime that can't nest containers OR with no compose
  path declared (`tester_infra_unsupported` — "limited mode" / "nothing to stand up"), and requires
  a resolvable workspace handler for a `kubernetes`/`custom` service (`provision_type_unhandled`, via
  the new `EnvironmentConnectionService.resolveHandlerForType` /
  `EnvironmentProvisioningService.canProvision` seam). The Tester's run mode (the `infra` job spec +
  the prompt run-mode line, kept in lock-step) is derived from the provision type AND the run's
  provisioned environment: a service that actually provisioned an env URL (e.g. via a `deployer`
  step) tests against it regardless of declared type, and an undeclared service runs with no infra.
  The agent-executor `service` context carries `provisioning` instead of the three legacy fields. The
  service inspector replaces the local/ephemeral toggle with a provision-type selector.

### Patch Changes

- Updated dependencies [f383515]
  - @cat-factory/kernel@0.60.0
  - @cat-factory/contracts@0.62.0

## 0.41.1

### Patch Changes

- Updated dependencies [e4cddb4]
  - @cat-factory/kernel@0.59.0
  - @cat-factory/contracts@0.61.0

## 0.41.0

### Minor Changes

- 337d94d: Per-service provision types (slice 2b — reshape `environment_connections` + handler-aware
  service). **Breaking:** `environment_connections` is rekeyed from a single per-workspace
  provider binding (`(workspace_id, provider_id)`, discriminated by `kind`) into a multi-row
  per-provision-type HANDLER table `(workspace_id, provision_type, manifest_id)` with
  `engine` / `backend_kind` / `accepts_manifest_id` columns and `handler_json` (was
  `manifest_json`); pre-reshape rows are dropped (BC is a non-goal). The kernel
  `EnvironmentConnectionRepository` port becomes a multi-row API (`listByWorkspace`,
  `getByWorkspaceAndType`, `upsert`, per-type `softDelete`), mirrored in the D1 + Drizzle repos
  and the cross-runtime conformance suite.

  `EnvironmentConnectionService` gains the final handler-aware API — `registerHandler` /
  `listHandlers` / `updateHandlerSecrets` / `unregisterHandler`, custom-manifest-type CRUD, and
  `resolveProviderForType`, which matches a service's declared provisioning to a workspace
  handler and **merges the service-owned `manifestSource` into the engine config** at resolve
  time (the what/where ÷ how split). `EnvironmentProvisioningService.provision` accepts the
  service's `provisioning` and resolves per-type (short-circuiting `infraless`). A new
  `provision_type_unhandled` conflict reason is added (wire vocabulary + SPA title).

  The existing single-connection HTTP surface (register/describe/test/connection endpoints) is
  preserved as a thin **compat bridge** over the new table, so the current infrastructure UI
  keeps working unchanged; the per-type HTTP endpoints + the frontend rebuild follow in later
  slices, as does the tester collapse (dropping `defaultTestEnvironment`).

### Patch Changes

- Updated dependencies [337d94d]
  - @cat-factory/kernel@0.58.0
  - @cat-factory/contracts@0.60.0

## 0.40.1

### Patch Changes

- 6009266: Refresh dependencies to their latest release-age-compliant versions: the Vercel AI
  SDK family within its `workers-ai-provider`-compatible majors (`ai` 6.0.214,
  `@ai-sdk/anthropic` 3.0.89, `@ai-sdk/openai` 3.0.77, `@ai-sdk/openai-compatible`
  2.0.54, `@ai-sdk/amazon-bedrock` 4.0.124), `drizzle-orm`/`drizzle-kit` 1.0.0-rc.4,
  and `yaml` 2.9.0, plus refreshed transitive resolutions.
- Updated dependencies [6009266]
  - @cat-factory/kernel@0.57.1

## 0.40.0

### Minor Changes

- 1952d6b: Per-service provision types (slice 2a — resolver + registry engine metadata). Adds the
  pure `resolveInfraHandler` resolution (service provision type → the workspace/user handler
  that serves it, per-user override winning, `infraless` → the `none` engine, ambiguous bare
  `custom` rejected), `engines()`/`acceptsManifestIds()` metadata + a `byEngine` lookup on the
  environment-backend registry (the built-ins map kubernetes → `local-k3s`/`remote-kubernetes`,
  compose → `local-docker`, manifest → `remote-custom`), and the app-owned
  `CustomManifestTypeRegistry` + `aggregateCustomManifestTypes` catalog seam. Kernel re-exports
  the new provision-type contract types. Pure/additive — the connection-table reshape, service
  consumption, and tester collapse follow in slice 2b.

### Patch Changes

- 1952d6b: Per-service provision types (slice 1 — additive foundation). Adds the
  `provisionType`/`infraEngine`/`serviceProvisioning`/`infraHandlerConfig` and
  custom-manifest-type contracts, a `provisioning` field on the service-frame `Block`
  (persisted as a JSON column on both runtimes and settable via the block update endpoint),
  and `provisionType`/`engine` fields on the environment handle. Introduces the per-user
  infra handler override table (`environment_user_handlers`, local-mode) and the workspace
  custom-manifest-type catalog (`custom_manifest_types`) — mirrored across D1 and Drizzle
  with a cross-runtime conformance suite — plus `provision_type`/`engine` columns on the
  `environments` registry. No behaviour is wired yet; the single→multi reshape of
  `environment_connections`, the resolver, and the UI follow in later slices. See
  `docs/initiatives/per-service-provision-types.md`.
- Updated dependencies [1952d6b]
- Updated dependencies [1952d6b]
  - @cat-factory/contracts@0.59.0
  - @cat-factory/kernel@0.57.0

## 0.39.0

### Minor Changes

- 2ac148d: Add a Docker Compose ephemeral-environment backend (the Checkbox-style preview-env mechanic).

  `composeEnvironmentBackend(runtime)` (new in `@cat-factory/integrations`) is an
  `EnvironmentProvider` that stands the PR repo's own `docker-compose.yml` up on a local Docker
  daemon under a per-PR `COMPOSE_PROJECT_NAME`, publishes the configured web service's port to an
  ephemeral host port, returns `http://localhost:<port>` for the Tester/`deployer` flow, and tears
  the project down on TTL. It rides the contract's generic environment-backend manifest member (no
  new config variant, no migration): the flat config lives in the stored manifest's `providerConfig`,
  written by the descriptor-driven connect form.

  To make the per-PR isolation real, the repo compose file is read checkout-free and **rewritten
  into one project file** before `up`: every service's published host port is forced ephemeral (so
  two concurrent per-PR stacks can't collide on a pinned host port — an additive `-f` overlay can't
  strip the base's mapping), the probed service is guaranteed to publish its port, and references
  this checkout-free backend can't honor — `build:` contexts, host bind mounts, relative `env_file`s,
  and `privileged` services — are **refused up front** with a clear reason instead of silently
  mis-mounting. An **auto-teardown TTL** is collected on the connect form (`ttlMinutes`, default
  2h; `0` = never) so a forgotten preview env is swept off the host instead of leaking containers +
  volumes. `testConnection` now probes the daemon (`compose ls`), not just the CLI, and every daemon
  call is time-bounded so a wedged daemon can't hang a provision/status/teardown. Default project
  names are disambiguated by block id so two workspaces sharing a repo name + PR number can't
  collide, and `status` reads `ps -a` so a brief container recreate doesn't flip a healthy env to
  `failed`.

  The local facade (`@cat-factory/local-server`) registers it by reference, closing over the host
  docker CLI, on the Docker-family runtimes only (Apple `container`, the plain Node service, and the
  Cloudflare Worker have no host docker daemon, so they don't register it — the documented
  runtime-bound asymmetry). The infrastructure picker (`@cat-factory/app`) surfaces it on the "Where
  test environments run" axis with actionable "when to use this" guidance and a local-only caveat.

  v1 supports self-contained image-based compose stacks (a service that builds from source, or that
  needs host bind mounts / relative env files, needs a full checkout — a follow-up). No
  backwards-compat concerns: this is a net-new opt-in backend.

## 0.38.1

### Patch Changes

- Updated dependencies [5fd0ffa]
  - @cat-factory/contracts@0.58.0
  - @cat-factory/kernel@0.56.1

## 0.38.0

### Minor Changes

- f9a173f: Fix three concurrency hazards in the backend with database-native primitives.

  - **Optimistic concurrency on execution runs.** `agent_runs` gains a monotonic `rev`
    column; the execution repo's `upsert` bumps it on every write and a new
    `compareAndSwap` performs a guarded conditional write. The in-place human-action handlers
    (resolve decision / request changes / reject / request-human-review-fix / resume-paused)
    now go through a `mutateInstance` retry helper, so a double-submit or a write that raced
    the durable driver is re-applied on fresh state instead of silently clobbering the other
    writer (lost update). (`retry` / `restart-from-step` mint a fresh run id, so the same-row
    hazard is structurally absent there.)
  - **Atomic API-key pool lease.** The non-transactional `listForPool → chooseToken →
markLeased` is replaced by a single atomic select-and-mark (`leaseLeastUsed`: Postgres
    `FOR UPDATE SKIP LOCKED`; D1 a single serialised write), so two concurrent dispatches
    can no longer grab the same key before usage is recorded.
  - **Notification open-card dedup.** A partial unique index on
    `(workspace_id, block_id, type) WHERE status='open'` plus an atomic
    `upsertOpenForBlock` replaces the racy `findOpenByBlock` read-before-write, so two
    concurrent raises can't stack duplicate open cards. `upsertOpenForBlock` returns the
    CANONICAL persisted row, so when a concurrent raise wins the insert the loser delivers
    and returns that row's id rather than a phantom id (which would show a duplicate inbox
    card and 404 when acted on).

  BREAKING (pre-1.0, no data migration): `agent_runs` adds a non-null `rev` column and the
  `notifications` table adds a partial unique index, mirrored across the D1 and Drizzle
  migrations. The `ExecutionRepository`, `ProviderApiKeyRepository` and
  `NotificationRepository` ports each gain a method.

### Patch Changes

- Updated dependencies [f9a173f]
  - @cat-factory/contracts@0.57.0
  - @cat-factory/kernel@0.56.0

## 0.37.1

### Patch Changes

- fdeb466: Eliminate N+1 query loops in the service layer. `ExecutionService.teardownForBlockTree` now
  resolves runs with a single `listByWorkspace` instead of a per-block `getByBlock`;
  `TaskConnectionService.listSourceStates` hoists its installation/connection reads out of the
  per-provider loop; and `BoardService` (`removeBlock` / `addServiceFromRepo`) and
  `AccountService.listForUser` batch their per-item point reads via two new chunked-`IN`
  repository methods, `ServiceRepository.listByFrameBlocks` and `AccountRepository.listByIds`
  (implemented symmetrically on the D1 and Drizzle stores, with cross-runtime conformance
  coverage). Behavior is unchanged.
- Updated dependencies [fdeb466]
  - @cat-factory/kernel@0.55.4

## 0.37.0

### Minor Changes

- 21b2096: Make the environment-backend and runner-backend registries app-owned (DI) instead of
  module-global Maps. This is the pilot for the registry-DI migration
  (`docs/initiatives/registry-di-migration.md`): the composition root now constructs each
  registry instance via `createBackendRegistries()` and injects it through
  `CoreDependencies`; a deployment registers a custom backend by reference
  (`registry.register(provider)`), so registration no longer depends on the adapter and
  server sharing the same `@cat-factory/integrations` module instance.

  BREAKING (`@cat-factory/integrations`): the module-global free functions
  `registerEnvironmentBackend` / `environmentBackend` / `registeredEnvironmentBackendKinds`
  / `environmentBackendKinds` / `findRepairCapableProvider` and their runner-backend
  equivalents (`registerRunnerBackend` / `runnerBackend` / `registeredRunnerBackendKinds`
  / `runnerBackendKinds`) are removed. Use the new `EnvironmentBackendRegistry` /
  `RunnerBackendRegistry` classes (methods `register` / `get` / `kinds` / `labelled`, plus
  `findRepairCapable` on the env registry), the `defaultEnvironmentBackendRegistry()` /
  `defaultRunnerBackendRegistry()` factories, or the unified `createBackendRegistries()`.

### Patch Changes

- Updated dependencies [21b2096]
  - @cat-factory/contracts@0.56.1
  - @cat-factory/kernel@0.55.3

## 0.36.1

### Patch Changes

- Updated dependencies [ad5d3e0]
  - @cat-factory/contracts@0.56.0
  - @cat-factory/kernel@0.55.2

## 0.36.0

### Minor Changes

- 4897078: Make the ephemeral-environment AND self-hosted runner-pool backend registries extensible to
  custom third-party kinds, so a single-tenant / self-hosted deployment can register a bespoke
  provider **programmatically** (an import side effect via `registerEnvironmentBackend` /
  `registerRunnerBackend`), mirroring custom agent kinds. This restores the capability the
  removed `buildNodeContainer({ environmentProvider })` / `startLocal({ environmentProvider })`
  deployment-wide injection used to provide, and serves both single- and multi-tenant.

  - **Contracts (breaking, additive):** `environmentBackendConfigSchema` /
    `runnerBackendConfigSchema` gain a generic custom-kind member (a lower-kebab `kind` slug,
    guarded to exclude the reserved built-ins, carrying the subsystem manifest body), so a
    custom kind's connect config validates with no new variant. The workspace snapshot gains
    `environmentBackendKinds` / `runnerBackendKinds`, and the describe routes accept an optional
    `kind` query. Existing `manifest`/`kubernetes` rows still parse — no migration.
  - **Registries:** `EnvironmentBackendProvider` / `RunnerBackendProvider` `kind` is now an open
    `string` with an optional `displayLabel`; new `environmentBackendKinds()` /
    `runnerBackendKinds()` accessors. `describeProvider(workspaceId, kind?)` can describe a
    registered kind before it is connected.
  - **Frontend:** the provider-connect backend-kind selector is snapshot-driven (built-in
    fallback) instead of a hardcoded `manifest`/`kubernetes` list; a custom kind's flat-form /
    manifest-editor save is tagged with its slug.
  - A custom kind requires a per-workspace connection (the encrypted-secret + `providerConfig`
    anchor) exactly like the built-ins. The `runnerPoolProvider` facade option is unchanged and
    remains the HTTP-pool override for the manifest backend, NOT the custom-kind seam.

### Patch Changes

- Updated dependencies [4897078]
  - @cat-factory/contracts@0.55.0
  - @cat-factory/kernel@0.55.1

## 0.35.4

### Patch Changes

- Updated dependencies [d5a0637]
- Updated dependencies [915861c]
  - @cat-factory/kernel@0.55.0
  - @cat-factory/contracts@0.54.0

## 0.35.3

### Patch Changes

- Updated dependencies [48a3df6]
- Updated dependencies [48a3df6]
  - @cat-factory/kernel@0.54.0
  - @cat-factory/contracts@0.53.0

## 0.35.2

### Patch Changes

- 614e985: Add real-cluster integration tests for the native Kubernetes runner + environment backends,
  and colocate all Kubernetes code under one module.

  The two Kubernetes adapters (`KubernetesRunnerTransport`, `KubernetesEnvironmentProvider`)
  were covered only by unit tests that stub `fetch` with hand-crafted responses, so the
  apiserver behaviours they depend on — the pod-proxy URL form, `404 → eviction`, server-side
  apply, namespace `409` idempotency, Deployment readiness, and the `status.loadBalancer` shape
  — were never validated against a real apiserver. A new integration suite (`*.it.spec.ts`, run
  via `pnpm --filter @cat-factory/integrations test:integration`) now drives both adapters
  against a real **k3d (k3s-in-Docker)** cluster, asserting the pod-proxy round-trip and the k3s
  ServiceLB-assigned URL for real. It self-skips when the `K8S_IT_*` cluster env is unset, and
  in CI runs as a blocking job gated behind a paths filter so the k3d cluster only spins up when
  Kubernetes code changes.

  That real-cluster suite caught a compatibility bug in the environment backend: its
  server-side apply sent the `application/apply-patch+json` media type, which only newer
  apiservers accept, so applying manifests `415`d on a stock/older cluster. It now sends
  `application/apply-patch+yaml` with the same JSON body (JSON is valid YAML), which every
  apiserver since 1.22 accepts — matching what kubectl/client-go do.

  The `kubernetesRunnerBackend` / `kubernetesEnvironmentBackend` registry entries moved into
  the `modules/kubernetes/` folder (the generic registries import them for side-effect
  registration); their exported names and the package's public surface are unchanged.

## 0.35.1

### Patch Changes

- Updated dependencies [0577404]
  - @cat-factory/contracts@0.52.0
  - @cat-factory/kernel@0.53.1

## 0.35.0

### Minor Changes

- 69558f9: Add a Kubernetes-based ephemeral-environment provider, selected per workspace through an
  env-backend registry that mirrors the runner-pool backends.

  The ephemeral-environment connection is now discriminated by a `kind` field (`manifest` =
  the generic BYO HTTP management API, `kubernetes` = native per-PR namespaces), resolved
  through a `registerEnvironmentBackend` provider-registry seam — so a native backend is a
  single registry entry + a config variant + a UI form, with no new table/service/controller.

  The Kubernetes backend applies an operator-authored set of k3s/Kubernetes manifests into a
  per-PR namespace over the kube-apiserver (server-side apply), reusing the Kubernetes runner
  backend's shared apiserver client (Bearer ServiceAccount token + custom-CA TLS). Manifests
  are read checkout-free from either the PR repo (co-located) or a separate repo; the URL is
  derived from an ingress host template or read back from an applied Service/Ingress
  LoadBalancer (k3s Traefik / ServiceLB). It is wired symmetrically into the Cloudflare and
  Node facades (the Worker rejects a custom-CA config it can't honor), and local mode can
  point at a developer-run local k3s (its env URL-safety policy is widened to loopback/LAN).
  See `backend/docs/local-k3s-environments.md`.

  BREAKING (pre-1.0):

  - The `environments/connection` register/test wire shape now takes a discriminated `config`
    instead of a bare `manifest`, and the `environment_connections` table gains a `kind`
    column (existing rows backfill to `manifest`).
  - The `EnvironmentProvider` provision request gains optional `runRepo` / `resolveRepoFiles`
    seams (additive).
  - The deployment-wide environment-provider injection option
    (`buildNodeContainer({ environmentProvider })` / `startLocal({ environmentProvider })`) is
    removed — native adapters register via `registerEnvironmentBackend` instead.

### Patch Changes

- Updated dependencies [69558f9]
  - @cat-factory/contracts@0.51.0
  - @cat-factory/kernel@0.53.0

## 0.34.1

### Patch Changes

- 29d8b5d: Harness error handling & observability: structured failure cause, stuck-run diagnosis, and transient API retry.

  - **Structured failure cause.** The executor-harness now reports a structured `failureCause`
    (`inactivity-timeout` | `max-duration` | `agent` | `git` | `api` | `no-usable-output` |
    `no-changes`) and an extended `detail` on a failed job view, alongside the existing one-line
    `error`. The backend prefers the structured cause to classify a failure (→ `AgentFailureKind`
    / `BootstrapFailureKind`) and falls back to the existing error-string regex when it's absent
    (older image, or a manifest pool that doesn't map the cause), so the change is backward
    compatible. The fallback now matches the bootstrap path's regex on BOTH the agent and
    bootstrap paths (a watchdog timeout classifies as `timeout`, not a generic `agent`). A `git`
    operation or an upstream `api` call that fails carries its real cause rather than `agent`.
    The Node/self-hosted runner pool forwards the structured cause/detail too (new optional
    `failureCausePath`/`detailPath` on the pool response manifest), so it isn't Cloudflare-only.
    Container eviction stays facade-detected (the harness never emits the eviction marker). The
    watchdog phrases are centralized so they can't drift from the regex that still reads them.
  - **Stuck-run diagnosis.** An inactivity kill now reports which phase was hung and the last tool
    that ran (e.g. "...likely hung in agent phase; last tool bash 40s ago"), with a per-phase
    timing breakdown in `detail` and on the failure log. A per-job child logger binds the run's
    correlation fields (jobId/repo/branch/kind) onto every line.
  - **Transient API retry.** Opening a PR/MR now retries a transient upstream failure (5xx / 429 /
    network) with bounded, abort-aware exponential backoff (honoring `Retry-After`), so a momentary
    blip no longer fails an otherwise-complete run. The 422/409 "already exists" success paths are
    unaffected.
  - **Surfaced silent degradation.** Checkpoint-push failures, dropped follow-up lines, malformed
    Pi JSONL records, and SIGKILL escalation are now logged at warn with counts instead of being
    swallowed. A final non-newline-terminated Pi event is flushed so its progress/span isn't lost.

  Bumps the `@cat-factory/executor-harness` image to `1.22.0` (and the matching tag in
  `deploy/backend`).

- Updated dependencies [29d8b5d]
  - @cat-factory/kernel@0.52.0
  - @cat-factory/contracts@0.50.1

## 0.34.0

### Minor Changes

- 40f687d: Surface container/environment spin-up breakages on the agent step instead of hanging or hiding them.

  - **Local Docker mode fails fast.** `LocalContainerRunnerTransport` now aborts the
    container start the moment the container has exited (or a CLI call fails) instead of
    spinning for the full ready timeout, and the thrown error carries the real Docker
    stderr plus a tail of the container's own logs — so a broken daemon / failed image
    pull / crashing entrypoint shows the root cause in the step's failure card and the
    provisioning-logs drawer within one poll rather than ~60s of "spinning up container".
    Adds a `logs()` method to the `ContainerRuntimeAdapter` seam (Docker + Apple adapters).

  - **Kubernetes runner fails fast on doomed pods.** `KubernetesRunnerTransport` now
    detects terminal container start-up reasons (`ImagePullBackOff`/`ErrImagePull`/
    `InvalidImageName`/`CreateContainerConfigError`/`CrashLoopBackOff`/…) and aborts the
    readiness wait immediately with the pod's real `reason: message` as a hard `dispatch`
    failure — instead of polling the full 120s and then mis-tagging a deterministic failure
    (e.g. a bad image) as a recoverable "evicted" that the engine re-drives into the same
    120s hang. The recoverable timeout/terminated paths are also enriched with the latest
    pod-status detail so a stuck pod is no longer a bare "not ready within 120000ms".

  - **Custom EnvironmentProvider failures are stored and displayed.** A failed `deployer`
    provision (the provider threw, or returned `status:'failed'`) is now a real, displayed
    step failure: the errored environment (with the provider's verbatim `lastError`) is
    persisted and stamped onto the step, and the run records a new `environment`
    `AgentFailureKind` — instead of a green step with the error buried in its prose output.
    A provider that reports `status:'failed'` WITHOUT throwing can now carry its verbatim
    reason on the new optional `ProvisionedEnvironment.error` field (`@cat-factory/kernel`),
    which surfaces as the step's `lastError` instead of a generic "Provisioning failed". The
    failure is terminal + surfaced for one-click retry (NOT auto-retried), deliberately
    symmetric with the `dispatch` (container-failed-to-start) failure.

  **Breaking shape change:** `agentFailureKindSchema` gains the `environment` member.
  Pre-1.0, no migration — stale failure rows simply don't use the new kind.

### Patch Changes

- Updated dependencies [40f687d]
  - @cat-factory/contracts@0.50.0
  - @cat-factory/kernel@0.51.0

## 0.33.0

### Minor Changes

- e0f1149: Design-context sources: add Zeplin, generalize the abstraction, drop the Claude Design backend connector.

  - **New source: Zeplin** (`source='zeplin'`, per-workspace Bearer PAT) — a real server-fetchable
    REST handoff source exposing screens, components and design tokens. On by default; a no-op until a
    workspace connects it.
  - **De-Figma-shaped abstraction:** Figma and Zeplin now map into a shared, source-neutral
    `DesignContext` model rendered by `renderDesignContext` (`integrations/documents/design.logic.ts`).
    The per-source prompt fragments collapse into a single `design.context` fragment.
  - **Breaking — Claude Design backend connector removed.** Its only real read path is login-bound
    (Claude Code's `DesignSync` / `/design-sync`, via the user's claude.ai login), so a headless
    multi-tenant backend can never authenticate. The provider, the `'claude-design'` source value, the
    descriptor `credentialScope` field, and the entire per-user `user_document_connections` store
    (D1 + Drizzle tables, repositories, kernel ports, scope-aware `DocumentConnectionService`) are
    removed — all document sources are workspace-scoped again. The supported Claude Design workflow is
    now: `/design-sync` into the repo → commit → agents read it as checkout files. Stale
    `user_document_connections` rows are dropped (D1 migration `0020`, Drizzle drop migration); per the
    pre-1.0 policy there is no data migration.

### Patch Changes

- Updated dependencies [e0f1149]
  - @cat-factory/contracts@0.49.0
  - @cat-factory/kernel@0.50.0

## 0.32.0

### Minor Changes

- fc324d2: Add Kubernetes support for executor containers via a universal "agent runner backend"
  abstraction.

  The self-hosted runner pool is generalized into a discriminated runner-backend
  connection (a new `kind` field): `manifest` (the existing BYO HTTP scheduler pool) and
  `kubernetes` (new), with a `registerRunnerBackend` provider-registry seam so future
  backends (Nomad, EKS, …) are a single registry entry + a config variant + a UI form — no
  new table, service, controller, or integration window.

  The Kubernetes backend (`KubernetesRunnerTransport`, target k8s 1.35+) runs one bare Pod
  per run and reaches the per-pod executor-harness through the kube-apiserver **pod-proxy
  subresource** (Bearer ServiceAccount token), so the orchestrator needs only HTTPS to the
  apiserver — no in-cluster networking or per-run Service — and full `RunnerJobView`
  fidelity is preserved with zero executor-harness changes. It is wired symmetrically into
  both the Cloudflare and Node facades (and local mode via Node), and surfaced in the
  existing runner-backend Integrations window via a backend-type selector.

  BREAKING (pre-1.0): the `runner-pool/connection` register/test wire shape now takes a
  discriminated `config` instead of a bare `manifest`, and the `runner_pool_connections`
  table gains a `kind` column (existing rows backfill to `manifest`). The
  `executor-harness` image is unchanged (no image/tag bump).

### Patch Changes

- Updated dependencies [fc324d2]
  - @cat-factory/contracts@0.48.0
  - @cat-factory/kernel@0.49.0

## 0.31.0

### Minor Changes

- e3b3540: feat(environments): durable, asynchronous environment-provider config-repair agent

  When mechanical config bootstrap can't produce a valid provider config (`needsAgent`, or the
  re-validation still fails) and the caller passed `allowAgentFallback`, the engine dispatches a
  coding agent that fixes the provider's config file in an existing repo and pushes the fix back.
  That repair is now a **durable, asynchronous, observable run** — modelled exactly on the
  "bootstrap repo" flow — instead of being awaited synchronously inside the `bootstrapRepo` HTTP
  request (a ~20-minute in-request poll loop that could not survive on the Cloudflare Worker).

  - The repair is its own `kind='env-config-repair'` run in the unified `agent_runs` table (no DB
    migration — the table is kind-scoped), driven durably by **Cloudflare Workflows**
    (`EnvConfigRepairWorkflow`) ⇄ **Node pg-boss** (`env-config-repair.advance` queue), and
    re-driven by the existing cron / stale-run sweeper on either runtime. Local mode inherits the
    pg-boss driver via `buildNodeContainer`.
  - `ContainerEnvConfigRepairer` (`@cat-factory/server`) is reworked into the kernel
    `EnvConfigRepairer` port (`startRepair`/`pollRepair`/`stopRepair`) — dispatch returns
    immediately; the durable runner polls. It still dispatches a plain `coding` job (no `bootstrap`
    block, no PR, no force-push), distinct from the repo-bootstrap flow.
  - `bootstrapRepo` now **starts** the repair run and returns immediately with `usedAgent:true`,
    `repairJobId`, and `ok:false` (pending); the new `EnvConfigRepairService` re-validates the repo
    on completion (via a callback into `EnvironmentConnectionService`, where the decrypted secrets +
    manifest config live) and records the terminal `ok`/`issues`. In PR mode the fix is targeted at
    the config PR branch, not the target branch.
  - The run is observable: progress/outcome is pushed as an `env-config-repair` workspace event and
    carried on the workspace snapshot (`envConfigRepairJobs`); the SPA holds it in the agentRuns
    store and rides the unified `agent-runs` retry/stop endpoints (the new kind supports both —
    retry re-starts a fresh run from the failed job's coords). There is no board block — a repair is
    surfaced only on the infrastructure-providers surface that triggered it.
  - Wired symmetrically across the Cloudflare, Node and local facades, with a cross-runtime
    conformance assertion (`driveEnvConfigRepair` + a fake `EnvConfigRepairer`) that drives a repair
    to `succeeded` with the post-repair validation recorded on both D1 and Postgres. Gated on the
    container prerequisites plus a provider that supports `describeRepairAgent`, so a stock
    deployment running the generic manifest provider is unchanged.
  - The original bootstrap `inputs` (which shape the repair agent's prompt) are persisted on the
    run record (internal, never on the wire), so a retry re-dispatches a fresh run with the SAME
    prompt context via `EnvConfigRepairService.retry` instead of dropping them.

  Breaking (pre-1.0, no migration): the `dispatchConfigRepair` /
  `CoreDependencies.dispatchEnvConfigRepair` seam is replaced by the `EnvConfigRepairer` /
  `EnvConfigRepairRunner` / `EnvConfigRepairJobRepository` ports + `Core.envConfigRepair`; any
  in-flight synchronous repair shape is obsolete.

### Patch Changes

- Updated dependencies [e3b3540]
  - @cat-factory/contracts@0.47.0
  - @cat-factory/kernel@0.48.0

## 0.30.0

### Minor Changes

- 704c99e: Fill the gaps in Linear support:

  - **Connection pagination**: the Linear task source now walks the `children` and
    `comments` GraphQL connection cursors, so an epic with more than one page of
    sub-issues imports its full child set (no longer silently capped at ~50) — matching
    the Jira provider's epic-children pagination.
  - **Team picker for ticket filing**: a new `GET /workspaces/:ws/task-sources/linear/teams`
    endpoint lists the connected workspace's Linear teams, and the issue-tracker settings
    UI offers a searchable (typeahead) team picker instead of requiring a hand-pasted team
    UUID.
  - **OAuth connect flow**: Linear can now be connected via OAuth ("Connect with Linear")
    in addition to a personal API key. The OAuth app credentials (client id / secret /
    redirect URL) are configured **per account in the UI** (account Deployment settings,
    sealed in the DB and resolved dynamically — mirroring the Slack OAuth model), NOT via
    env vars, so an admin can set/rotate them without a redeploy. Absent ⇒ only the manual
    API-key path is offered. The exchanged access token is stored as the connection and
    used as a `Bearer` token across import, search, ticket filing and PR writeback.
  - **Search exact-ref match**: pasting a Linear issue identifier or URL into search now
    resolves and surfaces that exact issue first (de-duped against the term hits), like the
    GitHub Issues source.

### Patch Changes

- Updated dependencies [704c99e]
  - @cat-factory/contracts@0.46.0
  - @cat-factory/kernel@0.47.2

## 0.29.0

### Minor Changes

- 3d0b85c: feat(environments): wire the live environment-provider config-repair agent (PR #416 increment 2)

  When mechanical config bootstrap can't produce a valid provider config (`needsAgent`, or the
  post-commit re-validation still fails) and the caller passed `allowAgentFallback`, the engine now
  dispatches a coding agent that clones the target repo at the write branch, fixes the provider's
  config file in place, and pushes the fix back onto the same branch — then `EnvironmentConnectionService`
  re-validates.

  - New `ContainerEnvConfigRepairer` (`@cat-factory/server`) dispatches a plain `coding` job via the
    shared `RunnerJobClient`/`RunnerTransport` (no `bootstrap` block, no PR) and awaits it. It is
    distinct from the repo-bootstrap flow — it never reinitialises history or force-pushes.
  - The `dispatchConfigRepair` / `CoreDependencies.dispatchEnvConfigRepair` seam now returns `void`
    (it only pushes the fix); re-validation moved into `EnvironmentConnectionService`, where the
    decrypted secrets + manifest config live.
  - Wired symmetrically across the Cloudflare and Node facades (local inherits via `buildNodeContainer`),
    gated on the container prerequisites plus an injected provider that supports `describeRepairAgent`,
    so a stock deployment running the generic manifest provider is unchanged.

## 0.28.1

### Patch Changes

- Updated dependencies [c2ec53b]
  - @cat-factory/contracts@0.45.1
  - @cat-factory/kernel@0.47.1

## 0.28.0

### Minor Changes

- 4b5d267: Environment provider repo-config lifecycle: validate + bootstrap (+ agent-repair seam)

  Adds optional `EnvironmentProvider` capabilities so a native adapter (e.g. one for an
  in-house ephemeral-environment system) can manage its config file inside the deployed repo:

  - `validateRepo` — mechanical repo-config validation, run on-demand
    (`POST /environments/connection/validate-repo`) and as a provision pre-flight gate that
    fails synchronously before `provider.provision()` instead of as an async failed environment.
  - `describeBootstrapInputs` + `bootstrapProviderConfiguration` — mechanically generate the
    config file from UI-collected variables; the engine commits it (idempotent; optional PR) and
    re-validates (`POST /environments/connection/bootstrap-repo`).
  - `describeRepairAgent` — agent-repair prompt + dispatch seam (the live engine dispatch is
    scaffolded but not yet wired; see `backend/docs/env-lifecycle.md`).

  All repo I/O flows through the existing VCS-neutral `RepoFiles` abstraction, so the provider
  never sees a VCS host or token (GitHub today, GitLab later). The provider descriptor now
  carries `supportsRepoValidation` / `supportsRepoBootstrap` / `bootstrapInputs`. The generic
  `HttpEnvironmentProvider` implements none of these, so manifest-driven providers are unchanged.

### Patch Changes

- Updated dependencies [4b5d267]
  - @cat-factory/kernel@0.47.0
  - @cat-factory/contracts@0.45.0

## 0.27.0

### Minor Changes

- 8727f2b: Filesystem blob backend + UI-managed, per-account content storage.

  - New `FilesystemBinaryBlobBackend` (Node/local) stores binary artifacts (UI-tester
    screenshots, reference designs) on disk under a base path (default `.file-storage`,
    git-ignored). Added `'fs'` to `BinaryArtifactStorageKind`.
  - Content-storage configuration moves entirely into the UI, scoped per **account**
    (Account → Deployment settings), stored in `account_settings` (no DB migration; the
    S3 access keys are sealed in the existing secrets blob). The blob backend is now
    resolved per request/run from the account's settings via the new
    `makeResolveBinaryArtifactStore` seam (`@cat-factory/server`), replacing the static
    `binaryArtifactStore` on the container with a `resolveBinaryArtifactStore(workspaceId)`.
  - Available backends per runtime: **Node/local** offer `fs` / `s3` / `db`, **Cloudflare**
    offers `r2` only (S3 is deliberately not offered on the Worker — the AWS SDK does not belong
    in the Worker bundle). Defaults when an account hasn't configured storage: **local** defaults
    to the filesystem backend (works out of the box); **Node** defaults to off (storage requires
    explicit configuration); **Cloudflare** defaults to its R2 bucket.

  BREAKING: the env-var content-storage configuration is removed — `BINARY_STORAGE_BACKEND`,
  `S3_ARTIFACT_*`, and `AppConfig.binaryStorage`/`BinaryStorageConfig` no longer exist.
  Configure storage per-account in the UI instead. Switching an account's backend orphans its
  previously-stored artifacts (no migration of existing bytes), which is acceptable pre-1.0.

### Patch Changes

- Updated dependencies [764c05b]
- Updated dependencies [764c05b]
- Updated dependencies [8727f2b]
- Updated dependencies [56e6ce6]
  - @cat-factory/kernel@0.46.0
  - @cat-factory/contracts@0.44.0

## 0.26.5

### Patch Changes

- 8fad695: Update dependencies to latest.

  - `undici` 7→8 (test-only `MockAgent`). undici's MockAgent must match Node's
    bundled undici to intercept the global `fetch`; Node 26 bundles undici 8.5.0,
    so the test runner / CI is pinned to **Node 26**. Production runtime is
    unaffected — `undici` is a dev/test dependency only, and the service still runs
    on any Node >=20 (e.g. the example `deploy/node` image stays on Node 24).
  - Minor/patch bumps: `wrangler` 4.105, `@cloudflare/*`, `@types/node` 26.0.1,
    `vue` 3.5.39, `msw` 2.14.6, `valibot` 1.4.2, `workers-ai-provider` 3.2.1,
    `@toad-contracts/*` (core 0.4.0, valibot 0.5.0, hono/testing/http-client 0.3.2),
    `@aws-sdk/client-s3` 3.1075.
  - The AI SDK (`ai`, `@ai-sdk/*`) is intentionally held at v6 / v3-v4: the latest
    `workers-ai-provider` (3.2.1, the Cloudflare Workers AI provider) still peers on
    `ai@^6` / `@ai-sdk/provider@^3` and is not yet compatible with `ai` v7.
  - Pinned the whole Vue runtime family to one version via a pnpm `override`
    (`vue` + `@vue/*` → 3.5.39). Bumping `vue` to 3.5.39 left Nuxt 4.4.8's
    transitive deps pinning parts of the graph to 3.5.38, so two copies of Vue were
    bundled into the SPA; Vue's render internals are module-level singletons, so the
    second copy crashed the app on boot (`Cannot read properties of null (reading
'ce')` in `renderSlot`) — a blank 500 page that hung the whole e2e suite. One
    version = one singleton.
  - GitHub Actions: `actions/checkout` v6→v7, `pnpm/action-setup` v6.0.9,
    `zizmorcore/zizmor-action` v0.5.7, `changesets/action` pinned to v1.9.0. CI Node 24→26.

- Updated dependencies [8fad695]
  - @cat-factory/contracts@0.43.3
  - @cat-factory/kernel@0.45.5

## 0.26.4

### Patch Changes

- Updated dependencies [fb339db]
  - @cat-factory/contracts@0.43.2
  - @cat-factory/kernel@0.45.4

## 0.26.3

### Patch Changes

- Updated dependencies [ab146e5]
  - @cat-factory/kernel@0.45.3

## 0.26.2

### Patch Changes

- c11a0cc: Add a `prepublishOnly` build hook so each package is compiled to `dist/` before it is
  packed, regardless of how publish is invoked. `dist/` is gitignored and was only built by
  the canonical `pnpm ci:publish` flow, so a bare `pnpm publish` could ship an empty shell
  (this is what happened to `@cat-factory/gitlab` and `@cat-factory/provider-s3`). The hook
  removes that footgun for every publishable library.
- Updated dependencies [c11a0cc]
  - @cat-factory/contracts@0.43.1
  - @cat-factory/kernel@0.45.2

## 0.26.1

### Patch Changes

- Updated dependencies [5363166]
  - @cat-factory/kernel@0.45.1

## 0.26.0

### Minor Changes

- eab73b8: feat(documents): add Claude Design as a per-user design-context document source

  Implements the Claude Design half of the design record in
  `backend/docs/figma-claude-design-context.md`. Claude Design becomes a new
  `DocumentSourceProvider` (`source='claude-design'`) that reuses the whole documents
  integration (link plumbing, controller, `.cat-context/` materialization, prompt
  fragment), with a deterministic design-system normalizer that turns a project's
  `_ds_manifest.json` / `@dsCard`-marked component HTML + CSS custom properties into the
  same `### Components` / `### Design tokens` Markdown shape the Figma provider emits — so
  it earns its place over a plain HTML upload.

  Auth is a **personal per-user PAT**, supported on every runtime: a new descriptor flag
  `credentialScope: 'user'` routes such a source to a new per-user
  `user_document_connections` store (D1 ⇄ Drizzle, encrypted at rest under a distinct HKDF
  info), keyed by the acting user and never shared with the workspace. `DocumentConnectionService`
  becomes scope-aware; the import path threads the acting user. Workspace-scoped sources
  (Notion/Confluence/GitHub/Figma/Linear) are unchanged. The acting user falls back to the
  empty user id ONLY when auth is disabled (dev-open / single-user local mode) so those
  deployments still connect; when auth is enabled the controller fails closed with a 401
  rather than silently using the shared empty-user bucket.

  Claude Design is **opt-in**, not on by default: its credentialed project-read API is
  still provisional (the read is claude.ai-login-bound, no per-user service token yet), so
  it is excluded from the default `DOCUMENT_SOURCES` set and must be enabled explicitly
  (`DOCUMENT_SOURCES=…,claude-design`) once the API is real — every other source stays on
  by default.

  Also hoists the host-pinned `safeFetch`/SSRF guard/capped-read into a shared
  `documents/http.ts` reused by Figma and Claude Design. Wired symmetrically into both
  facades and gated by a new cross-runtime conformance case (per-user connect → list →
  disconnect).

- eab73b8: feat(documents): add Figma as a design-context document source

  Implements the Figma half of the design record in
  `backend/docs/figma-claude-design-context.md`. Figma becomes a new
  `DocumentSourceProvider` (`source='figma'`) authenticated by a per-workspace
  personal access token, reusing the whole documents integration (connection table,
  sealing, link plumbing, controller, `.cat-context/` materialization). `fetchDocument`
  renders a frame/file's layout tree, text, components-used and (Enterprise-gated)
  design tokens to Markdown, with a best-effort rendered-preview URL on a reference
  line. Wired symmetrically into both the Cloudflare and Node facades (and the
  `DOCUMENT_SOURCES` allow-list), gated by a cross-runtime conformance case. Adds the
  `design.figma-context` prompt fragment for frontend agents. (Claude Design ships in a
  companion changeset.)

  Also makes a URL pasted into a block description auto-match its imported document by the
  document's stable `(source, externalId)` — canonicalised through the providers'
  `parseRef` (`AgentContextBuilder.documentUrlResolver`) — instead of by exact URL-string
  equality, which silently failed for a real Figma share link (title path segment, dash
  node id, `&t=` tracking params) whose canonical stored `url` omits that noise.

### Patch Changes

- Updated dependencies [eab73b8]
- Updated dependencies [eab73b8]
  - @cat-factory/contracts@0.43.0
  - @cat-factory/kernel@0.45.0

## 0.25.2

### Patch Changes

- Updated dependencies [e641417]
  - @cat-factory/contracts@0.42.0
  - @cat-factory/kernel@0.44.0

## 0.25.1

### Patch Changes

- Updated dependencies [bbafec9]
- Updated dependencies [bbafec9]
  - @cat-factory/kernel@0.43.0

## 0.25.0

### Minor Changes

- 63e2177: Add Linear support as a document source and issue tracker. Linear Docs can be
  imported as task context (mirroring Notion/Confluence); Linear issues can be
  imported and linked to board blocks (mirroring Jira/GitHub Issues); the `tracker`
  pipeline step can file issues into Linear; and PR writeback comments on and
  resolves the linked Linear issue. Authentication is a per-workspace personal API
  key (sealed at rest), behind a shared GraphQL client shaped so OAuth can be added
  later. Adds one nullable `linear_team_id` column to `tracker_settings` (mirrored
  across D1 and Postgres) for the team new issues are filed under.

### Patch Changes

- Updated dependencies [63e2177]
  - @cat-factory/contracts@0.41.0
  - @cat-factory/kernel@0.42.2

## 0.24.1

### Patch Changes

- Updated dependencies [d1027ec]
  - @cat-factory/contracts@0.40.1
  - @cat-factory/kernel@0.42.1

## 0.24.0

### Minor Changes

- 32c653f: Add the Visual Confirmation gate and split the tester into an API + UI tester.

  - **Tester split:** the `tester` kind is renamed to `tester-api` (general/API exploratory
    testing) and a new `tester-ui` kind drives a real browser (Playwright), captures a
    non-redundant screenshot of each distinct view, uploads them to the binary-artifact
    store, and reports them under `TestReport.screenshots[]`. Both share the Tester→Fixer
    loop and the `tester.environment` infra choice (`isTesterKind`). The UI tester dispatches
    with `image:'ui'` so a transport can route it to a dedicated Playwright/browser image.
  - **Visual Confirmation gate** (`visual-confirmation`): a park-on-decision engine gate
    (modelled on `human-test`) that gathers the UI tester's screenshots + the human-uploaded
    reference design images (paired by view) and parks for a person to review actual-vs-reference.
    The human approves (advance), requests a fix (dispatches the Tester's `fixer`, then re-parks),
    or recaptures. Raises a `visual_confirmation_ready` notification; passes through when no
    binary-artifact store is wired. New `pl_visual` pipeline (`… tester-ui → visual-confirmation
→ merger`) and the `GET /blocks/:id/artifacts` + visual-confirmation action endpoints.
  - Cross-runtime conformance covers the gate's no-store pass-through and the artifact store's
    `listByBlock`.

  BREAKING: the `tester` agent kind is renamed to `tester-api`. Per this repo's pre-1.0 policy
  (no backwards-compatibility shims), any persisted state that still names `tester` simply stops
  matching: a saved/custom pipeline referencing `tester` is detected as outdated and reseeded from
  the catalog, and an execution that is parked mid-`tester` at upgrade time will no longer be
  recognised by the tester gate (re-run the task). New runs are unaffected — the seeded pipelines
  all use `tester-api`.

  NOTE: the dedicated UI-tester container image (Playwright/Chromium) and the per-kind image
  routing into it (a second Cloudflare container class; image-per-step on the local/pool
  transports) are a deploy-time follow-up — the `image:'ui'` dispatch seam is in place. Until that
  routing AND the harness env-passthrough (`ARTIFACT_UPLOAD_URL`/`ARTIFACT_UPLOAD_TOKEN` + a
  Playwright driver) land, `tester-ui` has no browser and the `pl_visual` gate runs in MANUAL mode
  (a human uploads references + screenshots and reviews them), which is why `pl_visual` is flagged
  `experimental`.

### Patch Changes

- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
  - @cat-factory/kernel@0.42.0
  - @cat-factory/contracts@0.40.0

## 0.23.5

### Patch Changes

- Updated dependencies [b5231b0]
  - @cat-factory/contracts@0.39.0
  - @cat-factory/kernel@0.41.0

## 0.23.4

### Patch Changes

- Updated dependencies [6d829bb]
  - @cat-factory/contracts@0.38.0
  - @cat-factory/kernel@0.40.0

## 0.23.3

### Patch Changes

- Updated dependencies [714b7c9]
  - @cat-factory/contracts@0.37.0
  - @cat-factory/kernel@0.39.0

## 0.23.2

### Patch Changes

- Updated dependencies [efbd910]
  - @cat-factory/contracts@0.36.0
  - @cat-factory/kernel@0.38.1

## 0.23.1

### Patch Changes

- Updated dependencies [a4ea607]
  - @cat-factory/contracts@0.35.0
  - @cat-factory/kernel@0.38.0

## 0.23.0

### Minor Changes

- 76543fa: Add a **Human Review gate** — an opt-in pipeline step (`human-review`, pipeline `pl_pr_review`
  "Build & PR review") that watches a task's PR for a human code review on GitHub and loops the
  existing `fixer` agent to address feedback:

  - Advances once the PR meets GitHub's required approvals (read from branch protection) with no
    unresolved review threads.
  - Dispatches the `fixer` to address outstanding review threads (immediately when approved; after a
    per-task grace window otherwise), then resolves each handed thread on GitHub via the GraphQL
    review-thread API so the next probe sees it cleared. A reviewer re-opening a thread re-triggers a fix.
  - Waits indefinitely for the human (re-arming, never auto-failing), surfacing a `human_review`
    notification while it waits.
  - A human can request a freeform fix at any time from the gate window
    (`POST /workspaces/:ws/blocks/:blockId/human-review/request-fix`), dispatched immediately.

  Built as a registry gate in `@cat-factory/gates` (new `PullRequestReviewProvider` port +
  `GitHubPullRequestReviewProvider`, wired in every facade) reusing the generic gate driver, plus
  small generic engine seams: `pollExhaustion: 'rearm'`, a `GateDefinition.onHelperComplete` side-effect
  hook, and a `pendingFix` manual-inject path. Adds a per-task `humanReviewGraceMinutes` merge-preset
  knob (D1 ⇄ Drizzle migration). The cross-runtime conformance suite asserts the gate on every runtime.

  Review hardening:

  - Branch-protection's required-approval count is read against the PR's **actual base branch**
    (`pulls/{n}.base.ref`), not the repo default — so a PR into a stricter protected branch is gated
    against its own rule instead of silently defaulting to 1.
  - A **stalled fixer** (no progress on an unchanged head while feedback is outstanding) now raises a
    `human_review` notification instead of waiting silently/invisibly forever.
  - The awaiting-approval `human_review` card carries the run's `executionId`, so the inbox deep-links
    into the gate window (the "request a fix here" affordance) instead of merely selecting the block.
  - The thread-resolve reconcile is scoped strictly to threads the gate itself handed the fixer
    (retained until confirmed resolved) — a **third-party review bot's** open thread is never silently
    closed, and its feedback isn't mistaken for the fixer's own.
  - `requestHumanReviewFix` rejects (409) when the gate has no review provider / async executor wired,
    instead of accepting a request it would silently drop.
  - The static branch-protection read is cached on the gate state after the first probe, so an
    indefinite wait no longer re-reads it every poll.

  **Breaking:** `FIXER_AGENT_KIND` moved from `@cat-factory/orchestration`'s `ci.logic` to
  `@cat-factory/kernel` (re-exported from `ci.logic` for existing call sites); the `merge_threshold_presets`
  table gains a non-null `human_review_grace_minutes` column.

### Patch Changes

- Updated dependencies [76543fa]
  - @cat-factory/kernel@0.37.0
  - @cat-factory/contracts@0.34.0

## 0.22.0

### Minor Changes

- 17adf4c: Local mode: warm container pool + checkout reuse, and optional native (host-process)
  execution of the developer's installed Claude Code / Codex CLI.

  **Warm pool + persistent checkout (default off = unchanged):** the local runner transport
  can keep idle harness containers warm and lease one — preferring a member that already holds
  the run's repo — instead of cold-starting a container per run. A leased member reuses a
  stable per-repo checkout (`git reset --hard` + a keep-list clean sweep that preserves
  dependency caches like `node_modules`, then `fetch` + switch branch) rather than cloning from
  scratch. New harness job field `persistentCheckout` drives this; it is set only by the local
  pool transport, so every other runtime keeps the ephemeral fresh-clone path byte-for-byte.
  Pooling is Docker-family only (the new `capabilities.pooling`); Apple `container` keeps the
  per-run path.

  **Configured in the UI + DB, not env:** the warm-pool sizing (size / pre-warm / max / idle
  timeout) and the per-repo checkout-reuse knobs (workspace root + dep-cache keep list) are a
  new per-deployment singleton (`local_settings`, Postgres/Drizzle only — local-mode-only, so
  no D1 mirror) exposed through a dedicated **"Local mode"** settings panel
  (Integrations → Local mode), served by a new `GET|PUT /local-settings` controller wired only
  on the local facade (503 elsewhere). This REPLACES the env vars `LOCAL_POOL_SIZE`,
  `LOCAL_POOL_MIN_WARM`, `LOCAL_POOL_MAX`, `LOCAL_POOL_IDLE_TTL_MS`, `HARNESS_WORKSPACE_ROOT`,
  `HARNESS_CLEAN_KEEP` (no longer read). The container transport forwards the checkout knobs to
  the harness container as `HARNESS_*` env. Breaking: those env vars are dropped — set the
  values in the UI instead.

  **Native execution (`LOCAL_NATIVE_AGENTS`, default off):** an allow-list of subscription
  harnesses (`claude-code,codex`) to run as a host process (new `LocalProcessRunnerTransport`)
  driving the developer's OWN installed `claude` / `codex` CLI with its ambient login (new
  harness `ambientAuth` mode) — no leased credential, no personal-credential gate for those
  vendors. Native applies ONLY to a listed harness's NATIVE vendor (Anthropic `claude` /
  OpenAI `codex`): a non-native vendor that reuses the `claude-code` harness (GLM/Kimi/DeepSeek
  carries its own base URL) and proxy/`pi` models are NOT run unsandboxed on the host — they
  keep the sandboxed per-run container path (so they still lease their real credential and
  still need `LOCAL_HARNESS_IMAGE`). Gated, local-facade-only, with the explicit no-sandbox /
  own-subscription trade documented. Requires `LOCAL_HARNESS_ENTRY`. The Tester's local
  docker-compose infra is reported unsupported in native mode for now (host-compose +
  git-worktree isolation are a follow-up phase).

  Breaking: none (all paths default off). The executor-harness image is bumped (1.16.0) for
  the new `persistentCheckout` / `ambientAuth` handling.

### Patch Changes

- Updated dependencies [17adf4c]
  - @cat-factory/contracts@0.33.0
  - @cat-factory/kernel@0.36.0

## 0.21.7

### Patch Changes

- Updated dependencies [eb48652]
  - @cat-factory/contracts@0.32.0
  - @cat-factory/kernel@0.35.0

## 0.21.6

### Patch Changes

- 81b60d4: Add the future-looking **Follow-up companion** to the Coder agent.

  As the Coder works it now surfaces forward-looking items — genuine loose ends, useful
  side-tasks it is deliberately not acting on, and clarifying questions — by appending them
  to a `.cat-follow-ups.jsonl` sentinel file in its working directory. The executor-harness
  tails that file and streams the items **out** on the job view (drain-on-read, like tool
  spans), so a blinking **Follow-up companion** chip on the Coder step lights up the moment
  the first item appears — while the container is still running.

  A human triages each item at any point: file a follow-up as a tracker issue (GitHub Issues
  / Jira, via the existing `TicketTrackerProvider`), send it back to the Coder to address
  after delivering the key task, answer a question, or dismiss it. The pipeline's following
  steps do not start until **every** item is decided: an undecided follow-up or unanswered
  question parks the run at the Coder's completion (a new `followup_pending` notification).
  Once all are decided the engine loops the Coder for the queued / answered items (within a
  per-step budget) before advancing. The companion is enabled by default on Coder steps and
  disableable per step in the pipeline builder.

  This is pure engine + run-step state (no new table) so it is runtime-symmetric across the
  Cloudflare and Node facades — the cross-runtime conformance suite asserts the park →
  decide → loop → advance behaviour on both. Wire contracts (`followUpItem` /
  `followUpsStepState`, the `followup_pending` notification, the `follow-ups` result view),
  the `streamFollowUps` harness job flag + `RunnerJobView.followUps` channel (with an
  optional pool-manifest `followUpsPath`), and the `FOLLOW_UP_GUIDANCE` Coder prompt fragment
  are added across the stack.

  Bumps the executor-harness image (new src) — publish + redeploy to roll it out.

- Updated dependencies [9f7ee39]
- Updated dependencies [81b60d4]
  - @cat-factory/contracts@0.31.0
  - @cat-factory/kernel@0.34.0

## 0.21.5

### Patch Changes

- Updated dependencies [ea59e91]
  - @cat-factory/contracts@0.30.0
  - @cat-factory/kernel@0.33.0

## 0.21.4

### Patch Changes

- 18f6b3b: Security hardening across three surfaces.

  Local-runner SSRF: the server-side fetches to a user-supplied runner base URL (the "Test
  connection" probe and the run-time LLM proxy forward) now follow redirects manually and
  re-validate every hop against the loopback/LAN allow-list, so a reachable runner can no
  longer `302` the server into the cloud-metadata endpoint or a public host. `localRunnerUrlError`
  also rejects URLs with embedded credentials. New `fetchLocalRunner` helper in
  `@cat-factory/integrations`.

  Harness inbound auth: the Cloudflare container transport now sends the `x-harness-secret`
  header and injects `HARNESS_SHARED_SECRET` into each per-run container's env when the secret
  is configured, matching the harness server and the local Docker transport. Unset leaves the
  harness open as before (it is only reachable via DO-internal addressing). The self-hosted
  runner pool reaches the harness through its own control plane, so its secret is configured
  pool-side.

  GitHub API requests in the executor harness now build the PR-lookup query with
  `URLSearchParams` and encode the owner/name path segments, so a branch or owner containing
  `&`/`#` can't split the query or inject a parameter.

## 0.21.3

### Patch Changes

- Updated dependencies [b82304e]
  - @cat-factory/contracts@0.29.0
  - @cat-factory/kernel@0.32.0

## 0.21.2

### Patch Changes

- Updated dependencies [765cc42]
  - @cat-factory/kernel@0.31.0
  - @cat-factory/contracts@0.28.0

## 0.21.1

### Patch Changes

- Updated dependencies [52d886a]
  - @cat-factory/kernel@0.30.0
  - @cat-factory/contracts@0.27.0

## 0.21.0

### Minor Changes

- a639189: Observability for ephemeral-environment and container provisioning.

  - **Unified provisioning event log.** A new append-only log records every attempt to
    spin up / tear down throwaway infrastructure — ephemeral environments
    (provision/teardown/status) and the runner-pool / per-run containers
    (dispatch/release/poll-failure) — with the outcome and the verbatim provider/runtime
    error on failure. Surfaced via `GET /workspaces/:ws/provisioning-logs` and a "View
    logs" button in the ephemeral-environment provider and self-hosted runner-pool config
    panels.
  - **Env lifecycle in run details.** An agent run's step now carries the ephemeral
    environment it runs against (spinning up / running / shut down / errored + URL/expiry
    - exact error), shown in the step detail (notably for the Tester).
  - **Container-start failures.** When a container/runner never accepts the job, the run
    details now say "Container failed to start" and show the exact provider/runtime error
    (a `dispatch`-kind failure) instead of a generic "Run failed". A run's step detail also
    has an "Infrastructure attempts" drawer (filtered by execution id) that surfaces that
    run's container/runner/env spin-up + tear-down attempts.
  - **Secret redaction.** The verbatim provider/runtime error and structured detail are
    scrubbed at the single recorder choke point before they are persisted/served — bearer
    tokens, `Authorization`/`x-api-key` header echoes, credentialed URLs, and recognisable
    token shapes (`sk-`/`ghp_`/`AKIA`/JWT) are replaced with `[REDACTED]` while the
    surrounding context (field name, URL host, token scheme) is kept for diagnosis.

  **Breaking / operational:** the provisioning log lives in a PHYSICALLY SEPARATE store to
  isolate its high write churn. The Cloudflare Worker needs a new `PROVISIONING_DB` D1
  binding (its own `migrations-provisioning` dir — create the database and apply its
  migrations); when absent, the feature is simply off. The Node service uses a dedicated
  `provisioning` Postgres schema, created with `CREATE SCHEMA IF NOT EXISTS` by `migrate()`
  on boot (the DB role needs `CREATE` on the database — the same privilege the app already
  uses to create its `public` tables). Retention is governed by `PROVISIONING_LOG_RETENTION_DAYS`
  (default 14). Catching a container dispatch error at the dispatch site means a transient
  dispatch blip is now a terminal `dispatch` failure (retry from the failure card) rather
  than relying on a Workflows step retry.

### Patch Changes

- Updated dependencies [a639189]
  - @cat-factory/kernel@0.29.0
  - @cat-factory/contracts@0.26.0

## 0.20.1

### Patch Changes

- Updated dependencies [ed3a673]
  - @cat-factory/contracts@0.25.1
  - @cat-factory/kernel@0.28.1

## 0.20.0

### Minor Changes

- 69d2270: Surface the Sandbox (the parallel prompt/model testing surface) end to end. Previously
  only the domain logic (`@cat-factory/sandbox`), wire contracts and kernel ports existed,
  with no way to use the feature; this wires the full stack:

  - **Services** (`@cat-factory/orchestration`): `SandboxService` (prompt-version lineage,
    fixture library with lazy builtin seeding, experiment definitions) + `SandboxRunService`
    (the run-driver + judge — expands an experiment matrix into cells, runs each inline
    candidate against the prompt-version's system text + the fixture input, grades it with a
    judge model against the task rubric, and records the deterministic objective findings
    score). Assembled as the `sandbox` core module when its repositories are wired.
  - **HTTP API** (`@cat-factory/server`): `SandboxController` mounts the prompt/fixture/
    experiment CRUD + `POST /sandbox/experiments/:id/launch`. 503 when unconfigured.
  - **Persistence**: the Sandbox gets its **own database** per runtime for blast-radius
    isolation — a dedicated `SANDBOX_DB` D1 database on the Cloudflare Worker (its own
    `sandbox-migrations/` lineage) and a dedicated `sandbox` Postgres schema on Node
    (Drizzle). Both runtimes contribute the repositories via a single sandbox-owned
    `Partial<CoreDependencies>` mixin, so neither facade enumerates them. Cross-runtime
    conformance asserts parity.
  - **Frontend** (`@cat-factory/app`): a Sandbox window (opened from the sidebar +
    command palette) to clone/version prompts, browse graded fixtures, and define + run
    experiments with a scored results grid.

  BREAKING (deployment): the Cloudflare Worker reads an optional new `SANDBOX_DB` binding;
  without it the Sandbox API answers 503 (the rest of the product is unaffected). To enable
  it, provision a second D1 database and point the binding + its `migrations_dir` at the
  package's `sandbox-migrations/` (see `deploy/backend/wrangler.toml`). On Node the
  `sandbox` schema is created automatically by the boot migrator.

  Container/repo fixtures (a real checkout) are not yet supported by the in-product run
  driver and are refused at launch; the builtin fixtures are all inline.

  Run-driver hardening: a relaunch clears the prior result grid first (new
  `SandboxRunRepository`/`SandboxGradeRepository.removeByExperiment`, mirrored on D1 +
  Drizzle) instead of accumulating duplicate cells; the experiment's terminal status is
  derived from whether any cell was actually graded (`failed` when every candidate failed OR
  every grade failed — never a misleading `done` over a grid of unscored cells, and never
  left `running`); the token budget must be ≥ 1 (a `0` budget is rejected at create rather
  than silently failing every cell) and is documented as a soft cap enforced between cells;
  the judge model defaults to the deployment routing default (no hardcoded vendor) and
  requires an explicit `judgeModel` when none is configured (the experiment builder now
  exposes a judge-model picker so a deployment with no default still has recourse); an
  unparseable / empty / reasoning-only judge reply is now recorded as a grading **error** on
  the cell rather than silently flooring every dimension to the minimum (which read as a
  confident bottom-of-scale grade); the judge-reply JSON extractor — now the single robust
  `extractJson` promoted to `@cat-factory/kernel` and shared by the requirements reviewer, the
  document planner and the Sandbox judge (replacing two weaker object-only copies) — is
  string-literal aware, scans forward past any leading bracket whose span isn't valid JSON
  (so prose like `I weighed [the auth flow]: {…}` no longer defeats extraction for the
  object-returning reviewers), and falls back past a leading non-JSON code fence. The judge
  prompt appends the shared `FINAL_ANSWER_IN_REPLY` directive like the other parsed-reply
  agents, and the provider-for-scope resolution the Sandbox shares with the reviewers is now
  one `resolveScopedModelProvider` kernel helper instead of two copies. The Sandbox window now surfaces a
  non-503 load failure (with a retry) instead of rendering an empty, healthy-looking panel.
  The fixture↔kind mapping the UI filters by now lives on the `@cat-factory/sandbox` catalog
  (`SandboxAgentKindMeta.fixtureKinds`) instead of a parallel frontend switch. Concurrent
  launches of the same experiment are now serialised by an atomic
  `SandboxExperimentRepository.claimForRun` (a conditional transition to `running`, mirrored on
  D1 + Drizzle): only the winner clears + re-expands the result grid, so two simultaneous
  launches can't duplicate the grid or race the grid-clearing deletes, and the grid setup runs
  inside the terminal-status `finally` so a failure there can't strand the experiment
  `running`. The matrix cell cap is surfaced on the overview (`maxCells`) so the builder gates
  on the SAME limit instead of re-encoding the literal. NOTE: the run-driver still executes the
  matrix inline in the launch request (bounded by the cell cap + token budget); a durable
  fan-out (Workflows / pg-boss) for large matrices remains a follow-up.

### Patch Changes

- Updated dependencies [69d2270]
  - @cat-factory/contracts@0.25.0
  - @cat-factory/kernel@0.28.0

## 0.19.0

### Minor Changes

- 3546e3d: Move operator/integration config out of environment variables into encrypted, UI-editable
  DB settings. DB is now the source of truth — the moved env vars are **removed** (no
  fallback), so the listed vars below no longer have any effect.

  **Per-workspace budget (Workspace settings → Budget).** A workspace's spend currency,
  monthly limit, and per-model price overrides now live on the `workspace_settings` row.
  The spend safeguard resolves each workspace's effective pricing (base table + overrides)
  behind a short-TTL cache, scoping the budget gate to the workspace's own usage
  (`SpendService.status`/`isOverBudget` now take a `workspaceId`; new
  `TokenUsageRepository.totalsSinceForWorkspace`). **Behaviour change:** spend is metered +
  gated per workspace, not deployment-wide; a workspace with no budget inherits the built-in
  default (~100 EUR/month). Removes env: `SPEND_MONTHLY_LIMIT`, `SPEND_CURRENCY`,
  `SPEND_MODEL_PRICES`. A budget of `0` is intentional ("no PAID spend"): metered runs are
  refused **up front** at start/retry with a clear `409` (not just a silent mid-run pause),
  while LOCAL-runner models (keyless) and connected SUBSCRIPTIONS (flat-rate quota) keep
  running since they incur no metered cost — so `0` is the "local-/subscription-only" setting.
  The over-budget exemption (previously subscription-only) now also covers local-runner steps,
  inline and container alike. The hot-path per-workspace rollup is indexed
  (`idx_token_usage_workspace` on `(workspace_id, created_at)`, both runtimes).

  **Per-workspace incident enrichment (service inspector → Post-release health).** PagerDuty

  - incident.io credentials are sealed in a new per-workspace `incident_enrichment_connections`
    table (one grouped blob) and resolved/decrypted at enrichment time by a new
    `WorkspaceIncidentEnrichmentProvider`. Removes env: `PAGERDUTY_API_TOKEN`,
    `PAGERDUTY_FROM_EMAIL`, `INCIDENTIO_API_KEY`. The write API is three-state per provider
    group (omit ⇒ keep, `null` ⇒ clear, value ⇒ set) so one vendor can be removed without
    wiping the other.

  **Per-account integration secrets (Account settings → Deployment integrations, admin only).**
  The Slack app OAuth credentials and the container web-search upstream keys (Brave /
  SearXNG) now live in a new per-account `account_settings` table (one sealed secrets blob,
  HKDF tag `cat-factory:account-settings`), behind an admin-gated
  `GET|PUT /accounts/:id/settings`. Resolved dynamically: Slack OAuth at connect time, the
  web-search upstream per run (off the container session's account id). The executor now
  advertises the container `web_search` tool to a run **only when its account actually has
  keys** (so an agent is never handed a tool that always fails); a run with no upstream gets
  an empty result set rather than a hard `503`. Removes env:
  `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_REDIRECT_URL`, `WEB_SEARCH_BRAVE_API_KEY`,
  `WEB_SEARCH_SEARXNG_URL`, `WEB_SEARCH_SEARXNG_API_KEY` (the env-built upstream + its
  `createWebSearchUpstreamFromEnv`/`gateways.webSearch` fallback are deleted, not just
  unwired). (`SLACK_ENABLED` still gates Slack module assembly; the new tables/services
  assemble whenever `ENCRYPTION_KEY` is set.)

  **Hardening.** Re-sealing a partial settings/credentials write now **refuses** (clear `409`)
  when the stored blob can't be decrypted (e.g. after an encryption-key change) instead of
  silently dropping the un-edited secret group on the re-seal.

  New tables mirror across both runtimes (D1 migrations 0012–0014 ⇄ Drizzle schema +
  generated migration) with cross-runtime conformance assertions for the budget +
  incident-enrichment round-trips. `ENCRYPTION_KEY`, `AUTH_SESSION_SECRET`, and the GitHub
  App/OAuth secrets stay in env (bootstrap/auth). Retention windows, inline-web-search
  toggles, Langfuse keys, and execution timeouts intentionally remain env-configured.

### Patch Changes

- Updated dependencies [3546e3d]
  - @cat-factory/contracts@0.24.0
  - @cat-factory/kernel@0.27.0

## 0.18.3

### Patch Changes

- Updated dependencies [a62044d]
  - @cat-factory/kernel@0.26.1

## 0.18.2

### Patch Changes

- Updated dependencies [2aae8bc]
  - @cat-factory/kernel@0.26.0

## 0.18.1

### Patch Changes

- Updated dependencies [f4f954b]
  - @cat-factory/kernel@0.25.0

## 0.18.0

### Minor Changes

- ce81233: Surface optional/default config values and unconfigured-provider warnings for the
  ephemeral-environment and self-hosted runner-pool providers.

  - `ProviderConfigField` gains an optional `default`; a field that has one is optional
    (the connect form shows it blank with a "defaulted to …" hint and falls back to it).
  - `ProviderDescriptor` gains `missingRequired` (required-without-default keys not yet
    supplied — the loud-banner signal), an optional `manifestTemplate` scaffold, and the
    current `savedManifest` (non-secret) so the native connect form overlays edits onto the
    real stored manifest — preserving previously-saved `providerConfig` (incl. nested values
    the flat form doesn't render) instead of silently dropping it on a re-save.
  - A native `EnvironmentProvider` / `RunnerPoolProvider` may implement
    `describeManifestTemplate()` so the SPA renders a flat `describeConfig` connect form yet
    still persists a single full manifest (per `backend/docs/native-environment-adapter.md`).
  - Both connection services compute `missingRequired` server-side from the saved secret
    bundle + manifest `providerConfig` + manifest `baseUrl` (so a required `baseUrl` field,
    which is stored on the manifest rather than in providerConfig/secrets, can clear).
  - Frontend: a generic descriptor-driven connect panel for both providers (under
    Settings ▸ Integrations) and a loud `ProviderConfigBanner` that fires when a provider is
    wired for the instance but mandatory fields are missing.

### Patch Changes

- Updated dependencies [ce81233]
  - @cat-factory/contracts@0.23.0
  - @cat-factory/kernel@0.24.0

## 0.17.1

### Patch Changes

- Updated dependencies [7346a4f]
  - @cat-factory/kernel@0.23.0

## 0.17.0

### Minor Changes

- 6ff1f10: Link Confluence/Notion/GitHub documents as **living** best-practice fragments.

  A team can now link an external document (a Confluence page, a Notion page, or a
  GitHub file — any connected Document source) as a prompt-fragment whose guidance is
  **re-resolved from the source at the moment an agent run uses it**, rather than a
  one-time snapshot. Edit the upstream doc and the next agent run follows the new
  version — no re-import. The body is cached on the fragment as a last-resolved
  snapshot and refreshed on a short TTL (default 5 min); if the source is unreachable
  the run falls back to the cached body, so resolution never blocks a run. Available
  at both the account and workspace tiers; an account-tier link fetches through a
  chosen workspace's connection — recorded on the fragment so every consuming
  workspace re-resolves through that same connection at run time, not its own.

  New surface: `POST /:scope/document-fragments` (link a document as a fragment) and
  `POST /:scope/prompt-fragments/:id/refresh` (force an immediate re-resolve), a
  "Documents" tab in the fragment-library manager with a "Live · <source>" badge, and
  a `documentRef`/`resolvedAt` provenance block on `PromptFragment`.

  As part of this, run-time fragment-id resolution now goes through the merged tenant
  catalog (built-in ∪ account ∪ workspace) instead of only the built-in static pool,
  so **managed (DB-authored) fragments also reach a run** — previously only built-in
  ids resolved at run time. Behaviour is unchanged when the prompt-fragment library is
  not configured.

  Persistence: `prompt_fragments` gains `doc_source` / `doc_external_id` /
  `doc_via_workspace_id` / `resolved_at` columns on both runtimes (a D1 migration and
  a Drizzle migration); stale pre-existing rows simply carry nulls.

### Patch Changes

- Updated dependencies [6ff1f10]
  - @cat-factory/contracts@0.22.0
  - @cat-factory/kernel@0.22.0

## 0.16.1

### Patch Changes

- Updated dependencies [04befe8]
  - @cat-factory/contracts@0.21.0
  - @cat-factory/kernel@0.21.0

## 0.16.0

### Minor Changes

- be182e8: Hybrid linked-context delivery to agents, and deterministic reference resolution.

  Linked documents and tracker issues now reach a container agent as a cheap in-prompt
  summary index plus their full bodies materialised into a `.cat-context/` directory in the
  checkout (kept out of the agent's commits via a local git exclude), so the agent reads only
  what it needs on demand — replacing the previous 280-char document excerpt. Inline (no-
  checkout) agent kinds instead get the budgeted full body injected into the prompt.

  The engine also resolves references named explicitly in a block's description or its
  incorporated requirements (Jira keys like `PROJ-123`, fully-qualified GitHub `owner/repo#123`,
  and URLs) against the already-imported corpus, folding those high-confidence items into the
  context set. Each reference is resolved by a **point lookup** (a keyed `get`, or a new
  `getByUrl` repository method) rather than scanning the whole workspace corpus per step. Bare
  `#123` refs are intentionally not resolved: a workspace can hold many repos, so a bare number
  is ambiguous — name the issue as `owner/repo#123` (or by URL) to pull it in. There is no
  speculative relationship graph and no live fetching: everything is prepared backend-side,
  which is required because the container harness cannot reach Jira/Confluence/GitHub itself.

  Documents gain a `content_hash` column (D1 + Drizzle) so a re-import whose body AND title/url
  are unchanged is a no-op, preserving the existing projection and block link; a renamed/moved
  page still re-projects.

  Breaking (pre-1.0): `AgentRunContext.block.contextDocs` items now carry `summary` + `body`,
  `contextTasks` items carry `summary`, and `DocumentRecord` carries `contentHash`. The
  `DocumentRepository`/`TaskRepository` ports gain a `getByUrl` method (implemented on both the
  D1 and Drizzle stores). The executor-harness image gains an optional `contextFiles` job field;
  bump the runner image tag.

### Patch Changes

- Updated dependencies [be182e8]
  - @cat-factory/kernel@0.20.0

## 0.15.0

### Minor Changes

- 2c24da8: Add a **human-testing gate** (`human-test`) pipeline step. When reached it spins up an
  ephemeral environment and PARKS for a person to validate the change in the live URL before
  the run continues. From the dedicated window the human can confirm (tear the env down +
  advance), submit findings to dispatch the Tester's `fixer` (then the env rebuilds for
  re-testing), pull latest main into the PR branch + redeploy (a clean merge rebuilds the env; a
  conflict dispatches the `conflict-resolver`), or recreate / destroy the env on demand. Falls
  back to a degraded manual mode (no live env, still parks for confirmation) when no
  ephemeral-environment provider is wired.

  New opt-in pipeline `pl_human_review` (`coder → reviewer → human-test → conflicts → ci →
merger`) and a palette block; existing default pipelines are unchanged.

  Adds a `GitHubClient.mergeBranch` (the repo Merges API) and a `BranchUpdater` port behind the
  "pull main" action, wired from the GitHub client on every facade (Worker / Node / local), plus
  a `human_test_ready` notification type (in-app + Slack-routable). Both runtimes wire the gate
  identically and the cross-runtime conformance suite asserts the park → request-fix → confirm
  flow.

### Patch Changes

- Updated dependencies [2c24da8]
  - @cat-factory/contracts@0.20.0
  - @cat-factory/kernel@0.19.0

## 0.14.0

### Minor Changes

- 4120ac5: Nested tasks (epics) + a first-class task dependency graph.

  **Epics** are a new non-structural block level (`level: 'epic'`). An epic groups tasks
  that may live under different services/modules via the tasks' new `epicId` membership
  link (independent of `parentId`, so deleting an epic clears membership but never deletes
  the member tasks). The board draws an epic node linked to all its members, and the epic
  inspector shows the full member tree grouped service → module → task. Add one via
  `POST /workspaces/:ws/epics`; assign/detach a task via `POST /blocks/:id/epic`.

  **Importing a Jira epic / GitHub parent issue** spawns the epic + its children onto the
  board in one shot (`POST /workspaces/:ws/task-sources/:source/epics/spawn`, or the "As
  epic" button in the issue-import modal): an epic node, a board task per child issue
  (joined to the epic), and `dependsOn` edges seeded from the issues' **"blocked by" /
  "depends on"** links. Jira links come from `issuelinks` + `parent`/`subtasks` + epic
  children (JQL); GitHub children come from native **sub-issues** and dependency links are
  parsed from the issue body (`Blocked by #12`, `Depends on owner/repo#34`). The
  `GitHubClient` port gains `listSubIssues` + a `parentRef` on issue detail.

  **Dependency enforcement** is now hard and server-side: `ExecutionService.start()` refuses
  (409) to start a task while any block it `dependsOn` is unfinished — enforced for manual,
  recurring, auto-start and direct-API starts alike. Adding a dependency edge that would
  close a **cycle** is rejected (422).

  **Auto-start**: a preceding task carries an `autoStartDependents` toggle (task inspector).
  When it merges, the engine automatically starts every task that depends on it whose other
  dependencies are also done — skipping any on an individual-usage model (which can't unlock
  unattended).

  **Board UX**: a drag-to-connect handle on task cards creates dependency edges directly on
  the canvas (drag from the prerequisite onto the dependent); the dependency-edge overlay
  also draws epic→member membership links.

  Persisted on both runtimes (D1 migration `0010_epics_dependencies` ⇄ Drizzle
  `epic_id` / `auto_start_dependents` columns); the cross-runtime conformance suite asserts
  the epic + membership round-trip, the cycle rejection, and the dependency start gate on
  each store.

  Breaking (pre-1.0, acceptable): the `blocks` table gains `epic_id` / `auto_start_dependents`
  columns and the `level` enum gains `epic`; no migration shims.

### Patch Changes

- Updated dependencies [4120ac5]
  - @cat-factory/contracts@0.19.0
  - @cat-factory/kernel@0.18.0

## 0.13.0

### Minor Changes

- 25efe48: Add UI-configurable provider config + per-user GitHub PAT, with provider self-describe and connection-test.

  - Providers self-describe the config they expect (`describeConfig`) and can be connection-tested (`testConnection`) before saving — added as optional methods on the `EnvironmentProvider` and `RunnerPoolProvider` kernel ports, implemented by the generic HTTP adapters (secret-key fields from the manifest + an authed probe), and surfaced via new `GET …/environments/provider`, `POST …/environments/connection/test`, `GET …/runner-pool/provider`, `POST …/runner-pool/connection/test` endpoints. The SPA renders the descriptor fields generically.
  - New generic, `kind`-discriminated per-user secret store (`user_secrets`, mirrored D1 ⇄ Drizzle) with `UserSecretService` + a kind registry (first kind: `github_pat`). User-scoped `GET/POST/DELETE /user-secrets` + `…/test`; a "My GitHub token" entry under Integrations → Source control.
  - A run you initiate now prefers YOUR stored GitHub PAT over the deployment's GitHub App / env token for the container push token AND the engine CI-gate + merge reads (resolved by the run initiator via an ambient `RunInitiatorScope`), falling back to the existing source when you have none. Wired symmetrically across the Cloudflare, Node and local facades.

  Breaking: none for existing data. The local-mode `GITHUB_PAT` env var still works as a fallback.

### Patch Changes

- Updated dependencies [25efe48]
  - @cat-factory/contracts@0.18.0
  - @cat-factory/kernel@0.17.0

## 0.12.4

### Patch Changes

- Updated dependencies [c7b8012]
  - @cat-factory/contracts@0.17.1
  - @cat-factory/kernel@0.16.2

## 0.12.3

### Patch Changes

- Updated dependencies [aa06003]
  - @cat-factory/contracts@0.17.0
  - @cat-factory/kernel@0.16.1

## 0.12.2

### Patch Changes

- Updated dependencies [208c933]
  - @cat-factory/kernel@0.16.0

## 0.12.1

### Patch Changes

- 494fb34: Finish the Task-5 strangler: migrate the last two built-in agents (conflict-resolver and
  repo bootstrap) onto the single, manifest-driven `agent` harness kind, then delete every
  bespoke per-kind handler and collapse the dispatch surface. The harness is now a generic
  LLM-over-a-checkout runner with **one** kind — WHAT each agent does is decided entirely by
  the backend and carried as job data.

  **conflict-resolver** now dispatches `kind: 'agent'` `mode: 'coding'` with a `mergeBase`
  (full clone of the PR branch). `handleAgent`'s coding flow merges `origin/<mergeBase>` in to
  surface the conflicts, leads the prompt with the actual conflict hunks it discovers, then
  completes the merge commit and pushes back onto the same branch (no new PR) — refusing to
  push a half-resolved tree. Routed through `buildMigratedBuiltInBody`; the bespoke
  `/resolve-conflicts` body + handler are gone.

  **bootstrap** now dispatches `kind: 'agent'` `mode: 'coding'` with a `bootstrap` spec
  (`{ target, reference?, reinit, forcePush, fromScratch? }`). `handleAgent` clones the
  reference architecture (or scaffolds from an empty dir), runs the agent, guards against a
  no-op, then force-pushes a fresh single-commit history to the separate target repo's default
  branch (lifted `reinitAndPush` / `producedRepoContent`). `ContainerRepoBootstrapper` builds
  the generic body; its `linkRepoToBlock` post-op already lives in `pollBootstrapJob`.

  **Harness cleanup (image bump).** Deleted the bespoke handlers (`blueprint`/`spec`/`explore`/
  `merger`/`on-call`/`tester`/`ci-fixer`/`fixer`/`conflict-resolver`/`bootstrap`/`handleRun`),
  collapsed `server.ts`'s `KINDS` to `{ agent }`, and stripped the bespoke job types + parsers
  from `job.ts` (keeping `parseAgentJob` + the shared helpers + `BootstrapTargetSpec`). The
  executor-harness image is bumped (1.13.0 → 1.14.0; deploy tag + `wrangler.toml`).

  **Kernel (breaking, pre-1.0).** `RunnerDispatchKind` collapses to the single member
  `'agent'`, and `RunnerJobResult` is slimmed to `prUrl` / `branch` / `summary` / `error` /
  `defaultBranch` / `pushed` / `custom` / `usage` (the per-kind `service`/`spec`/`assessment`/
  `onCallAssessment`/`report`/`resolved` channels are removed — every structured agent returns
  its doc on `custom`, coerced kind-aware in `toRunResult`). The transports default to
  `kind: 'agent'`; the runner-pool result coercion passes only `custom` through.

  Two fixes ride along. (1) `toRunResult` now surfaces an opened PR (`prUrl`) **before** the
  in-place-fixer `pushed` branch — the migrated coder returns BOTH `pushed: true` and `prUrl`,
  so the previous ordering silently dropped its structured `pullRequest` (the worker test only
  passed because its fake omitted `pushed`). (2) The local transport ran the per-run container
  privileged off `kind === 'test'`, which never matched after the tester migration; the
  container is per-RUN (created by the run's first step, not the tester), so it now runs
  privileged whenever `privilegedTestJobs` is enabled (gated by the `localDind` capability).

- Updated dependencies [494fb34]
  - @cat-factory/kernel@0.15.1

## 0.12.0

### Minor Changes

- 0ac64b8: Add a "Create task from issue" button on service frames, and scope issue search to
  the service's repo.

  A service frame header now carries a ticket button (shown when a tracker is offered)
  that opens the tracker-issue modal pinned to that service: the new task is created in
  that frame, and the issue search is scoped to the service's linked GitHub repository
  instead of the whole installation. The same repo scoping applies to the
  attach-an-issue-as-context picker in the add-task form.

  Within a scoped GitHub search:

  - a pasted issue URL (or `owner/repo#n` / `owner/repo/issues/n`) resolves to that exact
    issue and is offered first instead of being fuzzy-matched — but only within the
    searching workspace's own GitHub App installation, so a URL naming another account is
    never fetched across tenants;
  - a bare issue number (`11`) resolves against the service's repo and is offered first;
  - free-text hits are restricted to the service's repo (`repo:owner/name`).

  A service is always created from (or with) a repo, so a GitHub search scoped to a block
  now REQUIRES that link: if the service isn't linked to a repo the search is refused with
  a clear error rather than silently widening to the whole installation. The
  block→service→repo resolver (`resolveRepoTarget`) is surfaced on the request container in
  both runtime facades so the shared task-search controller can resolve the scope.

### Patch Changes

- Updated dependencies [0ac64b8]
  - @cat-factory/kernel@0.15.0
  - @cat-factory/contracts@0.16.0

## 0.11.0

### Minor Changes

- fde0437: Add a first-class **Issue tracker** settings panel (Workspace settings → Issue tracker,
  also linked from the Integrations hub) plus a **live "Check setup" diagnostic** so a
  workspace can both configure issue tracking in one place and see _why_ a source isn't
  working.

  **Panel (frontend).** One discoverable home that gathers what used to be scattered:

  - **Filing tracker** — select where the tech-debt recurring pipeline files its ticket
    (GitHub Issues / Jira / none). Previously only reachable buried inside the tech-debt
    recurring-pipeline modal, so a workspace had no obvious way to designate GitHub Issues.
  - **Linking sources** — the per-workspace on/off toggle for each task source, making
    explicit that filing and linking are independent.
  - **Writeback** — the comment-on-PR-open / close-on-merge toggles, folded in from the old
    standalone "Issue writeback" tab (`IssueTrackerWritebackPanel` is removed).

  **Live "Check setup" (backend, all runtimes).** A new
  `POST /workspaces/:ws/task-sources/:source/diagnostics` endpoint actually authenticates
  against the source and reads a slice of its issues API, returning a classified verdict —
  `ready` / `not_installed` / `not_connected` / `auth_failed` / `forbidden` / `unreachable` /
  `error` — with an actionable message. For GitHub Issues it escalates three probes
  (validate the App credentials → mint the installation token + list repos → read issues on a
  repo) so a 403 pinpoints the most common misconfiguration: the GitHub App lacks the
  **Issues** permission. For Jira it probes `/myself` and distinguishes a rejected token (401)
  from a forbidden account (403). The panel also now surfaces the previously-swallowed probe
  error (e.g. "503 — integration disabled / ENCRYPTION_KEY not set", "500 — backend not
  migrated") instead of a blanket "install integration first".

  Adds an optional `diagnose` capability to the `TaskSourceProvider` port (kernel), implemented
  by the GitHub and Jira providers and orchestrated by `TaskConnectionService.diagnose`
  (integrations), the `taskSourceDiagnosticSchema` wire contract (contracts), and the
  controller endpoint (server). Runtime-neutral — wired through the existing `tasks` module on
  Cloudflare, Node, and local — with a cross-runtime conformance assertion (gate-on-connection
  then delegate-to-provider). A provider without `diagnose` falls back to a static verdict
  from availability.

### Patch Changes

- Updated dependencies [fde0437]
  - @cat-factory/contracts@0.15.0
  - @cat-factory/kernel@0.14.0

## 0.10.4

### Patch Changes

- 77b7d31: Migrate the `spec-writer` built-in agent onto the generic, manifest-driven `agent` harness
  kind, continuing the Task-5 strangler (after the read-only kinds, the merger/on-call/fixers,
  the coder, and blueprints).

  `ContainerAgentExecutor` now routes `spec-writer` through `buildMigratedBuiltInBody` →
  `buildRegisteredAgentBody` as a read-only `mode: 'explore'` structured agent that clones the
  per-block WORK branch (`cat-factory/<blockId>` — the coder's branch, created from base when
  absent; the spec-writer runs BEFORE the coder, so it seeds that branch) instead of the
  bespoke `/spec` body. The agent now READS the baseline spec from its own checkout under
  `spec/` (the harness no longer pre-injects it) and returns ONLY the complete spec doc as JSON;
  `toRunResult` coerces that `custom` result into the `spec` channel (via `coerceSpecDoc`) the
  engine already strict-validates + ingests. The `SPEC_WRITER_SYSTEM_PROMPT` is updated to point
  the agent at `spec/overview.md` + the `spec/modules/**` shards, and a new `specWriterUserPrompt`
  carries the task increment + the read-the-baseline / reuse-the-taxonomy guidance the harness
  `buildUserPrompt`/`renderTaxonomyInventory` used to inject.

  The deterministic SHARD + commit of the in-repo `spec/` artifact that used to live in the
  executor-harness `/spec` handler now runs as a BACKEND built-in post-op (`specPostOp`,
  `@cat-factory/agents`), over the checkout-free `RepoFiles` port. It is keyed by the engine's
  own built-in op map in `ExecutionService` — deliberately NOT the agent-kind registry, so the
  built-ins never leak into `customAgentKinds` / the SPA palette. It reproduces the harness
  reconcile exactly: the canonical `service.json` / `overview.md` / `modules/<m>/<g>.{json,md}`
  shards are always rewritten and a removed module/group's shards are PRUNED (the deletion
  channel); the Gherkin `features/<m>/<g>.feature` files are SEEDED-ONCE (committed only when
  absent, never clobbering a polished one); and the pre-sharding monolithic artifacts
  (`spec/spec.json` / `rules.md` / `version.json`) + old flat `features/*.feature` files are
  dropped on sight. Idempotent: the spec has no `version.json` manifest, so the post-op
  byte-compares each rendered shard to the branch and makes NO commit when everything matches
  and there is nothing to seed or prune (durable-driver replay re-commits nothing).

  Because the spec doc is handed onward to be sharded + committed, the migrated kind opts into
  a new `output.failOnUnusableFinal` flag (kernel `AgentOutputSpec`) so the generic explore
  handler FAILS the run LOUDLY when the agent's final answer is cut off at the output ceiling
  (or empty) — restoring the bespoke `/spec` handler's `unusableFinalAnswerCause` gate, which
  the generic `handleAgent` path lacked, so a truncated reply can no longer be laundered into a
  half-baked spec by the structured repair. This is a harness change, so the executor-harness
  image is bumped to `1.12.0` (the `deploy/backend` `image:publish` tag + `wrangler.toml` are
  bumped to match). The dead `/spec` handler is removed in a later sweep step.

  Cross-runtime conformance asserts the post-op shards + commits the `spec/` artifact onto the
  work branch via `RepoFiles` on both runtimes.

  Also fixes a facade-parity gap in the self-hosted runner-pool result coercion
  (`HttpRunnerPoolProvider.coerceRunnerResult`): the generic `agent`-kind structured channel
  `custom` was missing from the pass-through allow-list, so a migrated kind's doc
  (blueprints / spec-writer / merger / on-call) was silently dropped on a runner-pool backend
  while the Cloudflare/local transports — which return the harness view verbatim — kept it.
  `custom` now passes through, and a regression test covers it.

- Updated dependencies [77b7d31]
  - @cat-factory/kernel@0.13.4

## 0.10.3

### Patch Changes

- Updated dependencies [82d771e]
  - @cat-factory/contracts@0.14.0
  - @cat-factory/kernel@0.13.3

## 0.10.2

### Patch Changes

- Updated dependencies [ce27690]
  - @cat-factory/contracts@0.13.1
  - @cat-factory/kernel@0.13.2

## 0.10.1

### Patch Changes

- Updated dependencies [c8bd144]
  - @cat-factory/kernel@0.13.1

## 0.10.0

### Minor Changes

- 5c915fd: Replace the deployment-level `TASK_SOURCES` env allow-list with a per-workspace,
  UI-driven on/off toggle for each task source (Jira / GitHub Issues), persisted in DB.

  A source is now offered to a workspace when it is **available** AND **enabled**:

  - Availability is intrinsic, not a deployment switch. Jira is always registered (its
    credentials are per-workspace, entered in the UI) and is available once connected.
    GitHub Issues registers whenever the GitHub integration is configured and is available
    once the workspace has installed the GitHub App — it rides that App, so there is nothing
    to "connect" (the credentialless connect path now returns a clear error).
  - `enabled` is the new per-workspace toggle (defaults to on). A workspace can disable
    GitHub Issues to use GitHub repos without offering their issues, or park a connected
    Jira without disconnecting it. A disabled source is hidden from the import/link UI and
    its import/search endpoints are refused (409).

  New surface:

  - `task_source_settings` table, mirrored D1 (migration `0008_task_source_settings.sql`)
    ⇄ Drizzle (`taskSourceSettings` + generated migration), behind a new
    `TaskSourceSettingsRepository` kernel port.
  - `GET /workspaces/:ws/task-sources` now returns each source's descriptor plus
    `available` + `enabled`; `PUT /workspaces/:ws/task-sources/:source/enabled` toggles it.
  - The SPA settings modal hosts the toggle, and import entry points key off the offered
    (available + enabled) set instead of raw connections.

  BREAKING: the `TASK_SOURCES` env var (Cloudflare `wrangler.toml` / Node `.env`) and
  `TasksConfig.sources` are removed. Delete `TASK_SOURCES` from any deployment config —
  which sources a workspace uses is now controlled in the app, not by the operator.

### Patch Changes

- Updated dependencies [5c915fd]
  - @cat-factory/contracts@0.13.0
  - @cat-factory/kernel@0.13.0

## 0.9.0

### Minor Changes

- 4de2f5f: Declutter settings/navbar and make post-release health a pluggable observability integration.

  **Frontend**

  - Workspace settings is now a single tabbed window: **Merge thresholds**, **Issue writeback**
    and **Default service best practices** moved from standalone modals into tabs (their navbar/
    command-bar entries now deep-link to the tab). Fixed the **Mode** select clipping its options.
  - Removed the **Add a block** button and **all** "Add &lt;type&gt; block" command-bar commands
    (services come from Bootstrap / Add-from-repo, tasks from the add-task flow); dropped the
    unsupported `external` / `environment` block types.
  - The new-task form now shows **Context documents** and **Context issues** sections (inspector-
    style) **ungated** — the _Attach_ button is disabled with a tooltip until the relevant
    integration is connected. (`ContextPicker.vue` removed.)
  - Post-release health is no longer a Datadog-named window: the **connection** is an
    **Observability** entry in the Integrations hub (`ObservabilityConnectionPanel`, provider
    picker — Datadog today), and the per-service **monitor/SLO mapping** moved into the **service
    inspector** (`ServiceReleaseHealthConfig`, keyed by the selected frame — no manual block-id
    entry, disabled with a hint until a connection exists).

  **Backend — pluggable observability (Datadog = one adapter)**

  - The `ReleaseHealthProvider` is now served by `RegistryReleaseHealthProvider`, a registry of
    per-vendor adapters; the Datadog logic became `DatadogObservabilityAdapter`. Adding a second
    provider is a new registry entry — the gate, service, routes and persistence are vendor-neutral.

  **Breaking (acceptable per pre-1.0 policy — no migration):**

  - Persistence: the `datadog_connections` table is **dropped** and replaced by
    `observability_connections` (`provider` discriminator + a single sealed `credentials` JSON blob
    - a non-secret `summary`), mirrored D1 ⇄ Drizzle. Existing connections must be re-entered.
  - Kernel: `DatadogConnectionRecord`/`DatadogConnectionRepository` →
    `ObservabilityConnectionRecord`/`ObservabilityConnectionRepository` (+ `ObservabilityProviderKind`).
  - Contracts: `upsertDatadogConnectionSchema` / `datadogConnectionViewSchema` →
    `upsertObservabilityConnectionSchema` / `observabilityConnectionViewSchema` (now `{ provider,
credentials }` / `{ connected, provider, summary }`), plus `observabilityConnectionSummary`.
  - HTTP: `GET|PUT|DELETE /workspaces/:ws/datadog/connection` → `…/observability/connection`.
  - Config/env: `DATADOG_ENABLED` → `OBSERVABILITY_ENABLED`; `AppConfig.datadog` → `AppConfig.releaseHealth`
    (`DatadogConfig` → `ReleaseHealthConfig`); the sealed-secret domain tag `cat-factory:datadog` →
    `cat-factory:observability`.

  Note: the cross-runtime conformance suite does not yet cover the observability connection CRUD
  (it never covered the Datadog connection either); both facades wire the same repos/cipher/provider
  and ship mirrored D1 + Drizzle migrations.

### Patch Changes

- 4de2f5f: Review fixes for the declutter/observability pass:

  - **Board no longer crashes on `external`/`environment` blocks.** Those types stay
    user-uncreatable, but the backend still emits them (the seeded third-party service and
    the environments integration), so they are restored to the frontend `BlockType` union +
    `BLOCK_TYPE_META` for display parity with the contracts `blockTypeSchema`. `blockTypeMeta()`
    adds a safe fallback so an unknown/legacy block type degrades instead of throwing on the board.
  - **Integrations hub gates the Observability row on availability.** The `releaseHealth` store
    now probes an `available` flag (mirroring the other integration stores); the hub hides the
    "Post-release health" entry when `OBSERVABILITY_ENABLED` is off, instead of showing a dead
    row that only 503s.
  - **De-duplicated release-health loads.** `ensureLoaded()` coalesces repeated hub opens /
    frame-inspector mounts so they reuse the resolved connection + configs rather than re-fetching
    the whole configs list on every service selection.
  - **Vendor-neutral gate message.** The post-release-health pipeline guard now says "Connect an
    observability provider" instead of the leftover "Connect Datadog".
  - **Validated credentials at the registry boundary.** `parseDatadogCredentials` validates the
    decrypted blob in the observability registry, so a drifted/corrupted row fails with a clear
    error instead of deep inside the Datadog client during a live probe.

- Updated dependencies [128e12e]
- Updated dependencies [4de2f5f]
- Updated dependencies [4de2f5f]
  - @cat-factory/kernel@0.12.0
  - @cat-factory/contracts@0.12.0

## 0.8.3

### Patch Changes

- f8a24e0: Refresh dependencies to latest. Notable major bumps: TypeScript 5→6 (tooling
  packages), vitest 3→4, pino 9→10, `@hono/node-server` 1→2, `@hono/valibot-validator`
  0.5→0.6, happy-dom 15→20, and `@types/node` →26. Patch/minor refreshes for `ai`,
  `hono`, `wrangler`, `pg-boss`, `ws`, `@ai-sdk/*`, `oxlint`, and the Cloudflare
  workers tooling.
- Updated dependencies [f8a24e0]
  - @cat-factory/kernel@0.11.1

## 0.8.2

### Patch Changes

- Updated dependencies [1e31cbc]
  - @cat-factory/contracts@0.11.0
  - @cat-factory/kernel@0.11.0

## 0.8.1

### Patch Changes

- Updated dependencies [d0081e1]
  - @cat-factory/contracts@0.10.0
  - @cat-factory/kernel@0.10.1

## 0.8.0

### Minor Changes

- ae29687: OpenRouter: dynamic multi-tenant catalog + flavour unification.

  **Flavour unification.** A catalog model can now carry an `openrouter` flavour alongside
  `cloudflare`/`direct`/`subscription`. `effectiveVariant` resolves in the precedence
  direct → openrouter → cloudflare (the subscription override still wins in `ModelRouter`),
  so the SAME logical model routes through OpenRouter when only an OpenRouter key is
  configured, and through its native vendor when that key is present. The standalone
  `openrouter-*` catalog entries are folded into their native twins: `deepseek`, `gpt-5.5`
  and `claude-opus` gain an `openrouter` route; Gemini 3 Pro becomes a curated `gemini`
  entry. **Breaking (pre-1.0, acceptable):** the catalog ids `openrouter-claude-opus`,
  `openrouter-gpt`, `openrouter-deepseek`, `openrouter-gemini-pro` and `openrouter-llama`
  are removed — a block pinned to one falls through to default routing.

  **Dynamic catalog.** A workspace can now browse OpenRouter's live `/models` and enable a
  subset in the UI (the new "OpenRouter models" panel), rather than a hardcoded handful.
  Enabled models surface in the per-workspace picker as `openrouter:<slug>` entries with
  their live context window and price (overlaid onto the spend table, so budgets meter
  accurately). Persisted in a new generic per-workspace `provider_model_catalog` table
  (D1 ⇄ Drizzle, keyed by `(workspace_id, provider)` so future gateways like LiteLLM reuse
  it), behind the new kernel `ProviderModelCatalogRepository` port and the
  `OpenRouterCatalogService` (refresh leases the workspace's pooled OpenRouter key). New
  routes: `GET|PUT /workspaces/:ws/openrouter/catalog`, `POST /workspaces/:ws/openrouter/refresh`.
  Cross-runtime conformance asserts the enabled-subset round-trip + catalog surfacing on
  both D1 and Postgres.

### Patch Changes

- Updated dependencies [ae29687]
  - @cat-factory/contracts@0.9.0
  - @cat-factory/kernel@0.10.0

## 0.7.5

### Patch Changes

- Updated dependencies [5c20968]
  - @cat-factory/kernel@0.9.0

## 0.7.4

### Patch Changes

- Updated dependencies [c70df09]
  - @cat-factory/contracts@0.8.0
  - @cat-factory/kernel@0.8.0

## 0.7.3

### Patch Changes

- Updated dependencies [a0a1bcc]
  - @cat-factory/kernel@0.7.3

## 0.7.2

### Patch Changes

- 4fa5ed9: Re-release all publishable packages. The previous release bumped these on `main` but never reached npm (the publish job was never triggered), so npm is a release behind. This changeset re-triggers the release so every package publishes.
- Updated dependencies [4fa5ed9]
  - @cat-factory/contracts@0.7.2
  - @cat-factory/kernel@0.7.2

## 0.7.1

### Patch Changes

- 7463cf2: Add `repository` metadata (url + monorepo `directory`) to every published package.json. npm provenance attestation rejected the previous release because `repository.url` was empty and could not be matched against the source repo; declaring it lets the publish (and provenance) succeed, and re-triggers publishing of all packages from the failed release.
- Updated dependencies [7463cf2]
  - @cat-factory/contracts@0.7.1
  - @cat-factory/kernel@0.7.1

## 0.7.0

### Minor Changes

- fe53445: Add an existing GitHub repository to the board as a service, with no bootstrap
  run. A new "Add from existing repo" button (sidebar, Repositories section) opens
  a picker of repos the GitHub App can access — including ones the workspace
  doesn't track yet — plus a link to grant the App access to more repos. Importing
  links + syncs the repo into the workspace (if needed), creates a `ready` service
  frame titled after the repo, and links the repo projection to it so tasks dropped
  on the frame target that repo. Backed by `POST /workspaces/:ws/blocks/from-repo`
  (`BoardService.addServiceFromRepo` + `GitHubSyncService.linkRepo`).
- db77061: Refuse to pool individual-use-only subscriptions on a workspace.

  Some subscriptions are licensed for individual use only, so a single credential may not
  be shared across a workspace (any member's run leasing it). `SUBSCRIPTION_VENDORS` now
  carries an `individualOnly` flag, set — from each vendor's own terms of service — for
  `claude` (Anthropic consumer Pro/Max), `glm` (Z.ai's GLM Coding Plan is "licensed only
  to the individual natural person") and `codex` (a ChatGPT `auth.json` is a per-seat
  credential, sharing prohibited at every tier). The genuinely org-permitted coding-plan
  vendors `kimi` (Moonshot explicitly permits authorized enterprise use) and `deepseek` (a
  commercial API platform) stay poolable.

  `ProviderSubscriptionService` enforces it account-agnostically: `addToken`/`leaseToken`
  throw a `ConflictError` (HTTP 409) for any `individualOnly` vendor, and `hasToken` always
  reports it unavailable so the executor's "subscriptions always win" routing never
  auto-selects a vendor a lease would reject. The rule is asserted in the cross-runtime
  conformance suite against an org-owned workspace, and the LLM Vendors UI offers only the
  poolable vendors (the individual-use ones are connected per-user in the Personal
  subscriptions section). Organizations needing shared, programmatic access use a direct
  provider API key instead, which is unaffected by the flag.

- 8065fed: Make the CI / conflicts gates observable. The gate window now shows the run id
  (copyable, with a jump into observability), a per-attempt history of every
  ci-fixer / conflict-resolver run (what each tried and how it ended), and — for
  the conflicts gate — the resolver's own account of which files it left
  conflicting (GitHub's API exposes mergeability as a single bit, so this comes
  from the resolver, plus a link to inspect the PR on GitHub). Failing CI checks
  now link straight to their GitHub run logs.

  Mechanically: `GateStepState` gains an append-only `attemptLog`; the engine
  records each gate-helper attempt when its job finishes (previously discarded the
  moment the gate re-probed) and sets the conflicts gate's `lastFailureSummary`
  from the resolver's output. `CiCheck` / `gateFailingCheckSchema` /
  `githubCheckRunSchema` carry the check run's `html_url` so the UI can link to it
  (populated on the live check-runs read; not persisted to the projection). The
  conflict-resolver result mapping now surfaces the still-conflicting file list
  (its `error`) instead of dropping it.

  Also tightens the conflict-resolver prompt: lockfiles (`package-lock.json`,
  `pnpm-lock.yaml`, `Cargo.lock`, `go.sum`, …) must be regenerated via the package
  manager rather than hand-merged — large generated files are what exhausted the
  resolver's context window and left big conflict sets unresolved.

- 0972696: Surface external context sources in the add-task popup, with search + a new GitHub
  repo-doc source.

  The task-creation popup gains a `ContextPicker`: pick a connected source
  (Confluence, Notion, GitHub repo docs, Jira, GitHub issues), then **search its
  catalogue by title/content**, paste a page/issue URL, or pick something already
  imported — chosen items are imported and linked to the new task as agent context
  when it's created. Previously the popup could only tick already-imported items and
  there was no in-UI way to reach the catalogue.

  - **Search** is a new optional capability on the document/task source providers
    (`search?(credentials, query)`), exposed as `POST
/workspaces/:ws/{document,task}-sources/:source/search`. Implemented for
    Confluence (CQL), Notion (`/v1/search`), Jira (JQL), GitHub issues
    (`/search/issues`) and GitHub docs (`/search/code`). The `GitHubClient` port
    gains `searchIssues` / `searchCode`. Descriptors advertise `searchable` so the UI
    knows when to offer a search box.
  - **GitHub repo docs** are a new `github` document source: link a Markdown/text
    file from a repo (README, RFC, architecture note) by URL or `owner/repo:path`, or
    by code-search. Like GitHub issues it reuses the workspace's installed GitHub App
    (no credentials of its own) and is wired only when the GitHub integration is on.

- e9b9356: Create board tasks directly from imported GitHub issues or Jira tickets.

  Previously an imported issue could only be attached to an _existing_ task block as
  agent context. The task-source integration now also materialises an issue as a
  brand-new board task: `TaskLinkService.createTaskFromIssue` seeds a leaf block
  (title `KEY: summary`, description = a source-reference line + the issue body)
  inside a chosen service frame or module via `BoardService.addTask`, then links the
  issue to the new task so every agent step still sees the full issue (description,
  comments, metadata) as context. The issue stays the source of truth — re-importing
  refreshes it. Backed by `POST /workspaces/:ws/tasks/create-block`
  (`{ source, externalId, containerId }` → `{ block, task }`). In the UI, the
  task-source import modal gains a "create tasks in" container picker and a per-issue
  "Create task" action.

  The new task carries `createdBy` (the signed-in user, threaded through the widened
  `BoardWritePort.addTask`) for notification routing, the container is resolved in the
  request workspace so the workspace-scoped issue link always resolves at execution
  time, and creating a second task from an already-linked issue is refused (`409`)
  rather than silently re-pointing the single issue→block link. The shared
  cross-runtime conformance suite now asserts the whole create-task-from-issue flow
  (seeded over a deterministic task source) against BOTH the Cloudflare/D1 and the
  Node/Postgres facades.

  Also closes two cross-runtime parity gaps in the task-source layer so the feature
  works identically on both facades:

  - **GitHub issues as a task source now work on the Node runtime.** The
    runtime-neutral `GitHubIssuesProvider` (it depends only on the `GitHubClient` /
    `GitHubInstallationRepository` ports) moved from the Cloudflare package into the
    shared `@cat-factory/integrations`, the Node facade wires it whenever a GitHub
    client is available (the App is configured) — mirroring the Worker's
    `config.github.enabled` gate — AND `github` was added to the Node facade's
    task-source allow-list (it had been omitted, so the provider could never register).
    Previously only the Worker offered GitHub issues.
  - **Jira search now works on the Node runtime.** The duplicated per-runtime
    `JiraProvider` was hoisted into the shared `@cat-factory/integrations` (it is a thin
    runtime-neutral `fetch` shell, like `GitHubIssuesProvider`), so both facades now
    compose the SAME class — including `search()`, which the legacy Node copy had
    silently dropped.

- e8005ba: Datadog post-release-health gate + Agent-On-Call.

  After a release ships, a new **`post-release-health`** polling gate watches the team's
  Datadog **monitors/SLOs** over a monitoring window. It reuses the existing gate machinery
  (`ci`/`conflicts`): a clean window advances with nothing spun up; a regression escalates —
  Datadog credentials stay on the backend and never enter containers.

  The gate is **opt-in**: it is NOT in any default pipeline. A user adds it deliberately in
  the pipeline builder, and it only appears in the palette — and is only accepted by the
  backend — once the workspace has an **observability integration connected** (today a
  Datadog connection). `PipelineService` rejects a `create`/`update` that adds an enabled
  `post-release-health` step otherwise.

  - **No blind revert.** On a regression the gate dispatches an **`on-call`** container agent
    that clones the base branch (the merged release; the work branch is deleted on merge),
    locates the merged commit and correlates its diff with the regression evidence (alerting
    monitors/SLOs + recent error logs), returning a JSON assessment (culprit confidence +
    `revert`/`hold`/`monitor` recommendation). It makes no commits and reverts nothing — the
    engine raises a **`release_regression`** notification for a human to decide. The gate only
    engages once the PR actually merged, attributes only post-release alerts (not pre-existing
    ones) to the release, and honours the full configured watch window even when it outlasts a
    single poll budget.
  - **Datadog connection + monitor/SLO mapping** are per-workspace (keys sealed at rest under
    a `cat-factory:datadog` cipher, write-only), managed in a new settings panel and the
    `GET|PUT|DELETE /workspaces/:ws/datadog/connection` + `/release-health-configs/:blockId`
    API. The gate maps a run's repo to its service-frame config (monitor + SLO ids + env tag).
  - **Merge-preset knobs**: `releaseWatchWindowMinutes` (default 30) and `releaseMaxAttempts`
    (default 1) bound the watch window + on-call dispatches.
  - **Incident enrichment (optional, additive):** PagerDuty / incident.io are NOT used to
    re-alert (they already page off the same monitors/SLOs) — instead the on-call
    investigation is posted onto an incident they already opened (annotate, never duplicate),
    behind a new `IncidentEnrichmentProvider` port. Slack + the in-app inbox carry the
    human-facing `release_regression` notification.
  - Runtime-symmetric: D1 (`datadog_connections`, `release_health_configs` + the two preset
    columns) ⇄ Drizzle/Postgres, wired in both the Cloudflare Worker and Node/local facades.
  - New harness route `POST /on-call`; the executor-harness image is bumped to `1.7.1`.

  **Breaking (pre-1.0, acceptable):** `merge_threshold_presets` gains two columns — stale rows
  are re-seeded with the defaults.

- b40da13: Simplify task granularity and run configuration; open the pipeline-step detail
  overlay from the zoomed-in board.

  - **Open the agent step-detail overlay from the board.** Clicking a pipeline agent
    in a zoomed-in task card now opens the full `AgentStepDetail` overlay (execution
    metadata + the agent's prose output), exactly like clicking it from the inspector
    or the focus-view pipeline — instead of expanding raw text inside the card.
  - **Removed the per-task auto-merge "confidence threshold".** The confidence-score
    auto-merge gate (`Block.confidenceThreshold`, the inspector + task-card UI, the
    `DEFAULT_CONFIDENCE_THRESHOLD` constant) is gone; the `merger` step's merge-policy
    preset (complexity/risk/impact ceilings) is the sole auto-merge gate. (The raw
    `confidence` score is still recorded for transparency.)
  - **Removed "feature" tracking from the board and the service map.** `Block.features`
    (the inspector's "Features implemented" tags and the board/module feature badges)
    is removed, and the in-repo blueprint / board-scan decomposition is now
    service → modules only — the Blueprinter, harness rendering, and reconciliation no
    longer produce a "feature" sub-level or derive tasks from it. Acceptance scenarios
    are now freeform per task (decoupled from features) pending a deeper
    requirements-driven model.
  - **Task creation picks a pipeline + merge policy; model selection removed.** The
    "Add a task" modal now offers a default pipeline (`Block.pipelineId`, which the
    task's Run/Start controls use) and a merge policy preset. The per-task model
    picker is gone — a model is resolved per step, not per task.

  Migration `0025_task_run_config.sql` drops the `confidence_threshold` and `features`
  columns and adds `pipeline_id`. Bumps `@cat-factory/executor-harness` (the blueprint
  rendering inside its image changed).

- 084bf43: Widen the env-provisioning + runner-pool surface so an external orchestration adapter
  (e.g. an in-house PR-environment platform) can be written on top of our ports and wired
  into a stock facade build, without forking the facades.

  - `EnvironmentProvider` provision requests now carry a typed `provisionContext`
    (branch / PR number+url / repo owner+name, derived from the block's PR ref) and the same
    values are flattened into `{{input.*}}` for the manifest path. The deployer step supplies
    it. A PR-environment provider needs the git ref + repo to target the right environment.
  - New `UrlSafetyPolicy` (kernel) + `resolveUrlSafetyPolicy` (server): the env + runner-pool
    URL/host guard is now policy-driven. The default stays strict (https-only, no
    private/internal hosts); a TRUSTED operator can widen it per facade to reach an internal
    platform on a private/VPN host. The two integrations are scoped **independently** — each
    resolves its own policy from its own config slice, so widening one (`ENVIRONMENTS_*`) does
    not widen the other's (`RUNNERS_*`) SSRF guard. Config: `ENVIRONMENTS_ALLOW_URL_HOSTS` /
    `ENVIRONMENTS_ALLOW_HTTP_URLS` and `RUNNERS_ALLOW_URL_HOSTS` / `RUNNERS_ALLOW_HTTP_URLS`
    (Node env vars + the matching Worker `[vars]`).
  - The Node facade's `buildNodeContainer` gains a documented `environmentProvider` seam (the
    Worker injects via `buildContainer`'s `overrides`); a custom adapter replaces the default
    manifest-driven `HttpEnvironmentProvider` while the env repos + secret cipher still wire
    from config. The local facade inherits the seam through `buildNodeContainer`.

  No backwards-incompatible changes: every addition is optional and defaults to today's
  behaviour.

- db77061: Add an **individual-usage restricted mode** for subscriptions licensed for personal
  use only (`claude`, `glm` and `codex` — see their terms of service). Such vendors are no
  longer poolable on a workspace; instead each user stores their OWN credential and only
  that user's runs may use it.

  - **Per-user, double-encrypted storage.** A personal subscription's token is sealed
    under a key derived from the user's personal **password** (PBKDF2 → AES-GCM, never
    stored) and then encrypted again with the system key, so it cannot be recovered
    without BOTH the system key AND the password. New `personal_subscriptions` table on
    both runtimes (D1 migration `0039` ⇄ Drizzle), `PersonalSubscriptionService`, and
    `GET/POST/DELETE /personal-subscriptions` (user-scoped).
  - **One password per user.** All of a user's individual-usage subscriptions must share a
    single personal password (enforced at store time), since a run unlocks every vendor it
    touches with one password. Passwords are restricted to printable ASCII so they are
    HTTP-header-safe.
  - **Per-run activation, short TTL, transparently extended.** At task start/retry the user
    supplies their password — carried on the ambient `X-Personal-Password` header (never a
    body field), cached client-side (~40h) so it usually rides along transparently — to mint a
    short-lived (~12h), system-encrypted, per-run activation (`subscription_activations`
    table) that the asynchronous container steps lease, so the whole step chain authenticates
    without the user present. The activation is **re-minted from the cached password on each
    interaction** (resolve a decision / approve a step / retry), so an actively-tended run
    never lapses under the short TTL; the user is only re-prompted once the password cache
    expires. Activations are deleted when the run finishes (or its block's run is replaced)
    and swept on TTL expiry.
  - **No recurring runs.** A recurring schedule whose block resolves to an individual-usage
    model — by pin **or** workspace per-kind default — is refused at fire time (it can't be
    unlocked unattended).
  - **Gating.** Starting/retrying a run that resolves to individual-usage model(s)
    requires a signed-in user with the stored subscription(s); a missing password returns
    `428 credential_required` so the client prompts. The gate mirrors dispatch's model
    precedence (block pin → workspace per-kind default) across the pipeline's steps, so a
    block with no pin but an individual-usage workspace default is gated up-front instead
    of failing at dispatch. The container executor leases the initiator's activation and
    fails clearly (retryable) if it has lapsed. Expiry/renewal is surfaced in advance.

  **Breaking (no migration — backwards compatibility is a non-goal here):** `glm` and `codex`
  join `claude` as individual-only, and individual-only vendors are no longer poolable on ANY
  workspace. Any existing **pooled** `claude`/`glm`/`codex` workspace tokens become orphaned
  (no longer leased or listed) — reconnect them as personal subscriptions.

  See `backend/docs/individual-subscription-usage.md` for the full model + safeguards.

- 6406c8c: Extract `@cat-factory/integrations` — GitHub, documents, tasks, environments, and runners modules are now a standalone package. `@cat-factory/core` re-exports the full public surface for backward compatibility. `BoardWritePort` added to `@cat-factory/kernel` so `DocumentLinkService` can depend on a narrow port rather than the concrete `BoardService`.
- 57d70fa: Issue-tracker writeback: comment on a task's linked tracker issue when its PR
  opens, and comment + close the issue as resolved when the PR merges.

  Two independent toggles configured at the **workspace** level (on the existing
  tracker settings) and overridable **per task** in the inspector
  (`commentOnPrOpen`, `resolveOnMerge`; each task override is `inherit`/`on`/`off`).
  The linked issue(s) come from the existing task projection (`linkedBlockId`), so
  writeback targets whatever GitHub/Jira issue is attached to the task. All writeback
  is best-effort — a tracker outage never fails a run.

  GitHub issues close natively (`state_reason: completed`); Jira issues transition to
  the first status in their standard **Done** category (no manual status mapping). The
  new `IssueWritebackService` mirrors `TicketTrackerService`'s per-facade seams and is
  wired on both the Cloudflare and Node runtimes; the `GitHubClient` port gains a
  `closeIssue` method.

  **Breaking (pre-1.0, no migration):** the `tracker_settings` table gains
  `writeback_comment_on_pr_open` / `writeback_resolve_on_merge` columns and `blocks`
  gains `tracker_comment_on_pr_open` / `tracker_resolve_on_merge` (D1 migration `0005`
  ⇄ a generated Drizzle migration). Both default to off/inherit, so existing data is
  unaffected.

- 918764f: Add optional, opt-in **Langfuse** LLM observability. A new fetch-based
  `@cat-factory/observability-langfuse` package implements a runtime-neutral
  `LlmTraceSink` (new kernel port) against Langfuse's ingestion API — no Node SDK or
  OpenTelemetry, so it runs unchanged on BOTH the Cloudflare Worker (workerd) and Node
  facades.

  Proxied container-agent calls and inline (non-proxied) calls — requirements
  review/rework, document planner, fragment selector, the inline agent — flow through the
  SAME sink path: the orchestration `LlmObservabilityService` fans every recorded proxied
  call out as a generation, and an `InstrumentedModelProvider` wraps every resolved model
  so inline `generateText` calls surface the identical `LlmGenerationEvent`. Calls are
  grouped under one trace per run (`executionId`); inline single-shot calls become their
  own standalone trace.

  Off unless `LANGFUSE_ENABLED=true` and both keys are set; wired symmetrically in both
  runtime containers. Honours the existing `LLM_RECORD_PROMPTS` switch (prompt/response
  bodies are omitted from Langfuse too when disabled). The sink never throws into the LLM
  path — failures are swallowed and logged. The existing local metric store, spend gating
  and board rollups are unchanged; Langfuse is an additive external sink, not a
  replacement.

- f73652c: LLM key management overhaul: DB-backed, multi-scope, pooled provider API keys;
  opt-in Cloudflare AI; provider-gated pipelines; account roles.

  - **Direct-provider API keys move from env to the DB** (BREAKING). The
    OpenAI/Anthropic/Qwen/DeepSeek/Moonshot keys that were read from
    `*_API_KEY` env vars are now onboarded via the UI and stored encrypted (the
    shared `WebCryptoSecretCipher`, HKDF info `cat-factory:provider-api-keys`).
    They are pooled and leased with usage-aware rotation, and scoped to an
    **account, workspace, or user** — within a workspace the candidate pool merges
    the workspace's keys, its owning account's keys, and the run initiator's own
    user keys. Operators must re-enter their keys via the app after upgrading.
  - **Cloudflare Workers AI is no longer assumed available.** It becomes a separate
    opt-in provider lib (like `provider-bedrock`), explicitly registered per
    deployment (the Worker `AI` binding; Node REST account/token). The unconditional
    `workers-ai` fallback is removed, so a bare deployment exposes no models until a
    key is added or the Cloudflare lib is enabled.
  - **Model selectability is derived from what is configured**, and starting a
    pipeline is blocked when any step's canonical model has no usable provider
    (no direct key, no subscription, no registered registry).
  - **Account roles** (admin / developer / product, combinable) layered on the
    membership model: only admins may modify org-account settings; a product member
    can be set as a task's responsible person and is notified when requirement review
    raises findings.

- 8807f5c: Run agents on locally-hosted LLMs (Ollama, LM Studio, llama.cpp, vLLM, or any
  custom OpenAI-compatible server). Each user configures their own runners in
  Settings → "My local runners" (a runner lives on that person's machine), stored
  per-user in the DB with on-the-fly connection validation that probes the runner's
  `/v1/models` and lists the installed models to enable. The enabled models appear
  in the picker as the `direct` flavour and need no API key — the LLM proxy resolves
  the run initiator's endpoint and skips the DB key lease (new optional
  `LlmUpstreamEndpoint.apiKey` signal / keyless local branch), and inline LLM calls
  register the user's runners as keyless resolvers. Resolution is by the run
  initiator, exactly like personal subscriptions.

  New per-user `local_model_endpoints` table mirrored across both runtimes (D1
  migration `0002` ⇄ Drizzle), a user-scoped `GET|PUT|DELETE /local-model-endpoints`

  - `POST /local-model-endpoints/test` API, and a cross-runtime conformance
    assertion for the store (CRUD + bearer-key encryption round-trip + enabled-models
    JSON). Container kinds (coder/tester/merger/…) and the inline reviewer/planner all
    run on the local model. Breaking only in the pre-1.0 sense: a new table is added,
    no migration of existing data is needed.

  Because the user-supplied base URL is forwarded server-side (the test probe + the
  LLM proxy), it is constrained to a loopback/LAN allow-list (`localRunnerUrlError`):
  `localhost`, `*.local`, and RFC1918/ULA private addresses are accepted, while public
  hosts and the link-local cloud-metadata endpoint (`169.254.169.254` / `fe80::`) are
  rejected at the write boundary and the probe (anti-SSRF). Model usability is gated on
  the specific enabled model id (`localModels` capability), not merely the runner being
  configured, so a stale pin to a since-disabled model is caught at the pipeline-start
  guard.

- 5ec0d25: Real merge lifecycle: CI gate + CI-fixer, merger agent, and notifications.

  A task now becomes `done` only when its pull request is **actually merged** on
  GitHub — fixing the bug where a task showed "merged" (and a green board) from a
  confidence score alone, while CI was red and the PR still open.

  - **CI gate (`ci` step)** — auto-inserted before the merger in the standard
    pipelines. It polls the PR head's GitHub check runs and, on failure, dispatches a
    new **`ci-fixer`** container agent that pushes a fix to the PR branch, looping up
    to a configurable budget (default 10) until CI is green; polling stops the moment
    CI goes green. If the budget is spent it raises a `ci_failed` notification.
  - **Merger agent (`merger` step)** — runs last. A container agent scores the PR's
    complexity / risk / impact, and the engine compares those against the task's
    **merge threshold preset** to either auto-merge (a real GitHub merge) or raise a
    `merge_review` notification for a human. Presets are a per-workspace library
    (selectable per task); the CI-fixer attempt budget lives on the preset.
  - **`merger` is appended to the standard pipelines.** A pipeline with no merger now
    raises a `pipeline_complete` notification on completion (confirm + merge) instead
    of silently marking the task done.
  - **Notifications** — a new first-class, human-actionable board surface (inbox +
    events), modelled behind a `NotificationChannel` port so email/Slack delivery can
    be added later without touching the call sites. In-app delivery only for now.

  Adds migration `0024_merge_lifecycle.sql` (notifications + merge-preset tables, the
  `blocks.merge_preset_id` column). The executor-harness image gains `/ci-fix` and
  `/merge` endpoints (version bumped so the GHCR image is re-tagged).

- a691853: Monorepo support: select a subset of a repo's services and pin each to a subdirectory.

  A linked GitHub repository can now be flagged a **monorepo** (`github_repos.is_monorepo`,
  D1 migration `0044` ⇄ Drizzle), which lets it back **more than one** board service —
  each pinned to its own subdirectory (`services.directory`). The "Add service from repo"
  modal gains a monorepo toggle and a **directory browser** (`GET
/workspaces/:ws/github/repos/:id/tree`, served from GitHub's contents API via
  `GitHubSyncService.listRepoDirectory`) so you can explore the repo and pick the
  directory of the service you want — and add several (a subset of the repo's services).
  `PATCH /workspaces/:ws/github/repos/:id` sets the monorepo flag.

  The chosen subdirectory is **fed to the agents that build the service** when the repo is
  a monorepo: `buildResolveRepoTarget` resolves a frame's service (so multiple frames can
  target one repo) and returns its `serviceDirectory`, which flows through the container
  job body into the harness. The implementation agents — **coder, mocker and ci-fixer**
  (everything routed through `runCodingAgent`) — run with their working directory set to
  that subtree and are told, in their AGENTS.md context, that they're in a monorepo and to
  scope their work (and build/test commands) to it. The cross-cutting agents keep operating
  at the repo root by design: the **conflict-resolver** and **merger** act on the whole
  merge / diff, and the **blueprint** and **requirements** agents write repo-root artifacts.
  Non-monorepo repos keep the historical whole-repo behaviour.

  Known limitation: the in-repo blueprint (`blueprints/`) and requirements (`requirements/`)
  artifacts are still written at the repo root, so two services backed by the same monorepo
  share — and would overwrite — those files. Per-service artifact paths are a follow-up.

- c664fe6: Run container agent steps on the Node service via a self-hosted runner pool, so the
  Node facade no longer silently degrades repo-operating kinds (coder, mocker,
  playwright, blueprints, ci-fixer, conflict-resolver, merger) to useless one-shot LLM
  calls.

  The container-execution machinery is now shared, not Worker-only:

  - `@cat-factory/server` hosts the runtime-neutral `CompositeAgentExecutor`,
    `ContainerAgentExecutor` and `RunnerJobClient`, plus the Web-Crypto
    `WebCryptoSecretCipher` and GitHub-App auth (`GitHubAppAuth` / `GitHubAppRegistry`).
  - `@cat-factory/integrations` hosts the manifest-driven runner-pool transport
    (`HttpRunnerPoolProvider` / `RunnerPoolTransport`).
  - `@cat-factory/server` also hosts the runtime-neutral `buildResolveRepoTarget` (the
    security-sensitive block→service→repo ancestry walk, with its no-"first-repo"-fallback
    policy), so the Worker and Node service single-source it instead of keeping two
    hand-copied resolvers that could drift. Each facade just binds its own repositories.
  - `@cat-factory/worker` keeps thin re-export shims at the old paths (no API change).

  `@cat-factory/node-server` wires a `CompositeAgentExecutor` (inline + container) whose
  container executor dispatches to a workspace's registered runner pool
  (`RunnerPoolTransport`), resolving the run's repo + minting a short-lived GitHub
  installation token exactly as the Worker does. New Postgres tables
  (`runner_pool_connections`, `github_installations`, `github_repos`) mirror the D1
  schema. It activates when `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY`, `PUBLIC_URL`,
  `AUTH_SESSION_SECRET` and `ENCRYPTION_KEY` are configured; otherwise inline
  kinds still work and container kinds fail loudly rather than faking success.

- 7d5e060: Bridge the Cloudflare ⇄ Node/local runtime feature-parity gaps: seven product
  features that worked on the Worker but `503`'d on the Node + local facades (their
  repositories were never wired) now work identically on all three, each landed with
  a cross-runtime conformance assertion.

  - **Merge threshold presets** — `merge_threshold_presets` + `DrizzleMergePresetRepository`.
  - **Board-scan repository blueprints** — `repo_blueprints` + `DrizzleRepoBlueprintRepository`
    (the blueprint reads; the `blueprints` pipeline step already ran on Node).
  - **Document sources** — `document_connections`/`documents` + repos; the Confluence /
    Notion / GitHub-docs provider shells are promoted into `@cat-factory/integrations`
    so both facades compose the same providers.
  - **Ephemeral environments** — `environment_connections`/`environments` + repos;
    `HttpEnvironmentProvider` promoted into `@cat-factory/integrations`; a Node
    `setInterval` TTL-teardown sweeper mirrors the Worker's expiry cron.
  - **GitHub projections + inline sync** — `github_branches`/`github_pull_requests`/
    `github_issues`/`github_commits`/`github_check_runs` + `github_sync_cursors` and the
    full read/write projection repos, so the runtime-neutral `GitHubSyncService`'s inline
    webhook/backfill ingest persists on Node; `WebCryptoWebhookVerifier` promoted into
    `@cat-factory/server`.
  - **Repo bootstrap** — `reference_architectures` + bootstrap runs stored as
    `kind='bootstrap'` rows of `agent_runs`; `ContainerRepoBootstrapper` promoted into
    `@cat-factory/server`; a **pg-boss durable bootstrap driver** (the analogue of the
    Worker's `BootstrapWorkflow`) replaces the previous "bootstrap isn't durable on Node
    yet" gap, and the stale-run sweeper now re-drives orphaned bootstrap runs too. The
    self-hosted runner pool (`RunnerPoolTransport`) now accepts the `bootstrap` dispatch
    kind — the harness `/bootstrap` route needs no Cloudflare primitive, so a pool runner
    serves it just like the local Docker transport — so a real bootstrap run dispatches +
    pushes for real on Node, not just on local.
  - **Prompt-fragment library (ADR 0006)** — `prompt_fragments`/`fragment_sources` +
    `DrizzlePromptFragmentRepository`/`DrizzleFragmentSourceRepository`; the runtime-neutral
    `LlmFragmentSelector` promoted into `@cat-factory/agents`. Opt-in via
    `PROMPT_LIBRARY_ENABLED`/`PROMPT_LIBRARY_SELECTOR`, wired exactly like the Worker's
    `selectFragmentLibraryDeps` (repos + installation resolver + selector), so the managed
    tenant fragment catalog feeding every agent run works identically on all three.

  The Worker keeps the same behaviour (it gains the new conformance assertions and the
  shared promoted classes). **Breaking on Node/local:** these features now require their
  new tables — boot-time `migrate()` applies them; there is no data to preserve.

  The Node/local Drizzle migration lineage was re-baselined to a single fresh
  `drizzle-kit generate` migration off the current `schema.ts` (the prior hand-authored
  folders had no snapshots, which blocked `db:generate`); `db:generate`/`db:check` are
  green again. Safe because no deployed database depends on the old lineage.

  Deferred (still Worker-only, flagged for follow-up): real-time push (Node `realtime`
  gateway still `501`s — needs a WebSocket hub over Postgres `LISTEN/NOTIFY`),
  queue-backed async GitHub ingest (Node ingests inline rather than via a pg-boss queue),
  and GitHub rate-limit telemetry (Node keeps the no-op repository).

- 70e8ef0: Make in-org shared boards fully interactive, and tighten the shared-service model.

  A workspace that MOUNTS a service from another workspace can now edit it like its own: a
  shared service's blocks live in one home workspace, and board mutations resolve them there
  (authorized by the mount) instead of 404ing on the workspace-scoped lookup.

  - `BlockRepository.findById` (D1 + Drizzle) resolves a block by id across the org; `BoardService`
    uses it so `updateBlock`, `moveBlock`, `addTask`, `addModule`, `removeBlock`,
    `toggleDependency` and `reparent` act on the shared copy at its home workspace. A frame move
    writes the requesting board's mount layout (per-workspace), leaving the shared block untouched.
  - Cross-service `reparent` across two services homed in **different** workspaces moves the
    subtree's block rows (and any executions on them) to the destination service's home, re-stamped
    with the destination service — preserving the "a service's blocks live in its home" invariant.
  - **Every** top-level frame now registers as an account-owned service via the shared
    `registerServiceForFrame` helper — including **seeded demo boards** and **repo bootstrap**, which
    previously created unshareable, unbadged frames.
  - Executions and bootstrap runs now stamp `service_id` from their block at write time (D1 +
    Drizzle), so a shared service's **live** runs surface on every board that mounts it — not just
    pre-migration rows. `BootstrapJobRepository.listByService` + `BootstrapService.listJobs` compose
    a mounted service's in-flight bootstrap into the snapshot.
  - Real-time `boardChanged` now carries the affected block, so `FanOutEventPublisher` fans
    structural changes (module materialised, run cancelled, bootstrap finished) out to every
    mounting board live, not just on reload.
  - `services.frame_block_id` is now UNIQUE (D1 + Drizzle), enforcing the 1:1 frame↔service mapping.
  - Removed N+1s on the snapshot hot path (`composeBoard`) and the GitHub sync fan-out
    (`linkedWorkspaces`).

  The Node facade wires the service repos into the engine but, lacking a real-time transport,
  does not yet decorate its publisher with `FanOutEventPublisher` (noted in its container).

- 70e8ef0: Deduplicate GitHub sync effort within an org.

  Incremental-sync cursors were keyed per `(workspace_id, repo_github_id, kind)`, so two
  workspaces in the same account that both tracked a repo each kept their own ETag/`since`
  cursor and each reconcile pass fetched the repo from GitHub independently — N API
  round-trips for one repo per org.

  - Sync cursors are now keyed by `(installation_id, repo_github_id, kind)` (D1 migration
    `0032`): a repo is fetched from GitHub **once per org**.
  - `GitHubSyncService.syncRepo` fans each projection out to **every** workspace in the org
    that links the repo, so one fetch keeps all the boards consistent; a second workspace's
    reconcile pass becomes a cheap conditional `304`. A `full` pass (used at repo-link time)
    bypasses the shared cursor so a freshly-linked workspace is still fully populated.

  Projection reads stay per-workspace and unchanged. Verified: the worker GitHub suite
  (28 tests) passes with the installation-scoped cursor + fan-out.

  Operational note: migration `0032` rebuilds `github_sync_cursors` (the rows are pure sync
  bookkeeping, no user data), so the first reconcile pass after deploy runs cursorless and
  re-fetches each repo once — a one-time cost that settles back to conditional `304`s.

- b287996: Give every pipeline step its own runner job id so sibling steps in one run can't read
  back each other's results.

  Every container step of a run was dispatched and polled under the bare execution id,
  which is ALSO the per-run container's address. The harness keys its per-kind job
  registries by that id and `GET /jobs/{id}` checks them in a fixed order, so two steps
  that ran close enough together to share the still-warm container collided: a poll for
  one step returned another step's finished result. The visible symptom was an
  `architect` (`/explore`) step returning the `spec-writer`'s (`/spec`) document verbatim
  with no model call of its own — and, latently, `blueprints`/`mocker` reading back the
  `coder`'s result.

  The fix separates the two conflated identifiers into an explicit `RunnerJobRef`:

  - **`runId`** — the run (execution). On backends that share one container across a run
    (the Cloudflare per-run Container, the local Docker container) this addresses that
    container, and `release` reclaims it.
  - **`jobId`** — the job itself, now UNIQUE PER STEP (`<executionId>-<agentKind>`). The
    harness registers and polls each step's job by it, so siblings never alias.

  `RunnerTransport.dispatch`/`poll`/`release` and `RunnerJobClient` now take the ref;
  `AgentJobHandle` carries the `runId` so the poll/stop site can re-address the per-run
  container. The Cloudflare and local transports key the container by `runId` (one
  container per run, reclaimed as a unit) and read the harness job by the per-step
  `jobId`; a self-hosted pool, being per-job, keys on `jobId` (which already kept its
  steps distinct). Single-job flows (repo bootstrap/scan) use the same value for both.
  The engine reclaims a run by its id and passes the in-flight step's job id so a pool can
  cancel exactly it.

  Breaking: `RunnerTransport` implementers now receive a `RunnerJobRef` instead of a bare
  job-id string. The local container label moves from `cat-factory.jobId` to
  `cat-factory.runId`.

- 197264e: Self-hosted runner pools: serve every harness kind and forward structured results.

  Two fixes to the runtime-neutral runner-pool transport (used by both the Cloudflare
  and Node facades for a workspace's self-hosted pool):

  - **Forward the whole structured result.** `HttpRunnerPoolProvider.mapJobView`
    previously copied only `prUrl` / `branch` / `summary` / `error` off a finished job,
    silently dropping every structured product — so a pool-backed `tester` produced no
    `testReport`, a `merger` no assessment, a `blueprints`/`spec-writer` no tree/doc. The
    response mapping gains an optional `resultPath` pointing at the harness `result`
    envelope; when set, the provider coerces and forwards `report` / `service` / `spec` /
    `assessment` / `defaultBranch` / `pushed` / `resolved` / `usage` (type-guarded, with
    the structured products passed through for the engine to validate). The individual
    scalar paths still apply and override.
  - **Serve every harness route, with no allow-list.** A pool runs the same
    executor-harness image as the Cloudflare backend, and runtime parity is the default
    (the "keep the runtimes symmetric" guideline), so `RunnerPoolTransport` dispatches
    every kind with no opt-in `POOL_SUPPORTED_KINDS` guard to gate them. A new harness kind
    reaches a pool automatically, exactly as it does a Cloudflare container, instead of
    silently diverging until it is added to a list.

- 37baa7f: Scheduled recurring pipelines on services.

  A service (a `frame` block) can now carry **recurring pipelines** that re-run a
  pipeline on a cadence — primarily **Dependency updates** and **Tech debt**. A
  schedule runs every `intervalHours`, optionally constrained to an allowed window
  (weekdays + an hour-of-day range, in a chosen IANA timezone), and owns one reused
  on-board task block inside the service that each fire runs the pipeline against
  (skipping any fire while a run is still in flight). Run history is kept ~1 week and
  surfaced in the inspector.

  - **Tech-debt pipeline** adds two agent kinds: a read-only `analysis` container
    agent that audits the repo, then a special non-LLM `tracker` step that files a
    **GitHub issue or Jira ticket** from the analysis before implementation. The
    tracker is a per-workspace selection (`GET|PUT /workspaces/:ws/tracker-settings`);
    `GitHubClient` gains `createIssue`. The runtime-neutral `TicketTrackerService`
    resolves each **tenant's own** connected integration (it is injected with a
    `fileGitHubIssue` filer + a `resolveJiraConnection` resolver, never shared/env
    credentials): on Cloudflare it files GitHub issues through the workspace's GitHub
    App installation against the service's repo, and Jira tickets (markdown→ADF) using
    the workspace's encrypted `task_connections`. Two new seed pipelines:
    `pl_dep_update`, `pl_tech_debt`.
  - **Per-tenant tracker on the Node facade**: both trackers now work on Node, each
    resolving the **workspace's own** integration. Jira: the task-source integration is
    wired on Node (always on; requires the shared `ENCRYPTION_KEY`) — a Drizzle
    `task_connections`/`tasks` store + the runtime-neutral Jira provider — so each tenant
    connects its own Jira through the existing UI (credentials encrypted at rest). GitHub:
    the filer mints a short-lived token from that workspace's own GitHub App installation
    (reusing the per-tenant App infra) and resolves the service's repo from the
    `github_repos` projection — no shared/env credentials.
  - **Persistence + scheduling are symmetric across runtimes**: D1 migration
    `0029_recurring_pipelines.sql` ⇄ Drizzle schema + generated migration; the
    Cloudflare `scheduled` cron fires due schedules (and prunes run history) ⇄ a Node
    `setInterval` sweeper does the same. New ports `PipelineScheduleRepository` /
    `TrackerSettingsRepository` with D1 + Drizzle implementations; the cross-runtime
    conformance suite covers schedule CRUD, `runDue`, and the tracker setting.
  - **UI**: an "Add recurring pipeline" button on the service frame (mirroring "Add
    task") opens a per-frame modal (pipeline + cadence editor; the tracker choice is
    surfaced inline for the tech-debt pipeline). The schedule's block shows a recurring
    badge on the board; selecting it reveals the cadence, run-now/pause, and run
    history in the inspector.

- 2ab06b5: Self-hosted runner pools: expose the dispatch `kind` + provisioning hints as
  first-class manifest template variables.

  `HttpRunnerPoolProvider` now surfaces three more `{{input.*}}` variables to a
  manifest's request templates, alongside the existing `{{input.jobId}}` /
  `{{input.job}}`:

  - `{{input.kind}}` — the harness route the job targets (`run`, `blueprint`, `spec`,
    `explore`, `bootstrap`, `ci-fix`, `resolve-conflicts`, `merge`, `on-call`, `test`,
    `fix-tests`). The values map 1:1 to the harness route names, so a transparent
    proxy can route straight to a per-kind endpoint with `pathTemplate:
"/{{input.kind}}"` instead of parsing the embedded `{{input.job}}` JSON.
  - `{{input.instanceType}}` / `{{input.cloudProvider}}` — the provisioning hints the
    transport stamps on when the service pins a size/provider, so a self-provisioning
    pool (k8s/Nomad) can map them to a node selector / resource request / queue
    declaratively in the manifest.

  These were already carried inside `{{input.job}}`; exposing them flat lets a
  path/query/header template route and size without decoding the job JSON. Backward
  compatible — existing manifests that forward `{{input.job}}` are unaffected. The
  operator/integrator playbook (`docs/runner-pool-integration.md`) is fully rewritten
  to match current behaviour (all kinds incl. bootstrap route to a pool; only the
  synchronous repo scan stays Cloudflare-only).

- de5a9d7: Add configurable Slack notifications as an additional delivery transport for the
  existing notification mechanism (merge_review / pipeline_complete / ci_failed) —
  not a parallel system. A new `SlackNotificationChannel` implements the same
  `NotificationChannel` port the in-app channel does and is composed alongside it via
  `CompositeNotificationChannel`, so the engine call sites that raise notifications
  are untouched.

  Two scopes, mirroring the GitHub-App precedent:

  - The Slack **connection** (the installed team + its bot token) is bound
    **per-account**. The bot token is multi-tenant data, so it is encrypted at rest
    with `WebCryptoSecretCipher` (HKDF tag `cat-factory:slack`) and never returned on
    the wire — only safe metadata (team name/icon, bot user, scopes) is exposed.
    Onboarding is UI-based: a full OAuth "Add to Slack" flow when the app credentials
    are configured (`SLACK_CLIENT_ID`/`SLACK_CLIENT_SECRET`/`SLACK_REDIRECT_URL`),
    with manual bot-token paste always available as a fallback.
  - Notification **routing** (which types post, to which channel) is configured
    **per-workspace**.
  - Optional **@-mentions** are **role- and audience-aware**, not a workspace
    broadcast. The per-account member map tags each member `product` or `engineering`,
    and each notification type mentions a specific audience: requirement-review
    findings ping **product** people **plus the task's creator**, while the engineering
    notifications (merge_review / pipeline_complete / ci_failed) ping **only the task's
    creator**. This adds a `requirement_review` notification type (raised by the
    requirements reviewer when it produces findings) and records a `createdBy` on
    blocks (a new nullable column on both runtimes), captured from the authenticated
    user at task creation.

  New surface: the `slack` contracts, the kernel Slack repository ports, the
  `@cat-factory/integrations` Slack module (`SlackNotificationChannel`,
  `SlackConnectionService`, `SlackSettingsService`, `SlackMemberMappingService`,
  `SlackApiClient`), the shared `SlackController` (+ public OAuth callback) and
  `SlackConfig`, and the orchestration `SlackModule`. Persisted on **both** runtimes:
  the Cloudflare D1 tables (migration `0037_slack.sql`) and the Node Postgres tables
  (Drizzle schema + generated migration), with both facades wiring the channel +
  management module. The cross-runtime conformance suite asserts the routing and
  member-map persistence parity on both stores.

  This change also closes a pre-existing parity gap: the Node/Drizzle facade now has
  a `notifications` table + `DrizzleNotificationRepository` and wires
  `notificationRepository`, so the notification subsystem — and any channel composed
  onto it — fires on the Node runtime exactly as on the Worker.

  Opt-in via `SLACK_ENABLED=true` (requires `ENCRYPTION_KEY`); off by default, so
  unconfigured deployments are unaffected.

- 2dd7e56: Step observability + a discoverable iteration-cap decision.

  - Every pipeline step now carries the `runId` of the run it belongs to, surfaced on
    the step-detail panel (copyable) so a lone step in a log line or view names its run.
    It is a read-time projection (always equals the enclosing run's id), stamped on read
    and on emit; not persisted independently.
  - A step's duration now stops counting once it is terminal OR parked on a human. The
    engine records `pausedAt` when a step parks on an approval / decision / iteration-cap
    gate and clears it when the step resumes or finishes, so elapsed time no longer
    accrues while the run waits for input (the symmetric counterpart of the terminal
    freeze). A step finished directly out of a parked approval is billed to the pause
    instant, not the later human decision.
  - An iterative gate that spends its automatic budget (a quality companion at its rework
    cap, or the requirements reviewer at its iteration cap) now raises a
    `decision_required` notification. Previously the three-choice decision was reachable
    only by drilling into the parked step, so the run looked silently stuck; the inbox
    item now opens that step's decision surface (companion → step detail with the
    iteration-cap prompt; requirements → the review window).

  No DB migration: the step fields ride in the existing execution `detail` JSON, and the
  notification `type` column is free text in both runtimes.

- 5ca8086: Add alternate subscription-backed coding harnesses (Claude Code / Codex) alongside
  the Pi proxy harness.

  - New per-workspace **subscription token pool** (`provider_subscription_tokens`,
    D1 + Postgres, encrypted at rest) with usage-aware rotation, behind a kernel
    port + `ProviderSubscriptionService`, wired into all three runtimes.
  - A guided **LLM Vendors** navbar UI to connect Claude / Codex / GLM (Z.ai) /
    Kimi (Moonshot) / DeepSeek subscription credentials (token pool, write-only).
    GLM / Kimi / DeepSeek all run via Claude Code against the vendor's
    Anthropic-compatible endpoint; the unfiltered credential list covers every vendor.
  - The executor-harness image now bundles the Claude Code and Codex CLIs; the
    harness selects `pi` / `claude-code` / `codex` per job from the model, and the
    subscription harnesses authenticate direct-to-vendor (no proxy) and report token
    usage from the CLI event stream for rotation + telemetry.
  - The model catalog becomes a canonical-model → provider map with precedence
    **subscription > direct > cloudflare** ("subscriptions always win"): latest
    Opus/Sonnet + GPT-5.5/5.4 (subscription-only), GLM-5.2/Kimi gain a Claude-Code
    subscription flavour, and `ModelOption` now carries per-flavour cost, context
    window, and a `quotaBased` flag (subscription usage is flat-rate quota, never
    billed against the spend budget).
  - A block's model is shared by all its pipeline steps, so a pin to a subscription-only
    model (Claude Code / Codex — container-only, no provider key) is degraded to the
    step's env-routing default for every INLINE LLM path through one shared seam
    (`inlineModelRef` / `resolveInlineModelRef`): both the inline agent executor and the
    requirements reviewer/rework, so the inline steps run instead of hard-failing and the
    two paths can't drift. The claude-code subscription harness repairs malformed
    structured output through the vendor's own Anthropic-compatible endpoint (the Pi
    harness still uses the proxy; Codex keeps the graceful no-repair path).
  - Hardening: the per-vendor token pool is capped to bound growth; the leased
    subscription credential is scrubbed from subscription-repair error details (not just
    GitHub-shaped secrets); and Codex token usage is read from its cumulative
    `total_token_usage` so multi-turn runs attribute usage correctly for rotation.

- 7dc8e57: Link integration context at task creation, GitHub issues as a source, and feed
  all linked context to every agent step.

  - **Linked context now reaches every step.** Documents (Confluence / Notion / …)
    and tracker issues (Jira / GitHub) attached to a task were only rendered into the
    prompts of the generic agent kinds — the four standard phases (architect, coder,
    reviewer, tester) silently dropped them, so the agents doing the work never saw
    the linked requirements/issues. The engine already resolves this context per step
    (`ExecutionService.buildAgentContext`); a shared `linkedContextSection` is now
    appended to every kind's user prompt (`@cat-factory/agents`), standard phases
    included.
  - **Attach context when creating a task.** The "Add a task" modal now lets you
    select already-imported documents and issues and links them to the new task on
    creation (previously only possible from the inspector after the fact).
  - **GitHub Issues as a task source.** A new `github` task source reuses the
    workspace's installed GitHub App (no separate credentials): it resolves the
    installation that owns the issue's repo and fetches the issue body + comments via
    the existing `GitHubClient` (new `getIssue`). Refs accept a full issue URL or the
    `owner/repo#number` shorthand. Wired in when `TASK_SOURCES` includes `github` and
    the GitHub integration is enabled.

- cc8d96a: Flesh out the Tester agent, add an agent configuration-contribution mechanism, and
  make Mocker always precede Tester.

  - **Pipelines:** every built-in pipeline that runs a `tester` now runs `mocker`
    immediately before it, so the Tester has its external-dependency mocks up.
  - **Config contribution:** agents (built-in or custom, via the agent registry's new
    `configContributions`) declare task-level config parameters. The union over a
    task's pipeline appears on task creation + the inspector and freezes once the
    contributing agent's step starts. Values persist as a sparse `agentConfig` map on
    the block (keys/values length-capped); the catalog rides the workspace snapshot. The
    Tester contributes its `environment` (local vs ephemeral) and Playwright its e2e
    target (CI vs ephemeral). The old fixed `testTarget` block field is dropped — its
    column is dropped on both runtimes too (no backwards-compat shim).
  - **Tester → Fixer loop:** `tester` is now a container agent that runs the project's
    tests — standing infra up locally via the service's docker-compose (rootless
    Docker-in-Docker in the harness) or against an ephemeral environment — and returns
    a structured report (what was tested, outcomes, concerns, greenlight). On a
    withheld greenlight the engine loops a new dedicated `fixer` agent with the report
    and re-tests, up to the task's merge-preset attempt budget. Only **blocking
    (high/critical)** concerns withhold the greenlight — low/medium are advisory, so a
    trivial nit can't burn the whole fixer budget — and the engine re-applies that rule
    defensively over the report. When the budget is spent (or there's no PR branch to
    fix, or the report is unparseable) the run fails for real (the tester step is left
    un-`done`) and raises a human-actionable `test_failed` notification (retry action),
    mirroring the CI gate. New harness `/test` + `/fix-tests` endpoints; reports + fixer
    summaries render in the inspector and step detail.
  - **Service + provisioning config:** a service frame carries the Tester's
    docker-compose path / "no infra dependencies" toggle (a Tester pipeline can't start
    until one is set), plus a cloud provider and abstract instance size that resolve to
    the concrete instance-type id forwarded to the runner. Per-service sizing applies to
    the self-hosted-pool and local-Docker backends; the Cloudflare Container backend has
    a fixed per-class instance type (`wrangler.toml`) with no per-dispatch override, so
    it ignores the hints (pick `cloudflare` when you don't need per-service sizing).
  - **Account default cloud provider (fully wired):** accounts carry a
    `defaultCloudProvider` new services inherit — persisted on both runtimes, settable
    via `PATCH /accounts/:id` (owner-only) and the account menu, returned on the account
    wire, and pre-filled as the service editor's provider default.
  - **Local mode is 100% Docker/Podman:** a new first-class `docker` cloud provider
    represents the local daemon. The local runner backend sizes each per-job container
    from the abstract instance size (`--memory`/`--cpus`) and runs the Tester job
    `--privileged` so it stands its docker-compose infra up with Docker-in-Docker on the
    host daemon — never Cloudflare. A Tester-only pipeline with no PR branch now fails
    cleanly (no fixer to push to) instead of throwing.
  - Mirrored across both runtimes (D1 migration ⇄ Drizzle schema + migration).

- 3e6a844: Workspace creation/onboarding overhaul: real users, non-GitHub auth, invites,
  named+described boards.

  - **Persistent identity**: a new `users` + `user_identities` model replaces the
    GitHub-numeric-id identity. Memberships, `blocks.created_by`, personal
    subscriptions, and the session payload are all re-keyed to a generated `usr_*`
    id. (BREAKING: pre-existing personal accounts — keyed by GitHub login with a null
    `owner_user_id` — stop matching and a fresh personal account is created on next
    sign-in; old member-mapping rows keyed by GitHub id are orphaned. No migration,
    per the pre-1.0 policy.)
  - **Non-GitHub auth**: email/password (WebCrypto PBKDF2 hashing) and Google OAuth
    login alongside GitHub. New-user creation is invite-only plus an optional
    `AUTH_ALLOWED_EMAIL_DOMAINS` self-signup allowlist (fail-closed). A user without
    a GitHub account works fully — repo access is via the GitHub App, not a user token.
  - **Email invitations**: invite teammates by email into an org account; the invitee
    redeems a tokened link to gain membership. Email is sent via a pluggable
    `EmailSender` (SendGrid / Resend adapters) whose provider + API key are
    **onboarded per-account in the UI and stored sealed in the DB** (not env), like
    the Slack bot token. New tables: `users`, `user_identities`, `account_invitations`,
    `email_connections` (D1 + Drizzle).
  - **Board name + description**: `Workspace.description` end to end (create + edit).
  - **Onboarding discovery**: org members see and open existing org boards from the
    switcher instead of being forced to create one.
  - Slack member-mapping is re-keyed from `githubUserId` to the internal `userId`.

### Patch Changes

- 9d3a956: Clarity reviewer (bug-report triage) + bug investigator: a new bug-fix pipeline front.

  Adds two new agents at the front of a new `pl_bugfix` ("Triage & fix bug") pipeline preset:

  - **`bug-investigator`** — a read-only container agent (it runs the shared `/explore`
    harness path used by `architect`/`analysis`, so no new harness endpoint or image change).
    It clones the repo, reads the codebase from the raw bug report, and returns a prose
    enriched report plus an OPTIONAL working hypothesis — which it omits unless reasonably
    confident, so a low-confidence guess never misdirects the fix. Its output feeds the
    clarity reviewer (the triage subject) and the coder (a non-binding lead, via `priorOutputs`).
  - **`clarity-review`** — an inline engine gate step that triages the bug report for
    _fixability_ (repro steps, expected-vs-actual, environment, affected area), mirroring the
    requirements-review iterative loop (raise findings → answer/dismiss → incorporate into one
    standard-format clarified report → re-review until it converges, with the same per-task
    `maxRequirementIterations` / `maxRequirementConcernAllowed` knobs). The converged clarified
    report substitutes downstream as the task description for the spec-writer/coder (when both
    a requirements and a clarity review exist, the requirements doc wins).

  Persisted as a new `clarity_reviews` table on BOTH runtimes (D1 migration
  `0002_clarity_reviews` + Drizzle migration), wired in both facades' containers with a new
  `clarity` event on the real-time transport and a `clarity_review` notification type. A
  cross-runtime conformance assertion pins the clarified-brief substitution against both
  stores.

- b48c455: Internal cleanup — no behavior or API changes. Deduplicates repeated helpers into
  shared modules: the subtask-snapshot comparison (`sameSubtasks`/`sameSubtaskItems`)
  used by the execution + bootstrap flows now lives in `@cat-factory/kernel`
  (`domain/subtasks.logic`), a `getErrorMessage` helper replaces the repeated
  `error instanceof Error ? error.message : String(error)` expression, the shared
  `STANDARDS_FOOTER` prompt line is centralized in `@cat-factory/agents`
  (`agents/prompt-shared`), and the identical document/task in-memory provider
  registries now extend a generic `MapSourceRegistry` exported from
  `@cat-factory/kernel`.
- 8eed38c: Author relative imports with explicit `.js` extensions across the shared backend
  packages so their emitted `dist` is directly resolvable by Node's ESM loader (no
  bundler required). This lets the Node runtime run the built output on plain Node
  (`node dist/main.js`) — no tsx, no esbuild bundle — and is inert for the Cloudflare
  Worker (wrangler bundles regardless). `handlebars/runtime` is imported as
  `handlebars/runtime.js` for the same reason (its type is sourced from the full
  package, type-only). No behaviour or public-API change.
- 4030da2: Fix a 500 when flagging a repo as a monorepo while adding it as an existing
  service. The add-service flow flips the monorepo toggle (and browses the tree)
  before the repo is linked to the workspace, but `setRepoMonorepo` /
  `listRepoDirectory` threw `Repo … is not linked` for an untracked repo. Both now
  lazily link the repo via `linkRepo` first, throwing only when the repo isn't
  accessible to the installation.
- 157cd02: Standardize the executor-harness job API on a single `POST /jobs` endpoint with the
  agent kind carried in the request body, instead of one route per kind (`/run`,
  `/bootstrap`, `/merge`, …).

  Breaking wire change between the runtime transports and the harness image (acceptable
  pre-1.0: the two ship together, no external consumers). The old per-kind-route image
  is incompatible with the new transports, so the runner image MUST be republished and
  deployed.

  - Harness: `server.ts` is now table-driven — one `KINDS` registry keyed by kind drives
    a single `POST /jobs` dispatcher (reads the body's `kind` to pick the validator +
    registry) and a single `GET /jobs/{id}` poll. Adding an agent kind is one table
    entry, not a new endpoint + registry global + poll-chain branch. Bumps the runner
    image tag (1.7.2 -> 1.7.3) in `deploy/backend` (`image:publish` + wrangler.toml).
  - Harness: the explore job's temp-dir/log label field is renamed `kind` -> `label` so
    it no longer collides with the reserved dispatch discriminator `kind`.
  - Server: `ContainerAgentExecutor` stamps the kind into the dispatch body (the explore
    body now sends `label` for its agent-kind label).
  - Worker + local-server transports POST `{ ...spec, kind }` to `/jobs`;
    `LocalDockerRunnerTransport` drops its `KIND_ROUTE` map. The self-hosted pool already
    forwards `kind` in the spec, so it needs no code change — only the manifest docs
    (kernel/contracts/integrations) are updated to note the harness routes by the body's
    `kind`.

- Updated dependencies [fe53445]
- Updated dependencies [d94e75c]
- Updated dependencies [6406c8c]
- Updated dependencies [3d9a9d8]
- Updated dependencies [db77061]
- Updated dependencies [a48c620]
- Updated dependencies [3bc8c79]
- Updated dependencies [9d3a956]
- Updated dependencies [8d11833]
- Updated dependencies [ad9ba9e]
- Updated dependencies [3e0d753]
- Updated dependencies [f83ffd7]
- Updated dependencies [8065fed]
- Updated dependencies [385bd93]
- Updated dependencies [e50e78a]
- Updated dependencies [0972696]
- Updated dependencies [b48c455]
- Updated dependencies [e9b9356]
- Updated dependencies [e8005ba]
- Updated dependencies [3a12f15]
- Updated dependencies [b40da13]
- Updated dependencies [3a12f15]
- Updated dependencies [8eed38c]
- Updated dependencies [084bf43]
- Updated dependencies [268c15d]
- Updated dependencies [157cd02]
- Updated dependencies [7c37653]
- Updated dependencies [db77061]
- Updated dependencies [6406c8c]
- Updated dependencies [57d70fa]
- Updated dependencies [6406c8c]
- Updated dependencies [918764f]
- Updated dependencies [918764f]
- Updated dependencies [88b3170]
- Updated dependencies [fe0b7f8]
- Updated dependencies [f73652c]
- Updated dependencies [db336b1]
- Updated dependencies [8807f5c]
- Updated dependencies [9be11e1]
- Updated dependencies [5ec0d25]
- Updated dependencies [a691853]
- Updated dependencies [f066c59]
- Updated dependencies [4a08935]
- Updated dependencies [70e8ef0]
- Updated dependencies [70e8ef0]
- Updated dependencies [70e8ef0]
- Updated dependencies [70e8ef0]
- Updated dependencies [70e8ef0]
- Updated dependencies [70e8ef0]
- Updated dependencies [70e8ef0]
- Updated dependencies [b287996]
- Updated dependencies [b156b4b]
- Updated dependencies [5c8ca33]
- Updated dependencies [b156b4b]
- Updated dependencies [7cf2a2d]
- Updated dependencies [2d66d34]
- Updated dependencies [197264e]
- Updated dependencies [3a12f15]
- Updated dependencies [37baa7f]
- Updated dependencies [c664fe6]
- Updated dependencies [553a67d]
- Updated dependencies [311a110]
- Updated dependencies [f16ae62]
- Updated dependencies [36018cb]
- Updated dependencies [799be66]
- Updated dependencies [d65c979]
- Updated dependencies [75a0441]
- Updated dependencies [7157fd7]
- Updated dependencies [21ca647]
- Updated dependencies [c4ef995]
- Updated dependencies [8eed95b]
- Updated dependencies [0b38aa6]
- Updated dependencies [a97e485]
- Updated dependencies [de5a9d7]
- Updated dependencies [f647733]
- Updated dependencies [d5e9141]
- Updated dependencies [2d66d34]
- Updated dependencies [a54ada2]
- Updated dependencies [2dd7e56]
- Updated dependencies [5ca8086]
- Updated dependencies [d0697d1]
- Updated dependencies [0090313]
- Updated dependencies [7dc8e57]
- Updated dependencies [cc8d96a]
- Updated dependencies [7c37653]
- Updated dependencies [43f2443]
- Updated dependencies [acac735]
- Updated dependencies [3841315]
- Updated dependencies [48d2f0d]
- Updated dependencies [3e6a844]
  - @cat-factory/contracts@0.7.0
  - @cat-factory/kernel@0.7.0
