# Initiative: stuck-run audit (agent / step / container wedge cases)

**Status:** audit complete, fixes not started · **Owner:** core · **Started:** 2026-07-02
**Audited at:** `main` @ `fc8df61` (file:line references are against that commit)

> This is the durable source of truth for a multi-PR initiative. Read it first before
> picking up the next slice; update the checklist at the end of each PR.

## Goal & rationale

A systematic audit of every place an agent run, a pipeline step, or a container can get
**stuck**: never advances, never fails, parks with nothing scheduled to re-drive it — or the
inverse failure, where recovery machinery **kills a resumable run** instead of resuming it.
Three sweeps covered (1) the runtime-neutral execution engine
(`backend/packages/orchestration`), (2) the durable drivers + sweepers (Cloudflare Workflows,
pg-boss, mothership), and (3) the container/runner layer (executor-harness + the three
`RunnerTransport`s). The high-severity findings were verified by direct code reads.

**Headline:** no run is provably unbounded — every path eventually hits _some_ backstop. The
real defects are runs that land in states where the only remaining signal is missing, where
recovery terminates instead of resuming, or where failure burns the full ~70-minute poll
budget with no recovery attempt.

## The recovery model (what every finding is measured against)

Five independent bounds exist; a case is only a defect if it falls through the ones that were
supposed to catch it:

1. **Sweepers** — `cloudflare/src/infrastructure/workflows/sweeper.ts` (`sweepStuckRuns`,
   cron) and `node/src/execution/pgBossRunner.ts` (`startStaleRunSweeper`). Both select via
   `agentRunRepository.listStale`, which is **`status = 'running'` only**. A `blocked` or
   `paused` run is _deliberately invisible_ to the sweepers — its only recovery is a human
   acting on a signal (an inbox notification card, escalated yellow → red by the periodic
   sweep). This makes the notification the load-bearing recovery path for every park.
2. **In-drive poll budgets** — `jobMaxPolls` (~70 min) / `ciMaxPolls` +
   `jobPollFailureTolerance` (6) bound every `awaiting_job` / `awaiting_gate` wait, ending in
   `failRun('timeout')` or `resolveGatePollExhaustion`.
3. **Harness watchdogs** — per-job 60-min max-duration + 10-min inactivity abort timers
   (`executor-harness/src/runner.ts`), with per-git-command timeouts (`GIT_TIMEOUT_MS`,
   inactivity − 3 min) sized to lose the race against the inactivity window.
4. **Gate attempt budgets** — `attempts`/`maxAttempts` on `step.gate`, incremented on every
   helper dispatch.
5. **Container reapers** — Cloudflare cron reap at `CONTAINER_MAX_AGE_MINUTES` (90 min);
   local boot reap of exited + orphaned containers.

Decision parks are protected by an ordering invariant: every resolver flips
`blocked → running` and persists it **before** signalling the driver, so a lost/swallowed
signal leaves the run `running` and sweeper-recoverable. Cloudflare additionally re-advances
from storage on the `waitForEvent` 24h timeout, so even a signal sent while no instance was
listening self-heals.

## Findings

### High

**F1 — CF sweeper hard-stall keys off raw lease age: wrongly kills recoverable runs after any
cron gap > 1h.**
`backend/runtimes/cloudflare/src/infrastructure/workflows/sweeper.ts:119` fails a `missing`
execution `stalled` when `now - ref.updatedAt > hardStallMs` (60 min). The deadline is raw
lease age, not "time observed orphaned" — so after a cron outage / deploy freeze / sustained
sweep failures longer than 1h, a run whose instance is merely `missing` (evicted, re-creatable)
is failed on the **first** post-outage tick, with zero re-drive attempts. The Node sweeper
explicitly fixed this exact bug with a per-process `orphanedSince` map
(`node/src/execution/pgBossRunner.ts:234,258,280`; its comment at :180-186 states the
rationale); the CF sweeper never got the fix.
**Fix:** port the per-process `orphanedSince` clock into `sweepStuckRuns` (it is pure
orchestration over `SweepDeps` — add the map to the sweep state, extend the existing
fake-based unit tests).

