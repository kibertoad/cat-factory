import type {
  AgentFailure,
  ExecutionInstance,
  PipelineStep,
  PriorStepOutput,
} from '@cat-factory/kernel'
import { restartRalphState } from './ralph.logic.js'

/**
 * Plan how a failed run resumes on retry: keep the steps that already completed
 * and re-run from the one that actually failed, rather than restarting the whole
 * pipeline from step 0. For `pl_full` (`requirements → spec-writer → architect →
 * researcher → coder → …`) a coder failure otherwise re-runs the human-gated steps
 * before it; resuming skips straight back to `coder`.
 *
 * Pure + deterministic so it can be unit-tested without the service's ports. The
 * caller mints the new instance id and re-drives the durable runner.
 */
export function planResumedSteps(prev: { steps: PipelineStep[]; currentStep: number }): {
  steps: PipelineStep[]
  currentStep: number
} {
  // Resume at the first step that did not complete. A failed run normally parked
  // on `currentStep`, but deriving it from the `done` states is robust to a stale
  // index and means the steps before it are exactly the ones we preserve.
  const firstUnfinished = prev.steps.findIndex((s) => s.state !== 'done')
  // All steps done (shouldn't happen for a failed run): nothing to resume — re-run
  // the last step so the retry still does something rather than no-op.
  const resumeIndex = firstUnfinished === -1 ? Math.max(prev.steps.length - 1, 0) : firstUnfinished
  return planFromStep(prev.steps, resumeIndex)
}

/**
 * The most prior failures kept in a run's error trail. Each {@link AgentFailure} can carry
 * a large `detail` (an HTTP body / harness reason) and rides in the shared `agent_runs.detail`
 * JSON that is re-serialized on every step-progress write, so an uncapped trail would bloat
 * every write for the rest of a flaky run's life. We keep only the most recent few — the
 * newest errors are the ones worth looking at — and drop the oldest.
 */
export const MAX_FAILURE_HISTORY = 20

/**
 * Accumulate a failed run's error trail across a retry/restart: append the outgoing
 * attempt's own {@link AgentFailure} (if it has one) to the failures it already carried,
 * oldest→newest, keeping at most the {@link MAX_FAILURE_HISTORY} most recent. The fresh
 * attempt is minted with `failure` CLEARED (so the top failure banner, keyed on
 * `status === 'failed'`, disappears the moment the task restarts) but this history
 * preserved — so every recent prior error stays viewable. Called by both
 * {@link ExecutionService.retry} and {@link ExecutionService.restartFromStep}.
 *
 * Pure + deterministic so it can be unit-tested without the service's ports.
 */
export function carryForwardFailures(prev: {
  failure?: AgentFailure | null
  failureHistory?: AgentFailure[]
}): AgentFailure[] {
  const history = prev.failureHistory ?? []
  const next = prev.failure ? [...history, prev.failure] : history
  return next.length > MAX_FAILURE_HISTORY ? next.slice(-MAX_FAILURE_HISTORY) : next
}

/** How many prior successful outputs a run keeps (mirrors {@link MAX_FAILURE_HISTORY}). */
export const MAX_OUTPUT_HISTORY = 20

/**
 * Per-entry character cap on a recorded prior output. An agent's prose output can be many
 * KB and a single restart can discard several at once, so — unlike a failure `detail` — the
 * output is clipped (with a `truncated` flag) to keep the run's `detail` JSON, which is
 * re-serialized on every step-progress write, from bloating for the rest of the run's life.
 */
export const MAX_HISTORY_OUTPUT_CHARS = 8_000

/**
 * Accumulate a run's SUCCESSFUL-output trail across a restart — the positive complement of
 * {@link carryForwardFailures}. A restart resets `resetFromIndex` and every later step,
 * dropping their `output`; the ones that had already SUCCEEDED (state `done` with a non-empty
 * output) are appended here, attributed to their `stepIndex`, so the step-detail execution
 * history keeps the successful outputs the restart superseded rather than losing them. Each
 * output is clipped to {@link MAX_HISTORY_OUTPUT_CHARS} and the trail to the
 * {@link MAX_OUTPUT_HISTORY} most recent, so the `detail` JSON stays bounded. A plain retry
 * resumes at the first UNFINISHED step, so it resets no completed step and records nothing —
 * it simply carries the existing trail forward.
 *
 * Pure + deterministic so it can be unit-tested without the service's ports; the caller
 * supplies `now` (its clock) as the fallback timestamp for a step missing `finishedAt`.
 */
