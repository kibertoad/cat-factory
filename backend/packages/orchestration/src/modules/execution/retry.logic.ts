import type { PipelineStep } from '@cat-factory/kernel'

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
 */
function resetStep(step: PipelineStep, state: 'working' | 'pending'): PipelineStep {
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
  }
}