**F2 — CF `BootstrapWorkflow` "leave for sweeper" actually gets the job killed.**
`backend/runtimes/cloudflare/src/infrastructure/workflows/BootstrapWorkflow.ts:76-79` (poll
failures past tolerance) and `:93` (poll budget exhausted) `return` normally, with comments
saying the cron sweep will re-drive later. But a normal return makes the Workflows instance
**terminal**, and the sweeper routes `terminal` → `finalizeOrphan` → `bootstrap.service.stop`
→ job `failed`, frame `blocked`. A transiently-unreachable or legitimately slow bootstrap is
therefore stopped, not resumed. The Node analogue (`bootstrapRunner.ts`) behaves as the
comments claim (returning just completes the pg-boss job; `reenqueueStaleBootstrap` re-drives).
**Fix:** note that throwing doesn't help either — an errored-out instance is just as
`terminal` as a returned one, and the id can't be re-created. The correct shape is either
(a) have `finalizeOrphan` **re-drive** bootstrap kinds instead of stopping them — which
requires an attempt-suffixed instance id, since today instances are created with the bare run
id (`WorkflowsWorkRunner.create`) and a terminal id can never be reused — or
(b) never leave the instance: keep polling with long durable sleeps instead of returning.
Decide in the fix PR; add a sweeper unit test pinning "unreachable bootstrap is re-driven, not
stopped".

**F3 — Spend-paused runs park with zero signal and no auto-resume.**
`backend/packages/orchestration/src/modules/execution/ExecutionService.ts:1515-1524` flips the
run to `paused` and stops the driver. No notification is raised (the `NotificationType` enum
has no budget/paused member at all), the sweeper skips `paused`, and there is no budget-freed
hook — the only resume is a human manually calling `POST /spend/resume` (`resumePaused`,
`ExecutionService.ts:2661`). The only visible signal is the paused badge on the board. This is
the least-discoverable park in the system.
**Fix:** raise a notification on pause (new `NotificationType`, e.g. `budget_paused`, one per
workspace not per run; cleared by `resumePaused`) and/or make the sweeper probe paused runs'
budget and auto-resume when it frees. Runtime-symmetric + conformance assertion.

**F4 — Runner-pool transport: no eviction classification, unknown status → `running`, release
may be a no-op.**
`backend/packages/integrations/src/modules/runners/runners.logic.ts:47-60` — `mapJobState`
falls back to `'running'` for any unclassifiable status, and the pool poll has no 404→eviction
mapping (unlike `CloudflareContainerTransport.ts:133-142` and the local `harnessHttp.ts:93`).
A pool member dying mid-job therefore burns the full ~70-min poll budget before failing
`timeout`, and because the error never matches `isContainerEvictionError`, the transient
eviction re-dispatch (`RunDispatcher.ts:806-844`) never engages — no fresh member is tried.
`HttpRunnerPoolProvider.ts:88-91`: `release` is a silent no-op when the manifest defines no
release template, so the orphaned pool job may never be cancelled.
**Fix:** classify a 404/absent job as an eviction (throw the `evicted or crashed`-shaped
error so recovery engages); treat a scheduler-reported failed/unknown terminal status as
`failed`, not `running`; log loudly at wiring time when a manifest lacks `release`.
`runners.logic.ts` already has table tests to extend.

**F5 — `blocked` run + terminally-dead CF Workflows instance = the human's decision is
discarded.**
`backend/runtimes/cloudflare/src/infrastructure/workflows/ExecutionWorkflow.ts:40-41` —
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

