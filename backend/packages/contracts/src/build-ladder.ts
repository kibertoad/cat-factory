// ---------------------------------------------------------------------------
// The BUILD LADDER — the ids of the built-in build presets, and the rung a task defaults to.
//
// The definitions live in kernel's catalog (`seedPipelines`), but the ids and the default RULE
// live here because both sides have to agree about them: the SPA pre-selects a rung in the create
// form and on the task card's plain "Start", and the backend defines and resolves it.
// ---------------------------------------------------------------------------

/**
 * Pipeline id of the DEFAULT build preset: design → challenge the design → implement → review →
 * verify → guards → merge, every step unconditional except the tester pair's service conditions.
 * The everyday programmatic loop.
 */
export const BUILD_PIPELINE_ID = 'pl_build'

/**
 * Pipeline id of the TRIVIAL rung — {@link BUILD_PIPELINE_ID} minus the design phase, for work
 * whose approach is not in question (a copy fix, a version bump, a one-line guard).
 */
export const SIMPLE_PIPELINE_ID = 'pl_simple'

/**
 * Pipeline id of the ADAPTIVE rung, which runs a `task-estimator` first and estimate-gates its own
 * design / verification / human-review steps — the `pl_simple`-vs-`pl_build` choice made per task
 * rather than per service.
 */
export const ADAPTIVE_BUILD_PIPELINE_ID = 'pl_full'

/**
 * Pipeline id of the THOROUGH rung — {@link BUILD_PIPELINE_ID} preceded by the two phases that
 * settle what is being built at all: the `requirements-review` conversation and the `researcher`
 * pass. For work whose SCOPE is the risky part.
 */
export const COMPLEX_BUILD_PIPELINE_ID = 'pl_complex'

/**
 * The build preset a task defaults to at each INTERFACE MODE (the SPA's `basic` / `advanced`).
 *
 * Basic mode gets the fixed {@link BUILD_PIPELINE_ID}: its run has the same shape every time,
 * which is what someone who is not yet reading step lists needs from a default. Advanced mode gets
 * the ADAPTIVE rung, which sizes each task and switches its own optional steps on — better on
 * average, and legible only to a reader who already knows what an estimate gate is.
 *
 * The backend does not consult the mode (it has none): a caller that pins no pipeline falls
 * through to the workspace's positional default, which is {@link BUILD_PIPELINE_ID} — the same
 * answer basic mode gives, so the two doors agree wherever the mode is not in view.
 */
export function defaultBuildPipelineId(advanced: boolean): string {
  return advanced ? ADAPTIVE_BUILD_PIPELINE_ID : BUILD_PIPELINE_ID
}
