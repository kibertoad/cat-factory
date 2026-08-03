# Ralph loop (persistent retry-until-done task type)

A **task type** that runs a persistent, retry-until-done loop: a fresh-context coding
iteration works the task spec, then the executor-harness runs the task's configured
**programmatic validation command** against the checkout, and the engine re-dispatches the
iteration until that command exits 0 (the completion criterion) or a per-task iteration
budget is spent. It **survives restarts**: the loop state rides the persisted step, so both
durable drivers and both stale-run sweepers re-drive a mid-loop run from exactly where it was.

This is the "Ralph Wiggum loop" technique (Geoffrey Huntley; snarktank/ralph) expressed in
cat-factory's seams. The **community learnings** it bakes in:

- **The exit condition is a real programmatic check**: the harness runs the command and reads
  its exit code; the model never self-reports "done". (snarktank gates story completion on
  typecheck + tests before flipping `passes: true`.)
- **Fresh context per iteration**: each pass is a NEW container dispatch, so context never
  degrades. cat-factory dispatches a fresh job per iteration, so this is free.
- **State persists via durable artifacts**: git history on the one work branch, plus an
  append-only progress log the agent maintains (`.cat-factory/ralph-progress.md`), so a
  fresh-context iteration reads what prior iterations tried. The previous iteration's
  validation output is also threaded forward as a prior output.
- **Anti-runaway guardrails**: a max-iteration budget (default 10), a **no-progress early
  abort**, plus the existing spend gate. On either, the loop hands off to a human (a
  `decision_required` notification); it never loops forever.
- **The task description is the spec**: no design/spec phases; the loop works the task
  directly.

## Abstraction: the agent kind is the primitive

The load-bearing primitive is the **`ralph` agent kind** (`@cat-factory/agents`
`kinds/ralph.ts`): a `container-coding` iteration body with `configContributions` for the
validation command + iteration budget. It is reusable in any pipeline. On top of it sit two
thin layers: the **`pl_ralph` pipeline** (`ralph → conflicts → ci → merger`) and the **`ralph`
task type** (`createTaskTypeSchema`), a one-click creation entry point that defaults to
`pl_ralph`. The task type is sugar over the kind, never the mechanism.

## Engine model: the Tester→Fixer loop, not a gate

The validation runs _inside_ the iteration job (the harness can execute; the backend
`RepoFiles` port can only read), so the loop is structurally the **Tester→Fixer loop**, not a
backend-probe gate: one container job per iteration both codes and is validated, its result
carries a verdict, and the engine loops on it.

Flow (`RalphController` + the `ralph-verdict` `StepCompletionInterceptor` in `RunDispatcher`):

1. The `ralph` step dispatches a container-coding iteration (the generic handler). The
   `AgentContextBuilder` folds `step.ralph` → `context.ralphValidation` (command + progress
   path + `attempts + 1` as the iteration number); `jobBody` forwards it as the coding job's
   `validation` block.
