import type { PipelineStep } from '@cat-factory/kernel'

/**
 * Plan how a failed run resumes on retry: keep the steps that already completed
 * and re-run from the one that actually failed, rather than restarting the whole
 * pipeline from step 0. For `pl_full` (`requirements → architect → researcher →
 * coder → …`) a coder failure otherwise re-runs the two human-gated steps before
 * it; resuming skips straight back to `coder`.
 *
 * Pure + deterministic so it can be unit-tested without the service's ports. The
 * caller mints the new instance id and re-drives the durable runner.
 */
export function planResumedSteps(prev: {
  steps: PipelineStep[]
  currentStep: number
}): { steps: PipelineStep[]; currentStep: number } {
  // Resume at the first step that did not complete. A failed run normally parked
  // on `currentStep`, but deriving it from the `done` states is robust to a stale
  // index and means the steps before it are exactly the ones we preserve.
  const firstUnfinished = prev.steps.findIndex((s) => s.state !== 'done')
  // All steps done (shouldn't happen for a failed run): nothing to resume — re-run
  // the last step so the retry still does something rather than no-op.
  const resumeIndex = firstUnfinished === -1 ? Math.max(prev.steps.length - 1, 0) : firstUnfinished

  const steps = prev.steps.map((step, i) => {
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
    ci: null,
    conflicts: null,
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
