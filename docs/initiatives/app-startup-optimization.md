# Initiative: app startup time reduction

**Status:** proposed — analysis complete, no slices landed yet · **Owner:** core · **Started:** 2026-07-14

> This is the durable source of truth for a multi-PR initiative. Read it first before
> picking up the next slice; update the checklist at the end of each PR.

## Goal & rationale

A startup-path audit across every surface of the product found a bounded set of avoidable
costs between "launch" and "usable". This tracker prioritizes them. "Startup" here means
four distinct clocks, each with its own owner and its own fix shapes:

- **A — Node/local backend boot**: process launch → the HTTP listener accepting requests
  (`backend/runtimes/node/src/server.ts` `bootServer`, reused by local mode).
- **B — Cloudflare Worker cold start + per-request assembly**: isolate cold start (module
  graph parse) and the `buildContainer(c.env)` run on **every request**.
- **C — Frontend SPA cold open**: first paint → a live, connected board
  (`ssr: false`, so everything happens client-side after the bundle loads).
- **D — agent-run start latency** (adjacent): "start a run" → the first visible agent
  progress. Not app boot strictly, but the user experiences it as "the app is slow to
  start working", and the audit surfaced one outsized, trivially-fixable contributor.

The boot paths are already deliberately shaped in several places — sweepers start after
the listener binds, the local Docker image pull is fire-and-forget, ioredis is dynamically
imported, ~40 frontend panels are lazy-split, and the workspace snapshot endpoint
assembles ~18 reads in one `Promise.all`. So, like the sibling
[`performance-optimizations.md`](./performance-optimizations.md) initiative (runtime
hot-path perf — deliberately disjoint scope from this one), this is NOT a rewrite: it is
a punch list of the places that deviate from the paths' own good patterns, plus a
measurement item so the wins are provable.

Prioritization:

- **P1** — clear win, low risk, paid on every startup of that surface.
- **P2** — real win needing moderate care (ordering/coherence/semantics).
- **P3** — bounded win, or needs a design decision / measurement before code.

## Baseline & measurement (do item 1 first)

**There is no boot instrumentation today.** The only boot log markers are the
`"… listening"` lines (`backend/runtimes/node/src/server.ts:158`, `:193`); nothing times
migrate / `boss.start()` / worker registration / listen, and nothing on the frontend
times auth → snapshot → connected. Land item 1 before (or alongside) the first
optimization slice so every later slice can state its before/after honestly. Cheap
proxies that already exist: the e2e suite's `webServer` boot (a full real Node boot per
run) and Playwright traces for the SPA cold-open waterfall.

## Target patterns (copy these, don't invent)

- **Parallel waves for independent boot awaits**: group by true data dependency, then
  `Promise.all` each wave — the same shape `buildJobBody` landed in
  performance-optimizations item 4. The five pg-boss worker startups are the canonical
  application here.
- **Fire-and-forget for diagnostics**: boot probes that only WARN (never gate
  correctness) follow `preflightHarnessImage`
  (`backend/runtimes/local/src/server.ts:137`) — `void probe().catch(() => {})`, never an
  awaited stall on the boot path. Log when the probe resolves, not before listen.
- **Poll-first durable loops**: the bootstrap / env-test / env-config-repair runners poll
  THEN sleep (`backend/runtimes/node/src/execution/bootstrapRunner.ts:56-59`); the main
  execution drivers sleep first. Copy the poll-first shape.
- **Per-isolate memoization keyed on `env`**: `modelResolverCache`
  (`backend/runtimes/cloudflare/src/infrastructure/container.ts:309`) is the blessed
  precedent for caching deterministic-per-`env` construction across requests in one
  isolate.
- **Snapshot-carried readiness over extra probes**: the workspace snapshot already
  aggregates ~18 parallel reads (`WorkspaceController`); a cheap per-workspace fact the
  SPA needs before first paint belongs in it, not in a separate blocking round-trip.
