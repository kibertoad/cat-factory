# Initiative: performance optimizations (prioritized)

**Status:** planned — analysis complete, no slices landed yet · **Owner:** core · **Started:** 2026-07-09

> This is the durable source of truth for a multi-PR initiative. Read it first before
> picking up the next slice; update the checklist at the end of each PR.

## Goal & rationale

A codebase-wide performance audit (service layer, persistence, execution-engine hot loops,
frontend, dispatch/gateway paths) surfaced a bounded set of verified inefficiencies. The
codebase is already unusually well-optimized — batched `IN` reads, SQL aggregates,
`Promise.all` snapshot assembly, CAS-guarded per-poll writes, delta-stored prompt telemetry
are the norm — so this initiative is NOT a rewrite; it is a prioritized punch list of the
places that deviate from the repo's own rules (N+1 ban, caching seam, batch-or-reuse) or
that put avoidable work on the hottest paths.

Prioritization is **hotness × scaling**:

- **P1** — on a hot loop (per poll tick, per emit, per LLM call, per dispatch, per board
  event) AND cost grows unbounded with data (run history, LLM calls per run, board size).
- **P2** — hot-ish (per dispatch / per sync / per event) or a rule violation with a
  correctness edge (banned homebrew caches → multi-replica staleness).
- **P3** — real but bounded: cold paths, small tables, or fixes needing a design decision.

Each row below is a self-contained slice: most are one small PR; a few frontend ones can
be grouped. Every persistence change lands on BOTH runtimes (D1 migration ⇄ Drizzle
schema + `pnpm db:generate`) with a conformance assertion, per "Keep the runtimes
symmetric" (CLAUDE.md).

## Target patterns (copy these, don't invent)

- **Projected/batched port method** instead of `SELECT *` + JS filter: copy
  `ServiceRepository.listByIds` / `WorkspaceMountRepository.countByServiceIds` — add the
  narrow method to the kernel port, implement in BOTH `D1*Repository` and the Drizzle
  repo, assert in the conformance suite.
- **AppCaches slice** for slow-moving reads: copy `repoProjection` / `accountModelPolicy`
  (`backend/packages/caching/src/appCaches.ts`) — register on the kernel `AppCaches`
  interface + both profiles, read through `caches.slice.get(key, group, load)`,
  invalidate on every write, pass-through (`enabled: false`) in
  `ISOLATE_SAFE_APP_CACHES_PROFILE` for our own mutable DB state. Full model:
  [`caching-layer.md`](./caching-layer.md).
