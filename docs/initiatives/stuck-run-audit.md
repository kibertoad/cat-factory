# Initiative: stuck-run audit (agent / step / container wedge cases)

**Status:** Groups A (F1/F2/F5) + B (F3/F7/F10) + C-engine (F4/F11) landed; F8 + D todo ·
**Owner:** core · **Started:** 2026-07-02
**Audited at:** `main` @ `fc8df61` (original file:line references are against that commit; the
line numbers in individual findings have since drifted: the anchoring file + symbol names are
kept current, so search by symbol, not line).

> This is the durable source of truth for a multi-PR initiative. Read it first before
> picking up the next slice; update the checklist at the end of each PR.

## Goal & rationale

A systematic audit of every place an agent run, a pipeline step, or a container can get
**stuck**: never advances, never fails, parks with nothing scheduled to re-drive it, or the
inverse failure, where recovery machinery **kills a resumable run** instead of resuming it.
Three sweeps covered (1) the runtime-neutral execution engine
(`backend/packages/orchestration`), (2) the durable drivers + sweepers (Cloudflare Workflows,
pg-boss, mothership), and (3) the container/runner layer (executor-harness + the three
`RunnerTransport`s). The high-severity findings were verified by direct code reads.

**Headline:** no run is provably unbounded: every path eventually hits _some_ backstop. The
real defects are runs that land in states where the only remaining signal is missing, where
recovery terminates instead of resuming, or where failure burns the full ~70-minute poll
budget with no recovery attempt.

## The recovery model (what every finding is measured against)

Five independent bounds exist; a case is only a defect if it falls through the ones that were
supposed to catch it:

1. **Sweepers**: `cloudflare/src/infrastructure/workflows/sweeper.ts` (`sweepStuckRuns`,
   cron) and `node/src/execution/pgBossRunner.ts` (`startStaleRunSweeper`). Both select via
   `agentRunRepository.listStale`, which is **`status = 'running'` only**. A `blocked` or
   `paused` run is _deliberately invisible_ to the sweepers: its only recovery is a human
   acting on a signal (an inbox notification card, escalated yellow → red by the periodic
   sweep). This makes the notification the load-bearing recovery path for every park.
2. **In-drive poll budgets**: `jobMaxPolls` (~70 min) / `ciMaxPolls` +
   `jobPollFailureTolerance` (6) bound every `awaiting_job` / `awaiting_gate` wait, ending in
   `failRun('timeout')` or `resolveGatePollExhaustion`.
3. **Harness watchdogs**: per-job 60-min max-duration + 10-min inactivity abort timers
   (`executor-harness/src/runner.ts`), with per-git-command timeouts (`GIT_TIMEOUT_MS`,
   inactivity − 3 min) sized to lose the race against the inactivity window.
4. **Gate attempt budgets**: `attempts`/`maxAttempts` on `step.gate`, incremented on every
   helper dispatch.
5. **Container reapers**: Cloudflare cron reap at `CONTAINER_MAX_AGE_MINUTES` (90 min);
   local boot reap of exited + orphaned containers.

Decision parks are protected by an ordering invariant: every resolver flips
`blocked → running` and persists it **before** signalling the driver, so a lost/swallowed
signal leaves the run `running` and sweeper-recoverable. Cloudflare additionally re-advances
from storage on the `waitForEvent` 24h timeout, so even a signal sent while no instance was
listening self-heals.

## Findings

### High

**F1: CF sweeper hard-stall keys off raw lease age: wrongly kills recoverable runs after any
cron gap > 1h.**
`backend/runtimes/cloudflare/src/infrastructure/workflows/sweeper.ts:119` fails a `missing`
execution `stalled` when `now - ref.updatedAt > hardStallMs` (60 min). The deadline is raw
lease age, not "time observed orphaned", so after a cron outage / deploy freeze / sustained
sweep failures longer than 1h, a run whose instance is merely `missing` (evicted, re-creatable)
is failed on the **first** post-outage tick, with zero re-drive attempts. The Node sweeper
explicitly fixed this exact bug with a per-process `orphanedSince` map
(`node/src/execution/pgBossRunner.ts:234,258,280`; its comment at :180-186 states the
rationale); the CF sweeper never got the fix.
**Fix:** port the per-process `orphanedSince` clock into `sweepStuckRuns` (it is pure
orchestration over `SweepDeps`: add the map to the sweep state, extend the existing
fake-based unit tests).