**F6 — Harness event-loop starvation defeats both watchdogs.**
Both watchdog timers (`executor-harness/src/runner.ts:255-268`) and the `/health` + `/jobs`
poll endpoints share one Node event loop with the JSONL parsing hot path
(`executor-harness/src/pi.ts:874-922`) — and `summarizePiRun` re-parses the **entire** stdout
buffer at close (`pi.ts:1056-1063`). A pathologically large JSONL line or huge stdout blocks
the loop: the abort timers never fire and the container stops answering polls, so the
advertised "a container can never run forever" guarantee (`runner.ts:18-21`) fails. Bounded
only by the engine-side poll-failure tolerance → `release()`/destroy and, last, the reaper.
**Fix (harness, image-bumping):** cap accepted JSONL line size, and stream/chunk the
close-time summary parse (or reuse the incrementally-parsed events) so the loop stays live.

### Medium

**F7 — `ensureWaitingNotification`'s non-clobbering guard can suppress the ONLY signal for a
`blocked` run.**
`backend/packages/orchestration/src/modules/execution/RunStateMachine.ts:521-536` — the
`decision_required` card is suppressed when **any** open notification sits on the block, e.g.
a stale `pipeline_complete` / `merge_review` / `followup_pending` from a prior run. If the
human dismisses that unrelated card, the parked run has no discoverable signal and (per the
recovery model) nothing else ever re-drives a `blocked` run.
**Fix:** scope the suppression to cards that actually represent this park (match on
`executionId`, or restrict to decision-relevant types), and/or re-ensure the card on the
escalation sweep.

**F8 — `reinitAndPush` (bootstrap push phase) takes no abort signal.**
`executor-harness/src/git.ts:688-708`, called from `agent.ts:862`: none of its ~6 git commands
(`init`/`checkout`/`add`/`commit`/`remote`/`push --force`) thread `signal`, so the watchdog
abort cannot interrupt the push phase — bounded only by per-command timeouts (~7 min × 6 ≈
42 min of un-abortable work past `maxDurationMs`). Every other git helper threads `signal`;
this one dropped it.
**Fix (harness, image-bumping):** add `signal` to `reinitAndPush` and pass it through.

**F9 — Node has no per-advance timeout; a hung advance wedges the run for hours.**
`backend/packages/orchestration/src/modules/execution/drive.ts:113` — `await
exec.advanceInstance(...)` has no ceiling. pg-boss heartbeats the active job independently of
handler progress, so `classifyAdvanceJob` reports `live` and the sweeper skips it while
`updated_at` is frozen; a hung HTTP call inside an advance wedges the run until
`queue.expireInSeconds` (up to 24h). CF bounds the same call at 5 min
(`ExecutionWorkflow.ts:17-20` `STEP_CONFIG.timeout`).
**Fix:** wrap the Node advance in a timeout (`Promise.race` / `AbortSignal.timeout`) matching
CF's 5-min ceiling, funnelling to the same retry/fail path — restoring runtime symmetry on the
hang bound.

