// Shared rendering helpers for the run-step / pipeline views (PipelineProgress,
// TaskPipelineMini, AgentStepDetail), so the "is this step still live?" logic stays
// in one place rather than being re-derived as inline ternaries per component.

/**
 * Tailwind classes for a subtask-item status icon. An in-progress item spins only
 * while the run is live: once the run has failed, a step left mid-flight (its item
 * state still `in_progress`) keeps its colour but stops spinning, matching the frozen
 * failure card. Completed items are emerald, everything else muted.
 */
export function subtaskIconClass(status: string, runFailed: boolean): string[] {
  return [
    status === 'in_progress'
      ? runFailed
        ? 'text-indigo-400'
        : 'animate-spin text-indigo-400'
      : '',
    status === 'completed' ? 'text-emerald-400' : 'text-slate-500',
  ]
}