**F2: CF `BootstrapWorkflow` "leave for sweeper" actually gets the job killed.**
`backend/runtimes/cloudflare/src/infrastructure/workflows/BootstrapWorkflow.ts:76-79` (poll
failures past tolerance) and `:93` (poll budget exhausted) `return` normally, with comments
saying the cron sweep will re-drive later. But a normal return makes the Workflows instance
**terminal**, and the sweeper routes `terminal` → `finalizeOrphan` → `bootstrap.service.stop`
→ job `failed`, frame `blocked`. A transiently-unreachable or legitimately slow bootstrap is
therefore stopped, not resumed. The Node analogue (`bootstrapRunner.ts`) behaves as the
comments claim (returning just completes the pg-boss job; `reenqueueStaleBootstrap` re-drives).
**Fix:** note that throwing doesn't help either: an errored-out instance is just as
`terminal` as a returned one, and the id can't be re-created. The correct shape is either
(a) have `finalizeOrphan` **re-drive** bootstrap kinds instead of stopping them, which
requires an attempt-suffixed instance id, since today instances are created with the bare run
id (`WorkflowsWorkRunner.create`) and a terminal id can never be reused, or
(b) never leave the instance: keep polling with long durable sleeps instead of returning.
Decide in the fix PR; add a sweeper unit test pinning "unreachable bootstrap is re-driven, not
stopped".

**F3: Spend-paused runs park with zero signal and no auto-resume.** ✅ FIXED (this PR)
`ExecutionService.stepInstance`'s spend gate (`backend/packages/orchestration/.../ExecutionService.ts`,
the `instance.status = 'paused'` branch) flipped the run to `paused` and stopped the driver. No
notification was raised (the `NotificationType` enum had no budget/paused member at all), the
sweeper skips `paused`, and there is no budget-freed hook: the only resume is a human manually
calling `POST /spend/resume` (`ExecutionService.resumePaused`). The only visible signal was the
paused badge on the board. This was the least-discoverable park in the system.
**Fix (landed):** added the `budget_paused` `NotificationType` (contracts) and
`RunStateMachine.raiseBudgetPaused` / `clearBudgetPaused`. The pause branch raises ONE
workspace-scoped (block-less) card, de-duplicated against the open cards (a block-less card has no
per-type unique index); `resumePaused` clears it. Purely informational (`act` marks it read: the
human raises the budget then resumes from the spend panel). Runtime-neutral (shared orchestration +
the pre-existing per-facade notification repo), with a conformance assertion driving a real mid-run
pause → card → resume-clears on both stores. The sweeper-auto-resume alternative was deliberately
NOT taken: it would require widening `listStale` to see `paused` runs, and the invisibility of
`paused`/`blocked` to the sweeper is load-bearing for the decision model.

**F4: Runner-pool transport: no eviction classification, unknown status → `running`, release
may be a no-op.** ✅ FIXED (this PR)
`backend/packages/integrations/src/modules/runners/runners.logic.ts`; `mapJobState`
fell back to `'running'` for any unclassifiable status, and the pool poll had no 404→eviction
mapping (unlike `CloudflareContainerTransport` and the local `harnessHttp.ts`).
A pool member dying mid-job therefore burned the full ~70-min poll budget before failing
`timeout`, and because nothing set `RunnerJobView.evicted`, the eviction re-dispatch
(`RunDispatcher.recoverContainerEviction`) never engaged, no fresh member was tried.
`HttpRunnerPoolProvider.release` is a silent no-op when the manifest defines no
release template, so the orphaned pool job may never be cancelled.
**Fix (landed):** `mapJobState` became `classifyJobStatus`, returning `{ state, evicted? }`.
A 404/410 poll and a reclaim-word status (`evicted`/`preempted`/`oomkilled`/`node_lost`/…) both
mint `evicted: 'crash'` so the engine re-dispatches onto a fresh member; a job-level failure
vocabulary (`error`/`cancelled`/`timeout`/…) and a success vocabulary
(`completed`/`succeeded`/…) end the poll loop honestly instead of on the timeout budget.
Registration now logs the manifest gaps (`release`, `statusPath`) through the kernel `Logger`.
See the Group C notes for the two deviations from the fix sketch above.