- **Frontend live-push changes obey the coherence rules** (CLAUDE.md "Real-time
  store coherence"): monotonic refresh guard, resync-before-`connected`, REPLACE-hydrates
  never dropping live-only state, store-level unit test pinning any new ordering.

## Per-item checklist

| #   | Pri | Area          | Finding (short)                                                                                    | Status  | PR  |
| --- | --- | ------------- | -------------------------------------------------------------------------------------------------- | ------- | --- |
| 1   | P1  | observability | No boot-phase timing anywhere (backend or SPA) — add phase timers + "ready in N ms"               | ⬜ todo |     |
| 2   | P1  | node boot     | Five pg-boss worker startups awaited serially (~10 round trips) before listen                      | ⬜ todo |     |
| 3   | P1  | frontend      | Full workspace snapshot fetched TWICE per cold board open (init + on-connect resync)               | ⬜ todo |     |
| 4   | P1  | run start     | Execution drivers sleep a full 15s poll interval BEFORE the first poll                             | ⬜ todo |     |
| 5   | P2  | node boot     | `warnIfRedisUnreachable` awaited serially — up to ~3.5s stall when Redis is set but down           | ⬜ todo |     |
| 6   | P2  | local boot    | GitHub PAT probe awaited on the boot path (network hop to github.com before listen)               | ⬜ todo |     |
| 7   | P2  | frontend      | GitHub probe blocks first board paint; availability could ride the snapshot                        | ⬜ todo |     |
| 8   | P2  | frontend      | 3-deep critical-path waterfall: auth → listWorkspaces → snapshot                                   | ⬜ todo |     |
| 9   | P2  | worker        | `buildContainer` + `createAppCaches` + registries rebuilt on EVERY request                         | ⬜ todo |     |
| 10  | P3  | node boot     | `migrate()` spends ~5-6 serialized round trips per boot even when the DB is current               | ⬜ todo |     |
| 11  | P3  | node boot     | Start pg-boss workers after listen? (design decision — documented invariant says before)           | ⬜ todo |     |
| 12  | P3  | frontend      | Duplicate `github.probe()` + 6-probe SideBar fan-out on open                                       | ⬜ todo |     |
| 13  | P3  | frontend      | Non-`en` users pay an awaited locale-catalog fetch in the boot plugin                              | ⬜ todo |     |
| 14  | P3  | frontend      | Bundle: Vue Flow + 3 stylesheets eager; markdown-it likely in the initial chunk (measure first)    | ⬜ todo |     |
| 15  | P3  | worker        | Isolate cold-start parse weight (~250-import container graph; opt-in integrations eager)           | ⬜ todo |     |
| 16  | P3  | run start     | No container pre-warm on Cloudflare; local warm pool defaults off (design decision)                | ⬜ todo |     |

## Detailed findings

### 1. No boot instrumentation — P1 (prerequisite)

Nothing times the boot phases on any surface. Backend: add cheap `performance.now()`
brackets around the `bootServer` phases (config load, `migrate`, `boss.start`, worker
registration, listen) and log one structured `"ready"` line with per-phase millis —
mirrored in local mode's `bootLocal` additions (runtime preflight, PAT probe). Frontend:
mark the cold-open milestones (auth ready → workspaces listed → snapshot hydrated →
stream `connected`) via `performance.mark`/`measure` so the waterfall is visible in
traces. This is the honesty baseline every later slice reports against; without it we're
guessing which seconds matter.

### 2. Serial pg-boss worker startups — P1

`backend/runtimes/node/src/server.ts:390-413` awaits `startExecutionWorker` →
`startBootstrapWorker` → `startEnvConfigRepairWorker` → `startEnvTestWorker` →
`startGitHubSyncWorker` strictly in sequence. Each is `boss.createQueue(name)` +
`boss.work(name)` — two DB round trips (e.g.
`backend/runtimes/node/src/execution/pgBossRunner.ts:148-149`) — so the chain is ~10
serialized round trips against an already-started boss, all before the listener binds.
The queues are per-name and mutually independent; there is no ordering dependency.

**Fix:** wrap the five in one `Promise.all` wave (the `buildJobBody` pattern). Keep the
wave AFTER `boss.start()` and BEFORE listen (the documented "an enqueued job always has a
consumer" invariant, `server.ts:433-436` — revisiting that ordering is item 11, not this
slice). ~10 round trips → ~2.

### 3. Double snapshot fetch per cold board open — P1

On a cold open the SPA fetches the full workspace snapshot **twice**:

1. `workspace.init()` → `resolveActiveBoard()` → `api.getWorkspace(id)`
   (`frontend/app/app/stores/workspace.ts:158-203`).
2. Then `stream.start()` connects the WebSocket, and `onopen` runs the
   resync-before-`connected` refresh — `refreshWithRetry(workspaceId)` → a second full
   `api.getWorkspace(id)` (`frontend/app/app/composables/useWorkspaceStream.ts:181-212`).

The resync design is correct and deliberate (reconcile anything missed while
disconnected before announcing `connected` — see the long comment there and CLAUDE.md's
coherence rules). But on a **first** connect immediately following the initial load,
nothing can have been missed that the resync's own fetch wouldn't equally capture — the
heaviest payload in the app (the ~18-read aggregate) is simply paid twice, back to back.

**Fix (design carefully, coherence rules apply):** make the on-connect resync BE the
initial load. Shape: `init()` resolves the target workspace id (list/create as today)
but skips the eager `getWorkspace`; the stream connects first and its existing
resync-then-`connected` path performs the one snapshot fetch that hydrates the board.
Alternatively, keep the eager fetch and let the FIRST `onopen` skip its refresh when the
socket opened before the init fetch committed... — the first shape is cleaner (one code
path, resync semantics unchanged for genuine REconnects). Must keep: monotonic refresh
guard, `connected` only after hydrate settles, provisional-state reconcile. Ship with a
store-level unit test pinning the single-fetch cold open AND that a genuine reconnect
still refreshes. The e2e suite gates on `data-connected`, so it is the regression guard;
a flake after this change is a blocking bug (CLAUDE.md).

### 4. Leading 15s sleep before the first execution poll — P1

Both durable drivers sleep a full poll interval BEFORE the first poll of a dispatched
container job:

- Cloudflare: `ExecutionWorkflow.ts:102-103` — `await step.sleep(..., jobPollInterval)`
  then `poll()`.
- Node/orchestration: `backend/packages/orchestration/src/modules/execution/drive.ts:91-95`
  — `await sleep(intervalMs)` then `poll()`.

`jobPollInterval` defaults to **15 seconds** (`config/execution.ts:17-18` ⇄ Node
`execution/config.ts:51`), so every step dispatch shows up to ~15s of dead air between
"job accepted" and the first `running`/subtask state reaching the board — independent of
how fast the container actually started. The sibling runners already do this right:
bootstrap / env-test / env-config-repair poll FIRST, then sleep
(`bootstrapRunner.ts:56-59`, `envTestRunner.ts:53-56`, `envConfigRepairRunner.ts:56-59`).

**Fix:** flip the main drivers to poll-first (or a short fixed first-poll delay, e.g.
1-2s, if an immediate poll proves always-empty), in BOTH drivers in the same slice (the
runtimes-symmetric rule applies to the driver pair even though they're different
substrates). The e2e backend already runs at `JOB_POLL_INTERVAL=1 second`, so e2e won't
see the difference — assert the poll-first ordering in the driver unit tests.

### 5. Redis reachability probe stalls boot — P2

`backend/runtimes/node/src/server.ts:377` awaits `warnIfRedisUnreachable(env, logger)`
sequentially. The probe is diagnostics-only (one WARN log; ioredis retries in the
background regardless — `backend/runtimes/node/src/redisProbe.ts`), yet when `REDIS_URL`
is set and the bus is down it holds boot for its full bound (3s probe + 500ms guard,
`redisProbe.ts:22,129`) — precisely the degraded scenario where you want the replica
serving sooner, not later.

**Fix:** run it fire-and-forget (`void warnIfRedisUnreachable(...)`, the
`preflightHarnessImage` pattern) or start it before the worker wave and only `await` it
after listen. The warning must still fire exactly once and must not be lost on early
process exit in tests — keep its existing unit tests green and add one pinning that boot
does not block on the probe.

### 6. Local mode: awaited GitHub PAT probe on the boot path — P2

`backend/runtimes/local/src/server.ts:149-162` awaits `probeGitHubPat(localized)` — a
real network round-trip to github.com — before `start()` runs, whenever a `GITHUB_PAT`
is configured (i.e. every properly-configured local install). It is best-effort
diagnostics (invalid/expired-PAT warning; timeout returns undefined), so it can overlap
the whole Node boot instead of preceding it. The runtime `--version` preflight
(`server.ts:342`, 10s exec ceiling) stays awaited — its result gates real behaviour
(adapter capabilities / limited mode), and on a healthy host it is tens of ms.

**Fix:** fire-and-forget the PAT probe (log on resolution), same guardrails as item 5.

### 7. GitHub probe blocks first board paint — P2

`frontend/app/app/pages/index.vue:250-261,307-314`: the board render is gated on
`githubProbePending` (`github.available === null`) — a spinner holds the whole viewport
until `GET /workspaces/:ws/github/connection` resolves, putting one more round-trip on
the critical path after the snapshot. The gate exists so an unconnected user lands on
the onboarding screen rather than a flash of empty board.

**Fix:** carry GitHub availability/connection state in the workspace snapshot (which
already aggregates ~18 reads in one `Promise.all` — one more cheap read is the
snapshot-carried-readiness pattern), hydrate the `github` store from it, and keep
`github.probe()` for later re-checks. First paint then needs zero extra round-trips and
the onboarding gate still can't be slipped past. Wire-shape addition to the snapshot
contract — pre-1.0, no shim needed; land contracts + backend + SPA together.

### 8. Cold-open critical-path waterfall — P2

The cold open is a 3-deep sequential chain before the board can hydrate:
`auth.bootstrap()` (`getAuthConfig`, + `getMe` when a token is persisted —
`frontend/app/app/stores/auth.ts:182-216`, gating ALL rendering via `AuthGate.vue`) →
`workspace.init()`'s `listWorkspaces` → `getWorkspace(id)` snapshot
(`stores/workspace.ts:158-203`). Yet ~"which board" is usually already known: the
persisted `workspaceId` is read from localStorage before any request fires.

**Fix directions (pick during the slice, they compose):** (a) when a persisted
`workspaceId` exists, fire the snapshot fetch speculatively in parallel with
`listWorkspaces` and validate membership after both resolve (fall back to today's path
when the persisted board is gone); (b) start `workspace.init()` concurrently with the
`getMe` leg of auth bootstrap instead of after `auth.ready` (requests already carry the
token; a 401 falls back to the login screen exactly as today). Combines with item 3 —
design the two together so the "one snapshot per cold open" invariant holds in both.

### 9. Worker: full container rebuild per request — P2

`backend/runtimes/cloudflare/src/app.ts:85-93` runs `buildContainer(c.env, ...)` in
middleware on **every request**: `loadConfig` parse, binding checks, a fresh
`createAppCaches` bag (`container.ts:2060`), fresh registries, and `createCore`'s ~40
service constructions (`container.ts:2014-2457`). All of it is deterministic given
`env`; only `modelResolverCache` (`container.ts:309-355`) is memoized across requests
today. Rebuilding the caches bag per request also silently caps every enabled cache
slice's hit-rate at one request's lifetime.

**Fix:** extend the `modelResolverCache` precedent — memoize the env-deterministic core
of the container per-isolate in a `WeakMap<Env, …>` (config, caches bag, registries,
possibly the whole `ServerContainer`), keeping anything request-scoped out of the memo.
Needs care: audit for state that must NOT outlive a request (per-request `executionCtx`,
`waitUntil` capture) before widening the memo; the isolate-safe caches profile already
assumes isolate lifetime, so a longer-lived bag is semantically what that profile was
designed for. Measure with item 1-style timing in a canary before/after.

### 10. `migrate()` round-trips on every boot — P3

`backend/runtimes/node/src/db/migrate.ts:282-323` runs on every boot: pool connect →
`pg_advisory_lock` → `assertSchemaConsistent` (2-3 queries: ledger `to_regclass`, ledger
count, anchor-table probe) → drizzle migrator (ledger read) → unlock — ~5-6 serialized
round trips even when there is nothing to apply. Correct and deliberate (drift guard +
concurrent-replica lock), and small in absolute terms on a local Postgres; it matters
mainly on high-RTT managed databases.

**Fix (only if item 1's numbers say it matters):** collapse the consistency probe into
one round trip (a single SQL statement returning ledger-exists + count + anchor regclass
columns). Do NOT weaken the guard semantics or the advisory lock; the drift-guard
behaviour is load-bearing (see CLAUDE.md "Migration safety"). Skipping `migrate()`
entirely on a "current" fast-path is explicitly rejected — the ledger read IS the
fast-path, and any shortcut re-opens the ledger↔schema-split window the guard exists
to close.

### 11. Workers-before-listen ordering — P3 (design decision)

`server.ts:433-436` documents the current invariant: pg-boss workers register before the
listener binds "so an enqueued job always has a consumer". Jobs are durable (a consumer
registering 200ms after a request enqueues would pick the job up anyway), so listen
could plausibly move before the worker wave, shaving the wave off time-to-first-response
— but the invariant is deliberate, `/ready` already gates load-balancer traffic
separately from listen, and item 2 shrinks the wave to ~2 round trips anyway. Decide
explicitly (short design note in the PR) whether the reordering is worth loosening a
documented invariant; rejecting it is an acceptable outcome — record the rejection here.

### 12. Duplicate + fan-out probes on board open — P3

`github.probe()` fires from both `pages/index.vue:250-256` and `SideBar.vue:99-111` (the
duplicate is acknowledged as idempotent, but it is still a second network call), and the
SideBar fans out 5 more probes (`documents.probe`, `tasks.probe`, `slack.probe`,
`library.probe`, `providerConnections.ensureLoaded`) per board open. None block paint
(unlike item 7), so this is cleanup: give probes single-flight `ensureLoaded` semantics
keyed by workspace id (several stores already have the shape), and fold the cheapest
booleans into the snapshot where item 7 sets the precedent.

### 13. Non-`en` locale catalog awaited at boot — P3

`frontend/app/app/plugins/locale.client.ts:15-19` `await`s `i18n.setLocale(stored)` for
users with a persisted non-default locale — one extra catalog chunk fetch inside the boot
plugin, before anything renders. Lazy per-locale loading itself is right (10 locales,
only the active one loads). Options: preload the persisted locale's chunk via a
`<link rel="preload">`/parallel fetch so the await is warm, or apply the locale
non-blocking and accept a brief en-flash (worse UX — probably reject). Small, bounded;
measure the chunk size before bothering.

### 14. Initial bundle weight — P3 (measure first)

The audit found the SPA already well split (~40 async panels/modals in
`pages/index.vue:27-126`). What is eager: `@vue-flow/core` + 3 vue-flow stylesheets
(global CSS in `nuxt.config.ts:82-87`, static import in the always-mounted
`BoardCanvas.vue`) — defensible, the board IS the app's first view — and probably
`markdown-it` via eagerly-imported inspector/step-prose paths. No bundle-size
measurement exists in CI. **Fix:** add a one-off bundle analysis (rollup visualizer) to
establish the actual chunk composition; then decide whether anything (markdown-it path,
rarely-used eager components) is worth deferring. Don't blind-defer Vue Flow.

### 15. Worker isolate cold-start parse weight — P3 (measure first)

The Cloudflare facade's import graph is the heaviest in the repo
(`infrastructure/container.ts` ~250 imports pulling every D1 repo + all integrations +
gates + gitlab + consensus + langfuse; `registerBuiltinGates()` runs as an import side
effect — cheap Map inserts, but the graph weight itself is the cold-start parse cost).
Fix directions IF measurement shows isolate cold start matters in practice: dynamic
import for genuinely opt-in integrations (the ioredis opaque-specifier pattern), or
accept — Workers cold starts are already rare per-isolate events. Do not restructure the
registration seams for this; the side-effect-import registration model is a deliberate
public seam.

### 16. Container pre-warm / warm pools — P3 (design decision)

Every Cloudflare run cold-starts a fresh container (no `min_instances` in
`deploy/backend/wrangler.toml` `[[containers]]`; `sleepAfter = '10m'` in
`ExecutionContainer.ts:36-48`) — image fetch on a cold edge + boot + rootless dockerd
spawn + node server before `/health` answers. Local mode HAS the mitigation (an opt-in
warm pool with repo-affinity leasing, `LocalContainerRunnerTransport.ts:316-698`) but
defaults it off (`poolSize = 0`). Both are cost/complexity trade-offs, not defects:
pre-warmed Cloudflare instances bill while idle; a default-on local pool holds
containers + disk on a dev machine. Decide deliberately (per-surface), with the dispatch
→ first-progress timing from item 1/item 4 in hand — item 4 may already remove most of
the *perceived* gap, making this not worth its cost.

## Conventions & gotchas (carry between slices)

- **Measure first, claim second.** Item 1 lands before or with the first optimization
  slice; every slice's PR states the before/after from real timings, not vibes.
- **Deliberate orderings are load-bearing.** `migrate()` → `boss.start()` stays
  sequential (documented debuggability rationale, `server.ts:307-315`); sweepers stay
  after listen; the local runtime `--version` preflight stays awaited (gates limited
  mode). Don't "optimize" these; items 10/11 record where a documented rationale must be
  revisited explicitly instead of silently.
- **Fire-and-forget probes must stay observable**: a deferred diagnostic still logs
  exactly once, still never throws, and gets a unit test pinning "boot does not await
  it". Copy `preflightHarnessImage`.
- **Frontend slices (3, 7, 8) are coherence-sensitive.** The live-push rules in CLAUDE.md
  are the contract: monotonic refresh guard, `connected` only after reconcile,
  REPLACE-hydrate never dropping live-only state. Every ordering change ships a
  store-level unit test; the e2e suite is the guard and a post-change flake is a
  blocking bug, never a retry.
- **Snapshot contract additions (item 7) are breaking-OK** — pre-1.0, no shims; land
  contracts + backend + SPA together, flag in the changeset.
- **Driver changes land in BOTH runtimes** (item 4: `ExecutionWorkflow` ⇄ `drive.ts`),
  per "Keep the runtimes symmetric" — the substrates differ but the loop shape must not.
- **The executor-harness image is out of scope** (see below); nothing in this initiative
  may touch `backend/internal/executor-harness` — an image change is separate,
  deliberate, image-tag-bumping work (CLAUDE.md release rules).
- Changeset per slice for versioned packages; empty changeset for doc-only tracker
  updates. Format the whole tree (`pnpm exec oxfmt .`), never a subset.

## Suggested slicing (PR-sized)

1. Item 1 (boot + cold-open instrumentation) — the baseline everything else reports
   against.
2. Item 2 + item 5 (+ item 6, same shape) as one "Node/local boot de-serialization" PR.
3. Item 4 (poll-first drivers, both runtimes) — biggest perceived run-start win.
4. Item 7 (snapshot-carried GitHub state) — unblocks first paint; sets the pattern
   item 12 reuses.
5. Item 3 (single-snapshot cold open) — after 7, with the store unit tests; highest
   coherence risk in the initiative, treat e2e as the gate.
6. Item 8 (waterfall flattening) — designed together with 3.
7. Item 9 (Worker per-isolate memoization) — with canary timing.
8. Items 10-16 as measurement/decision follow-ups, each with a short design note; record
   explicit rejections in this tracker rather than leaving rows open forever.

## Out of scope

- **The executor-harness image** — the DinD stack (Docker CE CLI + rootless-extras +
  fuse-overlayfs) baked into every agent image, the three bundled agent CLIs, and the
  rootless `dockerd` spawned on every container boot (`entrypoint.sh:16-28`) are real
  cold-start weight, but dependency/runtime changes there are deliberate, image-bumping
  work with their own release mechanics — a future initiative of its own if item 1's
  numbers justify it.
- **Runtime hot-path performance** — snapshot payload slimming, board event granularity,
  N+1s, cache slices: that is [`performance-optimizations.md`](./performance-optimizations.md)
  (its items 5/6 will incidentally shrink the cold-open payload this tracker's items 3/8
  fetch — coordinate, don't duplicate).
- **Replacing Vue Flow / board virtualization** — bundle work here stops at measurement
  + cheap deferrals (item 14).
- **CI/build pipeline speed** (turbo caching, test runtime) — developer-loop time, not
  app startup.
