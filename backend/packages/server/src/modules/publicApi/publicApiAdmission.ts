// Public-API ADMISSION: what an external, key-authenticated caller may launch through
// `/api/v1/initiatives`, and the `headlessStartable` flag pipeline discovery reports.
//
// Extracted from `PublicApiController` so the policy is unit-testable in isolation: the built-in
// public pipeline is READ-ONLY, so there is no way to construct a public-and-parking pipeline over
// HTTP, and the guard's most important cases (a parking kind, a gated step, a disabled step) would
// otherwise be untestable. It is pure, runtime-neutral logic in the SHARED controller layer, so it
// cannot drift between facades — which is also why it belongs here rather than in the
// cross-runtime conformance suite.
//
// See docs/initiatives/headless-clarification-loop.md (D1).

import {
  type AgentKindRegistry,
  ARCHITECTURE_BRAINSTORM_AGENT_KIND,
  CLARITY_REVIEW_AGENT_KIND,
  isInlineModelStep,
  REQUIREMENTS_BRAINSTORM_AGENT_KIND,
  REQUIREMENTS_REVIEW_AGENT_KIND,
} from '@cat-factory/agents'

/**
 * Inline agent kinds that PARK a run on a human/gate decision. This MUST list every
 * inline-and-parking kind: the two review gates AND the two brainstorm dialogues (all four set the
 * run `blocked` awaiting a human, see ExecutionService.evaluateReview / the brainstorm gate).
 *
 * The guard these drive used to be a FLAT refusal, because a public run was headless with no way
 * to answer: the run would sit `blocked` forever while its anchor stayed `in_progress`, permanently
 * consuming one of the workspace's `MAX_ACTIVE_INITIATIVE_RUNS` slots. Note what is NOT available
 * as a backstop — a parked run waits for a human INDEFINITELY (`ExecutionWorkflow` re-arms its
 * `waitForEvent` on expiry rather than failing the run; the old hard decision timeout was removed
 * deliberately), so "it will eventually time out" was never true.
 *
 * With the public decision surface (`/api/v1/runs/:runId/decisions`) a headless caller CAN answer,
 * so the refusal is now a SCOPE question rather than a ban: a parking pipeline is admitted only for
 * a key that satisfies `decide` — the operator asserting "this integration is the headless overseer
 * for these runs" — and `POST /api/v1/jobs/:id/cancel` guarantees an abandoned park can always be
 * cleared, so the concurrency cap stays a recoverable `429` rather than a wall with no door. A
 * plain `write` key sees exactly the pre-existing behaviour, refusal included. See
 * `docs/initiatives/headless-clarification-loop.md` (decision D1).
 */
export const PARKING_INLINE_KINDS = new Set<string>([
  REQUIREMENTS_REVIEW_AGENT_KIND,
  CLARITY_REVIEW_AGENT_KIND,
  REQUIREMENTS_BRAINSTORM_AGENT_KIND,
  ARCHITECTURE_BRAINSTORM_AGENT_KIND,
])

/**
 * The park surface an approval GATE presents. Not an agent kind — a gate rides any ordinary step —
 * but it parks the run just as surely, so it is named alongside the kinds wherever parks are
 * enumerated for a caller.
 */
export const APPROVAL_GATE_PARK_SURFACE = 'approval-gate'

/**
 * The park surfaces `/api/v1/runs/:runId/decisions` can actually ANSWER today.
 *
 * Deliberately a SEPARATE set from {@link PARKING_INLINE_KINDS}, because the asymmetry between them
 * IS the current state: admission lets a `decide` key start more parks than the decision surface
 * can answer (clarity review and both brainstorms are separate orchestration modules
 * `buildDecisionList` does not read; an approval gate is not projected at all). Closing that gap is
 * tracked in `docs/initiatives/public-api-additions.md`.
 *
 * Keeping the answerable set EXPLICIT rather than implied is what stops the refusal below drifting
 * from what the surface really serves: landing a slice moves a member here and the message it
 * builds updates itself, where a hand-written sentence would keep promising an answer path that
 * does not exist — which is exactly the defect this replaced.
 */
export const PUBLICLY_ANSWERABLE_PARK_SURFACES = new Set<string>([REQUIREMENTS_REVIEW_AGENT_KIND])

/** The pipeline shape admission reasons about — the step chain plus its parallel flag arrays. */
export interface AdmissiblePipelineShape {
  agentKinds: string[]
  /** Per-step enable flags, parallel to `agentKinds`; a missing/`true` entry means enabled. */
  enabled?: boolean[]
  /** Per-step human approval gates, parallel to `agentKinds`. */
  gates?: boolean[]
}