export function carryForwardOutputs(
  prev: { steps: PipelineStep[]; outputHistory?: PriorStepOutput[] },
  resetFromIndex: number,
  now: number,
): PriorStepOutput[] {
  const history = prev.outputHistory ?? []
  const discarded: PriorStepOutput[] = []
  for (let i = Math.max(resetFromIndex, 0); i < prev.steps.length; i++) {
    const step = prev.steps[i]!
    const output = step.output
    // Only a step that actually produced a successful output is worth preserving — the
    // reset ones that failed/never ran are covered by the failure trail (or are just empty).
    if (step.state !== 'done' || !output || !output.trim()) continue
    const truncated = output.length > MAX_HISTORY_OUTPUT_CHARS
    discarded.push({
      stepIndex: i,
      occurredAt: step.finishedAt ?? now,
      output: truncated ? output.slice(0, MAX_HISTORY_OUTPUT_CHARS) : output,
      ...(truncated ? { truncated: true } : {}),
    })
  }
  const next = [...history, ...discarded]
  return next.length > MAX_OUTPUT_HISTORY ? next.slice(-MAX_OUTPUT_HISTORY) : next
}

/**
 * Plan a user-driven "restart from this step": re-run from the explicitly chosen
 * `fromIndex` regardless of how far the run had progressed (even a fully `done`
 * run), keeping every step before it intact and resetting that step + all later
 * ones to a clean, re-runnable state. Unlike {@link planResumedSteps} the target is
 * the human's pick, not the first failure — so it can rewind past already-completed
 * steps. The preserved earlier steps keep their `output`, so the engine still hands
 * the restarted step its predecessors' work as `priorOutputs` (a useful handoff); a
 * block's incorporated requirements are NOT touched here — they live on the
 * requirement-review record, so a restarted spec-writer/coder still reads them (and
 * restarting AT the requirements-review step itself re-runs the reviewer, which
 * mints a fresh iteration-1 review).
 *
 * Pure + deterministic so it can be unit-tested without the service's ports.
 */
export function planRestartFromStep(
  prev: { steps: PipelineStep[] },
  fromIndex: number,
): { steps: PipelineStep[]; currentStep: number } {
  // Clamp into range so an out-of-bounds index can't strand the run with a
  // `currentStep` past the last step (the service validates first, but the pure fn
  // stays total).
  const resumeIndex = Math.min(
    Math.max(Math.trunc(fromIndex), 0),
    Math.max(prev.steps.length - 1, 0),
  )
  return planFromStep(prev.steps, resumeIndex)
}

/**
 * Shared core of {@link planResumedSteps} / {@link planRestartFromStep}: keep the
 * steps before `resumeIndex` exactly as-is (their output/approval/timing are the
 * preserved handoff context) and reset that step + everything after it.
 */
function planFromStep(
  prevSteps: PipelineStep[],
  resumeIndex: number,
): { steps: PipelineStep[]; currentStep: number } {
  const steps = prevSteps.map((step, i) => {
    if (i < resumeIndex) return step // completed: preserve output/approval/timing as-is
    return resetStep(step, i === resumeIndex ? 'working' : 'pending')
  })
  return { steps, currentStep: resumeIndex }
}

/**
 * Reset a step to a clean, re-runnable state, dropping every transient field a
 * prior (partial) attempt may have left behind so the fresh run starts from
 * scratch: no in-flight job handle, no stale gate/subtask state, no prior output,
 * fresh timing (`startStep` re-stamps `startedAt`). The structural fields the
 * pipeline defined — `agentKind` and `requiresApproval` — are preserved so the
 * approval gate still fires after the re-run.
 *
 * A `ralph` step's loop state is RE-SEEDED rather than dropped. Everything else here is
 * re-derived at dispatch or lazily on the way back (`step.test` is seeded when the tester's
 * report arrives), but a ralph loop's completion command is needed BEFORE the dispatch: it is
 * what puts the `validation` block on the job body. Rebuilding this object without it left the
 * retried step with no ralph state at all, so the harness ran a plain coding pass, returned no
 * verdict, and the loop interceptor never fired — the step completed as an ungated one-shot
 * coder. {@link restartRalphState} keeps the frozen config and zeroes the counters.
 */