- **Parallel waves** for independent awaits: group by true data dependency, then
  `Promise.all` each wave (see item 4's dependency analysis).
- **Reuse the already-fetched list**: thread a loaded block list / pipeline catalog into
  the loop body instead of re-reading per iteration (CLAUDE.md "No N+1").

## Per-item checklist

| #   | Pri | Area         | Finding (short)                                                                                                                     | Status  | PR  |
| --- | --- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------- | ------- | --- |
| 1   | P1  | engine       | `emitInstance` runs LLM-metrics GROUP BY on every emit (incl. progress ticks)                                                       | ⬜ todo |     |
| 2   | P1  | gateways     | Gate polls: uncached `repoId()` + PAT re-resolved per `request()` + `listCommits` head lookup                                       | ⬜ todo |     |
| 3   | P1  | persistence  | Execution lists `SELECT *` (incl. `detail` JSON) + JS status filter on dispatch guard; missing `(workspace_id, kind, status)` index | ⬜ todo |     |
| 4   | P1  | dispatch     | `buildJobBody` serializes ~6 independent I/O steps per dispatch                                                                     | ⬜ todo |     |
| 5   | P1  | frontend     | Board snapshot embeds full step outputs the board never reads                                                                       | ⬜ todo |     |
| 6   | P1  | frontend     | Coarse `board` event forces full-snapshot refresh; payload already carries `blockId`                                                | ⬜ todo |     |
| 7   | P2  | caching      | `SpendService` three banned TTL `Map`s (pricing / account / user limits)                                                            | ⬜ todo |     |
| 8   | P2  | caching      | `AccountSettingsService` legacy 30s `Map` (the named anti-pattern)                                                                  | ⬜ todo |     |
| 9   | P2  | caching      | `WorkspaceSettingsService.get` uncached; read per recorded LLM call                                                                 | ⬜ todo |     |
| 10  | P2  | frontend     | Shared `useBlockQueries` index invalidates ALL BlockNodes on every execution event                                                  | ⬜ todo |     |
| 11  | P2  | frontend     | Two unconditional 60fps RAF loops doing DOM measurement while idle                                                                  | ⬜ todo |     |
| 12  | P2  | integrations | `GitHubSyncService`: serial per-workspace fan-out + serial resource syncs                                                           | ⬜ todo |     |
| 13  | P2  | engine       | `AgentContextBuilder` re-walks block ancestry per resolver, sequentially                                                            | ⬜ todo |     |
| 14  | P2  | events       | `FanOutEventPublisher` forwards to N mounted workspaces serially                                                                    | ⬜ todo |     |
| 15  | P3  | engine       | `autoStartDependents`: per-dependent pipeline point-read in loop                                                                    | ⬜ todo |     |
| 16  | P3  | engine       | `InitiativeLoopService.spawnItem`: per-item pipeline point-read in loop                                                             | ⬜ todo |     |
| 17  | P3  | board        | `BoardScanService` reconcile: `addModule` re-lists whole board per module                                                           | ⬜ todo |     |
| 18  | P3  | board        | Block delete: teardown + remove each re-list the whole board                                                                        | ⬜ todo |     |
| 19  | P3  | persistence  | `notifications.listOpen` unbounded `SELECT *` (body+payload) on snapshot                                                            | ⬜ todo |     |
| 20  | P3  | frontend     | `board.hydrate` JSON.stringifies every block per refresh; global decision/approval maps rebuilt per event; no node virtualization   | ⬜ todo |     |
| 21  | P3  | persistence  | `password_reset_tokens.deleteExpired` full-table scan (no `expires_at` index)                                                       | ⬜ todo |     |
| 22  | P3  | spend        | `isOverBudget`: up to 3 live SUM aggregates per proxied LLM call (design decision)                                                  | ⬜ todo |     |
| 23  | P3  | engine       | `resolveRiskPolicy` re-reads merge preset per gate evaluation (optional slice)                                                      | ⬜ todo |     |

## Detailed findings

### 1. `emitInstance` runs the LLM-metrics aggregate on every emit — P1

`backend/packages/orchestration/src/modules/execution/RunStateMachine.ts:217` awaits
`attachStepMetrics` (→ `llmObservability.summarizeByExecution`, `:279`) inside the
`Promise.all` of every `emitInstance`. `emitInstance` fires on every state transition AND
on every non-idle poll fold (`RunDispatcher.pollAgentJobInner`) — i.e. on every
subtask-progress change or streamed follow-up during a live container run. Each call is a
`GROUP BY agent_kind` aggregate over `llm_call_metrics` for the whole run, so the drive
loop pays **O(emits × LLM-calls-in-run)**, on the critical path of the emit (despite the
adjacent "no serial latency" comment).

**Fix:** roll up metrics only on emits that surface them — terminal (`done`/`failed`) and
step-boundary transitions; skip `attachStepMetrics` on progress-only folds (the running
fold already computes a change reason — gate on "step advanced", not "subtasks changed").
No cache slice: this is live telemetry, not slow-moving config.

### 2. Gate poll path: uncached `repoId()` + per-request PAT re-resolve — P1

- `FetchGitHubClient.repoId()` (`backend/packages/server/src/github/FetchGitHubClient.ts:1184`)
  does an uncached `GET /repos/{owner}/{repo}` per call, and is called internally by
  `listBranches` (`:413`), `listIssues` (`:567`), `listCommits` (`:720`),
  `listCheckRuns` (`:738`) purely to backfill a numeric id.
- `GitHubCiStatusProvider.getStatus` (`backend/packages/server/src/github/GitHubCiStatusProvider.ts:57-62`)
  calls `listCommits({sha: branch})` + `listCheckRuns` per PR per poll tick ⇒ **two
  redundant `/repos` fetches per PR per tick**, plus `listCommits` can pull pages of
  commits just to read `items[0]`.
- `PatPreferringAppRegistry.installationToken` (`backend/packages/server/src/github/PatPreferringAppRegistry.ts:37-45`)
  re-resolves the initiator's PAT (DB read + decrypt) fresh on **every** `request()` — ~4
  times per CI poll.

Runs continuously while any run sits on the `ci`/`conflicts` gate; scales with PRs in
flight × poll ticks.

**Fix:** (a) memoize `repoId` per `(installationId, owner, repo)` in a process-level Map
(immutable mapping — same justified pattern as `ownerAppCache` in `GitHubAppRegistry.ts`);
(b) replace the `listCommits` head lookup with the existing
`branchHeadSha(installationId, ref, branch)` (`FetchGitHubClient.ts:420`); (c) memoize the
resolved PAT for the duration of one gate probe (scope it to the ambient
`runInitiatorContext` around the probe) so one poll does one lookup.

### 3. Execution list reads over-fetch `detail` and filter in JS; missing index — P1

`D1ExecutionRepository.listByWorkspace/listByService/listByServices`
(`backend/runtimes/cloudflare/src/infrastructure/repositories/D1ExecutionRepository.ts:26-62`)
and the Drizzle mirrors (`backend/runtimes/node/src/repositories/drizzle.ts:578-624`) are
all `SELECT *`, including `detail` — the full serialized pipeline + per-step state, the
biggest column on `agent_runs`. Hot callers discard almost all of it:

- `ExecutionService.ts:1875-1880` — the per-service task-concurrency guard **on the
  run-dispatch path** loads every historical run in the workspace, JSON-decodes every
  `detail`, then filters to `status ∈ {running, blocked, paused}` and maps to `blockId`.
- `ExecutionService.resumePaused` (`:3409-3410`) — `listByWorkspace` then
  `.filter(status === 'paused')`.
- The board snapshot (`WorkspaceService.snapshot`) also rides these list methods.

Cost grows unbounded with run history even though only live rows matter.

**Fix:** add a projected port method, e.g.
`listLiveBlockIds(workspaceId): Promise<Array<{ blockId, status }>>` →
`SELECT block_id, status FROM agent_runs WHERE workspace_id = ? AND kind = 'execution' AND status IN (…)`,
mirrored D1 ⇄ Drizzle + conformance assertion; use it for the guard and `resumePaused`.
Add the supporting index in the SAME slice (both runtimes):
`CREATE INDEX idx_agent_runs_ws_kind_status ON agent_runs (workspace_id, kind, status);`
(existing indexes — `(workspace_id, created_at)`, `(status, updated_at)`,
`(workspace_id, block_id)`, `(service_id)` — serve neither the guard nor `resumePaused`).
Consider a `detail`-free projection for the snapshot list as a follow-up if the board
cards prove not to need full steps (couples with item 5).

### 4. `buildJobBody` serializes independent dispatch work — P1 (latency)

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
resolvePackageRegistries, resolveTestSecrets, resolveWebSearchAvailability]`. Secondary:
`startJob` awaits the best-effort `agentContextObservability.record` before returning
(`:696-704`) — fire-and-forget it (still swallowing errors) so the driver proceeds to the
first poll immediately.

### 5. Board snapshot carries full step outputs the board never reads — P1

`WorkspaceSnapshot.executions` (`backend/packages/contracts/src/snapshot.ts:48-52`) embeds
per-step `output` (full agent prose), `custom`, `outputHistory`, `rework` docs, and
companion `verdicts` (`entities.ts:1786,1794,1974,1704-1707,1674`). The board UI consumes
only `status`/`progress`/`currentStep`/`steps[].state/subtasks/decision/approval`; the
prose is read lazily via `execution.getInstance` when a detail overlay opens. Every full
refresh (item 6) re-fetches, re-valibot-parses, and re-hydrates all of it — on an active
board the step outputs dominate snapshot bytes.

**Fix:** serve the snapshot a lightweight execution projection (omit
`output`/`custom`/`outputHistory`/`rework`/`verdicts` from steps); keep the full shape on
the by-id endpoint the overlays already use. This is a wire-shape change — pre-1.0, no
back-compat shim (CLAUDE.md); land contracts + backend projection + SPA consumption
together. Couples naturally with item 3's `detail`-free list projection.

### 6. Coarse `board` events force full refreshes the payload could avoid — P1

`useWorkspaceStream.ts:92-93`: every `board`-type event collapses to
`debouncedBoardRefresh()` → full `workspace.refresh()` (REPLACE-style hydrate of ~20
stores), even though `emitBoardChanged(ws, reason, blockId)` already carries the affected
`blockId`, and even though `execution`/`bootstrap` events already do targeted
`board.upsert(event.block)` (`:91,:99`). Backend emits `board` mid-pipeline for module
materialisation, blueprint reconcile, requirements updates, and **per task spawned by an
initiative loop** — a steady drip yields a full snapshot fetch every ~300ms debounce
window.

**Fix:** carry the changed block (or a compact delta) on `board` events for the
single-block reasons (`block-added`, `block-updated`, `dependency-toggled`,
`epic-assigned`) and upsert it; reserve the full refresh for genuinely structural reasons
(`cancel`, `block-removed`, reparent). MUST respect the live-push coherence rules in
CLAUDE.md ("Real-time store coherence") — keep the monotonic refresh guard, never let a
targeted upsert be clobbered by a stale refresh, and pin the new path with a store-level
unit test.

### 7. `SpendService` homebrew TTL Maps → AppCaches slices — P2

`backend/packages/spend/src/SpendService.ts:111-116` holds `pricingCache`,
`accountLimitCache`, `userLimitCache` — exactly the banned `{value, expiresAt}` Map
pattern, for slow-moving admin config read per proxied LLM call and per advance tick
(`resolvePricing` inside `isOverBudget`). On multi-replica Node, a budget edit on one
replica leaves peers serving the stale limit for the full TTL.

**Fix:** three slices (or a grouped `spendConfig`) on `AppCaches`, keyed by
workspace/account/user id; invalidate from the existing `invalidatePricing` /
`invalidateAccountLimit` / `invalidateUserLimit` call-sites (`:162-174`); pass-through in
the isolate-safe profile. Mechanical migration — the invalidation hooks already exist.
Fold into / coordinate with item 9 (same `workspace_settings` row).

### 8. `AccountSettingsService` legacy 30s Map — P2

`backend/packages/integrations/src/modules/accountSettings/AccountSettingsService.ts:72`
(TTL at `:34`, read `:83-99`, `invalidate` `:103`) — the exact Map CLAUDE.md names as the
anti-pattern this rule exists to stop. The hot non-secret read (model policy) was already
migrated to `caches.accountModelPolicy`; what remains is `resolve()` decrypting the
grouped secrets blob (Slack/Linear/web-search/S3) for runtime integrations —
lower-frequency, but incoherent across replicas after a write.

**Fix:** an `accountSettings` slice grouped by account id, invalidated in `write()`
(`:173`). Values stay in-process (the seam broadcasts invalidation keys, never values), so
decrypted secrets never cross the wire — same safety, plus coherence. Delete the Map.

### 9. `WorkspaceSettingsService.get` uncached on the per-LLM-call path — P2

`backend/packages/orchestration/src/modules/settings/WorkspaceSettingsService.ts:31-33` is
a bare repository read. `LlmObservabilityService.bodiesEnabled` reads it **per recorded
LLM call** (off user latency, under `waitUntil`, but still a DB read per call), and the
per-service task-limit start guard reads it too. `SpendService` reads the same row through
its own banned Map (item 7).

**Fix:** a `workspaceSettings` slice keyed by workspace id, invalidated from
`WorkspaceSettingsService.update` (`:71`); pass-through on the Worker profile. Natural
home to fold item 7's `pricingCache` into.

### 10. Shared block index fans one event out to every BlockNode — P2

`frontend/app/app/composables/useBlockQueries.ts:18-36`: the single `index` computed
(id→block, parent→children, epic→members) full-scans `blocks` and underlies nearly every
getter. Any `board.upsert` (fired per `execution` event, `useWorkspaceStream.ts:91`)
invalidates it, which invalidates every frame's `directTasks`/`allTasks`/`taskStats`/
`frameStatus` computeds in `BlockNode.vue` — one step-progress event triggers
O(frames × children) recompute across all cards.

**Fix:** preserve identity for untouched entries (patch the changed block in place and
keep `childrenByParent` entries for unchanged parents referentially stable), or memoize
per-frame derivations keyed by the frame's own child set. At minimum apply structural
sharing so progress-only changes short-circuit downstream `===` checks. Also incremental
maintenance for the global `openDecisions`/`approvalsByBlock` maps
(`stores/execution.ts:137-197`) and `agentRuns.byBlock` (`stores/agentRuns.ts:139-167`),
which rebuild over all runs × steps per event (kept in item 20 if split).

### 11. Two unconditional 60fps DOM-measuring RAF loops — P2

- `frontend/app/app/components/board/TaskDependencyEdges.vue:111-197` — `useRafFn` runs
  every frame while the board is open: per edge, `document.querySelector` +
  2 × `getBoundingClientRect` — O(edges) forced layout reads 60×/sec even idle.
- `frontend/app/app/composables/useTaskExpansion.ts:74-143` — cheaper (early-returns
  unless deep-zoomed), but when zoomed does per-task measurement + `elementFromPoint`
  every frame.

**Fix:** drive edge recompute from actual change signals (viewport change, drag, resize,
store edge/frame changes) coalesced into a RAF that idles when nothing is animating; or
short-circuit when neither inputs nor viewport changed since the last frame.

### 12. `GitHubSyncService` serial fan-out and serial resource syncs — P2

`backend/packages/integrations/src/modules/github/GitHubSyncService.ts:418-420`: `fanOut`
awaits each workspace in turn, and `syncRepo` invokes it ~6 times (branches / PRs /
issues / commits / checks / re-stamp) ⇒ ~6×N sequential writes per repo per sync tick for
a repo linked by N workspaces. The five resource syncs also run one-after-another though
they're independent GitHub resources; and each client call re-derives the repo id via the
uncached `repoId()` (~4 wasted `/repos` fetches per repo per sync — fixed for free by
item 2a). `resyncWorkspace`/`backfillInstallation` (`:531-548`) iterate repos serially.

**Fix:** `Promise.all` the per-workspace applies inside `fanOut`; `Promise.all` the
independent resource fetches within a repo (keep per-resource cursor writes ordered where
required); bounded concurrency for the per-repo backfill loop.

### 13. `AgentContextBuilder` re-walks ancestry per resolver, serially — P2

`backend/packages/orchestration/src/modules/execution/AgentContextBuilder.ts:236-239`:
`resolveEnvironment`, `resolveServiceConfig`, `resolveFrontendConfig`, fragment resolution
each independently re-walk frame→module→task via per-level `blockRepository.get`
(`resolveServiceFrame` `:474-476`, `:796-803`), awaited in sequence, plus per-dispatch
workspace + account reads (`:591-598`). Per dispatch (not per tick), so latency +
redundant reads rather than unbounded scaling.

**Fix:** resolve the service-frame block ONCE per `buildContext` and thread it into the
resolvers (several already accept a pre-fetched block — see the `resolveServiceFrame`
docstring); `Promise.all` the independent resolvers. Reuse-not-cache.

### 14. `FanOutEventPublisher` serial per-workspace forwards — P2

`backend/packages/server/src/events/FanOutEventPublisher.ts:57-108`: each event method
forwards to every mounting workspace with `for (…) await inner.x(ws, …)` — for a shared
service mounted on N boards, N serial DO round-trips (Cloudflare) per state transition.

**Fix:** `Promise.all` the forwards (independent, already best-effort). Coalescing rapid
same-workspace events (per-call `llmCallObserved`, per-step `executionChanged`) into a
short publish batch is a further opportunity — note it in the slice but treat as a design
change, not a defect.

### 15. `autoStartDependents` per-dependent pipeline point-read — P3

`backend/packages/orchestration/src/modules/execution/ExecutionService.ts:2834` (loop at
`:2828`): `pipelineRepository.get(workspaceId, dependent.pipelineId)` per dependent — a
banned loop point-read; the catalog is small and partially loaded already (`:2826`).
Fires on the merge/finalize path, linear in dependents.

**Fix:** load `listByWorkspace` once unconditionally, index into a `Map`, resolve pinned
pipelines and `firstPipeline` from it.

### 16. `InitiativeLoopService.spawnItem` per-item pipeline point-read — P3

`backend/packages/orchestration/src/modules/initiative/InitiativeLoopService.ts:369`
(loop from `:340`): a `pipelineRepository.get` per eligible item, per initiative tick.
Slot-capped, so bounded — but same fix as item 15: one `listByWorkspace` per tick, check
membership in memory.

### 17. `BoardScanService` reconcile re-lists the board per added module — P3

`backend/packages/orchestration/src/modules/boardScan/BoardScanService.ts:100-114` /
`:54-65` loop `boardService.addModule(...)`, and `BoardService.addModule` internally
re-runs `requireWorkspace` + `blockRepository.listByWorkspace` per call
(`BoardService.ts:658`) — one full board list per new module, though the reconcile already
holds the block list (`:85`). Per `blueprints` step, linear in modules.

**Fix:** add a batch module-insert seam on `BoardService` (or let `addModule` accept a
pre-loaded block list) so the reconcile builds all rows against the single read it holds.

### 18. Block delete pays two full board reads — P3

`backend/packages/server/src/modules/board/BoardController.ts:158-159` calls
`teardownForBlockTree` (`ExecutionService.ts:3502`) then `removeBlock`
(`BoardService.ts:1027`); each independently runs `listByWorkspace` + recomputes
`descendantIds` over the same subtree. Per DELETE request, linear in board size.

**Fix:** resolve the block list + descendant set once and thread it into both (e.g.
`teardownForBlockTree` returns the resolved subtree, `removeBlock` accepts it).

### 19. `notifications.listOpen` unbounded `SELECT *` on the snapshot — P3

`backend/runtimes/cloudflare/src/infrastructure/repositories/D1NotificationRepository.ts:74-84`
and `backend/runtimes/node/src/repositories/notifications.ts:65-72`: no `LIMIT`, pulls
`body` + `payload` JSON for every open notification into the polled board snapshot. The
predicate is indexed (`idx_notifications_open`) — the issue is over-fetch + unbounded
growth.

**Fix:** add a LIMIT (+ pagination) and project away `body`/`payload` if the inbox list
renders only title/severity/type until a card opens. Both runtimes + conformance.

### 20. Frontend hydrate/derived-state costs (grouped) — P3

- `frontend/app/app/stores/board.ts:105-122` — `hydrate` `JSON.stringify`s every incoming
  block per full refresh to preserve identity. Fix: compare a server-stamped
  revision/`updatedAt` per block instead (cheap once item 6 sends deltas).
- `frontend/app/app/stores/execution.ts:137-197` + `stores/agentRuns.ts:139-167` — global
  decision/approval/run maps rebuilt over all instances × steps on every upsert. Fix:
  incremental maintenance patching only the changed instance's entries.
- `frontend/app/app/components/board/BoardCanvas.vue:65-91` — no viewport culling (all
  frames mount), and `frameZIndex` in the `nodes` computed rebuilds the whole array on
  every hover/drag. Fix: cull off-viewport frames via Vue Flow viewport bounds +
  `containerSize`; move z-index to a class binding so hover doesn't reallocate all nodes.

### 21. `password_reset_tokens.deleteExpired` full-table scan — P3

`D1PasswordResetTokenRepository.ts:90-92` deletes on `expires_at < ?` with no index on
`expires_at` (schema: `backend/runtimes/node/src/db/schema.ts:205-216`, migration
`0017_password_reset_tokens.sql`). Table stays tiny (1h TTL), so impact is low — but the
codebase indexes `expires_at` everywhere else (`idx_environments_expiry`,
`idx_personal_subs_expiry`). One-line fix on both runtimes:
`CREATE INDEX idx_password_reset_tokens_expiry ON password_reset_tokens (expires_at);`

### 22. `isOverBudget` synchronous aggregates per proxied LLM call — P3 (design decision)

`backend/packages/spend/src/SpendService.ts:347-373`, awaited at
`LlmProxyController.ts:255` before every upstream forward: `totalsSinceForWorkspace`
(always) + account/user variants (when scoped) — SUM aggregates over `token_usage` per
call, latency on every model call, scan growing within the billing period. NOT a
slow-moving-config cache (a stale read under-gates spend). A very-short-TTL (2–5s)
memoized total keyed by `(tier, periodStart)` would collapse a running container's call
burst without meaningfully loosening the gate — but the correctness tradeoff needs an
explicit decision. Related: `token_usage.totalsSince` (the platform-wide safeguard,
`D1TokenUsageRepository.ts:86-103`) range-scans ALL workspaces' rows per check; if it
turns out to run per-call, a maintained running counter is the durable fix — verify call
frequency first.

### 23. `resolveRiskPolicy` re-reads the merge preset per gate evaluation — P3

`ExecutionService.ts:2861-2887`, called from the review/tester/human-test/visual gate
controllers + `MergeResolver`. Slow-moving admin config, re-read per gate evaluation
(≈ per advance / human action — NOT per fast poll: the CI gate already stamps
`maxAttempts` on `step.gate` and reuses it, `RunDispatcher.ts:3130-3132`, don't touch
that). Optional `mergePreset` cache slice keyed by `(workspaceId, riskPolicyId|default)`,
invalidated from `RiskPolicyService.create/update/remove/reseed` (`RiskPolicyService.ts:77-162`).

## Conventions & gotchas (carry between slices)

- **Every persistence change lands on BOTH runtimes in the same PR** — D1 migration ⇄
  Drizzle schema + `pnpm db:generate` migration — with a conformance assertion for any new
  port method. A facade-parity gap is a showstopper (CLAUDE.md).
- **New batch/projection reads are PORT methods, not repo-internal helpers** — add to the
  kernel port, implement in both repos, copy the `listByIds` good citizens. Chunk `IN`
  lists like the existing repos do.
- **Caches go through the AppCaches seam, never a new Map** (items 7–9, 23). Register in
  the kernel interface + BOTH profiles; our own mutable DB state is pass-through
  (`enabled: false`) in `ISOLATE_SAFE_APP_CACHES_PROFILE`; invalidate on every write path;
  wrap nullable values as `{ value: T | null }`. See
  [`caching-layer.md`](./caching-layer.md) for the proven pattern + deviations.
- **Two deliberate non-seam caches are correct — leave them:**
  `GitHubAppAuth`'s installation-token cache (secrets must never ride the invalidation
  bus; per-process is the right scope) and the CI gate's `step.gate.maxAttempts` stamp.
  The `repoId` memo (item 2) joins this family: immutable mapping, process-level Map is
  fine (precedent: `ownerAppCache`).
- **Frontend live-push changes must respect the coherence rules** (CLAUDE.md "Real-time
  store coherence"): monotonic refresh guard stays, REPLACE-hydrates must not drop
  live-only state, and every ordering fix ships a store-level unit test pinning the race.
  Item 6 is the highest-risk slice in this initiative for exactly that reason — treat the
  e2e suite as the guard, and a flaky spec after the change as a blocking bug.
- **Wire-shape changes (items 5, 6) are breaking and that's fine** — pre-1.0, no
  back-compat shims; flag in the changeset; land contracts + backend + SPA together.
- **Don't "fix" what the audit verified as already optimal.** The audits explicitly
  cleared: snapshot assembly (`Promise.all` + batched reads), the stale-run sweeper and
  retention sweeps (indexed, projected), per-poll writes (CAS-guarded, idle-skipping),
  poll payloads (lean, no transcript), local transport (no per-poll shell-outs), LLM proxy
  telemetry (deferred via `waitUntil`, delta-stored prompts), prompt/fragment composition
  (cached at the expensive layer). Don't re-churn these.
- **Measure before/after where cheap**: for engine slices, the per-tick query count in the
  conformance/durable-execution tests is the honest signal; for frontend slices, the e2e
  suite plus a `--repeat-each` run under load.
- Changeset per slice (most touch versioned packages); empty changeset for doc-only
  updates to this tracker. Format the whole tree (`pnpm exec oxfmt .`), never a subset.

## Suggested slicing (PR-sized)

1. Item 2 (repoId memo + branchHeadSha + PAT probe-scope) — pure server package, big win.
2. Item 3 (projected `listLiveBlockIds` + index, both runtimes + conformance).
3. Item 1 (gate `attachStepMetrics` to step-boundary emits).
4. Item 4 (parallel waves in `buildJobBody` + fire-and-forget context snapshot).
5. Items 7+9 together (spend/workspace-settings slices), then 8 (account settings).
6. Items 15+16+17+18 as one "reuse the loaded list" batch-fix PR.
7. Item 12 (GitHub sync parallelism) + 14 (fan-out publisher).
8. Frontend: 6 first (targeted board upserts, with store unit tests), then 5 (snapshot
   projection, coupled contracts change), then 10/11, then 20.
9. Items 19, 21 as small both-runtime persistence PRs.
10. Items 22, 23 last — each needs a short design note before code.

## Out of scope

- Rewriting the board renderer (virtualization beyond simple viewport culling), replacing
  Vue Flow, or a general snapshot-caching layer (the board is too mutable — verified not
  a clear win).
- The executor-harness image (dependency/runtime changes there are deliberate,
  image-bumping work — see CLAUDE.md).
- Coalescing/batching the event-publisher protocol itself (noted in item 14 as a design
  opportunity, not scheduled).