**F5: `blocked` run + terminally-dead CF Workflows instance = the human's decision is
discarded.**
`backend/runtimes/cloudflare/src/infrastructure/workflows/ExecutionWorkflow.ts:40-41`:
`buildContainer(this.env)` / `loadConfig` run on every hibernation wake **outside** any
retriable `step.do`. An unhandled throw there kills the instance terminally while the run is
parked `blocked` (invisible to the sweeper). When the human finally resolves: status flips to
`running`, the signal to the dead instance throws and is swallowed
(`WorkflowsWorkRunner.ts:62-66`), and the sweeper then sees a `running` run with a `terminal`
instance → `finalizeOrphan` → **stopRun**. The run is terminated and the decision discarded
instead of resumed. CF-only: the pg-boss/mothership "instance" is just a queue row, so a fresh
send re-drives cleanly.
**Fix:** wrap the per-wake construction in a retriable step (or catch-and-retry) so a parked
instance can't die terminally on a transient wake failure; and/or teach `finalizeOrphan` to
re-drive an execution whose record shows an unconsumed resolved decision rather than stopping.

**F6: Harness event-loop starvation defeats both watchdogs.**
Both watchdog timers (`executor-harness/src/runner.ts:255-268`) and the `/health` + `/jobs`
poll endpoints share one Node event loop with the JSONL parsing hot path
(`executor-harness/src/pi.ts:874-922`), and `summarizePiRun` re-parses the **entire** stdout
buffer at close (`pi.ts:1056-1063`). A pathologically large JSONL line or huge stdout blocks
the loop: the abort timers never fire and the container stops answering polls, so the
advertised "a container can never run forever" guarantee (`runner.ts:18-21`) fails. Bounded
only by the engine-side poll-failure tolerance → `release()`/destroy and, last, the reaper.
**Fix (harness, image-bumping):** cap accepted JSONL line size, and stream/chunk the
close-time summary parse (or reuse the incrementally-parsed events) so the loop stays live.

### Medium

**F7: `ensureWaitingNotification`'s non-clobbering guard can suppress the ONLY signal for a
`blocked` run.** ✅ FIXED (this PR)
`RunStateMachine.ensureWaitingNotification` (`backend/packages/orchestration/.../RunStateMachine.ts`):
the `decision_required` card was suppressed when **any** open notification sat on the block, e.g.
a stale `pipeline_complete` / `merge_review` / `followup_pending` from a prior run. If the human
dismissed that unrelated card, the parked run had no discoverable signal and (per the recovery
model) nothing else ever re-drives a `blocked` run.
**Fix (landed):** the suppression is now scoped to `executionId`: it fires only when an open card
for THIS run already sits on the block. Every richer card raised during a run (`merge_review`,
`decision_required`, `pipeline_complete`, …) carries `executionId: instance.id`, so the "richer
message wins" intent is preserved, while a prior run's card (different `executionId`, or a block-less
workspace card) no longer masks the new park. Unit-tested.

**F8: `reinitAndPush` (bootstrap push phase) takes no abort signal.**
`executor-harness/src/git.ts:688-708`, called from `agent.ts:862`: none of its ~6 git commands
(`init`/`checkout`/`add`/`commit`/`remote`/`push --force`) thread `signal`, so the watchdog
abort cannot interrupt the push phase; bounded only by per-command timeouts (~7 min × 6 ≈
42 min of un-abortable work past `maxDurationMs`). Every other git helper threads `signal`;
this one dropped it.
**Fix (harness, image-bumping):** add `signal` to `reinitAndPush` and pass it through.