/** The enabled steps of a pipeline, paired with their ORIGINAL index (gates are index-aligned). */
function enabledSteps(pipeline: AdmissiblePipelineShape): { kind: string; i: number }[] {
  return pipeline.agentKinds
    .map((kind, i) => ({ kind, i }))
    .filter(({ i }) => pipeline.enabled?.[i] !== false)
}

/**
 * Whether every enabled step of a pipeline runs INLINE — no container, no repo, no push. This is
 * the non-negotiable half of public admission: an external key must never be able to trigger
 * container work or a GitHub write through the initiative surface, whatever its scope.
 */
export function isInlineOnlyPipeline(
  pipeline: AdmissiblePipelineShape,
  registry: AgentKindRegistry,
): boolean {
  const enabled = enabledSteps(pipeline)
  if (enabled.length === 0) return false
  return enabled.every(({ kind }) => isInlineModelStep(kind, registry))
}

/**
 * Whether a pipeline can PARK the run on a human decision — an approval gate on an enabled step,
 * or one of the {@link PARKING_INLINE_KINDS} review/brainstorm kinds. Parking is not a defect: it
 * is the clarification loop. It just needs an answerer, which is what the `decide` scope asserts.
 */
export function canParkOnHuman(pipeline: AdmissiblePipelineShape): boolean {
  return parkSurfacesOf(pipeline).length > 0
}

/**
 * Every park surface an ENABLED step of `pipeline` can put the run on, in step order and deduped:
 * an approval gate on the step, or the step's own {@link PARKING_INLINE_KINDS} kind.
 *
 * This is the single enumeration {@link canParkOnHuman} derives its boolean from, so the predicate
 * and the explanation a caller is given can never disagree about what parks.
 */
export function parkSurfacesOf(pipeline: AdmissiblePipelineShape): string[] {
  const surfaces = new Set<string>()
  for (const { kind, i } of enabledSteps(pipeline)) {
    if (pipeline.gates?.[i]) surfaces.add(APPROVAL_GATE_PARK_SURFACE)
    if (PARKING_INLINE_KINDS.has(kind)) surfaces.add(kind)
  }
  return [...surfaces]
}

/**
 * The message behind the `pipeline_requires_decide_scope` refusal, built from the pipeline's ACTUAL
 * park surfaces.
 *
 * It used to be a fixed sentence naming all four parking kinds plus the approval gate and promising
 * that a `decide` key "can answer the park through /api/v1/runs/:runId/decisions". Four of those
 * five cannot be answered there, so an operator following that advice minted a wider-scoped key and
 * got a run whose only exit is `POST /api/v1/jobs/:id/cancel` — the platform's degrade-loudly rule
 * inverted, since the refusal was confidently describing a capability it does not have.
 *
 * What is ADMITTED is unchanged: whether a start path should refuse a park nothing can answer is a
 * policy question left open for the maintainer in the tracker. This only stops the refusal lying
 * about the surface while that question is open.
 */
export function parkingRefusalMessage(pipeline: AdmissiblePipelineShape): string {
  const surfaces = parkSurfacesOf(pipeline)
  const answerable = surfaces.filter((s) => PUBLICLY_ANSWERABLE_PARK_SURFACES.has(s))
  const unanswerable = surfaces.filter((s) => !PUBLICLY_ANSWERABLE_PARK_SURFACES.has(s))
  const parts = [`This pipeline can park on a human decision (${surfaces.join(', ')}).`]
  parts.push(
    answerable.length > 0
      ? `Start it with a 'decide'-scope key, which can answer ${answerable.join(', ')} through /api/v1/runs/:runId/decisions.`
      : `Starting it needs a 'decide'-scope key.`,
  )
  if (unanswerable.length > 0) {
    parts.push(
      `The public decision surface cannot answer ${unanswerable.join(', ')} yet, so a run that parks there can only be ended with POST /api/v1/jobs/:id/cancel.`,
    )
  }
  return parts.join(' ')
}

/**
 * Whether a pipeline is safe to run with NO human in the loop at all: inline-only AND non-parking.
 * This is what the `headlessStartable` discovery flag reports — a caller holding only a `write` key
 * can drive such a pipeline end to end with no follow-up. A parking pipeline is still admissible
 * for a `decide`-scoped key (see {@link PARKING_INLINE_KINDS}), it simply needs answering.
 */
export function isHeadlessInlinePipeline(
  pipeline: AdmissiblePipelineShape,
  registry: AgentKindRegistry,
): boolean {
  return isInlineOnlyPipeline(pipeline, registry) && !canParkOnHuman(pipeline)
}
