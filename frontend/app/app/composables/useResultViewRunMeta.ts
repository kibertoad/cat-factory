import { computed } from 'vue'
import type { ExecutionInstance, PipelineStep } from '~/types/execution'
import { agentKindMeta } from '~/utils/catalog'

/**
 * Resolves the `StepRunMeta` prop bundle for a dedicated result window, for BOTH of the ways
 * such a window opens (see `stores/ui/resultViews.ts`):
 *
 * - the PIPELINE path (`dispatchStepView`), which carries `instanceId` + `stepIndex` — the step
 *   is exactly the one that was clicked, as every step-backed window already assumes; and
 * - an OFF-PATH open (`ui.openInitiativeTracker`, `ui.openInitiativePlanning`, …), which carries
 *   only a block id, because the human entered from the board card or the inspector rather than
 *   from the run's timeline.
 *
 * Windows that are reachable BOTH ways used to fall back to no metadata at all on the second
 * route, which is how the initiative windows ended up with no run details, no model and no token
 * telemetry — on the entry point people actually use. The fallback resolves the block's live run
 * and picks the step this window represents, so the two routes report the same facts.
 */
export function useResultViewRunMeta(
  viewId: string,
  source: {
    blockId: () => string | null
    instanceId: () => string | null
    stepIndex: () => number | null
  },
) {
  const execution = useExecutionStore()

  /**
   * The run the metadata describes: the dispatched one on the pipeline path, else the block's
   * live run. Read reactively rather than resolved once at open time, so a window left open
   * across a run start/advance follows it instead of freezing on whatever existed at mount.
   */
  const instance = computed<ExecutionInstance | null>(() => {
    const id = source.instanceId()
    if (id !== null) return execution.getInstance(id) ?? null
    const blockId = source.blockId()
    return blockId ? (execution.getByBlock(blockId) ?? null) : null
  })

  const stepNumber = computed<number | null>(() => {
    const index = source.stepIndex()
    if (index !== null) return index
    return instance.value ? resultViewStepIndex(instance.value.steps, viewId) : null
  })

  const step = computed<PipelineStep | null>(() => {
    const index = stepNumber.value
    if (index === null) return null
    return instance.value?.steps[index] ?? null
  })

  return {
    instance,
    step,
    /** The run id, for the copyable field + the "View all calls" observability link. */
    instanceId: computed(() => instance.value?.id),
    /** 1-based position, as `StepRunMeta` renders it ("N of M"). */
    position: computed(() => (stepNumber.value === null ? undefined : stepNumber.value + 1)),
    totalSteps: computed(() => instance.value?.steps.length),
    runFailed: computed(() => instance.value?.status === 'failed'),
    failureAt: computed(() => instance.value?.failure?.occurredAt),
  }
}

/**
 * The step an off-path open should report, among the run's steps whose agent kind declares
 * `viewId` as its dedicated result view (the same `resultView` seam `dispatchStepView` routes
 * on, so the mapping can never drift from the window registry).
 *
 * Precedence, most to least specific:
 *
 * 1. the last step that has actually RUN A MODEL. A window's kind set can span both model-running
 *    steps and bookkeeping ones — the initiative tracker is registered for the analyst and the
 *    planner but also for `initiative-committer`, which runs no model — and anchoring on the last
 *    STARTED step alone would hand a human who opened the window for its telemetry the one step
 *    guaranteed to have none.
 * 2. the last started step, so a run mid-flight (or one whose telemetry sink isn't wired) still
 *    reports timing, model and run id rather than nothing.
 * 3. the first declaring step, so a run that hasn't reached any of them yet still names which
 *    step is coming and how far into the pipeline it sits.
 *
 * Null when the run declares none — the caller hides the sidebar rather than rendering an empty one.
 */
export function resultViewStepIndex(steps: readonly PipelineStep[], viewId: string): number | null {
  let first: number | null = null
  let lastStarted: number | null = null
  let lastMetered: number | null = null
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    if (!step || agentKindMeta(step.agentKind).resultView !== viewId) continue
    if (first === null) first = i
    if (step.startedAt != null) lastStarted = i
    if ((step.metrics?.calls ?? 0) > 0) lastMetered = i
  }
  return lastMetered ?? lastStarted ?? first
}
