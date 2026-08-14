// ---------------------------------------------------------------------------
// The BUILD LADDER — the ids of the built-in build presets, and the rung a task defaults to.
//
// The definitions live in kernel's catalog (`seedPipelines`), but the ids and the default RULE
// live here because both sides have to agree about them: the SPA pre-selects a rung in the create
// form and on the task card's plain "Start", and the backend defines and resolves it.
// ---------------------------------------------------------------------------

import type { RunDefaultScope } from './run-provenance.js'

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
 * Pipeline id of the UNATTENDED rung — the adaptive shape, sized per task, with every step that
 * needs a person either absent or estimate-gated: no `requirements-review` conversation, a
 * `task-estimator` first, and `human-review` / `human-test` reached only by a task whose estimate
 * says the risk earns them.
 *
 * This is the seeded default for a run nothing is watching (`Pipeline.isUnattendedDefault`), which
 * is why it exists as its own rung rather than reusing {@link ADAPTIVE_BUILD_PIPELINE_ID}: the
 * adaptive rung is what an in-app operator picks to have the platform size a task, and its
 * verification tail is deliberately the same one every other rung carries. A headless run wants a
 * DIFFERENT trade: fewer human doors overall, and the ones it keeps placed by measured risk rather
 * than by an author's standing choice.
 */
export const UNATTENDED_BUILD_PIPELINE_ID = 'pl_unattended'

/**
 * The pipeline a workspace has DECLARED as its default for the given resolution scope, or
 * `undefined` when no row claims it.
 *
 * Stated here rather than in kernel because both sides have to agree: the SPA pre-selects the same
 * rung on its start controls that the engine falls back to when a headless caller names none, and
 * two readings of "the default" is exactly how a Start button comes to run something other than
 * what the board said it would.
 *
 * `undefined` is a real answer, not a lookup failure — see `Pipeline.isDefault`. Each caller
 * composes its own fallback with it: the SPA {@link defaultBuildPipelineId}, the engine catalog
 * order.
 */
export function declaredDefaultPipelineId(
  pipelines: readonly {
    id: string
    isDefault?: boolean | undefined
    isUnattendedDefault?: boolean | undefined
  }[],
  scope: RunDefaultScope,
): string | undefined {
  const claims = scope === 'unattended' ? 'isUnattendedDefault' : 'isDefault'
  return pipelines.find((pipeline) => pipeline[claims] === true)?.id
}

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
 *
 * This is the FALLBACK half of the in-app answer: {@link declaredDefaultPipelineId} outranks it,
 * because an operator who named a default said something the interface tier cannot overrule.
 */
export function defaultBuildPipelineId(advanced: boolean): string {
  return advanced ? ADAPTIVE_BUILD_PIPELINE_ID : BUILD_PIPELINE_ID
}