function resetStep(step: PipelineStep, state: 'working' | 'pending'): PipelineStep {
  const ralph = restartRalphState(step.ralph)
  return {
    agentKind: step.agentKind,
    state,
    progress: 0,
    gate: null,
    subtasks: undefined,
    decision: null,
    requiresApproval: step.requiresApproval,
    approval: null,
    output: undefined,
    model: undefined,
    selectedFragmentIds: undefined,
    jobId: undefined,
    startedAt: undefined,
    finishedAt: undefined,
    pausedAt: undefined,
    ...(ralph ? { ralph } : {}),
  }
}

/**
 * Build the replacement `ExecutionInstance` a retry or a restart installs for a block: a FRESH run
 * id over the re-planned steps, carrying forward everything that describes the WORK rather than
 * the attempt — the initiator, the authority the run was admitted under (its pinned role and
 * mode), how the run entered the system, and the prior-attempt failure + successful-output
 * trails.
 *
 * Both callers had this identically inline, which is precisely how a field comes to be carried
 * forward on one path and silently dropped on the other (a retried headless run reverting to `ui`
 * intake would, in slice 2, stop its clarification questions ever reaching the ticket). Keeping it
 * here — beside the step-planning it pairs with — makes "what survives a re-drive" one decision in
 * one place.
 */
export function buildResumedInstance(input: {
  /** The run being replaced (its identity + everything carried forward). */
  previous: ExecutionInstance
  /** The freshly-minted run id. */
  id: string
  /** The re-planned steps + cursor (from {@link planResumedSteps} / {@link planRestartFromStep}). */
  plan: { steps: PipelineStep[]; currentStep: number }
  /** Initiator override (a retry may be driven by a different user); falls back to the previous. */
  initiatedBy?: string | null
  /** `now`, for attributing the carried-forward successful outputs. */
  now: number
}): ExecutionInstance {
  const { previous, id, plan, initiatedBy, now } = input
  return {
    id,
    blockId: previous.blockId,
    pipelineId: previous.pipelineId,
    pipelineName: previous.pipelineName,
    steps: plan.steps,
    currentStep: plan.currentStep,
    status: 'running',
    initiatedBy: initiatedBy ?? previous.initiatedBy ?? null,
    // A retry/restart re-drives the SAME work, so how it originally entered the system is a
    // property of the work, not of this attempt — a headless run stays headless whether its failed
    // attempt is retried through the public API or the SPA.
    ...(previous.intakeOrigin != null ? { intakeOrigin: previous.intakeOrigin } : {}),
    // The merge policy the run was ADMITTED under travels with it, for the same reason and with
    // more at stake. A re-drive is the same work under the same authority: the role is what the
    // operator granted when they let this run start, and re-resolving it here is impossible
    // anyway (a retry can be driven by a different user, or by a sweeper with no user at all).
    //
    // Dropping either is a live escape hatch rather than a degraded feature. `restartFromStep`
    // has no `failed` precondition, so start-a-dry-run then restart-from-step-0 would mint a
    // LIVE run over the same work — the sandbox exactly one restart deep, through the ordinary
    // affordance. A dry run stays a dry run; only a fresh start can settle a new mode.
    ...(previous.initiatedByRole != null ? { initiatedByRole: previous.initiatedByRole } : {}),
    // Who the run was started FOR travels with it too, and is NOT re-taken from whoever drives
    // the re-drive: a retry is the same work for the same requester, so re-pinning it would
    // hand a run to the operator who pressed retry (or, from a sweeper, to nobody at all).
    ...(previous.initiatedByExternalIdentity != null
      ? { initiatedByExternalIdentity: previous.initiatedByExternalIdentity }
      : {}),
    ...(previous.mode != null ? { mode: previous.mode } : {}),
    // Preserve the error trail: the failure this attempt clears is appended to the history so it
    // stays viewable after the top banner disappears on restart.
    failureHistory: carryForwardFailures(previous),
    // A retry resumes at the first UNFINISHED step and so discards no completed output (this just
    // carries any prior restart's trail forward); a restart resets the chosen step and every later
    // one, so the SUCCESSFUL outputs it discards are recorded here, attributed by step index.
    outputHistory: carryForwardOutputs(previous, plan.currentStep, now),
  }
}