**F10 — Recurring pipeline fire clobbers a human-parked (`blocked`) prior run.**
`backend/packages/integrations/src/modules/.../RecurringPipelineService.ts:317-324` — the
active-run guard checks only `running` / `paused`. A prior run parked `blocked` on a review or
decision gate is replaced by the next cron fire; the parked run's durable driver is orphaned
against a replaced execution and a later human resolve hits `NotFound`.
**Fix:** add `blocked` to the guard (skip the fire; the human gate is the pipeline's state).

**F11 — Block flipped `pr_ready` BEFORE the `merge_review` card is raised; a raise failure
loses the only actionable prompt.**
`backend/packages/orchestration/src/modules/execution/MergeResolver.ts:133-143`
(`raiseReviewAndBlock`), same order in `raisePipelineComplete`
(`RunStateMachine.ts:407-430`). If `notificationService.raise` throws, the run fails but the
block is already `pr_ready` with no inbox card — a human sees a PR-ready task with no
merge-review action and nothing re-drives the review.
**Fix:** raise the card first, then flip the block (or make the raise failure-tolerant with a
retry on the escalation sweep).

**F12 — A >10-min poll gap sleeps the CF container and burns the single eviction recovery.**
`backend/runtimes/cloudflare/src/infrastructure/.../ExecutionContainer.ts:43-48`
(`sleepAfter '10m'`) + `job.logic.ts:11` (`MAX_EVICTION_RECOVERIES = 1`). The DO is kept warm
only by polling; two backend poll-scheduling hiccups in one step fail a healthy run `evicted`
(rollout evictions get a budget of 5; ordinary sleep-eviction gets 1).
**Fix:** consider a larger recovery budget for sleep-evictions, or a keep-warm ping decoupled
from the poll cadence.

**F13 — Pi "chatty hang" (streaming output, zero tool calls) runs the full 60 min.**
`executor-harness/src/pi.ts:943-951` resets inactivity on **any** stdout/stderr chunk; the
progress guard (`pi.ts:721-769`) only watches `tool_execution_end`. A thinking-forever model
never trips either and burns the whole budget (and the engine budget behind it).
**Fix (harness, optional):** a no-tool-progress guard between the 10-min inactivity and the
60-min cap. Arguably the 60-min ceiling is the intended bound — lowest-priority medium.

**F14 — Resumed work branch with nothing ahead of base fails the run with GitHub's opaque
422 instead of no-op'ing (and the merger silently strands the branch).**
`executor-harness/src/coding-agent.ts` computed `hasWork = resumed || branchHasCommitsSince(...)`,
so ANY pre-existing work branch was treated as work even when it had zero commits ahead of the
PR base. A branch gets stranded in that state when its earlier PR is merged with a **merge
commit** (leaving the branch reachable from base) and `GitHubPullRequestMerger`'s best-effort
`deleteBranch().catch(() => {})` skips the cleanup. A re-dispatch then resumes it, the agent
no-op's, and `openPullRequest` fails `422 "No commits between <base> and <branch>"` — surfaced
to the user as a scary `Failed to open PR (HTTP 422)` rather than a clean no-changes outcome.
Observed on a local docker+postgres run (`exec_91f9521463e64bd898e53f3d`).
**Fix (this PR):** `runCodingAgent` confirms a resumed branch is actually ahead of the PR base
(new tri-state `branchAheadOfBase`; `undefined` keeps the prior resume-is-work behaviour) and
records a no-op otherwise; `openPullRequest` maps the 422 "No commits between" to a no-op
(`null`) as a backstop; `GitHubPullRequestMerger` now logs the swallowed branch-delete failure.
Harness change ⇒ image-bumped (`@cat-factory/executor-harness` 1.31.6 → 1.31.7 + the three
pins). Follow-up (not done): don't re-dispatch a block whose PR already merged.

### Low — recorded as accepted / not planned (don't re-derive these)

- **pg-boss poison run dodges the hard-stall clock:** a drive that throws → pg-boss `failed` →
  sweeper re-sends a fresh job → momentarily `live` → `orphanedSince` resets; the run retries
  forever instead of failing `stalled`. Only manifests during a persistence outage (during
  which `failRun` couldn't persist anyway). The mothership runner is stricter
  (consecutive-failure `maxAttempts`).
- **No hard-stall backstop for `bootstrap`/`env-config-repair` kinds** in either sweeper
  (`ref.kind === 'execution'` guards) — a deterministic create-then-die loop re-drives forever.
- **Node lacks CF's periodic `blocked`-run re-advance** (`waitForEvent` timeout re-loop). All
  current resolvers flip `blocked → running` before signalling, so self-healing holds today;
  a divergence to watch if a resolver ever signals without the status flip.
- **Crash window between `startJob` and the `jobId` upsert** double-dispatches a container
  (`RunDispatcher.ts:376-401`, `:2385-2397`); the orphan is reaped, the run advances on the
  second job — duplicate work, not a wedge.
- **`MAX_GATE_HOPS` break falls through** with an unhandled `awaiting_*` result
  (`drive.ts:125-166`); the outer loop re-advances so nothing wedges — a defensive `failRun`
  would be tidier.
- **PR/MR lookup GETs** (`git.ts:1001-1041`) rely solely on the watchdog signal, no
  independent `AbortSignal.timeout`; fine on all production paths (the signal is always
  threaded).
- **`JobRegistry` never deletes finished entries** — bounded per ephemeral container, and it
  is what makes a slow job impossible to mis-404 into a false eviction (a feature; keep it).
- **Preview-mode containers deliberately live until release/reaper** (`agent.ts:303-357`) —
  by design for browsable previews.
- **Transient-flakiness trade-off:** 6 consecutive poll read failures (~3 min) terminally
  fail a healthy 60-min job. Accepted as the price of bounding a dead backend; revisit only
  if real flakiness data shows it firing.

## Fix groups & status checklist

Fixes are grouped by cohesion; each group is one PR-sized slice. Update the table at the end
of each PR.

| #   | Finding                                             | Area                   | Fix group                | Status  | PR  |
| --- | --------------------------------------------------- | ---------------------- | ------------------------ | ------- | --- |
| F1  | CF sweeper hard-stall on raw lease age              | CF sweeper             | A — recovery correctness | ⬜ todo |     |
| F2  | BootstrapWorkflow terminal-return vs sweeper        | CF workflow/sweeper    | A                        | ⬜ todo |     |
| F5  | `blocked` + dead instance discards decision         | CF workflow/sweeper    | A                        | ⬜ todo |     |
| F3  | Spend-pause: no signal, no auto-resume              | engine + notifications | B — invisible parks      | ⬜ todo |     |
| F7  | `ensureWaitingNotification` suppression             | engine                 | B                        | ⬜ todo |     |
| F10 | Recurring fire clobbers `blocked` run               | integrations           | B                        | ⬜ todo |     |
| F4  | Pool transport: no eviction mapping / no-op release | integrations           | C — transport bounds     | ⬜ todo |     |
| F8  | `reinitAndPush` not abort-aware                     | harness (image bump)   | C                        | ⬜ todo |     |
| F11 | `pr_ready` before `merge_review` raise              | engine                 | C                        | ⬜ todo |     |
| F6  | Harness event-loop starvation vs watchdogs          | harness (image bump)   | D — hang ceilings        | ⬜ todo |     |
| F9  | Node advance has no timeout                         | node driver            | D                        | ⬜ todo |     |
| F12 | Sleep-eviction burns the single recovery            | CF container           | D                        | ⬜ todo |     |
| F13 | Chatty-hang runs full 60 min                        | harness (image bump)   | D                        | ⬜ todo |     |
| F14 | Resumed empty branch fails 422 vs no-op             | harness + engine       | (fixed inline)           | ✅ done |     |

Suggested order: A (guaranteed wrong-kill on common operational events), then B (parks with
no signal), then C, then D (most invasive; D is deferrable).

## Conventions & gotchas for implementers

- **Runtime symmetry is mandatory** for anything touching engine/sweeper/notification
  behaviour (F3, F7, F9, F10, F11): land Worker + Node together with a conformance assertion
  (`@cat-factory/conformance`), per the CLAUDE.md rule. F1/F2/F5 are CF-only by nature (the
  Node sweeper is the reference implementation being ported _from_).
- **Harness changes (F6, F8, F13) are image-bumping:** bump `@cat-factory/executor-harness`'s
  version + the three tag pins (`deploy/backend/package.json`, `deploy/backend/wrangler.toml`,
  `RECOMMENDED_HARNESS_IMAGE`) per the release rules in CLAUDE.md — keep them separate from
  non-harness slices.
- **`sweepStuckRuns` is pure orchestration over `SweepDeps`** — extend its fake-based unit
  tests for F1/F2/F5; don't test through real Workflows.
- **`runners.logic.ts` has table tests** — extend them for F4's state-mapping changes.
- **The sweepers only see `status='running'`** — any fix that wants sweeper coverage for a
  park must either flip the status or extend `listStale` deliberately (and symmetrically);
  don't widen it casually, the invisibility of `blocked`/`paused` is load-bearing for the
  decision model.
- **Notification cards are the recovery path for parks.** When adding one (F3) mind the
  suppression guard (F7) — fixing F3 without F7 can still yield an invisible park.
- Changeset per touched published package; empty changeset for docs/test-only slices.
