import type { PipelineStep } from '@cat-factory/kernel'

/**
 * The step fields the context builder REWRITES from each resolution, behind one seam that owns the
 * single question they share: may THIS resolution write them?
 *
 * Both fields describe the dispatch that produced the tree a step pushed, which is only meaningful
 * because each resolution rewrites them, CLEARING what an earlier one recorded. That contract is
 * exactly what makes them dangerous, because `buildContext` has callers that resolve a full context
 * without starting any job: the over-budget exemption probe, and a re-attach to a job an earlier
 * (possibly replayed) dispatch already started. Left ungated, a config store that recovered between
 * the dispatch and the replay ERASES the record that the shipped job ran with no checks, and the PR
 * verification report goes back to telling the reviewer the service configures none.
 *
 * So the decision is taken ONCE per `buildContext` call and handed to the resolvers as this object,
 * rather than as a boolean each of them re-interprets. A resolver cannot write the field it owns
 * without going through the seam, and the next per-dispatch field to be added inherits the rule
 * instead of rediscovering it.
 */
export interface StepObservations {
  /**
   * Whether a write lands. Exposed because a degradation may want to SAY which it was: the
   * validation-read warning names it, so an operator knows whether the report will carry the fact
   * or whether the real dispatch's own line is the one to look for.
   */
  readonly records: boolean
  /** The best-practice fragment ids this resolution folded; `undefined` when it folded none. */
  fragmentIds(ids: string[] | undefined): void
  /** Whether this resolution could READ the service frame's validation configuration. */
  validationConfigUnreadable(unreadable: boolean): void
}

/**
 * Bind {@link StepObservations} to a step for one `buildContext` call.
 *
 * Recording is the DEFAULT, and the asymmetry is deliberate: a caller that should have opted out
 * states a fact about a resolution that never shipped, which is visible and is corrected by the
 * next real dispatch, while one that wrongly opts out deletes evidence with nothing left to show
 * it ever existed. Given a caller will eventually forget, forget loudly.
 */
export function stepObservations(
  step: PipelineStep,
  options?: { recordsDispatch?: boolean },
): StepObservations {
  const records = options?.recordsDispatch ?? true
  return {
    records,
    fragmentIds(ids) {
      if (records) step.selectedFragmentIds = ids
    },
    validationConfigUnreadable(unreadable) {
      if (!records) return
      if (unreadable) step.validationConfigUnreadable = true
      else delete step.validationConfigUnreadable
    },
  }
}
