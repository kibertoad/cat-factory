# Race-condition audit — July 2026

A systematic search for race conditions across the whole codebase, run as four parallel
sweeps: the shared engine packages (`backend/packages/*`), the runtime facades
(`backend/runtimes/*`), the frontend SPA stores (`frontend/app`), and the executor
harness / gates / credential paths. Every finding names the racing code paths with
file:line references (current as of this audit's commit), the concrete interleaving,
and a confidence tag:

- **CONFIRMED** — both racing code paths traced in the source.
- **PLAUSIBLE** — one path traced; the trigger needs an edge condition (timing, infra).

Verified-sound areas are listed at the end so they aren't re-reported as gaps.

---

## 1. Critical — features that are broken, not just racy

> **Status: ADDRESSED.** The `ExecutionWorkflow` no longer returns on `paused` (which
> made its instance terminal); it keeps the instance alive, sleeping between budget
> re-checks, so the run auto-resumes on budget-free or `/spend/resume` with no
> terminal-id trap.

### 1.1 Cloudflare: a spend-paused run can never be resumed; resume converts it into an auto-stopped failure — CONFIRMED

- `ExecutionService.resumePaused` (`backend/packages/orchestration/src/modules/execution/ExecutionService.ts:2629`) flips `paused` → `running` (correctly via CAS), then `workRunner.startRun(…, resumed.id)`.
- `WorkflowsWorkRunner.create` (`backend/runtimes/cloudflare/src/infrastructure/workflows/WorkflowsWorkRunner.ts:42-53`) creates the Workflows instance with `id: executionId` and **swallows** any error.
- `ExecutionWorkflow` (`backend/runtimes/cloudflare/src/infrastructure/workflows/ExecutionWorkflow.ts:198-200`) **returns** on `paused` — the instance becomes terminal.
- The sweeper's own doc (`backend/runtimes/cloudflare/src/infrastructure/workflows/sweeper.ts:8-12`) states a terminal instance "can NOT be recreated (instance ids are unique), so a re-drive via `create` is a silent no-op — the run must be FINALIZED instead."

Sequence: spend gate pauses a run → its workflow instance completes (terminal) → the user
frees budget and hits `/spend/resume` → the row flips to `running`, but
`workflow.create({ id: executionId })` fails on the terminal id and the error is
swallowed → no driver exists → ~5–7 min later the cron sweeper finds a stale `running`
run with a `terminal` instance and `finalizeOrphan` force-fails it ("its durable driver
ended without finalizing it"). The comment at `ExecutionWorkflow.ts:198-199` ("The
/spend/resume endpoint re-creates the workflow") directly contradicts the sweeper doc;
Cloudflare's documented Workflows semantics side with the sweeper.

Node is unaffected (pg-boss jobs are freely re-sendable), so this is also a
facade-parity bug. Fix shape: mint a fresh instance id on resume, exactly as
`retry`/`restartFromStep` already do (`ExecutionService.ts:2443-2447` documents why) and
as `GitHubBackfillWorkflow` does with its `Date.now()` suffix (`GitHubGateways.ts:18`).

> **Status: ADDRESSED.** Past the poll-read tolerance the `BootstrapWorkflow` no longer
> returns (terminal → sweeper force-fail); it keeps the instance alive and keeps polling,
> so a merely-busy container recovers.

### 1.2 BootstrapWorkflow's "leave it for the sweeper to re-drive" actually force-fails the job — CONFIRMED intent/behavior mismatch

- `BootstrapWorkflow.ts:71-77`: after `jobPollFailureTolerance` consecutive unreadable
  polls the workflow **returns**, leaving the job `running`, "so the cron sweep can
  re-drive it later (the container may recover…)".
- Returning makes the instance terminal (same mechanism as 1.1), so the sweeper takes the
  `finalizeOrphan` branch (`backend/runtimes/cloudflare/src/index.ts:252-262`) →
  `bootstrap.service.stop` — killing the container and failing the job, never the
  intended re-drive. A bootstrap that was merely busy (long clone/install) is stopped
  instead of recovered. Node's analogue re-enqueues correctly
  (`bootstrapRunner.ts:113-121`) — another silent facade asymmetry.

---

## 2. High — engine-wide structural races

> **Status: ADDRESSED.** A partial unique index on live execution rows per block (D1
> migration `0033` ⇄ Drizzle) plus an atomic `ExecutionRepository.insertLive` (ON CONFLICT
> DO NOTHING) make `start`/`retry`/`restartFromStep` refuse a concurrent double start with
> a 409 instead of creating two live runs. Cross-runtime conformance assertion added. The
> amplifiers (3.1 notification retry, 3.3 bootstrap double-start, recurring double-fire)
> still funnel through their own call sites and remain open.

### 2.1 No "one live run per block" constraint: concurrent starts yield two live runs, two drivers, two containers — CONFIRMED

- `ExecutionService.start` (`ExecutionService.ts:1216-1333`): mint fresh id →
  `deleteByBlock` → `upsert` → `startRun`, with no transaction or lock. Same
  delete-then-insert shape in `retry` (`:2498-2516`) and `restartFromStep`
  (`:2601-2619`).
- `idx_agent_runs_block (workspace_id, block_id)` is **non-unique** on both runtimes
  (`backend/runtimes/cloudflare/migrations/0001_init.sql:605`,
  `backend/runtimes/node/src/db/schema.ts:399`); only `(workspace_id, id)` is unique —
  the invariant is app-level only.

Interleaving: writers A and B (double-click on Start; a manual start racing a recurring
fire; notification-retry racing human retry) both run `deleteByBlock`, then each inserts
its own fresh-id row. Both succeed → two `running` rows for one block, each with its own
durable driver and its own container (the per-run workflow-id / `singletonKey`
exclusivity does NOT dedupe them — the ids differ), both mutating `blocks.status`, both
pushing to the same branch, double spend. `block.executionId` is last-writer-wins, so one
run becomes invisible to the UI but keeps writing; `getByBlock` has no `ORDER BY`
(`D1ExecutionRepository.ts:72-80`, `drizzle.ts:483-495`), so stop/retry/cleanup address a
nondeterministic row. All start guards (task limit `:1390-1455`, dependency gate
`:1353-1369`, retry's `status !== 'failed'` check `:2465`) are read-then-act.

Amplifiers (each independently CONFIRMED):

- **Recurring double-fire**: `RecurringPipelineService.fire`
  (`backend/packages/orchestration/src/modules/recurring/RecurringPipelineService.ts:273-368`)
  reads `getByBlock` long before `start()` persists, and `nextRunAt` advances only at the
  end. The Node recurring tick (`backend/runtimes/node/src/recurring.ts:25-39`) has **no**
  in-flight guard (unlike the kaizen sweeper beside it, `kaizen.ts:28-33`), and Cloudflare
  cron invocations are not mutually exclusive — overlapping sweeps both `listDue` the
  same schedule. `advanceCadence`'s whole-row upsert (`:370-380`) can also erase a
  concurrent user `update()` (silently re-enabling a just-disabled schedule).
  `KaizenService.runPending`'s atomic `claim` (`KaizenService.ts:150-171`) is the in-repo
  reference pattern `fire` lacks.
- **Notification double-act** (see 3.1) routes `retry` through the same hole.
- **Bootstrap double-start** (see 3.3): two containers force-pushing the same repo.

Fix shape: a partial unique index on live runs (`WHERE status IN ('running','paused',…)`)
or an atomic delete+insert (D1 `batch()` / Postgres transaction), mirrored on both
runtimes with a conformance assertion.

### 2.2 The optimistic-concurrency (rev/CAS) migration is one-sided: blind whole-row upserts clobber CAS-protected writes — CONFIRMED

The engine has a real OCC design (`ExecutionRepository.compareAndSwap`,
`kernel/src/ports/repositories.ts:136-146`; `RunStateMachine.mutateInstance`,
`RunStateMachine.ts:145-162`) — but only five human-action handlers use it
(`resolveDecision`, `requestStepChanges`, `rejectStep`, `requestHumanReviewFix`,
`resumePaused`). Everything else still force-writes the **entire serialized instance**:

- **The durable driver**: ~30 `executionRepository.upsert` sites in `RunDispatcher.ts`.
  The canonical window: `pollAgentJob` loads the instance (`RunDispatcher.ts:501`), makes
  an outbound container HTTP poll of up to 30 s
  (`CloudflareContainerTransport.ts:44`), then blind-upserts (`:553`; same shape at
  `:652`, `:1387`, `:2236`, `:2277`, `:2362`). `pollGate` has the same read → multi-second
  GitHub probe → blind upsert window (`:867-888` → `:2256-2279`). Any CAS'd human write
  landing inside those windows is silently erased — e.g. `requestHumanReviewFix` returns
  HTTP 200, then the driver's stale snapshot wipes `step.gate.pendingFix` and nothing
  dispatches until the user clicks again. The doc comment at `entities.ts:1525` claims the
  human write is protected; the driver's subsequent stale write defeats it.
- **Un-migrated human actions on the same rows**: `approveStep`
  (`ExecutionService.ts:2245-2264`, plain `get` → blind upsert — despite `mutateInstance`'s
  own doc listing "approve" as covered); `resolveCompanionExceeded` (`:1901-1958`, the code
  itself flags this at `:1902-1908` as "the remaining slice of the lost-update fix");
  every gate-window action going through `RunStateMachine.persistInstance` (`:124-127`) —
  `ReviewGateController.incorporate`/`offloadRecommendation`/`resumeRun`,
  `HumanTestController.signalAction`, `VisualConfirmationController`, `TesterController`,
  `CompanionController`. Traced interleaving: `proceed` (advances `currentStep`, upserts)
  racing `incorporate` (blind-persists a stale snapshot with the gate still parked) — the
  advance is reverted, the incorporation cycle re-runs on an already-advanced run, and a
  just-dispatched next-step container's handle is erased (orphaned container, wedged run).
  Concurrent `approveStep` vs `requestStepChanges` on one gate can leave a re-run in
  flight _and_ the run advanced past the gate.

Fix shape: route the remaining human actions through `mutateInstance`, and make the
driver's post-poll writes CAS-with-retry (re-apply the mechanical mutation on fresh
state) or narrow them to field-level patches (the bootstrap-job `json_set` column
patches are the in-repo model).

### 2.3 `cancel()`/`stopRun()` vs an in-flight driver iteration: run resurrection and terminal-state clobber — CONFIRMED mechanism (Node; narrower on Cloudflare)

A direct consequence of 2.2, called out separately because the effect is user-visible:

- `cancel` (`ExecutionService.ts:2654-2675`) deletes the run row and flips the block
  `planned`; `stopRun` (`:2685-2710`) kills the container then `failRun`. On Node,
  `PgBossWorkRunner.cancelRun` is an explicit **no-op** (`pgBossRunner.ts:96-100`).
- An in-flight `pollAgentJob` that loaded the instance before the cancel later
  blind-upserts its stale `running` snapshot — upsert **re-inserts the deleted row**. A
  zombie `running` run now drives a block that shows `planned`; the stale-run sweeper
  re-drives it; and because `stopRun` already killed the container, the next poll's 404
  maps to eviction → the automatic fresh-container restart can **re-spawn the container
  the user just stopped**.
- Related: `failRun` treats only `failed` as terminal (`RunStateMachine.ts:407-429`) — a
  `stopRun` racing a run that just completed (merger merged the PR, block `done`)
  re-marks the run `failed` and the block `blocked` even though the PR merged.

### 2.4 Spend budget gate is check-then-act with post-hoc metering: unbounded overspend under concurrency — CONFIRMED

- `SpendService.isOverBudget` (`backend/packages/spend/src/SpendService.ts:157-162`) reads
  a SUM; `record` (`:115-138`) appends after the fact. `TokenUsageRepository` has no
  reserve/conditional-increment primitive. Callers: `ExecutionService.stepInstance`
  (`:1506`) and the LLM proxy (`LlmProxyController.ts:269`), which meters only after the
  upstream call completes (`:306-321`).
- N concurrent agent steps / proxied calls each read totals just under the limit → all
  admitted; costs land minutes later. Overshoot ≈ in-flight concurrency × max cost per
  call — the safeguard structurally cannot hold under exactly the concurrent-agent
  workload the product generates. Partly inherent to post-hoc metering, but there is no
  reservation step or documented overshoot bound.

### 2.5 Requirement/clarity/brainstorm reviews: whole-JSON last-write-wins on every mutation — CONFIRMED

- `IterativeReviewService.mutateItem` (`.../review/IterativeReviewService.ts:538-552`),
  `patchReview` (`:527-536`), `RequirementReviewService.mutateRecommendation`
  (`:475-494`); the repository `upsert` is documented "create or replace"
  (`kernel/src/ports/requirement-review-repositories.ts:19`). No rev/CAS exists for
  review rows on either runtime (`D1RequirementReviewRepository.ts:82-115` ⇄
  `drizzle.ts:2326-2358`).
- Interleaving: reply to item 1 concurrent with dismiss of item 2 — both load the review,
  both write the full `items` array from their stale read; the loser's edit vanishes.
  Because `incorporate` requires zero `open` items, a lost dismissal blocks incorporation
  on a phantom open item. `incorporate` itself holds its snapshot **across an LLM call**
  (`:312-372`), so a human dismissal landing mid-incorporation is clobbered.
- `review()` is `deleteByBlock` → `upsert` (`:231-232`) with a non-unique index
  (`0001_init.sql:612`) — a double-click mints two live reviews (two reviewer LLM calls),
  and a parked run's decision can key to a different review than the window loads.

### 2.6 `GitHubInstallationService.connect`: the cross-account takeover guard is check-then-act — CONFIRMED shape (security-adjacent)

- `backend/packages/integrations/src/modules/github/GitHubInstallationService.ts:69-97`:
  `getByInstallationId` → reject-if-bound-to-another-account → `upsert` keyed by
  installationId, with a slow `githubClient.getInstallation` network call (`:82`) between
  check and write. Two concurrent `connect`s from different accounts both pass the check;
  the last upsert silently overwrites the loser's binding — the guard the code itself
  calls "an account-takeover primitive" never fires. No unique-constraint or
  conditional-write backstop.

---

## 3. Medium — engine and runtime findings

### 3.1 Notification `act` double-fires the side effect — CONFIRMED

- `NotificationController.ts:43-73`: read → check `status !== 'open'` → perform side
  effect (`mergePr`/`retry`) → mark acted (`:72`). Two concurrent acts (double-click, two
  members' inboxes, HTTP retry) both pass the check. `merge_review`/`pipeline_complete`
  → both reach `prMerger.mergeForBlock` (GitHub serialises the real merge; the loser
  surfaces a 500), and `issueWriteback` + `autoStartDependents`
  (`ExecutionService.ts:2069-2082`) run twice where the merger is unwired.
  `ci_failed`/`test_failed` → both `retry` → the 2.1 duplicate-run path. Fix shape exists
  in-repo: `PasswordResetTokenRepository.consume`'s atomic CAS
  (`PasswordResetService.ts:164-168`) — flip the status conditionally BEFORE the side
  effect.

### 3.2 Notification escalation sweep resurrects resolved notifications — CONFIRMED

- `NotificationService.escalateStale` (`NotificationService.ts:174-186`, driven by
  cron/interval concurrent with HTTP): `listOpen` snapshot → a human `resolve`s a card →
  the sweep upserts its stale copy (`status:'open'`, `resolvedAt:null`) as `urgent`,
  reopening an acted card (acting on it again hits 3.1). Same stale-copy pattern in
  `clearWaitingDecision` (`:151-163`). Fix: a conditional `UPDATE … WHERE status='open'`.

### 3.3 Bootstrap lifecycle — CONFIRMED (multiple)

- **Double-start, no dedup**: `BootstrapService.bootstrap` (`BootstrapService.ts:236-345`)
  has no existing-running-job-per-repo check (controller neither). Two POSTs → two
  containers concurrently force-pushing the same repo, two provisional frames,
  `linkRepoToBlock` (`:551`) last-writer-wins → one frame permanently unlinked.
  Concurrent `retry` (`:355-371`, read-then-act on `status==='failed'`) has the same hole.
- **Lost success side effects**: `pollBootstrapJob` writes `succeeded` FIRST (`:542`) then
  runs `stopContainer`/`linkRepoToBlock`/frame-`ready`/blueprint-start (`:544-572`)
  unguarded. A crash after `:542` + the driver's retried `step.do` hits the `:485`
  terminal early-return → job `succeeded` but the frame is stuck `in_progress`, the repo
  never linked (tasks then resolve the wrong repo via the `repos[0]` fallback), and the
  initial blueprint never fires.
- **`stop()` vs the final success poll** (`:588-622`): an unconditional `failed` patch can
  overwrite a just-succeeded job. (LOW-MEDIUM, PLAUSIBLE.)

### 3.4 CI gate passes on `none` checks in the post-push window — PLAUSIBLE (logic confirmed; timing external)

- `backend/packages/gates/src/gates.ts:71-91` (probe) +
  `kernel/src/domain/gate-logic.ts:94-95,110`: zero check runs → verdict `none` →
  treated as green ("no checks configured") → the run advances to `merger`.
- After a `ci-fixer` pushes, GitHub creates check runs for the new head **asynchronously**
  (seconds). A probe landing in that window sees zero checks and advances while the real
  CI is about to run — exactly the "merged with red CI" class the gate exists to prevent.
  Prior gate state (`failingChecks`/`lastVerdict` proving checks DO exist for this repo)
  is available on `gateState` but not consulted. Mitigation: treat `none` as `pending`
  when the gate previously observed checks or when `headSha` changed since the last probe.

### 3.5 Sweeper hazards on both runtimes

- **Node lease TOCTOU → double-drive** — PLAUSIBLE: the stale-heartbeat reclaim
  (`pgBossRunner.ts:240-316` + `reclaim.ts:45-73`) classifies an `active` job as orphaned
  on a stalled heartbeat, then `deleteJob` + re-`send`. A live drive whose heartbeat
  writes stall > ~3 min (DB blip, event-loop stall) while it sleeps between container
  polls gets a second driver. Container steps dedupe via deterministic job ids, but
  inline LLM steps (requirements review, companions) execute twice, and the two drivers'
  blind upserts (2.2) interleave whole-row snapshots.
- **Cloudflare: transient status-read error + 1 h hard-stall deadline can fail a live
  run** — PLAUSIBLE: an unreadable `instance.status()` maps to `missing`
  (`sweeper.ts:39-43`) — safe when the only action was an idempotent `create`, but
  `sweeper.ts:119-123` added a destructive action on `missing`: an execution stale > 1 h
  is `failStalled`. A legitimately-running run whose row hasn't changed in an hour (a
  long gate wait) + one transient read error → force-failed while its live instance keeps
  advancing and blind-upserting against the `failed` row.
- **Sweep overlap**: only the Kaizen sweep has an in-flight guard (CF `index.ts:99,398-418`;
  Node `kaizen.ts:28-47`). The stale-run, recurring, retention, environment and
  escalation sweeps can overlap themselves (slow tick > interval; `waitUntil` outliving
  the cron). Mostly absorbed by idempotency — except the recurring double-fire feeding 2.1.

### 3.6 Decision signal sent while the workflow isn't parked is lost; worst-case self-heal is 24 h on Cloudflare — CONFIRMED mechanics, mitigated

- CF: `signalDecision` sends `decision-${id}`; `ExecutionWorkflow.ts:202-220` parks in
  **24-hour** `waitForEvent` chunks. A signal landing between the advance that parked the
  run and the wait arming (or between chunk re-arms) is dropped; the DB write survives,
  and the re-loop self-heals — but only when the 24 h chunk expires. Sub-second window,
  day-long worst-case penalty, no operator signal.
- Node: the analogous re-send is an `ON CONFLICT DO NOTHING` no-op while the parked drive
  job is `active` (`pgBossRunner.ts:81-94`); the stale sweeper recovers in ≤ ~15 min.

### 3.7 Other confirmed read-modify-write clobbers

- **`WorkspaceSettingsService.update`** (`.../settings/WorkspaceSettingsService.ts:36-73`):
  concurrent patches load-then-write the full row — the loser's field (e.g. a lowered
  `spendMonthlyLimit`) silently reverts.
- **Board**: `removeBlock` (`BoardService.ts:737-810`) snapshots blocks, then ~6 awaited
  phases before `deleteMany` — a reparent committing in the window orphans a subtree
  moved into the doomed frame or deletes a task just moved out. `removeBlock` racing
  `ExecutionService.start` dispatches a container for a deleted task. Cross-home reparent
  (`:678-709`) copies row-by-row then deletes — a crash mid-way duplicates the subtree.
  `toggleDependency`'s whole-array patch (`:813-856`) loses one of two concurrent edge
  adds (the cycle race itself is mitigated by a post-write re-check).
- **`UserService.findOrCreateByIdentity`** (`.../users/UserService.ts:76-136`): two
  concurrent first logins create two users; the identity upsert re-points to the second
  → one session bound to an orphaned user (self-heals on next login; no privilege impact).
- **Environments** — PLAUSIBLE: `supersedePriorEnvironment` + `insert` with no unique
  live-per-block index → two live env rows; the loser's **real cluster resources** become
  invisible to teardown and to the TTL sweep (`listExpired` filters tombstones) — leaked
  namespaces. `sweepExpired` racing a re-provision into the same deterministic per-PR
  namespace has no fencing re-check before the slow namespace delete.
- **D1 preset/connection upserts drifted from their Node mirrors**: merge-preset default
  demote+insert are two un-batched statements (`D1MergePresetRepository.ts:88-145`; the
  sibling `D1ModelPresetRepository.ts:73-108` shows the correct `batch()` pattern);
  runner-pool connection is delete-then-insert unprotected on BOTH runtimes
  (`D1RunnerPoolConnectionRepository.ts:52-77`, `node/.../containerExecution.ts:51-69`).

### 3.8 Local runtime (`backend/runtimes/local`)

- **`trimIdle` removes a member leased mid-iteration** — CONFIRMED:
  `LocalContainerRunnerTransport.ts:583-592` snapshots idle members once, then awaits
  `docker rm` between drops without rechecking `leasedTo` — a dispatch that leases a
  member during the await gets its live container force-removed (run fails as evicted).
- **`prewarmPool` bypasses `pendingStarts`** (`:512-519` vs `:555-568`) — over-starts past
  `poolMax`.
- **Apple adapter: a stopped VM that still reports an IP wedges re-dispatch** — PLAUSIBLE
  (`appleContainerRuntime.ts:114-128,177-181`): `resolve()` succeeds on the dead
  `cf-<runId>` container so the recreate path never runs; every re-drive repeats until
  hard-stall. Gate `endpoint()` on `running`.
- **Cross-process reaping kills a live sibling's containers** — PLAUSIBLE
  (`:388-416,575-580`): label queries carry no process identity, so a new boot's
  housekeeping force-removes a still-draining old process's leased containers.
- **Per-process random `HARNESS_SHARED_SECRET` defeats the restart re-attach**
  (`:195`, `container.ts:283`) — CONFIRMED: after a restart, polls against a surviving
  container fail auth (not mapped to eviction), so the run flaps instead of recovering.
- **`accountPromise` caches a rejection forever** (`container.ts:210-211`) — CONFIRMED:
  one transient GitHub failure at first read poisons all installation reads until restart
  (the sibling transport promise resets on rejection; this one doesn't).

### 3.9 Harness: process-global Pi config races concurrent jobs in one container — PLAUSIBLE

- `executor-harness/src/pi-workspace.ts:204-278`: `runAgentInWorkspace` writes
  `~/.pi/agent/AGENTS.md`, `~/.pi/agent/models.json` and the web-tools config, with
  awaits between the writes and the Pi spawn. `withDirLock` (`:69-111`) serialises only
  the same-repo checkout — the config files are per-process globals. Irrelevant on
  Cloudflare (one container per run, sequential steps), but on a pooled/persistent
  container transport two concurrent jobs interleave: job A writes its config → job B
  overwrites → A spawns Pi with **B's system prompt, model, and proxy config**. Extend
  the lock to cover write-config→spawn, or write per-job config dirs.

### 3.10 Poll-vanished-container misclassification can fail/redo completed work — PLAUSIBLE

- `CloudflareContainerTransport.ts:133-141` maps a poll 404 to "container evicted or
  crashed". A job that **completed** (coder already pushed/opened its PR) whose `done`
  view was never consumed (driver died, container then idle-slept or was drained by a
  rollout) is indistinguishable from a crash: the re-driven driver's first poll 404s →
  the run is failed as evicted, or retried — re-running an agent whose work already
  landed. Inherent to the poll-only design; worth documenting.

---

## 4. Frontend SPA — the snapshot-vs-live-push race was fixed as a point fix, not a pattern

The documented flake fix (a stale on-connect resync dropping a live-added terminal
bootstrap run) exists and is solid — but **only** for `agentRuns.bootstrapJobs`
(`frontend/app/app/stores/agentRuns.ts:77-125`, unit-tested) plus the delayed-`connected`
mitigation in `useWorkspaceStream.ts:134-162`. Of the ~9 stores that reconcile snapshots
with live pushes, only that slice (fully) and `consensus.upsert` (events only) guard
monotonicity. The identical bug pattern survives everywhere else:

| #    | Finding                                                                                                                                                                                                                                                                                                                                                                               | Where                                                                         | Severity           |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------ |
| 4.1  | `execution.hydrate` is a bare replace, `upsert` LWW — a stale snapshot regresses a terminal run to `running` (terminal runs emit nothing further, so the block is stranded "working…") or drops a live-added run. `ExecutionInstance` already carries a monotonic `rev` (`contracts/src/entities.ts:1522-1530`) — the guard is implementable today, exactly like the bootstrap fix.   | `stores/execution.ts:30-39`                                                   | HIGH, CONFIRMED    |
| 4.2  | `workspace.refresh()` has no concurrency control: 33 call sites overlap; two concurrent snapshot fetches commit in arrival order and the older one re-hydrates board, executions, notifications, pipelines, settings — the systemic amplifier of every per-store gap.                                                                                                                 | `stores/workspace.ts:221-224`, `hydrate :72-119`                              | HIGH, CONFIRMED    |
| 4.3  | An in-flight `refresh()` reverts a workspace switch: the old board's snapshot resolves after `switchTo` and `hydrate` unconditionally sets `workspaceId` back — the board spontaneously switches back, per-block caches reset, the stream restarts against the old board. (The stream's `connect()` guards both of its await points against exactly this; `refresh`/`hydrate` don't.) | `stores/workspace.ts:221-224`                                                 | HIGH, CONFIRMED    |
| 4.4  | `notifications.hydrate` resurrects resolved notifications (stale snapshot re-adds an acted card → user can re-click "merge") and drops live-added ones. `Notification` has no `updatedAt` on the wire — needs a contract field or a tombstone set.                                                                                                                                    | `stores/notifications.ts:25-41`                                               | MEDIUM, CONFIRMED  |
| 4.5  | Env-config-repair jobs missed the fix **in the same store that was fixed**: `hydrateEnvConfigRepair`/`upsertEnvConfigRepair` are bare replace/LWW ten lines below the guarded bootstrap twins, though `EnvConfigRepairJob` HAS `updatedAt`. Terminal repair jobs emit nothing further — the DROP case strands the infra window.                                                       | `stores/agentRuns.ts:93-106`                                                  | MEDIUM, CONFIRMED  |
| 4.6  | `board.hydrate`/`upsert` have no staleness guard: a live event patches a block (status `done`, PR fields), then a stale debounced/post-action refresh reverts it. `Block` carries no `updatedAt` — needs a contract change. Optimistic reparent/move can be clobbered mid-flight (self-correcting flicker).                                                                           | `stores/board.ts:60-73,189-225`                                               | MEDIUM, CONFIRMED  |
| 4.7  | requirements/clarity/brainstorm: every action response and live event overwrites the whole review LWW — rapid answer/dismiss sequences revert the later edit in the UI (can mis-enable/hide the Incorporate button); a slow response regresses the pushed `incorporating`→`reviewing` stage. `RequirementReview` HAS `updatedAt` — unused.                                            | `stores/requirements.ts:96-98,281`, `clarity.ts:86-88`, `brainstorm.ts:83-85` | MEDIUM, CONFIRMED  |
| 4.8  | `consensus.load()` writes directly, bypassing the store's own `updatedAt` guard in `upsert` — a slow load regresses the transcript the guard just protected.                                                                                                                                                                                                                          | `stores/consensus.ts:35-57`                                                   | LOW-MED, CONFIRMED |
| 4.9  | kaizen: stale `loadForExecution` drops a live-pushed grading; `upsert` LWW despite `KaizenGrading.updatedAt` existing.                                                                                                                                                                                                                                                                | `stores/kaizen.ts:55-82`                                                      | LOW, PLAUSIBLE     |
| 4.10 | Concurrent 428s clobber the credential prompt: the second `pending.value = {…}` overwrites the first's resolve/cancel closures — the first `withCredential` promise never settles, its "Starting…" state spins forever.                                                                                                                                                               | `stores/personalSubscriptions.ts:148-193`                                     | LOW, PLAUSIBLE     |

There are no event sequence numbers anywhere — reconnect gap-fill relies entirely on the
snapshot, so every reconnect deliberately re-runs the risky snapshot-vs-live merge in all
stores. Highest-leverage fixes: (a) guard `execution.hydrate`/`upsert` with the
already-shipped `rev`; (b) generation-check `workspace.refresh()`/`hydrate` (fixes 4.2 +
4.3 at one stroke); (c) replicate the bootstrap guard onto `envConfigRepairJobs`.

---

## 5. Low (summarised)

- **Subscription-token lease is read→choose→mark** (`ProviderSubscriptionService.ts:161-196`)
  — the API-key pool got the atomic fix (`leaseLeastUsed`: `FOR UPDATE SKIP LOCKED` /
  one-statement D1 claim, both verified sound); the subscription pool did not
  (acknowledged in-code as benign).
- **Pool-size caps are check-then-act** (`ApiKeyService.ts:82-92`,
  `ProviderSubscriptionService.ts:94-103`) — concurrent adds can exceed the 25 cap.
- **Subscription usage dedup Set doesn't survive the per-request Worker executor**
  (`ContainerAgentExecutor.ts:491,617-634`) — a replayed done-poll double-counts rotation
  counters.
- **Installation-token cache**: concurrent misses double-mint (harmless); a pre-grant
  mint completing after a `forceRefresh` can clobber the cache with an old-grant token
  for up to ~1 h (`GitHubAppAuth.ts:100-143`).
- **`wsTicket` is not single-use** (`server/src/auth/wsTicket.ts:4-17`): the doc says
  "ONE WebSocket handshake" but it's a stateless HMAC valid 60 s — replayable within the
  TTL; it also travels in a query string. Same no-nonce-store shape for the OAuth `state`.
  Audience-pinned and tightly scoped, so impact is bounded — doc/behavior mismatch.
- **LLM-proxy usage write is fire-and-forget on Workers**
  (`LlmProxyController.ts:311-312`: `void …recordUsage().catch()`, no `waitUntil`) —
  rotation counters undercount.
- **Node realtime upgrade**: `authorizeWsUpgrade(...).then(...)` has no `.catch`
  (`realtime.ts:225-236`) — a rejection leaks the socket; a verdict resolving after
  `stopRealtime()` calls `handleUpgrade` on a closed server. Shutdown-window only.
- **Cancelled/restarted runs never call `deleteByExecution` on personal-subscription
  activations** — the system-key-only token copy lingers up to the 12 h TTL.
- **Tracker writeback dedup is caller-side read-then-act** (`RunDispatcher.ts:1123-1135`)
  — a duplicate driver pass double-comments; `TaskLinkService.createTaskFromIssue`'s
  duplicate guard is check-then-act (two board tasks, first orphaned).
- **`BoardScanService.reconcileBlueprint`** / **`applyModuleAssignment`**: two genuinely
  concurrent reconciles/merges both `addModule` the same name → duplicate modules.
- **Gate helper dispatch persists `jobId` after dispatching** (`RunDispatcher.ts:352-397`)
  — a crash between dispatch and persist re-dispatches on replay (absorbed by the
  deterministic job id: the harness re-attaches; only an `attempts` increment is lost).
- **Double-driver helper dispatch** is deliberately defused by deterministic
  `stepJobId(executionId, agentKind, dispatchEpoch)` ids — verified benign.
- **Registry fragility caveat**: `buildContainer`'s `clearGateProviders()` → re-wire →
  `applyGateProviders` is fully synchronous today, so no torn window exists — but any
  future `await` inserted between clear and re-wire turns every gate into a silent
  pass-through for concurrent probes. Worth a guard or a loud comment.

---

## 6. Verified sound (checked, not gaps)

- **Healthy-path single-driver-per-run on both facades**: Workflows instance-id
  idempotency; pg-boss `exclusive` queue + `singletonKey` + heartbeat classification
  (a time-based lease — engineered against, not impossible, see 3.5).
- **Harness `JobRegistry`**: `start` is a synchronous get→set (duplicate `POST /jobs`
  re-attaches); watchdog-vs-completion double-settle is prevented (`killReason ??=`,
  single promise settle, timers cleared in `finally`); `runPi`'s abort/guard/close
  ordering is correct; `withDirLock` is a correct chained mutex (see 3.9 for its scope
  limit).
- **`human-review` gate state handling** (`gates.ts:400-604`) is carefully race-hardened
  against GitHub read-after-write lag (headSha backoff, snapshot-driven thread retention).
- **Atomic patterns to copy** (the in-repo good citizens): API-key `leaseLeastUsed`
  (one-statement claim / `FOR UPDATE SKIP LOCKED`), Kaizen's atomic sweep `claim` + its
  in-flight tick guard, notification raise dedup (partial unique index + `RETURNING`),
  model-preset `batch()`/transaction demote+promote, bootstrap-job column-level
  `json_set` patches, `PasswordResetTokenRepository.consume` CAS,
  `GitHubBackfillWorkflow`'s fresh instance ids, the SPA's `agentRuns` hydrate guard and
  `observability.load` reconcile.
- **GitHub projections**: webhook vs cron reconcile writes are safe (proper `ON CONFLICT`
  upserts; sync's update set excludes the board-owned `block_id`, so it can't clobber
  `linkBlock`); HMAC verify is timing-safe + audience-pinned; `resolvePendingFix`
  clears+persists before dispatching (correct order).

---

## 7. Suggested fix order

1. **Spend-resume on Cloudflare** (1.1) — a broken feature that destroys runs; fresh
   instance id on resume, plus the same fix for the BootstrapWorkflow re-drive intent (1.2).
2. **One live run per block at the DB** (2.1) — a partial unique index or atomic
   delete+insert on both runtimes + a conformance assertion; collapses the amplifiers in
   3.1/3.3 and the recurring double-fire.
3. **Finish the OCC migration** (2.2/2.3) — route `approveStep`,
   `resolveCompanionExceeded`, and the gate-window controllers through `mutateInstance`;
   make the driver's post-poll writes CAS-or-merge so Stop/cancel can't be undone by an
   in-flight poll.
4. **CAS the notification status flip before the side effect** (3.1) + conditional
   `UPDATE … WHERE status='open'` in the escalation sweep (3.2).
5. **rev/CAS or item-targeted writes for the review repositories** (2.5).
6. **Frontend**: `rev`-guard `execution.hydrate`, generation-check `workspace.refresh`,
   replicate the bootstrap guard onto env-config-repair (4.1–4.5).
7. **Spend gate**: a reservation/estimate or a documented overshoot bound (2.4).
8. The remaining mediums as touched: bootstrap success ordering (3.3), CI-gate `none`
   window (3.4), sweeper edges (3.5), local-transport set (3.8), D1/Drizzle upsert
   parity drift (3.7).
