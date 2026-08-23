# Initiative: performance optimizations (prioritized)

**Status:** in progress; items 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 21, 23, 25, 26, 27, 28, 29, 30 landed (20 partly) (emit metrics rollup · gate-poll GitHub reads · live-run projection · parallel dispatch waves · targeted board events · spend/workspace-settings/account-settings cache slices · GitHub-sync + fan-out-publisher parallelism · reuse-the-loaded-list batch across autoStart/initiative-spawn/blueprint-reconcile/block-delete · agent-context single frame-walk + parallel wave · password-reset-token expiry index · risk-policy merge-preset cache slice · board RAF loops driven by an activity pulse · per-block execution index · shared lane derivations with structural sharing · the one refresh funnel · the lean board-snapshot execution projection with its by-id read · bounded observability/kaizen caches · a shallow `execution.instances` · the store/composable hygiene group) · frontend deep re-audit 2026-08-14, after the task-swimlanes rework (#1777): items 5/10/19/20 re-verified and refreshed, PR links backfilled, items 25-30 added · **Owner:** core · **Started:** 2026-07-09

> This is the durable source of truth for a multi-PR initiative. Read it first before
> picking up the next slice; update the checklist at the end of each PR.

## Goal & rationale

A codebase-wide performance audit (service layer, persistence, execution-engine hot loops,
frontend, dispatch/gateway paths) surfaced a bounded set of verified inefficiencies. The
codebase is already unusually well-optimized (batched `IN` reads, SQL aggregates,
`Promise.all` snapshot assembly, CAS-guarded per-poll writes, delta-stored prompt telemetry
are the norm), so this initiative is NOT a rewrite; it is a prioritized punch list of the
places that deviate from the repo's own rules (N+1 ban, caching seam, batch-or-reuse) or
that put avoidable work on the hottest paths.

Prioritization is **hotness × scaling**:

- **P1**: on a hot loop (per poll tick, per emit, per LLM call, per dispatch, per board
  event) AND cost grows unbounded with data (run history, LLM calls per run, board size).
- **P2**: hot-ish (per dispatch / per sync / per event) or a rule violation with a
  correctness edge (banned homebrew caches → multi-replica staleness).
- **P3**: real but bounded; cold paths, small tables, or fixes needing a design decision.

Each row below is a self-contained slice: most are one small PR; a few frontend ones can
be grouped. Every persistence change lands on BOTH runtimes (D1 migration ⇄ Drizzle
schema + `pnpm db:generate`) with a conformance assertion, per "Keep the runtimes
symmetric" (CLAUDE.md).

## Target patterns (copy these, don't invent)

- **Projected/batched port method** instead of `SELECT *` + JS filter: copy
  `ServiceRepository.listByIds` / `WorkspaceMountRepository.countByServiceIds`. Add the
  narrow method to the kernel port, implement in BOTH `D1*Repository` and the Drizzle
  repo, assert in the conformance suite.
- **AppCaches slice** for slow-moving reads: copy `repoProjection` / `accountModelPolicy`
  (`backend/packages/caching/src/appCaches.ts`). Register on the kernel `AppCaches`
  interface + both profiles, read through `caches.slice.get(key, group, load)`,
  invalidate on every write, pass-through (`enabled: false`) in
  `ISOLATE_SAFE_APP_CACHES_PROFILE` for our own mutable DB state. Full model:
  [`caching-layer.md`](./caching-layer.md).
- **Parallel waves** for independent awaits: group by true data dependency, then
  `Promise.all` each wave (see item 4's dependency analysis).
- **Reuse the already-fetched list**: thread a loaded block list / pipeline catalog into
  the loop body instead of re-reading per iteration (CLAUDE.md "No N+1").

## Per-item checklist

| #   | Pri | Area         | Finding (short)                                                                                                                     | Status  | PR                                                          |
| --- | --- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------- | ------- | ----------------------------------------------------------- |
| 1   | P1  | engine       | `emitInstance` runs LLM-metrics GROUP BY on every emit (incl. progress ticks)                                                       | ✅ done | [#1002](https://github.com/kibertoad/cat-factory/pull/1002) |
| 2   | P1  | gateways     | Gate polls: uncached `repoId()` + PAT re-resolved per `request()` + `listCommits` head lookup                                       | ✅ done | [#993](https://github.com/kibertoad/cat-factory/pull/993)   |
| 3   | P1  | persistence  | Execution lists `SELECT *` (incl. `detail` JSON) + JS status filter on dispatch guard; missing `(workspace_id, kind, status)` index | ✅ done | [#996](https://github.com/kibertoad/cat-factory/pull/996)   |
| 4   | P1  | dispatch     | `buildJobBody` serializes ~6 independent I/O steps per dispatch                                                                     | ✅ done | [#1051](https://github.com/kibertoad/cat-factory/pull/1051) |
| 5   | P1  | frontend     | Board snapshot embeds full step outputs the board never reads (re-verified 2026-08-14: unstarted, refs refreshed)                   | ✅ done | this PR                                                     |
| 6   | P1  | frontend     | Coarse `board` event forces full-snapshot refresh; payload already carries `blockId`                                                | ✅ done | [#1759](https://github.com/kibertoad/cat-factory/pull/1759) |
| 7   | P2  | caching      | `SpendService` three banned TTL `Map`s (pricing / account / user limits)                                                            | ✅ done | [#1060](https://github.com/kibertoad/cat-factory/pull/1060) |
| 8   | P2  | caching      | `AccountSettingsService` legacy 30s `Map` (the named anti-pattern)                                                                  | ✅ done | [#1068](https://github.com/kibertoad/cat-factory/pull/1068) |
| 9   | P2  | caching      | `WorkspaceSettingsService.get` uncached; read per recorded LLM call                                                                 | ✅ done | [#1060](https://github.com/kibertoad/cat-factory/pull/1060) |
| 10  | P2  | frontend     | One event re-classifies + re-sorts every frame's swimlanes; no structural sharing (rewritten post-#1777)                            | ✅ done | [#2023](https://github.com/kibertoad/cat-factory/pull/2023) |
| 11  | P2  | frontend     | Two unconditional 60fps RAF loops doing DOM measurement while idle                                                                  | ✅ done | [#1914](https://github.com/kibertoad/cat-factory/pull/1914) |
| 12  | P2  | integrations | `GitHubSyncService`: serial per-workspace fan-out + serial resource syncs                                                           | ✅ done | [#1085](https://github.com/kibertoad/cat-factory/pull/1085) |
| 13  | P2  | engine       | `AgentContextBuilder` re-walks block ancestry per resolver, sequentially                                                            | ✅ done | [#1143](https://github.com/kibertoad/cat-factory/pull/1143) |
| 14  | P2  | events       | `FanOutEventPublisher` forwards to N mounted workspaces serially                                                                    | ✅ done | [#1085](https://github.com/kibertoad/cat-factory/pull/1085) |
| 15  | P3  | engine       | `autoStartDependents`: per-dependent pipeline point-read in loop                                                                    | ✅ done | [#1078](https://github.com/kibertoad/cat-factory/pull/1078) |
| 16  | P3  | engine       | `InitiativeLoopService.spawnItem`: per-item pipeline point-read in loop                                                             | ✅ done | [#1078](https://github.com/kibertoad/cat-factory/pull/1078) |
| 17  | P3  | board        | `BoardScanService` reconcile: `addModule` re-lists whole board per module                                                           | ✅ done | [#1078](https://github.com/kibertoad/cat-factory/pull/1078) |
| 18  | P3  | board        | Block delete: teardown + remove each re-list the whole board                                                                        | ✅ done | [#1078](https://github.com/kibertoad/cat-factory/pull/1078) |
| 19  | P3  | persistence  | `notifications.listOpen` unbounded `SELECT *` (body+payload) on snapshot                                                            | ⬜ todo |                                                             |
| 20  | P3  | frontend     | Hydrate stringify (now WeakMap-cached), gate-map rebuilds per event, no viewport culling, z-index in `nodes` computed               | 🟡 part | this PR                                                     |
| 21  | P3  | persistence  | `password_reset_tokens.deleteExpired` full-table scan (no `expires_at` index)                                                       | ✅ done | [#1143](https://github.com/kibertoad/cat-factory/pull/1143) |
| 22  | P3  | spend        | `isOverBudget`: up to 3 live SUM aggregates per proxied LLM call (design decision)                                                  | ⬜ todo |                                                             |
| 23  | P3  | engine       | `resolveRiskPolicy` re-reads merge preset per gate evaluation (optional slice)                                                      | ✅ done | [#1143](https://github.com/kibertoad/cat-factory/pull/1143) |
| 24  | P2  | gateways     | Dispatch GH client: no single-flight / throttle; concurrent same-run steps duplicate token mint + branch probe                      | ⬜ todo |                                                             |
| 25  | P1  | frontend     | `execution.getByBlock` full scan per call on the card/lane/measurement paths; cards scan global gate lists                          | ✅ done | [#2023](https://github.com/kibertoad/cat-factory/pull/2023) |
| 26  | P2  | frontend     | Activity pulse re-wakes the DOM-measuring loops on every card re-render, so a busy board never parks them                           | ✅ done | this PR                                                     |
| 27  | P2  | frontend     | Observability/kaizen stores grow unbounded per session and survive board switches                                                   | ✅ done | this PR                                                     |
| 28  | P2  | frontend     | ~35 direct `refresh()` call sites + starvable trailing-only debounce + stacking retry chains                                        | ✅ done | [#2023](https://github.com/kibertoad/cat-factory/pull/2023) |
| 29  | P3  | frontend     | Deep reactivity over `execution.instances` (shallowRef viable) and `board.blocks` (blocked by in-place writes)                      | ✅ done | this PR                                                     |
| 30  | P3  | frontend     | Identity churn, uncached derived counts, per-invocation timers, drag/viewport listener leaks (grouped)                              | ✅ done | this PR                                                     |

## Detailed findings

### 1. `emitInstance` runs the LLM-metrics aggregate on every emit (P1)

`backend/packages/orchestration/src/modules/execution/RunStateMachine.ts:217` awaits
`attachStepMetrics` (→ `llmObservability.summarizeByExecution`, `:279`) inside the
`Promise.all` of every `emitInstance`. `emitInstance` fires on every state transition AND
on every non-idle poll fold (`RunDispatcher.pollAgentJobInner`), i.e. on every
subtask-progress change or streamed follow-up during a live container run. Each call is a
`GROUP BY agent_kind` aggregate over `llm_call_metrics` for the whole run, so the drive
loop pays **O(emits × LLM-calls-in-run)**, on the critical path of the emit (despite the
adjacent "no serial latency" comment).

**Fix:** roll up metrics only on emits that surface them: terminal (`done`/`failed`) and
step-boundary transitions; skip `attachStepMetrics` on progress-only folds (the running
fold already computes a change reason; gate on "step advanced", not "subtasks changed").
No cache slice: this is live telemetry, not slow-moving config.

**Landed (branch `claude/performance-tracker-next-phase-cvbcmh`):** `emitInstance` gained a
`{ rollUpMetrics }` option (default `true`); the two progress-only poll folds in `RunDispatcher`
(`pollAgentJobInner`'s container running fold and `pollDeployerJob`'s deploy fold) pass
`rollUpMetrics: false`, so the per-run GROUP BY no longer runs on every poll tick, only on the
step-boundary/terminal emits that surface a settled step. Because `step.metrics` is live-only,
never-persisted, derived state (absent from the snapshot and now from running-fold events), the
SPA execution store carries the last-known per-step rollup forward when an incoming instance omits
it (`upsert`/`hydrate`), per the live-push coherence rules, so a metric-less fold no longer blanks
the board's per-step metrics bar between boundaries. Pinned with backend
(`RunStateMachine.emit.test.ts`) and store (`stores/execution.spec.ts`) unit tests.

### 2. Gate poll path: uncached `repoId()` + per-request PAT re-resolve (P1)

- `FetchGitHubClient.repoId()` (`backend/packages/server/src/github/FetchGitHubClient.ts:1184`)
  does an uncached `GET /repos/{owner}/{repo}` per call, and is called internally by
  `listBranches` (`:413`), `listIssues` (`:567`), `listCommits` (`:720`),
  `listCheckRuns` (`:738`) purely to backfill a numeric id.
- `GitHubCiStatusProvider.getStatus` (`backend/packages/server/src/github/GitHubCiStatusProvider.ts:57-62`)
  calls `listCommits({sha: branch})` + `listCheckRuns` per PR per poll tick ⇒ **two
  redundant `/repos` fetches per PR per tick**, plus `listCommits` can pull pages of
  commits just to read `items[0]`.
- `PatPreferringAppRegistry.installationToken` (`backend/packages/server/src/github/PatPreferringAppRegistry.ts:37-45`)
  re-resolves the initiator's PAT (DB read + decrypt) fresh on **every** `request()` (~4
  times per CI poll).

Runs continuously while any run sits on the `ci`/`conflicts` gate; scales with PRs in
flight × poll ticks.

**Fix:** (a) memoize `repoId` per `(installationId, owner, repo)` in a process-level Map
(immutable mapping, the same justified pattern as `ownerAppCache` in `GitHubAppRegistry.ts`);
(b) replace the `listCommits` head lookup with the existing
`branchHeadSha(installationId, ref, branch)` (`FetchGitHubClient.ts:420`); (c) memoize the
resolved PAT for the duration of one gate probe (scope it to the ambient
`runInitiatorContext` around the probe) so one poll does one lookup.

### 3. Execution list reads over-fetch `detail` and filter in JS; missing index (P1)

`D1ExecutionRepository.listByWorkspace/listByService/listByServices`
(`backend/runtimes/cloudflare/src/infrastructure/repositories/D1ExecutionRepository.ts:26-62`)
and the Drizzle mirrors (`backend/runtimes/node/src/repositories/drizzle.ts:578-624`) are
all `SELECT *`, including `detail`: the full serialized pipeline + per-step state, the
biggest column on `agent_runs`. Hot callers discard almost all of it:

- `ExecutionService.ts:1875-1880`: the per-service task-concurrency guard **on the
  run-dispatch path** loads every historical run in the workspace, JSON-decodes every
  `detail`, then filters to `status ∈ {running, blocked, paused}` and maps to `blockId`.
- `ExecutionService.resumePaused` (`:3409-3410`): `listByWorkspace` then
  `.filter(status === 'paused')`.
- The board snapshot (`WorkspaceService.snapshot`) also rides these list methods.

Cost grows unbounded with run history even though only live rows matter.

**Fix:** add a projected port method, e.g.
`listLiveBlockIds(workspaceId): Promise<Array<{ blockId, status }>>` →
`SELECT block_id, status FROM agent_runs WHERE workspace_id = ? AND kind = 'execution' AND status IN (…)`,
mirrored D1 ⇄ Drizzle + conformance assertion; use it for the guard and `resumePaused`.
Add the supporting index in the SAME slice (both runtimes):
`CREATE INDEX idx_agent_runs_ws_kind_status ON agent_runs (workspace_id, kind, status);`
(the existing indexes `(workspace_id, created_at)`, `(status, updated_at)`,
`(workspace_id, block_id)`, and `(service_id)` serve neither the guard nor `resumePaused`).
Consider a `detail`-free projection for the snapshot list as a follow-up if the board
cards prove not to need full steps (couples with item 5).

**Landed (#996):** shipped as `ExecutionRepository.listLive(workspaceId) → LiveRunSummary[]`
(`{ id, blockId, status }`) rather than the tentative `listLiveBlockIds`/`{ blockId, status }`
name above: `resumePaused` needs the paused runs' `id` as well as the guard's `blockId`, so
the projection carries both. Filters `status IN ('running','blocked','paused')` in SQL, mirrored
D1 ⇄ Drizzle with a conformance assertion, plus the `idx_agent_runs_ws_kind_status` index (D1
migration `0048` ⇄ Drizzle) and a mothership-allow-list entry (workspace-scoped read). The
snapshot-list `detail`-free projection remains the noted follow-up (couples with item 5).

### 4. `buildJobBody` serializes independent dispatch work (P1, latency)

`ContainerAgentExecutor.buildJobBody` (`backend/packages/server/src/agents/ContainerAgentExecutor.ts`,
~`:1008-1134`) awaits in strict sequence: `resolveEffectiveRef` → `resolveRepoTarget` →
`mintInstallationToken` → `ensureWorkBranch` → `resolveAuth` (itself serial:
`resolveAccountId` then session mint) → `resolvePackageRegistries` → `resolveTestSecrets`
→ `resolveWebSearchAvailability`. Only the token mint and `ensureWorkBranch` depend on the
resolved repo target; auth, package registries, test secrets, and web-search availability
are workspace/block-scoped and mutually independent. Paid on **every step dispatch** and
every re-dispatch epoch (tester→fixer rounds).

**Fix:** after `resolveRepoTarget`, run two parallel waves with `Promise.all`:
`[mintInstallationToken, ensureWorkBranch]` alongside `[resolveAuth,
resolvePackageRegistries, resolveTestSecrets, resolveWebSearchAvailability]`. (Fire-and-forgetting
`startJob`'s best-effort `agentContextObservability.record` was considered but rejected; see the
landed note below: it's already off the critical path, and a `void` would be dropped on the Worker.)

**Landed (branch `claude/perf-tracker-next-phase-3wg1gq`):** once the repo target is resolved,
`buildJobBody` fans the six independent dispatch resolutions out in a single `Promise.all`
wave: the repo-scoped `mintInstallationToken` + work-branch ensure alongside the
workspace/block-scoped `resolveAuth`, `resolvePackageRegistries`, `resolveTestSecrets`, and
`resolveWebSearchAvailability`. That collapses ~6 serial round-trips per step dispatch (and per
tester→fixer re-dispatch epoch) to one. The apriori/work-branch logic moved to a private
`resolveWorkBranchReady` helper so it fits as one entry in the wave (behaviour unchanged: PR-head
short-circuit, apriori probe-only-or-fail, writer-create / reader-probe). `startJob` keeps
`agentContextObservability.record` **awaited** (with a swallowing `catch`): it runs after the
container job is already dispatched, so it is off the container's critical path; the only thing
it delays is the driver's handle return, which then sleeps before its first poll regardless. A
bare fire-and-forget `void` was considered but rejected: `startJob` runs inside a Cloudflare
Workflow step, so an un-awaited insert is silently dropped once the isolate hibernates on the next
durable `step.sleep` (the `http/waitUntil.ts` anti-pattern), which would stop the snapshot
recording on the primary runtime for a negligible latency gain. Pure `@cat-factory/server` change
(no persistence / no conformance surface). The per-kind body snapshots are byte-identical (the
`containerAgentJobBody.spec.ts` characterization guard), plus two new tests pin the concurrency
(resolvers all started before any resolves) and that a failing observability record still never
breaks the dispatch.

### 5. Board snapshot carries full step outputs the board never reads (P1, LANDED)

`WorkspaceSnapshot.executions` (`backend/packages/contracts/src/snapshot.ts:48-52`) embeds
per-step `output` (full agent prose), `custom`, `outputHistory`, `rework` docs, and
companion `verdicts` (`entities.ts:1786,1794,1974,1704-1707,1674`). The board UI consumes
only `status`/`progress`/`currentStep`/`steps[].state/subtasks/decision/approval`; the
prose is read lazily via `execution.getInstance` when a detail overlay opens. Every full
refresh (item 6) re-fetches, re-valibot-parses, and re-hydrates all of it; on an active
board the step outputs dominate snapshot bytes.

**Fix:** serve the snapshot a lightweight execution projection (omit
`output`/`custom`/`outputHistory`/`rework`/`verdicts` from steps); keep the full shape on
the by-id endpoint the overlays already use. This is a wire-shape change: pre-1.0, no
back-compat shim (CLAUDE.md); land contracts + backend projection + SPA consumption
together. Couples naturally with item 3's `detail`-free list projection.

**Premise correction (2026-08, while landing item 11): "the by-id endpoint the overlays already
use" does not exist.** `execution.getInstance` (`stores/execution.ts`) is a pure `byId` lookup over
the hydrated cache, not a fetch, and neither runtime serves an `executions/:executionId` instance
route. The SPA has exactly two sources for an `ExecutionInstance`, the snapshot and the live
`execution` event, and the event carries the FULL instance. So this item is not the one-sided
projection it reads as; it is three things, and the first two have to land before the third:

1. a real by-id endpoint plus the store action and loading state the detail overlays would fetch through;
2. a store reconcile that carries the heavy fields forward when a lean instance arrives. `hydrate`
   and `upsert` are monotonic by `rev` ALONE and a projection does not bump `rev`, so a lean
   snapshot at equal `rev` currently REPLACES a full event-delivered instance and would blank an
   open overlay mid-read. `withPreservedMetrics` is the shape to copy;
3. the projection itself. Two traps found in the audit: `output` is read on the BOARD as a
   truthiness flag (`TaskPipelineMini`, `PipelineProgress`, `TaskExecution`), so omitting it
   silently drops the has-output affordance unless the projection carries an explicit
   `hasOutput`; and the heavy fields live INSIDE the `detail` JSON blob, so this is a JS
   projection over `rowToExecution`, not a narrower `SELECT`.

The finding also under-counts what is heavy: `prReview`, `judge`, `ralph`, `validation` and
`reproduction` all carry histories or captured output, while `outputHistory` is on the INSTANCE
rather than the step. `step.metrics` must stay out of scope (live-only, never persisted; see item 1).

**Re-verified 2026-08-14: entirely unstarted, and every part of the premise correction still
holds.** Refreshed references: the execution schemas moved out of `entities.ts` into
`contracts/src/execution.ts` (step fields: `judge` :739, `ralph` :748, `validation` :758,
`reproduction` :784, `prReview` :801, `rework` :826, `output` :936, `custom` :958; instance
`outputHistory` :1324), `snapshot.ts:72` still embeds the full `executionInstanceSchema`, and
`verdicts` now sits one level deeper, under `step.testerQuality` (:284). There is still no by-id
instance endpoint on either runtime (`ExecutionController` registers mutations and telemetry reads
only) and the SPA's `getInstance` is still a cache lookup that every overlay reads synchronously
(`stores/ui/resultViews.ts:56,70`, `ResultWindowShell.vue:134` and siblings). Item 3's lean
projection landed only as `listLive`; the snapshot path still rides `listByWorkspace`'s `SELECT *`
with `detail` (`D1ExecutionRepository.ts:39-48`), so "couples with item 3" remains future work.
One helpful narrowing from the swimlanes rework: the board's only remaining `output` read is the
truthiness icon in `TaskPipelineMini.vue:123` (TaskCard itself no longer touches it, and contracts'
`composeRunOutcome` reads no `output`), so the projection owes exactly one `hasOutput` boolean plus
the fields the mini pipeline really renders (`state`, `agentKind`, `subtasks`, `approval`,
`prReview` phase).

**LANDED.** All three parts, in the order the premise correction named:

1. `GET /workspaces/:ws/executions/:executionId` (`getExecutionContract`, served from
   `executionRepository.get`, which already existed on both runtimes), plus the SPA's
   `execution.ensureFull(id)`: single-flight per run, a no-op for a run the cache already holds
   whole, with `isFullPending` / `fullError` so a failed fetch never renders as a step that said
   nothing. Asked from the two OVERLAY HOSTS (`ResultWindowShell`, `AgentStepDetail`) rather than
   from each window, for the same reason the shell owns the trailing report sections: the host
   mounts exactly one window, so no window can forget.
2. The store carry-forward (`withCarriedForwardWithheld`, beside `withPreservedMetrics`), gated on
   an EQUAL `rev`. That gate is the part worth remembering: at the same revision the run is
   byte-identical server-side, so the cached prose IS the withheld prose. One revision later it may
   not be, and pasting it back is the same clobber in reverse, so a newer projection replaces and
   the open overlay re-fetches. A merge over a run the cache held whole clears `projected`.
3. `projectExecutionForBoard` (contracts, applied in `WorkspaceController` at the wire rather than
   in `WorkspaceService.snapshot`, whose own callers drive runs off the whole instance). It
   withholds `step.output` (leaving `hasOutput`, read through `stepHasOutput` at the six board /
   inspector truthiness sites), `step.rework`, `step.testerQuality` and instance `outputHistory`.

Two narrowings against the finding as written, both deliberate:

- **`step.custom` STAYS.** It is structured JSON rather than prose, and it is read on two
  non-overlay paths (the environment wizard's analyst draft, the inspector's merger decision), so
  withholding it means moving those reads first.
- **`judge` / `ralph` / `validation` / `reproduction` / `prReview` STAY.** They carry bounded
  histories, and `prReview` / `forkDecision` / `followUps` drive park ROUTING
  (`dedicatedParkView`) on the board itself. Same rule: move the board read first, then withhold.

`projected` on the instance is what makes the rest safe: withheld is not absent, and every reader
that needs the difference can ask. Three consequences of that, each a place where getting it wrong
renders as a step that said nothing:

- **The overlay hosts watch `execution.fullFetchKey(id)`, not the id.** A run does not stop being a
  projection once a window is open: every full refresh lands a lean projection over it, and at a
  newer `rev` the carry-forward cannot fire. Keyed on the id, the watch that fired on open never
  fires again and the open reader blanks with nothing left to refill it; keyed on the fetch key
  (null while the run is held whole, `id:rev` while it is not) each newer projection re-asks.
- **A recorded fetch failure is READ through the same question.** `fullError` answers only while
  the run is still a projection, because the prose can arrive by a route the fetch knows nothing
  about (a live `execution` event carries every run whole), and a banner saying the run could not
  be loaded standing over prose that loaded is worse than no banner. A board switch drops the
  pending/failed marks and disowns the requests behind them (`resetFullReads`), which is also what
  stops a late answer landing a foreign run in the switched-to board's cache.
- **"Approve with corrections" is gated on the run being held whole.** The editor seeds from
  `step.output`, so entering it under a projection would seed an EMPTY draft and approving it would
  replace the agent's proposal with nothing. The verb is withheld until the read lands; the reader
  already states the pending/failed state on its own.

### 6. Coarse `board` events force full refreshes the payload could avoid (P1) — LANDED

`useWorkspaceStream.ts:92-93`: every `board`-type event collapses to
`debouncedBoardRefresh()` → full `workspace.refresh()` (REPLACE-style hydrate of ~20
stores), even though `emitBoardChanged(ws, reason, blockId)` already carries the affected
`blockId`, and even though `execution`/`bootstrap` events already do targeted
`board.upsert(event.block)` (`:91,:99`). Backend emits `board` mid-pipeline for module
materialisation, blueprint reconcile, requirements updates, and **per task spawned by an
initiative loop**; a steady drip yields a full snapshot fetch every ~300ms debounce
window.

**Fix:** carry the changed block (or a compact delta) on `board` events for the
single-block reasons (`block-added`, `block-updated`, `dependency-toggled`,
`epic-assigned`) and upsert it; reserve the full refresh for genuinely structural reasons
(`cancel`, `block-removed`, reparent). MUST respect the live-push coherence rules in
CLAUDE.md ("Real-time store coherence"): keep the monotonic refresh guard, never let a
targeted upsert be clobbered by a stale refresh, and pin the new path with a store-level
unit test.

**As landed.** The kernel port takes a `BoardChange` value (`reason` / `blockId` / `block` /
`originConnectionId`) instead of four positionals, so adding a field does not grow a signature
and every call site reads as the decision it is making. The wire event gained `block`; the SPA
upserts a carried block through the SAME `board.upsert` the `execution` branch uses, which is what
keeps the monotonic live-upsert stamp in play, and falls back to the old debounced refresh when
none is carried.

`blockId` stays on the BoardChange and off the wire. It is how the backend resolves which
workspaces to publish to (`boardChangeSubject` → `FanOutEventPublisher.targets`), spent before the
event exists; a client has nothing to do with it the payload does not already say, and an id
riding along for no reader is the kind of inert surface the next person assumes is load-bearing.

Three things the original finding did not anticipate, all learned while implementing:

- **Two blocks can never be CARRIED**, so the reason-by-reason list above is not the whole rule.
  A service FRAME: one payload is published for every board that mounts the affected service, and
  a frame's position and size live on the per-workspace `WorkspaceMount`, so whichever mount the
  publisher projected through would be wrong on every other board and would jump the frame there,
  the exact failure `applyMountLayout` exists to prevent, arriving by a different door. And a
  headless `internal` anchor block (a public-API run's own "task"), which `composeBoard` filters
  out of every snapshot and which would therefore render as a card no later read can remove.
  Kernel's `deliverableBoardBlock` enforces both at the WIRE rather than at each call site, and
  both facades assemble every block-carrying event through it (`boardWireEvent` /
  `bootstrapWireEvent`), so a future emitter cannot reintroduce either. `cancel` therefore CAN
  carry its block for an ordinary task, even though the finding grouped it with the structural
  reasons, and degrades to coarse for the internal one.
- **Withholding the PAYLOAD is not withholding the SUBJECT.** A coarse change that also drops
  `blockId` resolves no service, so `FanOutEventPublisher` collapses it to the acting board and
  every other mount of a shared service learns nothing. Resize is the case that bites: children
  shift with the container, so the payload must go, but the block still has to be named.
- **`block-updated` and `epic-assigned`/`dependency-toggled` re-read the block anyway** to build
  their REST response, so carrying it cost a reorder rather than a query. Emitting before the
  re-read would have shipped the pre-write value, which is worse than carrying nothing.

A targeted upsert also does not self-heal the way the coarse signal did, so ORDER became load
bearing where a payload rides: the initiative loop announces a spawned task only once
`executionService.start` has resolved, because the failure path deletes the block and emits
nothing, and the refresh a coarse event triggered used to reconcile that away by itself.

Still coarse, and deliberately: removal (cascades over descendants and prunes edges on blocks the
event never names), reparent (moves a subtree between parents), resize (children shift too),
blueprint reconcile, bootstrap frame transitions, `module`, and every frame change.

### 7. `SpendService` homebrew TTL Maps → AppCaches slices (P2)

`backend/packages/spend/src/SpendService.ts:111-116` holds `pricingCache`,
`accountLimitCache`, `userLimitCache`: exactly the banned `{value, expiresAt}` Map
pattern, for slow-moving admin config read per proxied LLM call and per advance tick
(`resolvePricing` inside `isOverBudget`). On multi-replica Node, a budget edit on one
replica leaves peers serving the stale limit for the full TTL.

**Fix:** three slices (or a grouped `spendConfig`) on `AppCaches`, keyed by
workspace/account/user id; invalidate from the existing `invalidatePricing` /
`invalidateAccountLimit` / `invalidateUserLimit` call-sites (`:162-174`); pass-through in
the isolate-safe profile. A mechanical migration: the invalidation hooks already exist.
Fold into / coordinate with item 9 (same `workspace_settings` row).

**Landed (with item 9, branch `claude/performance-tracker-next-phase-hcdba4`):** three new
`AppCaches` slices replace the three Maps: `workspaceSettings` (raw settings row),
`accountBudgetLimit`, and `userBudgetLimit`. `resolvePricing` now reads the settings row through
the SHARED `workspaceSettings` slice and overlays `mergeSpendPricing` on the cached value, so
its coherence rides item 9's single invalidation site (`WorkspaceSettingsService.update`) and
`SpendService.invalidatePricing` + the controller's manual drop are **deleted**. The two
budget-limit slices are invalidated by the existing `invalidateAccountLimit` /
`invalidateUserLimit` methods (now `async`, delegating to the slice), wired unchanged from the
`AccountService` / `UserSettingsService` budget-change callbacks (made `await`able). All three
are pass-through on the Worker's isolate-safe profile (our own mutable D1 state). Pinned by a new
`@cat-factory/spend` vitest suite (read-through + invalidation for all three) and covered
end-to-end by the conformance `/spend` budget test (warm → settings write → re-read).

### 8. `AccountSettingsService` legacy 30s Map (P2)

`backend/packages/integrations/src/modules/accountSettings/AccountSettingsService.ts:72`
(TTL at `:34`, read `:83-99`, `invalidate` `:103`): the exact Map CLAUDE.md names as the
anti-pattern this rule exists to stop. The hot non-secret read (model policy) was already
migrated to `caches.accountModelPolicy`; what remains is `resolve()` decrypting the
grouped secrets blob (Slack/Linear/web-search/S3) for runtime integrations,
lower-frequency but incoherent across replicas after a write.

**Fix:** an `accountSettings` slice grouped by account id, invalidated in `write()`
(`:173`). Values stay in-process (the seam broadcasts invalidation keys, never values), so
decrypted secrets never cross the wire: same safety, plus coherence. Delete the Map.

**Landed (branch `claude/performance-initiative-next-phase-i3mtxw`):** the new `accountSettings`
`AppCaches` slice (group == key == account id, holding the decrypted `ResolvedAccountSettings`)
replaces the homebrew `{ value, expiresAt }` `Map` + the `CACHE_TTL_MS` constant. `resolve()`
now reads through `settingsCache.get(accountId, accountId, () => this.load(...))` (the decrypt +
default assembly moved into a private `load` helper), and `write()` awaits
`invalidate(accountId)` after the upsert commits, so a credential edit is visible on the very
next `resolve` on any replica (the model-policy read stays on its own `accountModelPolicy` slice,
which the update controller drops separately). The decrypted secrets stay in-process: the
notification bus carries only invalidation keys, never plaintext (same safety as the Map, plus
cross-replica coherence). `ResolvedAccountSettings` moved from the service to the kernel
account-settings port (the caching port now names it) and is re-exported from
`@cat-factory/integrations` so the Slack/Linear/web-search/S3 consumers import it unchanged.
Pass-through on the Worker's isolate-safe profile (our own mutable D1 state, no cross-isolate
bus). Wired from both facades (Worker's `buildAccountSettings` helper + Node's two construction
sites, from `caches.accountSettings` / `options.caches`); no new persistence, so no conformance
surface; pinned by a new `@cat-factory/integrations` unit suite (read-through, write-invalidation,
per-account scoping, and no-cache pass-through parity).

### 9. `WorkspaceSettingsService.get` uncached on the per-LLM-call path (P2)

`backend/packages/orchestration/src/modules/settings/WorkspaceSettingsService.ts:31-33` is
a bare repository read. `LlmObservabilityService.bodiesEnabled` reads it **per recorded
LLM call** (off user latency, under `waitUntil`, but still a DB read per call), and the
per-service task-limit start guard reads it too. `SpendService` reads the same row through
its own banned Map (item 7).

**Fix:** a `workspaceSettings` slice keyed by workspace id, invalidated from
`WorkspaceSettingsService.update` (`:71`); pass-through on the Worker profile. Natural
home to fold item 7's `pricingCache` into.

**Landed (branch `claude/performance-tracker-next-phase-hcdba4`):** the `workspaceSettings`
slice (group == key == workspace id, `{ settings: WorkspaceSettings | null }` wrapper) is read
through by ALL of the row's consumers via the shared `readCachedWorkspaceSettings` kernel helper
(so they can't drift on the cache key): `WorkspaceSettingsService.get`, the task-limit start
guard (through `get`), `LlmObservabilityService.bodiesEnabled`, and `SpendService.resolvePricing`
(item 7's fold-in). Its sole write path, `WorkspaceSettingsService.update`, invalidates the
workspace's entry after the upsert commits, so a settings/budget edit is visible on the very next
read on any replica. Pass-through on the Worker's isolate-safe profile. Pinned by
`WorkspaceSettingsService.test.ts` (read-through / default caching / update-invalidation /
per-workspace scoping) and a new conformance cache-coherence assertion (warm GET → PUT → GET
reflects) on both runtimes.

### 10. One event re-assembles every frame's swimlanes (P2, rewritten 2026-08-14)

As originally written this finding named `BlockNode`'s `directTasks`/`taskStats` computeds; the
task-swimlanes rework (#1777) replaced that render path, and two halves of the fix have since
landed: the single-pass block index (`useBlockQueries.ts:19-37`) and the per-block gate maps
(`decisionsByBlock`/`approvalsByBlock`, `stores/execution/pendingGates.ts:76-91`) that `BlockNode`
reads with O(1) lookups (`BlockNode.vue:108-135`). What remains is the same fan-out through the
new path: `useFrameLanes` (one instance per frame) derives `byLane`/`lanes` from the blocks
index, both gate maps, `agentRuns.byBlock` (a Record rebuilt over all runs + bootstrap jobs per
event, `stores/agentRuns.ts:130-158`) and `notifications.open`, so ONE step-progress event
re-classifies, re-sorts and re-groups all four lanes of every mounted frame.

Breadth found in the re-audit, all in the same recompute:

- `waitingSinceByBlock` derives `collectReviewDebt(notifications.open)` once per FRAME instance
  (`useFrameLanes.ts:63-65`): O(frames × open notifications) where one store-level computed would
  serve every frame.
- The `title` and `task_type` comparators call `localeCompare` with no cached `Intl.Collator`
  (`utils/laneSort.ts:183,191-192`, the second twice per comparison).
- The lane output has no structural sharing, so an unchanged lane hands `TaskLane`/`LaneGroup` a
  fresh array every recompute and every card diff re-runs.

**Fix:** hoist the review-debt map to a store-level computed shared by all frames; cache one
`Intl.Collator`; preserve identity for unchanged lanes/groups (compare member ids + the entry
fields the comparators read) so a progress-only event short-circuits downstream `===` checks.
The `getByBlock` scans inside `classify` are item 25 and should land first, since they dominate
the recompute this item makes rarer.

**Landed ([#2023](https://github.com/kibertoad/cat-factory/pull/2023), with items 25 and 28):** `collectReviewDebt` moved onto the notifications store as
`reviewDebtByBlock`, so the workspace-wide reduction is derived once instead of once per mounted
frame; `laneSort` compares text through one lazily built `Intl.Collator` (no options, so the
collation is byte-for-byte what `localeCompare` performed); and the assembled output passes through
`utils/laneIdentity.ts`, which hands back the previous lane / group / entry objects wherever the
fresh ones are field-for-field identical, so a progress-only event leaves `TaskLane` / `LaneGroup`
diffing on `===`. What makes reuse sound is the DERIVED fields being compared: `moduleName`,
`initiativeName`, `epicName` and the activity/wait stamps exist only on the entry, so a reused entry
carrying a stale one is a lie nothing else corrects. `task` is compared by reference, and review
corrected the reason: it is NOT that the board store always replaces the object (`board/placement.ts`
patches a block in place for its optimistic writes), but that a replaced block is a new reference and
an in-place patch is one object both entries share, which a renderer reads through and Vue's deep
reactivity invalidates on its own. The rule a future field must respect (add it to `sameEntry` or
reuse goes stale) is stated at that file's head and pinned by `laneIdentity.spec.ts`. Still open
here: incremental maintenance of the gate/run projections themselves (item 20's third bullet).

### 11. Two unconditional 60fps DOM-measuring RAF loops (P2)

- `frontend/app/app/components/board/TaskDependencyEdges.vue:111-197`: `useRafFn` runs
  every frame while the board is open, doing `document.querySelector` +
  2 × `getBoundingClientRect` per edge; O(edges) forced layout reads 60×/sec even idle.
- `frontend/app/app/composables/useTaskExpansion.ts:74-143`: cheaper (early-returns
  unless deep-zoomed), but when zoomed does per-task measurement + `elementFromPoint`
  every frame.

**Fix:** drive edge recompute from actual change signals (viewport change, drag, resize,
store edge/frame changes) coalesced into a RAF that idles when nothing is animating; or
short-circuit when neither inputs nor viewport changed since the last frame.

**Landed (branch `claude/frontend-performance-iteration-mal14b`).** Both drivers now pair a
signal source with a self-parking frame loop, because neither half works alone. `createSettlingLoop`
(pure, injected scheduler) runs while its `compute` reports it changed something visible and parks
after a short tail of unchanged frames; `provideBoardActivity` publishes the canvas pulse that wakes
it. An idle board schedules no frames at all.

Three things the finding did not anticipate:

- **A change signal fires one frame BEFORE the transition it starts produces any geometry.** The
  first measured frame after a wake therefore routinely reports "nothing moved", so parking on it
  would stop every animation dead at its first frame. The settle TAIL (four frames, ~66ms) is what
  makes a signal-driven loop correct, and it is why the finding's alternative phrasing
  ("short-circuit when neither inputs nor viewport changed") cannot stand alone: the inputs to a CSS
  height transition do not change while it runs.
- **The signal set is a DOM `MutationObserver` over the canvas, not the enumerated list above.**
  Enumerating causes (viewport, drag, resize, store edges) leaves out every card that reflows because
  its own content changed, which on a live board is most of them. Watching structure plus
  `style`/`class` under the canvas catches every Vue-driven render including Vue Flow's camera, and
  the `attributeFilter` is what keeps a driver from pulsing itself awake forever: the edge overlay
  writes geometry attributes, which are outside it. The camera is ALSO pulsed explicitly, so the
  overlays do not depend on which DOM strategy Vue Flow uses to apply a pan.
- **Dependency links can change with no card changing**, so the DOM pulse genuinely cannot see
  them; those keep an explicit `watch`.

A second win fell out of making the loop report honestly: the overlay used to assign a new
(equal-valued) segment array every frame, re-rendering the whole SVG 60 times a second on a still
board. `commitSegments` publishes only a list that actually moved, and the four lists moved to
`shallowRef`, so the segment objects are no longer deep-proxied.

Not caught by the pulse, and accepted: a reflow with no mutation and no gesture (a late-loading
image or font resizing a card) leaves an arrow stale until the next pulse of any kind.

**Follow-up surfaced 2026-08-14:** the pulse's breadth means a busy board re-wakes the loops on
every card re-render, so under a steady event stream they effectively never park: item 26.

### 12. `GitHubSyncService` serial fan-out and serial resource syncs (P2)

`backend/packages/integrations/src/modules/github/GitHubSyncService.ts:418-420`: `fanOut`
awaits each workspace in turn, and `syncRepo` invokes it ~6 times (branches / PRs /
issues / commits / checks / re-stamp) ⇒ ~6×N sequential writes per repo per sync tick for
a repo linked by N workspaces. The five resource syncs also run one-after-another though
they're independent GitHub resources; and each client call re-derives the repo id via the
uncached `repoId()` (~4 wasted `/repos` fetches per repo per sync; fixed for free by
item 2a). `resyncWorkspace`/`backfillInstallation` (`:531-548`) iterate repos serially.

**Fix:** `Promise.all` the per-workspace applies inside `fanOut`; `Promise.all` the
independent resource fetches within a repo (keep per-resource cursor writes ordered where
required); bounded concurrency for the per-repo backfill loop.

**Landed (branch `claude/performance-tracker-next-phase-kky9ny`):** `syncRepo`'s `fanOut` now
`Promise.all`s the per-workspace projection writes (each resource's rows reach all N linking
workspaces concurrently, not N serial writes). The four independent cursor resources
(branches / PRs / issues / commits, each on its OWN installation-scoped cursor, so there is
no cross-kind ordering to preserve; `syncResource` reads+writes a single per-kind cursor)
fetch+upsert in one `Promise.all` wave; checks stays after the wave because it needs the branch
head. The data-scaled loops (`resyncWorkspace` per repo, `backfillInstallation` per workspace)
move from serial to **bounded** concurrency via `p-map`, capped at `REPO_SYNC_CONCURRENCY = 4` /
`WORKSPACE_BACKFILL_CONCURRENCY = 3`: parallel but not an unbounded burst, so a large
installation backfills fast without tripping GitHub's secondary (abuse) rate limits (the
concern item 24 tracks for the dispatch path). The intra-repo resource wave is a fixed 4-wide
fan-out (not data-scaled), so it needs no bound. This slice also standardizes bounded-map
fan-out on `p-map` project-wide: the pre-existing hand-rolled `mapLimit` in `readServiceSpec`
(`@cat-factory/server`) is replaced with `p-map` too (the `@cat-factory/agents` `Semaphore`
stays; it is a shared FIFO permit/mutex, not a bounded map, which `p-map` doesn't cover).
Pure orchestration, no persistence surface; pinned by a new
`GitHubSyncService.parallelism.test.ts` (concurrent resource wave, concurrent workspace
fan-out, both bounded loops). The existing cursor/cache tests are unaffected (per-kind
cursors and ordered invalidation preserved).

### 13. `AgentContextBuilder` re-walks ancestry per resolver, serially (P2)

`backend/packages/orchestration/src/modules/execution/AgentContextBuilder.ts:236-239`:
`resolveEnvironment`, `resolveServiceConfig`, `resolveFrontendConfig`, fragment resolution
each independently re-walk frame→module→task via per-level `blockRepository.get`
(`resolveServiceFrame` `:474-476`, `:796-803`), awaited in sequence, plus per-dispatch
workspace + account reads (`:591-598`). Per dispatch (not per tick), so latency +
redundant reads rather than unbounded scaling.

**Fix:** resolve the service-frame block ONCE per `buildContext` and thread it into the
resolvers (several already accept a pre-fetched block; see the `resolveServiceFrame`
docstring); `Promise.all` the independent resolvers. Reuse-not-cache.

**Landed (branch `claude/performance-initiative-next-phase-exeew1`):** `buildContext` now walks
the ancestry ONCE via a private `serviceFrameFor(block)` (walks from the block in hand with no
re-fetch, frame→module→task, cycle-guarded) and threads that frame into every service-frame
resolver: `resolveEnvironment` (frame id), `serviceConfigFrom` (frame block; this also drops the
old resolve-id-then-re-`get` double read), `frontendConfigFrom`/`frontendResolutionFrom` (frame
block), and `resolveFragments` (reads the frame's `serviceFragmentIds` directly; the standalone
`resolveServiceFragmentIds` walk is deleted). The description substitution + the frame walk run
in a first `Promise.all`, then the ten mutually-independent resolutions (linked context,
environment, service, frontend, involved services, test secrets, initiative, brainstorm
direction, fragments, doc authoring) fan out in ONE wave rather than ten sequential awaits. The
public `resolveServiceConfig`/`resolveFrontendConfig`/`resolveFrontendRunInfo`/`resolveServiceFrame`
keep their walk-from-a-block-id contract for external callers (they delegate to the `*From`
variants). Pure orchestration, no persistence surface; pinned by `AgentContextBuilder.reuse.test.ts`
(exactly one block read for a frame→module→task chain, the walk length rather than
once-per-resolver; zero reads for a frame-level block; and two previously-sequential resolvers
now overlapping in the wave), with the existing `AgentContextBuilder.*` suites unchanged.

### 14. `FanOutEventPublisher` serial per-workspace forwards (P2)

`backend/packages/server/src/events/FanOutEventPublisher.ts:57-108`: each event method
forwards to every mounting workspace with `for (…) await inner.x(ws, …)`; for a shared
service mounted on N boards, that is N serial DO round-trips (Cloudflare) per state transition.

**Fix:** `Promise.all` the forwards (independent, already best-effort). Coalescing rapid
same-workspace events (per-call `llmCallObserved`, per-step `executionChanged`) into a
short publish batch is a further opportunity; note it in the slice but treat it as a design
change, not a defect.

**Landed (branch `claude/performance-tracker-next-phase-kky9ny`):** every fan-out method
resolves its target set once and `Promise.all`s the per-target inner forwards instead of
`for (…) await`, so a service mounted on N boards pays one round-trip's latency, not N serial
ones. The block-less methods (`envConfigRepairChanged` / `envTestChanged` / `llmCallObserved`)
were already single-forward and are untouched. Semantics are unchanged beyond concurrency: the
forwards were already independent and best-effort. Coalescing rapid same-workspace events into
a publish batch remains the noted (deferred) design opportunity. Pinned by a new
`fanOutEventPublisher.spec.ts` case (forwards enter concurrently; a serial chain would
deadlock the barrier).

### 15. `autoStartDependents` per-dependent pipeline point-read (P3)

`backend/packages/orchestration/src/modules/execution/ExecutionService.ts:2834` (loop at
`:2828`): `pipelineRepository.get(workspaceId, dependent.pipelineId)` per dependent, a
banned loop point-read; the catalog is small and partially loaded already (`:2826`).
Fires on the merge/finalize path, linear in dependents.

**Fix:** load `listByWorkspace` once unconditionally, index into a `Map`, resolve pinned
pipelines and `firstPipeline` from it.

**Landed (branch `claude/performance-tracker-next-phase-caz67j`):** `autoStartDependents` reads
the workspace pipeline catalog once (`listByWorkspace`), indexes it into a `Map<id, pipeline>`,
and resolves each dependent's pinned pipeline from the map (`firstPipeline = pipelines[0]` for a
dependent with none); the per-dependent `pipelineRepository.get` in the loop is gone. Behaviour
is unchanged (same pipeline selection); the read count drops from `1 + N` pinned gets to one list.

### 16. `InitiativeLoopService.spawnItem` per-item pipeline point-read (P3)

`backend/packages/orchestration/src/modules/initiative/InitiativeLoopService.ts:369`
(loop from `:340`): a `pipelineRepository.get` per eligible item, per initiative tick.
Slot-capped, so bounded, but the same fix as item 15 applies: one `listByWorkspace` per
tick, check membership in memory.

**Landed (branch `claude/performance-tracker-next-phase-caz67j`):** `spawn` loads the pipeline
catalog once per tick into a `Set<pipelineId>` and hands it to `spawnItem`, which now checks
`knownPipelineIds.has(pipelineId)` instead of a `pipelineRepository.get` per eligible item. The
missing-pipeline path (block the item + deviation) is unchanged.

### 17. `BoardScanService` reconcile re-lists the board per added module (P3)

`backend/packages/orchestration/src/modules/boardScan/BoardScanService.ts:100-114` /
`:54-65` loop `boardService.addModule(...)`, and `BoardService.addModule` internally
re-runs `requireWorkspace` + `blockRepository.listByWorkspace` per call
(`BoardService.ts:658`): one full board list per new module, though the reconcile already
holds the block list (`:85`). Per `blueprints` step, linear in modules.

**Fix:** add a batch module-insert seam on `BoardService` (or let `addModule` accept a
pre-loaded block list) so the reconcile builds all rows against the single read it holds.

**Landed (branch `claude/performance-tracker-next-phase-caz67j`):** new
`BoardService.addModules(workspaceId, serviceId, inputs[])` resolves the workspace + service and
lists the board ONCE for the whole batch (positions lay out against one starting count), then
inserts every module; `addModule` delegates to it (single input). `BoardScanService` uses it in
both paths: `spawnBlueprint` inserts all modules in one batch, and `reconcileBlueprint` collects
the name-deduped missing modules and inserts them in one batch (the same-named-module dedup the
per-module loop gave is preserved) before refreshing descriptions. A new
`BoardScanService.test.ts` pins that reconcile adds the batch with two board lists total (its
own plus the batch's), not one per module.

### 18. Block delete pays two full board reads (P3)

`backend/packages/server/src/modules/board/BoardController.ts:158-159` calls
`teardownForBlockTree` (`ExecutionService.ts:3502`) then `removeBlock`
(`BoardService.ts:1027`); each independently runs `listByWorkspace` + recomputes
`descendantIds` over the same subtree. Per DELETE request, linear in board size.

**Fix:** resolve the block list + descendant set once and thread it into both (e.g.
`teardownForBlockTree` returns the resolved subtree, `removeBlock` accepts it).

**Landed (branch `claude/performance-tracker-next-phase-caz67j`):** `teardownForBlockTree` now
returns a `PreloadedBlocks` (`{ workspaceId, blocks }`), the workspace block list it already
loaded (it deletes only run records, never blocks, so the list is still current), and the
`BoardController` DELETE handler threads it into `removeBlock(workspaceId, blockId, { preloaded })`.
`removeBlock` reuses the list ONLY when it was loaded for the block's resolved home workspace (the
common locally-owned delete); a mounted shared service homed elsewhere re-lists against its home,
so the mount semantics are unchanged. `PreloadedBlocks` is a new shared kernel type.
`BoardService.removeBlockPreloaded.test.ts` pins reuse (no second read) for the local case,
re-list for the mounted (home-mismatch) case, and the unchanged default (no-opts) path.

### 19. `notifications.listOpen` unbounded `SELECT *` on the snapshot (P3)

`backend/runtimes/cloudflare/src/infrastructure/repositories/D1NotificationRepository.ts:75-85`
and `backend/runtimes/node/src/repositories/notifications.ts:67-74`: no `LIMIT`, pulls
`body` + `payload` JSON for every open notification into the polled board snapshot. The
predicate is indexed (`idx_notifications_open`); the issue is over-fetch + unbounded
growth. Re-verified 2026-08-14: unchanged on both runtimes.

**Fix:** add a LIMIT (+ pagination) and project away `body`/`payload` if the inbox list
renders only title/severity/type until a card opens. Both runtimes + conformance. One
consumer constrains the projection: the snapshot controller reuses the SAME list for the
`infra_unreachable` fold (`WorkspaceController.ts:648-653`), so `type`/`status`/`payload`
must survive for that read (or it gets its own narrow query). The SPA-side derivation over
the list is item 10's `collectReviewDebt` hoist and item 30's `byBlock` churn.

### 20. Frontend hydrate/derived-state costs (grouped, P3; states refreshed 2026-08-14)

- `frontend/app/app/stores/board.ts:90-123`: `hydrate`'s stringify compare is now WeakMap-cached
  (a kept block is serialized once, and a live-upsert baseline stops a stale refresh clobbering),
  so the remaining cost is one `JSON.stringify` per INCOMING snapshot block per refresh. The
  server-stamped per-block revision is still the real fix, but refreshes are rarer post-#1759,
  so this half has dropped in urgency.
- `frontend/app/app/stores/execution/pendingGates.ts:14-99` + `stores/agentRuns.ts:130-158`:
  the decision/approval/run projections are still rebuilt over all instances × steps on every
  upsert. Since the extraction they are Map-grouped, so CONSUMERS are O(1) (that was the
  expensive half); what remains is incremental maintenance patching only the changed instance's
  entries, worthwhile only after items 25/10 remove the bigger per-event work.
- `frontend/app/app/components/board/BoardCanvas.vue:73-99`: unchanged. No viewport culling (all
  frames mount), and `frameZIndex` is still read inside the `nodes` computed, so every
  hover/drag (`hoveredFrameId`/`draggingId`) rebuilds the whole nodes array. Fix: cull
  off-viewport frames via Vue Flow viewport bounds + `containerSize`; move z-index to a class
  binding so hover doesn't reallocate all nodes.

**PARTLY LANDED.** The `nodes` half is done and the other two are refused / still open, with the
reasons, so nobody re-proposes them blind:

- **z-index (done).** The projection moved to `BoardCanvas.logic.ts` and is MEMOISED PER NODE: the
  key carries every field a node has, so an unchanged node comes back as the SAME object. A hover
  now allocates the two nodes whose stacking changed instead of all of them, and Vue Flow diffs two
  changes instead of N. Keeping `zIndex` IN the node (rather than moving it to a class binding) is
  deliberate: Vue Flow writes it as an inline style on the node wrapper, which a class on the inner
  component cannot outrank.
- **Viewport culling: REFUSED, not deferred.** Both routes strand frames. Vue Flow's own
  `only-render-visible-elements` narrows `getNodes`, and `fitView` only ever fits nodes with
  MEASURED dimensions, which an unrendered node does not have. So `fit-view-on-init` would fit
  only the frames that happened to fall inside the default viewport, and a frame outside it could
  never be brought back into view: it is not rendered, so it is not measured, so no fit includes
  it. A hand-rolled cull inherits the same circularity. Culling needs the board to know each
  frame's extent WITHOUT having rendered it (a stored or server-side size), which is a different
  change from this one.
- **Hydrate stringify: still open**, and still waiting on the same thing it was: a server-stamped
  per-block revision. `Block` carries no `updatedAt` or `rev` on the wire, so there is no cheap
  pre-filter to put in front of the compare, and refreshes stayed rare after #1759.
- **Incremental gate/run projections: still open, and now cheaper to leave alone.** `instances` is
  a `shallowRef` since item 29, and the consumers have been Map-grouped since the item 25/10
  slice, so what remains is one rebuild per event over a board-sized population. Hand-maintaining
  those Maps means giving up `computed` for a set of caches that must agree with the array they
  are derived from, which is the coherence hazard this repo's own rules warn about; it needs a
  measurement showing the rebuild matters before it is worth that.

### 21. `password_reset_tokens.deleteExpired` full-table scan (P3)

`D1PasswordResetTokenRepository.ts:90-92` deletes on `expires_at < ?` with no index on
`expires_at` (schema: `backend/runtimes/node/src/db/schema.ts:205-216`, migration
`0017_password_reset_tokens.sql`). Table stays tiny (1h TTL), so impact is low, but the
codebase indexes `expires_at` everywhere else (`idx_environments_expiry`,
`idx_personal_subs_expiry`). One-line fix on both runtimes:
`CREATE INDEX idx_password_reset_tokens_expiry ON password_reset_tokens (expires_at);`

**Landed (branch `claude/performance-initiative-next-phase-exeew1`):** `idx_password_reset_tokens_expiry`
added symmetrically on both runtimes: the D1 migration
`0051_password_reset_tokens_expiry_index.sql` and the mirrored Drizzle index in `schema.ts` (with a
generated Postgres migration), so `deleteExpired`'s `expires_at < ?` sweep is index-driven on
either facade. Pure additive index, no schema/data change and no new port method, so no conformance
surface.

### 22. `isOverBudget` synchronous aggregates per proxied LLM call (P3, design decision)

`backend/packages/spend/src/SpendService.ts:347-373`, awaited at
`LlmProxyController.ts:255` before every upstream forward: `totalsSinceForWorkspace`
(always) + account/user variants (when scoped); SUM aggregates over `token_usage` per
call, latency on every model call, scan growing within the billing period. NOT a
slow-moving-config cache (a stale read under-gates spend). A very-short-TTL (2-5s)
memoized total keyed by `(tier, periodStart)` would collapse a running container's call
burst without meaningfully loosening the gate, but the correctness tradeoff needs an
explicit decision. Related: `token_usage.totalsSince` (the platform-wide safeguard,
`D1TokenUsageRepository.ts:86-103`) range-scans ALL workspaces' rows per check; if it
turns out to run per-call, a maintained running counter is the durable fix; verify call
frequency first.

### 23. `resolveRiskPolicy` re-reads the merge preset per gate evaluation (P3)

`ExecutionService.ts:2861-2887`, called from the review/tester/human-test/visual gate
controllers + `MergeResolver`. Slow-moving admin config, re-read per gate evaluation
(≈ per advance / human action, NOT per fast poll: the CI gate already stamps
`maxAttempts` on `step.gate` and reuses it, `RunDispatcher.ts:3130-3132`, don't touch
that). Optional `mergePreset` cache slice keyed by `(workspaceId, riskPolicyId|default)`,
invalidated from `RiskPolicyService.create/update/remove/reseed` (`RiskPolicyService.ts:77-162`).

**Landed (branch `claude/performance-initiative-next-phase-exeew1`):** the new `riskPolicy` AppCaches
slice (grouped by workspace id, keyed per resolved preset: `picked:<id>` / `default`) replaces the
per-gate repository re-read. `ExecutionService.resolveRiskPolicy` reads each preset through
`riskPolicyCache.get(...)` when wired (a `RiskPolicyCacheValue` wrapper so a deleted picked id or an
unseeded null default caches as a value and still falls through, exactly as an uncached read would),
and `RiskPolicyService` drops the workspace group after EVERY write path: create / update / remove /
reseed AND the lazy first-use seed (so a gate that resolved the pre-seed null default
re-reads the seeded default, not the built-in fallback). ADR 0055 later added the clone, the two
suppression writes and an account tier whose writes drop the WHOLE slice; the kernel port's own doc is
the current contract. Registered on the kernel `AppCaches`
interface + both profiles + `createAppCaches`; pass-through (`enabled: false`) on the Worker's
isolate-safe profile (our own mutable D1 state, no cross-isolate bus). Wired entirely inside
`createCore` (`caches.riskPolicy` into both `ExecutionService` and `RiskPolicyService`), so BOTH
facades pick it up with no facade-container edits. The coherence contract is exercised against the
REAL cache by `RiskPolicyService.cache.test.ts` (warmed read served from cache; every write path
re-loads on the next read; no-cache pass-through). No conformance HTTP assertion: `resolveRiskPolicy`
is engine-internal (read only by the merge gate, not any HTTP GET), the wiring is 100% shared
(`createCore`), and the profile mirrors the four already-conformance-covered slices, so the
facade-drift a conformance test guards against has no per-facade surface here.

### 24. Dispatch GH client has no single-flight / throttle (P2)

Follow-up surfaced while reviewing item 4 (parallel dispatch waves, PR #1051). Item 4
overlapped the six per-dispatch resolutions in one `Promise.all` wave, which is the right
per-dispatch fix, but it exposes a fleet-level shape the wave alone doesn't address: when
several steps of the SAME run advance near-simultaneously (e.g. a coder finishing while the
sweeper re-drives, or a tester→fixer epoch), each dispatch independently mints the run's
installation token and probes the SAME work branch, and firing them concurrently nudges GitHub's
**secondary** (concurrency/abuse) limits sooner than the old serial chain did. Scope of the real
GitHub traffic per dispatch is small: `mintInstallationToken` already rides `GitHubAppRegistry`'s
in-memory token cache (a true mint only on a cold isolate / near expiry), and `ensureWorkBranch`
is the one guaranteed round-trip (get-ref, maybe create-ref); the other four wave members are
DB/local. So this is a **defensiveness + de-duplication** slice, not a hot-loop fix.

**Fix (through the blessed seams, both runtimes):**

- **Single-flight / request coalescing** on the shared `FetchGitHubClient`, keyed by
  `installationId` (token mint) and `(repo, branch)` (`ensureWorkBranch` probe), so N concurrent
  same-run dispatches collapse to one in-flight call each. This is the biggest real dispatch-path
  win and the "concurrency-aware" piece.
- **Reuse item 2's `branchHeadSha` cache** for the dispatch-path branch probe instead of a fresh
  get-ref per dispatch (the gate-poll client already caches it; thread the same slice through).
- **Global throttle + `Retry-After` honoring** (token-bucket / `p-limit`) on the client so a
  fleet-wide advance storm degrades gracefully instead of tripping abuse detection.

Route cached reads through an `AppCaches` slice, NOT a homebrew `Map` (CLAUDE.md caching rule).
An installation token is self-expiring, so its slice may keep a real TTL even in
`ISOLATE_SAFE_APP_CACHES_PROFILE` (like `fragmentDocumentBody`); the single-flight wrapper is a
thin in-flight-promise map on the client, invalidated by nothing (it only lives for the call's
duration). Keep the runtimes symmetric: the client + its cache slice land for both facades at
once. Join-batching does NOT apply: the wave members hit heterogeneous endpoints, not a
loop of point-reads over a list.

### 25. No per-block execution index: `getByBlock` is a full scan per call (P1)

`execution.getByBlock` (`frontend/app/app/stores/execution.ts:182-190`) filters the WHOLE
`instances` array on every call. Its hot callers, all re-run per execution event:

- `TaskPipelineMini.vue:29`: a computed per task card (the mini pipeline is mounted on every
  card), so O(cards × runs) per event.
- `useFrameLanes.ts:83`: `classify` calls it per task, so the swimlane assembly (item 10) is
  O(tasks × runs) per frame per recompute. This contradicts the composable's own header comment
  ("every cross-block lookup below is a Map read off an index the stores already maintain"): the
  gate lookups are Map reads, `getByBlock` is the one that is not.
- `useTaskExpansion.ts:83,117`: per measurement pass while the board is awake (hover probe), and
  per task when deep-zoomed.

The same event also invalidates `byId` (`execution.ts:134-138`), so every card's
`outcomeReadable` (`TaskCard.vue:123-129`, running contracts' `composeRunOutcome`, six passes
over the run's steps) recomputes per event regardless of which run changed.

`TaskCard` additionally scans GLOBAL lists although per-block maps exist for exactly this:
`openDecisions.find` / `openApprovals.find` (`TaskCard.vue:236,253`; the maps are
`decisionsByBlock`/`approvalsByBlock`, `pendingGates.ts:76-91`, whose docstring names this very
pattern as what they replace). Same shape at smaller N: `recurring.byBlock` is a `schedules.find`
per card (`stores/recurringPipelines.ts:36-38`) and `defaultPipeline` re-scans the pipeline list
per card (`TaskCard.vue:82-102`, `stores/pipelines.ts:129-148`).

**Fix:** one `byBlockLive` computed Map on the execution store beside `byId`, collapsing to the
live-preferred run with the SAME rule `getByBlock` applies today (stated once; the stale terminal
predecessor beside a live successor is the case to pin in a store test), and `getByBlock` reads
it. Switch `TaskCard`'s two finds to the existing byBlock maps; index `recurring.byBlock` and the
pipeline-default lookup the same way. Pure SPA change, PR-sized, and it multiplies with item 10:
each removes a factor of the O(frames × tasks × runs) product.

**Landed ([#2023](https://github.com/kibertoad/cat-factory/pull/2023)):** `byBlockLive` is a single pass stating the preference rule as "replace whatever is held
whenever it is TERMINAL", which is the array form (`find(live) ?? at(-1)`) exactly: the first live
run wins and is never displaced, and with no live run the last terminal one wins. `getByBlock` is
now a Map read, so `TaskPipelineMini`, `useFrameLanes.classify` and `useTaskExpansion` all pay O(1).
`TaskCard`'s two global `find`s read `decisionsByBlock` / `approvalsByBlock`, `recurring.byBlock`
indexes its schedules, and `pipelines.getPipeline` indexes the catalog by id. Both orderings of the
retry-predecessor case are pinned in `execution.spec.ts`. Not addressed here: `outcomeReadable`
still recomputes per card on every event because `byId` invalidates wholesale (item 20/29).

### 26. The activity pulse re-wakes the DOM-measuring loops on every card re-render (P2)

Item 11's follow-up. The canvas MutationObserver is deliberately broad
(`useBoardActivity.ts:73-78`: `childList` + `subtree` + `style`/`class` attributes), which is
what lets it catch every geometry change without enumerating causes. The cost: every Vue-driven
card re-render (each execution event on a busy board) fires `pulse()`, and each wake runs the
settle tail of ≥ 4 frames (`utils/settlingLoop.ts:44`), so under a steady event stream the two
loops never actually park. Each expansion recompute does `document.elementFromPoint` plus a
`getByBlock` (hover probe, any zoom) and, when deep-zoomed, a `querySelector` +
`getBoundingClientRect` per task plus an O(k²) overlap pass (`useTaskExpansion.ts:76-159`); the
edge overlay re-measures every link (`TaskDependencyEdges.vue:144-164`). `useTaskExpansion` also
registers a second capture-phase `pointermove` on the same canvas the pulse already listens to
(`useTaskExpansion.ts:172-177`).

**Fix sketch (measure first):** the loops are cheap while parked, so the question is how often a
live board actually parks. Options that keep item 11's settle-tail insight intact: have the
observer ignore mutations inside subtrees the overlays own AND rate-limit re-wakes while no
gesture/camera/geometry-affecting change happened (a card's text-content churn does not move
cards); or split the hover probe (cheap, per-frame) from the deep-zoom sweep (expensive, only
needed on real geometry change). Fold the duplicate `pointermove` into the pulse's listener.

**As landed (this PR): the pulse classifies its own sources, and one pass measures once.**

The wake sources split in two. A gesture, a `ResizeObserver` / window resize and the camera's
explicit `pulse()` stay unthrottled: those are the user moving something, and an arrow lagging the
card it points at is the bug item 11 fixed. MUTATIONS go through `utils/boardWakeGate.ts`, which
admits the first straight through and then at most one per 250ms for as long as the stream lasts, so
a board taking an execution event every few frames wakes the loops a few times a second instead of
continuously. The interval is several times the ~66ms settle tail, which is what lets the loops park
BETWEEN renders on exactly the board where measuring costs the most. The gate is a pure factory over
an injected scheduler, so its leading-edge / owed-wake / idle behaviour is pinned by unit tests
rather than by a timer.

Rate-limiting wakes without making a wake cheaper would have left the expensive pass expensive, so
the second half is `utils/blockRects.ts`: ONE `querySelectorAll` per pass plus a per-pass rect memo,
shared by both drivers. The edge overlay ran two `document.querySelector` scans and two
`getBoundingClientRect` reads PER LINK, so a task with five dependencies was found and measured five
times in one frame; the expansion sweep ran a scan per candidate task. First-in-document-order wins
per id, which is what `document.querySelector` returned before, so a card also rendered outside the
canvas resolves to the same element it always did.

`useTaskExpansion`'s second `pointermove` listener is gone: the pulse already listened for the same
gestures on the same element, so it tracks the position and the driver reads it inside its pass. One
trap that fold surfaced, documented at the site: the pulse listens in the CAPTURE phase, where a
non-bubbling `pointerleave` fired at a descendant is still seen, so only the canvas's OWN leave
clears the pointer. Clearing on any descendant's would collapse the hovered card the moment the
pointer crossed one of its inner elements.

Two things review caught, both about the boundary of "unthrottled". The gesture listeners bind to
the WINDOW, not to the canvas element: `useBlockDrag` tracks the pointer on the window precisely so
a dragged card keeps following it past the canvas's edge, and the top overlay region and the
inspector are SIBLINGS painted over the canvas, so a canvas-bound listener went silent for as long
as the cursor crossed one of them and the arrows fell back to the 250ms mutation wake during the
one interaction this design exists to keep smooth. Capture on the window sees the same events
wherever they are dispatched, and the `pointerleave` check is on the TARGET, so it reads unchanged.
And `measureBlocks` defers its query to the first lookup: the edge overlay builds a pass every awake
frame and, on a board with no links of any kind, asks it for no card at all, where the per-link
scans it replaced did no DOM work there either. Deferring keeps that in the helper, which both
drivers inherit, rather than as a link-count guard at a call site a fifth overlay would miss.

Not done here, deliberately: teaching the observer to ignore the overlays' own subtrees. The drivers
already write their attributes outside its filter, so the wakes that would drop are the ones the
rate limit now bounds anyway.

### 27. Observability/kaizen stores grow unbounded per session and survive board switches (P2)

- `observability.appendCall` (`stores/observability.ts:127-144`): per `llmCall` event, a linear
  dedupe over the run's whole call list plus a spread of BOTH the run-keyed record and the entire
  array. The opened-panel gate is real (an unopened run accumulates nothing), but an opened run's
  list is never trimmed, so a long watched run accumulates quadratically.
- The observability store is absent from `resetPerBoardCaches`
  (`stores/workspace/hydrate.ts:38-50`), so `callsByExecution`, `contextByExecution`,
  `searchQueriesByExecution` and the tool-call sinks (`stores/observability/toolCalls.ts:55-81`)
  persist across every board the session visits; no execution id is ever evicted.
- `kaizen.upsert` (`stores/kaizen.ts:117-128`) prepends every stream-pushed grading into
  `history` UNCONDITIONALLY (its own comment says "if it's been loaded", but the else-branch
  prepends regardless), with no opened-screen gate like `appendCall`'s; kaizen is also absent
  from `resetPerBoardCaches`, and `byExecution` grows a key per run forever.
- `notifications.liveWrites` (`stores/notifications.ts:43`) is trimmed only inside `hydrate`, so
  a long stream period carrying only targeted events grows it one entry per notification id.

**Fix:** cap the per-run call log (ring buffer, and per Degrade loudly the cap states what it
dropped), gate kaizen's history fold on the screen having loaded, add observability + kaizen to
`resetPerBoardCaches`, trim `liveWrites` on upsert too. The e2e live-update specs are the guard
that an eviction doesn't blank an open panel.

**LANDED,** all four, plus the one thing the fix owed the reader:

- The call log is capped per run, and the cap RECORDS what it evicted: `droppedLiveCallCount`
  feeds a line in the panel, because a capped list is not a prefix and a reader who cannot see the
  number concludes the run made exactly the calls they are scrolling. The bound is
  `LLM_CALL_LIST_LIMIT` (contracts), which is the SERVER's own read bound rather than a smaller
  number of the client's: sized lower, the first live event on a run whose persisted log fills a
  read would evict rows the server did answer with and report them as live-evicted, which is a
  count of calls the panel is missing for a reason that never happened. At this size an eviction
  means the run has outrun what one read could show either way, which is the same story the server
  tells by truncating, so the copy does not offer a reload as the remedy.
- Kaizen's `history` fold is gated on the SCREEN having asked for it, and the gate is set when
  `loadOverview` STARTS rather than when it resolves, so a grading pushed while that fetch is in
  flight still lands (which is what the reconcile is for). `byExecution` stays ungated: the run
  windows read it without loading first.
- Both stores now reset on a board switch (`resetPerBoardCaches`), including the tool-call sinks.
- `notifications.liveWrites` is bounded on upsert too. `hydrate` already forgot what a snapshot had
  reconciled, which bounded it by what is genuinely in flight; the case that needed a second bound
  is a long stream period carrying only targeted events, where no hydrate ever runs.

### 28. Full-refresh fan-out: direct `refresh()` call sites, a starvable debounce, stacking retries (P2)

One `workspace.refresh()` is the client's heaviest operation: the ~20-read snapshot aggregate
plus 31 hydrate calls into 24 stores (`stores/workspace/hydrate.ts:67-144`). Three shapes
multiply it:

- **~35 call sites bypass the stream's debouncer** with a direct `await ws.refresh()`: 11 in
  `stores/execution/commands.ts`, 7 in `stores/riskPolicies.ts`, 4 in
  `stores/recurringPipelines.ts`, 3 each in `sharedStacks.ts` / `consensusGroups.ts` /
  `board/mutations.ts`, plus notifications/bootstrap/documents/BudgetSettings. A mutation that
  also triggers a server-side coarse `board` event pays the snapshot twice (once directly, once
  debounced).
- **`debouncedBoardRefresh` is trailing-only with no max-wait** (`useWorkspaceStream.ts:81-86`):
  a sustained sub-300ms coarse-event stream re-arms the timer forever, so the board stops
  resyncing exactly when the workspace is busiest.
- **Retry chains stack**: `refreshWithRetry` (up to 4 fetches with backoff,
  `useWorkspaceStream.ts:69-79`) is never aborted when a newer debounce fires; the `refreshSeq`
  guard (`stores/workspace.ts:207,226`) discards the stale HYDRATE but every request is still
  issued. Related: `environmentTest.hydrate` fires a best-effort point-read per preserved
  still-running run per refresh with no in-flight tracking (`stores/environmentTest.ts:57-73`),
  so overlapping refreshes duplicate the same GET.

**Fix:** one refresh funnel (single-flight + max-wait debounce) that the stream AND the mutation
call sites go through; where a mutation's own response already carries the authoritative entity,
hydrate that store directly instead of refetching the world; an in-flight map for
`reconcileRun`. Must respect the live-push coherence rules: the funnel keeps the
capture-baseline-then-hydrate ordering `refresh()` already does.

**Landed ([#2023](https://github.com/kibertoad/cat-factory/pull/2023), `stores/workspace/refreshFunnel.ts`):** the funnel IS `refresh()`, so the ~35 direct call
sites needed no edit and a new mutation has nothing to opt into. It is deliberately NOT plain
single-flight: a caller that mutated and then refreshed is entitled to a snapshot read AFTER its
call, so a call arriving mid-fetch joins a single QUEUED follow-up rather than the in-flight
request. N concurrent callers therefore cost one extra fetch between them, never one each, and no
caller ever observes a pre-mutation world. The stream's debounce gained a 2s max-wait cap (trailing
alone re-armed forever under a sustained sub-300ms stream, so the board stopped resyncing exactly
when it was busiest) plus a coverage check: `refreshMark()` / `hydratedSince()` let it drop a
resync that some mutation's own refresh already served, which is the double-snapshot the finding
opens with. The `refreshSeq` guard is gone: with one fetch at a time, two snapshots cannot resolve
out of order, and that guard existed only to order them.

Serializing is what makes the two bounds below load-bearing, and both were added in review:

- **The slot has a 30s DEADLINE and aborts the request.** The wretch client sets no timeout, so a
  stalled connection can leave a GET pending indefinitely; behind one slot that single stall wedges
  every refresh, the resync and the retry chain at once. A deadline turns it into an ordinary failure
  they can all act on, and a snapshot arriving after it is never applied.
- **A queued follow-up is tagged with the board it was queued FOR** and stands down on a switch,
  rather than reading the CURRENT board on behalf of a caller that asked about the old one.

`refreshWithRetry` chains stand down when a newer one starts, and a stood-down chain HANDS ITS CALLER
the newer chain rather than resolving: `socket.onopen` announces `connected` off that promise, so
resolving early would announce a board whose reconcile is still in flight. `reconcileRun` dedupes
its point-read with one queued follow-up, for the same reason the funnel is not plain single-flight:
the outstanding read may predate the run reaching terminal, and nothing asks a third time.

Behaviour to watch: the coverage skip assumes the server emits a coarse `board` event only AFTER
committing what it announces. Not addressed here: hydrating a mutation's own response instead of
refetching the world, which is a per-call-site change rather than a funnel one.

### 29. Deep reactivity over the two biggest arrays (P3)

`execution.instances` (`stores/execution.ts:24`) is a deep-proxied `ref` over every
run → steps → subtasks → items, and the swimlane assembly + cards read step fields constantly.
The store only ever whole-array replaces, index-assigns or pushes (no in-place property
mutation), so `shallowRef` plus an explicit trigger on the two write sites is viable and removes
proxy overhead from every step-level read. `board.blocks` (`stores/board.ts:32`) is NOT a
drop-in: optimistic updates mutate blocks in place (`stores/board/placement.ts:65-183`,
`board/mutations.ts:125-129`, `board/removal.ts:56-81`); convert those to object replacement
first or leave it. Reactivity regressions are silent, so the store unit suites plus an e2e pass
are the bar.

**LANDED for `execution.instances`; `board.blocks` stays as it was.** The premise needed one
correction: the store does NOT only replace, index-assign and push. `echoAfter` lets an action
store patch one step (`step.prReview = …` and its four siblings), which a shallow ref cannot see.
That turned out to help rather than block: `echoAfter` is the ONE seam every such `assign` goes
through, so the whole conversion is three write sites, `hydrate`/`cancel` (a whole array replace,
which a shallow ref tracks itself) plus `upsert` and `echoAfter`.

`triggerRef` alone is NOT enough at those two, and that is the trap worth recording. Under a shallow
ref nothing in the run graph is a proxy, so the only dependency a reader can hold is the ref, and
nearly every reader holds it through an identity-stable chain (`computed(() => getInstance(id))` to
`steps[i]` to one field). A trigger re-runs the first computed in that chain, Vue then compares its
recomputed value to the previous one, and an IN-PLACE patch makes them `===`: propagation stops
there and the window never updates. So `echoAfter` applies the patch to a COPY of the run and its
steps and swaps that in. The store spec pins each write shape twice, on the array and through the
`getInstance` chain, because the array-level assertion is exactly the one that cannot see this.

`board.blocks` is unchanged and still blocked for the reason stated: optimistic placement mutates
blocks in place across three modules.

### 30. Store/composable hygiene: identity churn, uncached derived counts, listener leaks (grouped, P3)

- **Whole-record clones to write one key**: the review-family stores (`requirements.ts:97-99`,
  `clarity.ts:86-88`, `brainstorm.ts:83-85`, `consensus.ts:30-32`, `docInterview.ts:30`,
  `initiatives.ts` upsert) and `notifications.byBlock` (`notifications.ts:84-91`, fresh array
  per block per event): every consumer keyed on an UNCHANGED id re-runs. Patch per key or share
  structure.
- **Derived counts as plain re-filtering functions**, composing into 5+ passes per render
  (`requirements.ts:77-95` and siblings); `requirements.backgroundStage` (`:61-65`), on the
  per-card path, scans the recommendation list per call. Make them computeds/Maps.
- **`useUpsertList` has no id→index map** (`useUpsertList.ts:31-50`); `environmentTest`
  hand-rolls the same linear lookups (`environmentTest.ts:82-94`).
- **`useNowTick` ticks for the mounted lifetime** whether or not anything is running
  (`useStepTimer.ts:63-74`; `isRunning` gates the render, not the tick), and `useStepTimer`
  creates one PER invocation (`:87`) against its own one-interval intent (`:57-62`): N mounted
  `StepRunMeta`s means N independent 1s intervals.
- **`useBlockDrag` window listeners leak on a cancelled drag**: `pointermove`/`pointerup` are
  removed only inside `onUp` (`useBlockDrag.ts:68-70,81-82`); no `pointercancel`, no unmount
  cleanup, so a touch interruption strands both listeners and a stuck `draggingId`.
- **`useViewport` is not the singleton its docstring claims** (`useViewport.ts:22-27`): three
  media-query listeners per calling component. `createSharedComposable` shape.
- **Missing single-flight on panel loads** (two concurrent openers fire two requests):
  `observability.load`/`loadContext`/`loadSearchQueries`/the tool-call loads,
  `kaizen.loadForExecution`, `consensus.load`, `docInterview.load`. The
  requirements/clarity/brainstorm per-key in-flight-promise maps (`requirements.ts:132-150`) are
  the model; `docInterview.load` also lacks a result-ordering ticket.

**LANDED,** with one item narrowed and one left where it was:

- **`useBlockDrag` listener leak (a bug, not a cost).** `pointercancel` and unmount are both
  handled now, through one `detach` every exit shares plus a scope-dispose hook. A cancel also puts
  the local preview BACK: nothing was persisted, so leaving it would show a position the server
  does not hold and the next refresh would silently snap the block back.
- **`useViewport` is the singleton its docstring claimed** (`createSharedComposable`): three media
  queries for the app, not three per calling component.
- **The wall clock is shared AND gated.** One ticker per interval, refcounted, running only while
  something wants it; `useStepTimer` subscribes exactly while its step is running, which is also
  when its values can change at all. N mounted `StepRunMeta`s used to mean N 1s timers, each
  ticking for the component's whole life.
- **`useUpsertList` has a key index**, rebuilt LAZILY: the two writes that move existing positions
  (a prepend, a removal) invalidate rather than maintain it, so a burst of them does not pay a
  rebuild each. It also invalidates when a caller replaces `items` wholesale, which the returned
  ref deliberately allows.
- **Single-flight on the panel loads**, through one `useSingleFlight` seam: observability's three
  reads plus both tool-call reads, `kaizen.loadForExecution`, `consensus.load`,
  `docInterview.load`. It coalesces, it does not cache: the entry drops when the promise settles.
  Coalescing `loadForExecution` also RETIRED kaizen's per-execution load ticket, which now had
  nothing left to order; the overview's ticket stays, that load not being keyed.
- **`docInterview.load` needed no ordering ticket after all**: its `upsert` is monotonic by the
  session's own `updatedAt`, which is a stronger rule than a ticket and already covers a slow fetch
  resolving after a live push.
- **Derived counts**: `requirements`' five composing predicates share one tally memoised on the
  review OBJECT (`store` replaces it on every write, so identity self-invalidates), and
  `backgroundStage`'s recommendation scan is a computed `Set` instead of a per-card pass.
- **Whole-record clones are NOT done.** The review-family stores and `notifications.byBlock` still
  rebuild a record/array per event. Sharing structure there means changing what each store hands
  its consumers, which is a bigger change than the rest of this group and wants its own slice.

## Conventions & gotchas (carry between slices)

- **Every persistence change lands on BOTH runtimes in the same PR** (D1 migration ⇄
  Drizzle schema + `pnpm db:generate` migration), with a conformance assertion for any new
  port method. A facade-parity gap is a showstopper (CLAUDE.md).
- **New batch/projection reads are PORT methods, not repo-internal helpers**: add to the
  kernel port, implement in both repos, copy the `listByIds` good citizens. Chunk `IN`
  lists like the existing repos do.
- **Caches go through the AppCaches seam, never a new Map** (items 7–9, 23). Register in
  the kernel interface + BOTH profiles; our own mutable DB state is pass-through
  (`enabled: false`) in `ISOLATE_SAFE_APP_CACHES_PROFILE`; invalidate on every write path;
  wrap nullable values as `{ value: T | null }`. See
  [`caching-layer.md`](./caching-layer.md) for the proven pattern + deviations.
- **Two deliberate non-seam caches are correct; leave them:**
  `GitHubAppAuth`'s installation-token cache (secrets must never ride the invalidation
  bus; per-process is the right scope) and the CI gate's `step.gate.maxAttempts` stamp.
  The `repoId` memo (item 2) joins this family: immutable mapping, process-level Map is
  fine (precedent: `ownerAppCache`).
- **Frontend live-push changes must respect the coherence rules** (CLAUDE.md "Real-time
  store coherence"): monotonic refresh guard stays, REPLACE-hydrates must not drop
  live-only state, and every ordering fix ships a store-level unit test pinning the race.
  Item 6 is the highest-risk slice in this initiative for exactly that reason: treat the
  e2e suite as the guard, and a flaky spec after the change as a blocking bug.
- **Wire-shape changes (items 5, 6) are breaking and that's fine**: pre-1.0, no
  back-compat shims; flag in the changeset; land contracts + backend + SPA together.
- **Don't "fix" what the audit verified as already optimal.** The audits explicitly
  cleared: snapshot assembly (`Promise.all` + batched reads), the stale-run sweeper and
  retention sweeps (indexed, projected), per-poll writes (CAS-guarded, idle-skipping),
  poll payloads (lean, no transcript), local transport (no per-poll shell-outs), LLM proxy
  telemetry (deferred via `waitUntil`, delta-stored prompts), prompt/fragment composition
  (cached at the expensive layer). Don't re-churn these. The 2026-08-14 frontend re-audit
  adds: the capabilities-manifest signature (`modular/capabilities.ts`, a canonicalize +
  stringify per refresh) is a documented, deliberate tradeoff buying skip-reprojection and
  its docstring explains why a field list is the wrong fix; `appendCall`'s opened-panel
  gate is correct (the cap in item 27 is about AFTER opening); the lane pure functions
  (`laneSort.ts`/`swimlanes.ts`) are linear or n·log n with a stable final tiebreak;
  `useTaskExpansion` prunes its height map every pass; `board.getBlock`/`unmetDeps`/
  `epicMembers` all ride the single-pass index. Don't re-churn these either.
- **Measure before/after where cheap**: for engine slices, the per-tick query count in the
  conformance/durable-execution tests is the honest signal; for frontend slices, the e2e
  suite plus a `--repeat-each` run under load.
- Changeset per slice (most touch versioned packages); empty changeset for doc-only
  updates to this tracker. Format the whole tree (`pnpm exec oxfmt .`), never a subset.

## Suggested slicing (PR-sized)

1. Item 2 (repoId memo + branchHeadSha + PAT probe-scope): pure server package, big win.
2. Item 3 (projected `listLiveBlockIds` + index, both runtimes + conformance).
3. Item 1 (gate `attachStepMetrics` to step-boundary emits).
4. Item 4 (parallel waves in `buildJobBody`; context-snapshot record stays awaited, being off
   the critical path, and a `void` would be dropped on the Worker).
5. Items 7+9 together (spend/workspace-settings slices), then 8 (account settings).
6. Items 15+16+17+18 as one "reuse the loaded list" batch-fix PR.
7. Item 12 (GitHub sync parallelism) + 14 (fan-out publisher).
   7b. Item 24 (dispatch GH client single-flight + throttle): natural pairing with item 2's
   `branchHeadSha` cache; both runtimes + conformance.
8. Frontend, re-sequenced 2026-08-14 (6 and 11 have landed): 25 first (the per-block
   execution index plus the card map reads: small, pure SPA, and the biggest per-event
   win), then 10 (lane-assembly breadth; multiplies with 25), then 5 (now three parts:
   by-id endpoint, store carry-forward, projection with `hasOutput`), then 26/27/28 in
   any order, then 20/29/30.
   8b. 25, 10 and 28 landed together (they share the per-event and per-refresh hot paths and
   the same store seams). 28 was pulled ahead of 5 deliberately: 5 is the one frontend item
   that is NOT groupable, because its own premise correction makes it three dependent slices
   (a by-id instance endpoint that does not exist on either runtime, then a store carry-forward
   for the heavy fields, and only then the projection), and 28 call sites read the instance
   SYNCHRONOUSLY off the hydrated cache today. Landing it beside two unrelated items would have
   put a wire-shape change and a new endpoint behind the same review as two pure SPA fixes.
   Remaining frontend order: 5 (as its own sequence), then 26/27, then 20/29/30.
   8c. 5, 27, 29, 30 and the landable half of 20 went together after 26. Grouping them was right
   for one reason worth reusing: 29 (`shallowRef`) and 5 (the carry-forward) touch the SAME three
   write sites in the execution store, and 30's single-flight seam is what 5's `ensureFull` needed
   anyway. What is LEFT of the frontend is now three things, each blocked on something outside this
   initiative rather than on effort: viewport culling (needs a frame extent known without
   rendering, see item 20), the hydrate stringify (needs a per-block revision on the wire), and
   whole-record clone removal in the review-family stores (changes what those stores hand their
   consumers).
9. Items 19, 21 as small both-runtime persistence PRs (19 pairs naturally with 5).
10. Items 22, 24 last among backend; each needs a short design note before code.

## Out of scope

- Rewriting the board renderer (virtualization beyond simple viewport culling), replacing
  Vue Flow, or a general snapshot-caching layer (the board is too mutable; verified not
  a clear win).
- The executor-harness image (dependency/runtime changes there are deliberate,
  image-bumping work; see CLAUDE.md).
- Coalescing/batching the event-publisher protocol itself (noted in item 14 as a design
  opportunity, not scheduled).