**F9: Node has no per-advance timeout; a hung advance wedges the run for hours.**
`backend/packages/orchestration/src/modules/execution/drive.ts:113`: `await
exec.advanceInstance(...)` has no ceiling. pg-boss heartbeats the active job independently of
handler progress, so `classifyAdvanceJob` reports `live` and the sweeper skips it while
`updated_at` is frozen; a hung HTTP call inside an advance wedges the run until
`queue.expireInSeconds` (up to 24h). CF bounds the same call at 5 min
(`ExecutionWorkflow.ts:17-20` `STEP_CONFIG.timeout`).
**Fix:** wrap the Node advance in a timeout (`Promise.race` / `AbortSignal.timeout`) matching
CF's 5-min ceiling, funnelling to the same retry/fail path: restoring runtime symmetry on the
hang bound.

**F10: Recurring pipeline fire clobbers a human-parked (`blocked`) prior run.** ✅ FIXED (this PR)
`RecurringPipelineService.fire`'s active-run guard (now at
`backend/packages/orchestration/src/modules/recurring/RecurringPipelineService.ts`: the service
moved from `integrations` to `orchestration` since the audit) checked only `running` / `paused`. A
prior run parked `blocked` on a review or decision gate was replaced by the next cron fire; the
parked run's durable driver was orphaned against a replaced execution and a later human resolve hit
`NotFound`.
**Fix (landed):** `blocked` was added to the guard (skip the fire: the human gate is the
pipeline's current state; leave `nextRunAt` so the next pass retries). Unit-tested across
`running`/`paused`/`blocked` (skip) vs terminal (fire).

**F11: Block flipped `pr_ready` BEFORE the `merge_review` card is raised; a raise failure
loses the only actionable prompt.** ✅ FIXED (this PR)
`MergeResolver.raiseReviewAndBlock`, same order in `RunStateMachine`'s
`finalizeBlock` → `raisePipelineComplete`. If `notificationService.raise` threw, the run failed
but the block was already `pr_ready` with no inbox card: a human saw a PR-ready task with no
merge-review action and nothing re-drives the review.
**Fix (landed):** the card is raised first, then the block flips. The retry-on-escalation-sweep
alternative was not taken: it needs new persisted state to know a raise is owed, while the
ordering swap costs nothing and makes the surviving failure the honest one (run failed, block
unchanged, visible on the board) instead of a task dressed up as PR-ready. Unit-tested on both
sites: ordering AND "a failed raise leaves the block alone".

**F12: A >10-min poll gap sleeps the CF container and burns the single eviction recovery.**
`backend/runtimes/cloudflare/src/infrastructure/.../ExecutionContainer.ts:43-48`
(`sleepAfter '10m'`) + `job.logic.ts:11` (`MAX_EVICTION_RECOVERIES = 1`). The DO is kept warm
only by polling; two backend poll-scheduling hiccups in one step fail a healthy run `evicted`
(rollout evictions get a budget of 5; ordinary sleep-eviction gets 1).
**Fix:** consider a larger recovery budget for sleep-evictions, or a keep-warm ping decoupled
from the poll cadence.

**F13: Pi "chatty hang" (streaming output, zero tool calls) runs the full 60 min.**
`executor-harness/src/pi.ts:943-951` resets inactivity on **any** stdout/stderr chunk; the
progress guard (`pi.ts:721-769`) only watches `tool_execution_end`. A thinking-forever model
never trips either and burns the whole budget (and the engine budget behind it).
**Fix (harness, optional):** a no-tool-progress guard between the 10-min inactivity and the
60-min cap. Arguably the 60-min ceiling is the intended bound: lowest-priority medium.

**F14: Resumed work branch with nothing ahead of base fails the run with GitHub's opaque
422 instead of no-op'ing (and the merger silently strands the branch).**
`executor-harness/src/coding-agent.ts` computed `hasWork = resumed || branchHasCommitsSince(...)`,
so ANY pre-existing work branch was treated as work even when it had zero commits ahead of the
PR base. A branch gets stranded in that state when its earlier PR is merged with a **merge
commit** (leaving the branch reachable from base) and `GitHubPullRequestMerger`'s best-effort
`deleteBranch().catch(() => {})` skips the cleanup. A re-dispatch then resumes it, the agent
no-op's, and `openPullRequest` fails `422 "No commits between <base> and <branch>"`: surfaced
to the user as a scary `Failed to open PR (HTTP 422)` rather than a clean no-changes outcome.
Observed on a local docker+postgres run (`exec_91f9521463e64bd898e53f3d`).
**Fix (this PR):** `runCodingAgent` confirms a resumed branch is actually ahead of the PR base
(new tri-state `branchAheadOfBase`; `undefined` keeps the prior resume-is-work behaviour) and
records a no-op otherwise; `openPullRequest` maps the 422 "No commits between" to a no-op
(`null`) as a backstop; `GitHubPullRequestMerger` now logs the swallowed branch-delete failure.
Harness change ⇒ image-bumped (`@cat-factory/executor-harness` 1.31.6 → 1.31.7 + the three
pins). Follow-up (not done): don't re-dispatch a block whose PR already merged.

### Low: recorded as accepted / not planned (don't re-derive these)

- **pg-boss poison run dodges the hard-stall clock:** a drive that throws → pg-boss `failed` →
  sweeper re-sends a fresh job → momentarily `live` → `orphanedSince` resets; the run retries
  forever instead of failing `stalled`. Only manifests during a persistence outage (during
  which `failRun` couldn't persist anyway). The mothership runner is stricter
  (consecutive-failure `maxAttempts`).
- **No hard-stall backstop for `bootstrap`/`env-config-repair` kinds** in either sweeper
  (`ref.kind === 'execution'` guards): a deterministic create-then-die loop re-drives forever.
- **Node lacks CF's periodic `blocked`-run re-advance** (`waitForEvent` timeout re-loop). All
  current resolvers flip `blocked → running` before signalling, so self-healing holds today;
  a divergence to watch if a resolver ever signals without the status flip.
- **Crash window between `startJob` and the `jobId` upsert** double-dispatches a container
  (`RunDispatcher.ts:376-401`, `:2385-2397`); the orphan is reaped, the run advances on the
  second job: duplicate work, not a wedge.
- **`MAX_GATE_HOPS` break falls through** with an unhandled `awaiting_*` result
  (`drive.ts:125-166`); the outer loop re-advances so nothing wedges: a defensive `failRun`
  would be tidier.
- **PR/MR lookup GETs** (`git.ts:1001-1041`) rely solely on the watchdog signal, no
  independent `AbortSignal.timeout`; fine on all production paths (the signal is always
  threaded).
- **`JobRegistry` never deletes finished entries**: bounded per ephemeral container, and it
  is what makes a slow job impossible to mis-404 into a false eviction (a feature; keep it).
- **Preview-mode containers deliberately live until release/reaper** (`agent.ts:303-357`):
  by design for browsable previews.
- **Transient-flakiness trade-off:** 6 consecutive poll read failures (~3 min) terminally
  fail a healthy 60-min job. Accepted as the price of bounding a dead backend; revisit only
  if real flakiness data shows it firing.

## Fix groups & status checklist

Fixes are grouped by cohesion; each group is one PR-sized slice. Update the table at the end
of each PR.

| #   | Finding                                             | Area                   | Fix group               | Status     | PR      |
| --- | --------------------------------------------------- | ---------------------- | ----------------------- | ---------- | ------- |
| F1  | CF sweeper hard-stall on raw lease age              | CF sweeper             | A: recovery correctness | ✅ done    | this PR |
| F2  | BootstrapWorkflow terminal-return vs sweeper        | CF workflow/sweeper    | A                       | ✅ done    | this PR |
| F5  | `blocked` + dead instance discards decision         | CF workflow/sweeper    | A                       | 🟨 partial | this PR |
| F3  | Spend-pause: no signal, no auto-resume              | engine + notifications | B; invisible parks      | ✅ done    | this PR |
| F7  | `ensureWaitingNotification` suppression             | engine                 | B                       | ✅ done    | this PR |
| F10 | Recurring fire clobbers `blocked` run               | orchestration          | B                       | ✅ done    | this PR |
| F4  | Pool transport: no eviction mapping / no-op release | integrations           | C; transport bounds     | ✅ done    | this PR |
| F11 | `pr_ready` before `merge_review` raise              | engine                 | C                       | ✅ done    | this PR |
| F8  | `reinitAndPush` not abort-aware                     | harness (image bump)   | C (harness slice)       | ⬜ todo    |         |
| F6  | Harness event-loop starvation vs watchdogs          | harness (image bump)   | D; hang ceilings        | ⬜ todo    |         |
| F9  | Node advance has no timeout                         | node driver            | D                       | ⬜ todo    |         |
| F12 | Sleep-eviction burns the single recovery            | CF container           | D                       | ⬜ todo    |         |
| F13 | Chatty-hang runs full 60 min                        | harness (image bump)   | D                       | ⬜ todo    |         |
| F14 | Resumed empty branch fails 422 vs no-op             | harness + engine       | (fixed inline)          | ✅ done    | this PR |

Suggested order: A (guaranteed wrong-kill on common operational events), then B (parks with
no signal), then C, then D (most invasive; D is deferrable). C landed its two non-harness
findings (F4, F11); F8 was split off because a harness change is image-bumping and the
conventions below keep those out of a non-harness slice. Next up: **F8 + F6 + F13 as one
harness/image slice**, then the rest of **D** (F9 Node advance timeout, F12 sleep-eviction
budget).

### Group A implementation notes (landed)

- **F1**: `sweepStuckRuns` (`cloudflare/.../workflows/sweeper.ts`) gained an `orphanedSince`
  `Map<runId, firstSeenMs>` (mutated in place, defaulting to a fresh map when omitted). The
  hard-stall check now compares `now - firstSeenOrphaned` instead of `now - ref.updatedAt`, and
  the loop prunes the map of runs that recovered / went terminal / were stalled. The cron
  handler (`index.ts`) owns a **per-isolate** module-global `runSweepOrphanedSince` and threads
  it in; a warm isolate carries it across the 2-min ticks and an eviction just resets it (the
  safe direction: more grace, never a premature kill). Unit-tested with fakes in
  `durable-execution.spec.ts` (huge-lease-age → re-driven-not-stalled on first tick; forgets a
  recovered run).
- **F2**: `BootstrapWorkflow` **and** `EnvConfigRepairWorkflow` no longer `return` on a
  poll-read failure past `jobPollFailureTolerance`; they `continue` (keep the instance alive).
  `pollReadFailures` is now purely diagnostic. Reasoning: a thrown poll error is always
  transient (a vanished container surfaces as a 404→`failed` poll RESULT, not a throw) and the
  container's own max-duration watchdog (60 min) is shorter than the 70-min poll budget, so a
  healthy run can never legitimately reach the budget-exhausted tail (where the sweeper's
  finalize-as-stopped is the correct terminal outcome for a truly-wedged run).
- **F5**: **partial.** Added `buildWorkflowRuntime` (`workflows/runtime.ts`): retries the
  per-wake `buildContainer`/`loadConfig` a few times with durable `step.sleep`s, applied at the
  top of all three workflows. This closes the **transient** wake-throw door (the audit's stated
  trigger). It does NOT close the deterministic case: a persistent construction throw still
  rethrows → terminal instance, and because a terminal Workflows instance id can never be
  re-created, the sweeper still can only finalize (not re-drive) such a `blocked` run, so the
  decision can still be discarded on a genuinely broken deployment.
  **Deferred:** the complete fix (and F2's option (a), and the general "terminal id can't be
  reused" limitation behind several findings) needs **attempt-suffixed Workflows instance ids**
  so the sweeper can re-drive a terminal instance under a fresh id, plus tracking the current
  attempt for `signal`/`cancel`. That's a cross-workflow refactor (execution + bootstrap +
  env-config-repair): carve it out as its own slice before relying on `finalizeOrphan` to
  resume rather than stop.

### Group B implementation notes (landed)

- **F10**: one-line guard widening in `RecurringPipelineService.fire`: the overlap guard now
  treats `blocked` as live alongside `running`/`paused`. Pure orchestration (runtime-neutral by
  construction); table-tested over the three live states (skip) vs a terminal prior (fire).
- **F7**: `ensureWaitingNotification`'s suppression predicate gained `&& n.executionId ===
instance.id`. The whole point of the card is that it is a `blocked` run's ONLY recovery signal,
  and every richer card raised during a run carries this run's `executionId`, so scoping by it both
  preserves "richer card wins" and stops a stale prior-run card (or a block-less workspace card like
  the new `budget_paused`) from masking the park.
- **F3**: the `budget_paused` `NotificationType` + `RunStateMachine.raiseBudgetPaused` /
  `clearBudgetPaused`. Workspace-scoped (block-less) so ONE card covers every paused run; the
  raiser de-dupes against `listOpen` (a block-less card has no per-type unique index, unlike the
  block-scoped `upsertOpenForBlock` path). Wired at the pause branch (`stepInstance`) + the resume
  path (`resumePaused`). Frontend: the inbox `META`/`ACTION_KEYS` maps + the SlackPanel `routes`
  map + the Slack `MENTION_AUDIENCE`/`TYPE_LABEL` maps are all exhaustive over `NotificationType`,
  so each needed a new entry (the typecheck enforces this); `budget_paused` is in-app-only (NOT in
  `SLACK_ROUTABLE_TYPES`, mentions no one). i18n: one `action.budget_paused` key across all 10
  locales. Conformance: a real mid-run pause (tiny positive budget so the run starts, then step 1's
  usage crosses it) → one block-less card → resume clears it, asserted on D1 + Postgres.
- **Gotcha for C/D:** the spend START guard (`assertBudgetAllowsPipeline`) refuses an over-budget
  run up front with a 409: it does NOT pause. A run only reaches the `paused` state by crossing
  the budget threshold DURING its own run (an earlier step's usage over-runs a later step), which
  is why the F3 conformance test needs a multi-step pipeline + a tiny (not zero) budget.

### Group C implementation notes (landed)

- **F4**: `mapJobState` became `classifyJobStatus`, returning `{ state, evicted? }`, and
  `HttpRunnerPoolProvider` now sets `RunnerJobView.evicted` from it. Two deliberate deviations
  from the fix sketch:
  - **"unknown terminal status → `failed`" was NOT taken.** The audit's wording covers the
    real bug (a scheduler saying `error`/`evicted` read as `running`), but implementing it
    literally would fail every pool whose scheduler reports an unmapped `queued` /
    `provisioning` / `assigning`; the wrong-kill class this whole audit exists to prevent, and
    on the FIRST poll rather than after a budget. Instead there are three explicit vocabularies
    (eviction / failure / success) matched after the manifest's own `statusMap`, and a genuinely
    unrecognised word still falls back to `running`. Such a run stays bounded by the poll budget,
    and a manifest can always map the word.
  - **Reclaim words are narrow on purpose.** `evicted`, `preempted`, `oomkilled`, `node_lost`
    and friends mint `evicted: 'crash'`; `cancelled`, `killed`, `aborted` and `terminated` do
    NOT, because they routinely mean a human stopped the job and re-dispatching would
    resurrect it. The eviction check also runs on a status the manifest mapped to `failed`, so
    `{"from":"evicted","to":"failed"}` still gets the recovery: an operator naming their
    scheduler's word is describing the STATE, not declining the retry.
  - **Every failure word must be terminal in EVERY vocabulary it could come from.** The first
    cut had `unschedulable` in the failure set; Kubernetes reports it as a condition on a
    PENDING pod while the cluster autoscales, so it would have killed a live run on its FIRST
    poll: the same wrong-kill the bullet above declines. A word that can also mean "waiting
    for capacity" belongs in no vocabulary; the manifest maps it when a pool means it
    terminally. Both sides of a `statusMap` comparison are trimmed + lower-cased, so a padded
    or pretty-cased enum still binds what the operator declared.
  - `crash`, not `transient`: a pool member is ordinary infrastructure, while `transient` is
    reserved for churn a facade knows is expected (a Cloudflare rollout).
  - **A 404 is not proof of an eviction**, so the view's `error` leads with the raw status
    (`Runner pool poll → 404: …`) and the scheduler's own message rides `detail`. A mistyped
    `poll` template (the `dispatch` one can be right while it is wrong) and an endpoint that
    404s an unauthorized read both land here, and an operator handed a bare "container evicted
    or crashed" has nothing to act on. `evicted or crashed` stays a SUBSTRING, which is all
    the dispatch-time `isContainerEvictionError` needs: the wording itself is now kernel's
    `CONTAINER_EVICTION_ERROR` rather than a constant copied into all four transports.
  - **An eviction recovery re-dispatches under a FRESH job id** (`dispatchEpochFor` now counts
    `evictionRecoveries` + `transientEvictionRecoveries`, which the deploy path's
    `deployEvictionEpoch` had always done). Without it the recovery was close to a no-op for
    exactly the backend this finding is about: a pool is asked to keep routing **sticky by job
    id**, so re-dispatching under the same id routes the retry back to the dead job, the next
    poll 404s again, the budget (1) is spent, and the run fails `evicted`; faster and more
    honest than the 70-minute wedge, but never the "fresh pool member" the fix promises. A
    fresh id is correct for every transport: nothing can re-attach to a container that no
    longer exists. `release` is deliberately NOT called first: the runner is already gone;
    the pool docs now say a vanished job is the pool's to reap.
  - The release/status-path gaps ride a new optional `warnings(config)` on
    `RunnerBackendProvider` (the connection service stays kind-agnostic) and reach an
    operator on BOTH of their surfaces: logged once at `register()` (the deployment operator's
    copy; `resolve()` would re-log per dispatch) and returned on the CONNECTION TEST, which is
    where the person who pasted the config is actually looking. A log line nobody reads is not
    a warning. Each gap crosses the wire as a `{ code, message }` (the backend does not
    localize prose), the SPA maps the code through an exhaustive `Record` in
    `utils/connectionWarnings.ts`, and `message` is the untranslated fallback.
    `RunnerPoolConnectionService` gained `logger?: Logger` (normalised to `noopLogger`), wired
    in all three composition roots.
- **F11**: the ordering swap on both sites, plus tests that pin it AND pin "a failed raise
  leaves the block alone". Pure orchestration, so runtime-symmetric by construction (like F7 and
  F10) and unit-tested rather than conformance-tested: there is no per-facade behaviour to
  diverge, only a call order inside one shared service.
- **F8 deferred, not skipped.** It is the only Group C finding that touches the executor-harness,
  and the conventions below require a harness change to bump the image + the three tag pins. It
  belongs with F6 and F13 in one harness slice rather than dragging an image bump into an
  engine PR.

## Conventions & gotchas for implementers

- **Runtime symmetry is mandatory** for anything touching engine/sweeper/notification
  behaviour (F3, F7, F9, F10, F11): land Worker + Node together, per the CLAUDE.md rule. A
  conformance assertion is what proves it when a fix touches per-facade state (F3 did: a new
  notification type crossing both notification repos); a fix that only reorders or widens logic
  inside ONE shared orchestration service (F7, F10, F11) has no per-facade surface to diverge,
  so unit tests are the honest coverage. F1/F2/F5 are CF-only by nature (the Node sweeper is
  the reference implementation being ported _from_), and F4 lives in the shared `integrations`
  transport both facades resolve.
- **Harness changes (F6, F8, F13) are image-bumping:** bump `@cat-factory/executor-harness`'s
  version + the three tag pins (`deploy/backend/package.json`, `deploy/backend/wrangler.toml`,
  `RECOMMENDED_HARNESS_IMAGE`) per the release rules in CLAUDE.md: keep them separate from
  non-harness slices.
- **`sweepStuckRuns` is pure orchestration over `SweepDeps`**: extend its fake-based unit
  tests for F1/F2/F5; don't test through real Workflows.
- **`runners.logic.ts` now has table tests** (`runners.logic.test.ts`, added with F4: the
  audit's claim that they already existed was wrong; the pool coverage lived entirely in
  `runner-pool-transport.test.ts`). Extend both for further status/eviction mapping work.
- **The sweepers only see `status='running'`**: any fix that wants sweeper coverage for a
  park must either flip the status or extend `listStale` deliberately (and symmetrically);
  don't widen it casually, the invisibility of `blocked`/`paused` is load-bearing for the
  decision model.
- **Notification cards are the recovery path for parks.** When adding one (F3) mind the
  suppression guard (F7): fixing F3 without F7 can still yield an invisible park.
- Changeset per touched published package; empty changeset for docs/test-only slices.