2. The harness runs the coding agent, commits, pushes, then runs `validation.command` in the
   checkout (bounded timeout + redacted output tail) and returns `{ validationPassed, exitCode,
validationOutputTail }` on `RunnerJobResult.ralphVerdict` → `AgentRunResult.ralphVerdict`.
3. The `ralph-verdict` interceptor calls `RalphController.resolveRalphResult`: it records the
   iteration on `step.ralph` (attempts++, attempt log, no-progress streak), then
   `decideRalphNext`:
   - **pass** → return null → the normal completion finishes + advances the run (the PR flows
     through the pipeline's ship tail).
   - **stalled** → the loop has stopped making progress; give up early (see below).
   - **fail + budget left** → re-dispatch a fresh iteration (`dispatchIteration`), threading the
     failure output forward; the bumped `attempts` gives the new job a distinct dispatch epoch.
   - **budget spent** → raise a `decision_required` notification, leave the block `blocked`,
     fail the run for a human.

### The no-progress early abort

The iteration budget alone is a poor runaway guard: a loop whose agent commits nothing is
provably not converging, and every further pass costs a full model run to re-learn that. So the
harness stamps the work branch's HEAD onto the verdict (`headSha`) and the engine ends the loop
after `RALPH_NO_PROGRESS_LIMIT` (2) consecutive FAILING iterations against an unchanged head.

- **It fails open.** A verdict with no `headSha` (a self-hosted runner pool on an older harness
  image, or a head that could not be read) RESETS the streak rather than extending it. A missed
  stall costs a few iterations the budget still bounds; a false stall kills a loop that was
  working the whole time.
- **It is reported distinctly** from a spent budget, in the step output, the notification and
  the run failure alike, because the two send a human to different fixes: "the budget was not
  enough" invites raising it, "nothing changed for two iterations" says raising it will not help.
  The SPA derives the same distinction from the loop having ended SHORT of its budget, so it
  keeps no copy of the limit.

### Re-running a ralph step

`step.ralph` is the one piece of step state a re-run must neither drop nor keep. Its completion
command is read at DISPATCH time (it is what puts the `validation` block on the job body), so a
reset that drops the state leaves the re-run dispatching an ungated one-shot coding pass that
reports no verdict: the loop silently stops existing. Keeping the state as-is is equally wrong:
a spent `attempts` sends the re-run's very first verdict straight to `exhausted`. Both reset
paths (`retry.logic.resetStep` for retry/restart-from-step, `StepGraph.resetStepForRerun` for a
loop-back) therefore go through `restartRalphState`, which keeps the frozen config and zeroes
the counters.

`clone: 'pr-or-work'` opens the PR on iteration 1 and amends that same PR branch in place on
every later iteration, so the loop accretes on one branch/PR.

## Where things live

- **Contract**: `contracts/src/ralph.ts` holds `ralphVerdictSchema` (harness verdict, incl.
  `headSha`), `ralphStepStateSchema` (`step.ralph`), `ralphAttemptSchema`; `ralph` on
  `pipelineStepSchema` (rides the run's `detail` JSON blob: **no migration, no table**). `'ralph'`
  added to `taskTypeSchema` + `createTaskTypeSchema`. `AgentConfigDescriptor` gained
  `text`/`number` types (the validation command is free text); the schema always anticipated this.
- **Kind**: `agents/src/agents/kinds/ralph.ts` (`RALPH_AGENT_KIND`, the two config ids,
  presentation with `resultView: 'ralph-loop'`), registered in `defaultAgentKindRegistry`.
- **Pipeline**: `kernel/src/domain/seed.ts` (`RALPH_PIPELINE_ID = 'pl_ralph'`,
  `defaultPipelineIdForTaskType`).
- **Result plumbing**: `ralphVerdict` on `AgentRunResult` + `RunnerJobResult` (kernel);
  `toRunResult` forwards it (`server/src/agents/containerAgentResult.ts`); `jobBody` emits the
  `validation` block.
- **Harness**: `executor-harness/src/coding-agent.ts` runs the command post-commit
  (`runRalphValidation`), `job.ts` parses `validation` + carries `ralphVerdict`. The spawn goes
  through `captured-command.ts`'s `runCapturedCommand`, the ONE seam every harness-run command
  shares, which is also where the scrub-before-truncate ordering and the wire-tail bound live
  (`RALPH_VALIDATION_TAIL_CHARS`, 4k, matching the two sibling phases; the tail rides the run's
  `detail` blob, re-serialized on every progress write). The command is activity-SILENT and the
  harness spawns it itself, so it feeds the inactivity watchdog on a 30s heartbeat; without
  that, `JOB_INACTIVITY_MS` (10 min), being tighter than the command's own 15-min watchdog,
  aborts any slower validation as a wedge. Any source change here bumps the harness version +
  the three runner-image pins.
- **Engine**: `orchestration/src/modules/execution/ralph.logic.ts` (pure: `resolveRalphConfig`
  / `seedRalphState` / `restartRalphState` / `buildRalphValidation` / `nextNoProgressStreak` /
  `decideRalphNext` / `appendRalphAttempt`), `RalphController.ts`, the
  `ralph-verdict` interceptor + `dispatchEpochFor` in `RunDispatcher` / `AgentContextBuilder`,
  and the seed + start-time "needs a validation command" guard in `ExecutionService`.
- **Frontend**: the `ralph` task type in `AddTaskModal.vue` (auto-selects `pl_ralph`; the
  text/number config inputs render generically), `RalphLoopResultView.vue` (registered in
  `StepResultViewHost.vue`), i18n across all locales.

## Config

Per-task on `block.agentConfig` (frozen onto `step.ralph` at run start):
`ralph.validationCommand` (required, the completion criterion; the SPA and the engine's
start guard both enforce it) and `ralph.maxIterations` (default 10, clamped ≤ 50). The command
is inherently per-task, so it lives on agent config rather than the workspace merge preset.

## Security

The validation command runs only inside the sandboxed per-run container, the same trust
boundary as the coding agent (which already runs arbitrary code). There is no backend/host
execution. Output is bounded + secret-redacted before it leaves the container.

## Out of scope / non-goals

- **Multi-repo ralph**: the loop is scoped to the run's primary repo (v1).
- **CI-green as an alternative criterion**: the completion criterion is the in-container
  command; delegating to CI is a possible future alternative.
- **A workspace-level default validation command**: per-task only for now.
- **Playwright e2e**: the loop is covered by the cross-runtime conformance suite + unit
  tests; a live-pushed-UI e2e spec is a follow-up (the result view already carries the
  `data-testid`s it would need).
