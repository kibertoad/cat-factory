// Public-API ADMISSION: what an external, key-authenticated caller may launch through
// `POST /api/v1/jobs` and `POST /api/v1/tasks/:taskId/start`, and the `headlessStartable`
// flag pipeline discovery reports.
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
  hasTrait,
  INTERVIEW_GATE_TRAIT,
  isInlineModelStep,
  REQUIREMENTS_BRAINSTORM_AGENT_KIND,
  REQUIREMENTS_REVIEW_AGENT_KIND,
} from '@cat-factory/agents'
import { HUMAN_WAIT_GATE_KINDS } from '@cat-factory/contracts'

/**
 * Inline agent kinds that PARK a run on a human/gate decision. This MUST list every
 * inline-and-parking kind: the two review gates AND the two brainstorm dialogues (all four set the
 * run `blocked` awaiting a human, see ExecutionService.evaluateReview / the brainstorm gate).
 *
 * The guard these drive used to be a FLAT refusal, because a public run was headless with no way
 * to answer: the run would sit `blocked` forever while its anchor stayed `in_progress`, permanently
 * consuming one of the workspace's `MAX_ACTIVE_JOB_RUNS` slots. Note what is NOT available
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
 * The park surface the PRE-DISPATCH INPUT GATE presents. A THIRD kind of thing again, and the
 * distinction matters more here than the others: the two above are properties of the PIPELINE, so
 * {@link parkSurfacesOf} can read them off the step chain, while this one is a property of the
 * TASK. A run whose pipeline parks nowhere at all still stops here if its task states nothing an
 * agent could act on, which is why it is composed in by {@link publicRunParkSurfaces} at the start
 * surfaces (which have the task in hand) rather than derived from the pipeline.
 */
export const INPUT_GATE_PARK_SURFACE = 'input-gate'

/**
 * The park surface an INTERVIEW GATE presents: an inline interviewer asks a batch of clarifying
 * questions and the run waits while a human answers them.
 *
 * A FOURTH mechanism, read off the step kind's `interview-gate` TRAIT rather than a list of
 * interviewer kinds, which is what makes a deployment's OWN registered interviewer visible to
 * admission with no edit here, the opposite of the wait-gate gap {@link HUMAN_WAIT_GATE_KINDS}
 * documents. Being visible HERE is not the same as being answerable: the decision surface needs the
 * gate's controller wired too (`ExecutionService.interviewGateFor`), and a kind registered without
 * one is admitted as a park and 503s when answered. That order is the safe one (the refusal
 * over-counts rather than under-counts), but it is why the two checks are not one.
 *
 * Missing it was reachable rather than theoretical, and in the worst direction: an interviewer is
 * an INLINE step, so a pipeline built out of interview steps was reported `headlessStartable`
 * (the flag that tells a caller a `write` key can drive the pipeline end to end with no follow-up)
 * while every run of it stopped on the first batch of questions. No SHIPPED preset changes hands
 * here, because both built-in interview pipelines already carry a human gate on a later step and
 * were admitted as parking on that; what changes is that the refusal now names the interview, and
 * that a pipeline whose only park is the interview is finally seen.
 */
export const INTERVIEW_PARK_SURFACE = 'interview'

/**
 * POLLING-GATE kinds that park on a human, re-exported from `@cat-factory/contracts` so every park
 * surface this module enumerates is reachable from one place.
 *
 * A third category beside {@link PARKING_INLINE_KINDS} and {@link APPROVAL_GATE_PARK_SURFACE},
 * because it is a third MECHANISM: not an inline review that sets the run `blocked`, and not an
 * approval flag riding an ordinary step, but a gate step whose own poll loop never times out
 * (`pollExhaustion: 'rearm'`) because it is waiting on a person. `human-review` is the one built-in
 * that qualifies, and it is why `pl_full` (the shipped Adaptive build preset, which carries a
 * risk-gated `human-review`) is a parking pipeline.
 *
 * Missing it was a real hole rather than a theoretical one: `human-review` is not answerable through
 * `/api/v1/runs/:runId/decisions` at all, so a plain `write` key could start the platform's flagship
 * board preset and have it park forever on the one surface with no public answer path.
 *
 * ONLY BUILT-IN GATES ARE IN IT, and a deployment that registers its own unbounded-wait gate
 * through the public `GateRegistry` seam is therefore INVISIBLE to this check: such a pipeline is
 * admitted for a plain `write` key and then parks with nothing here able to name it. That is a
 * limit of what a request-time check can read, not an oversight: a gate's `pollExhaustion` is
 * declared inside the object its FACTORY builds from an engine context, and standing a fake
 * context up per admission call to interrogate a static declaration would be a shortcut, not a
 * design. So the deployment that registered the gate owns the answer to it, in whatever surface
 * it registered it for, and the run reports `parked: true` with an empty decision list until then.
 *
 * Note what the neighbouring surfaces do NOT share this limit: {@link INTERVIEW_PARK_SURFACE} is
 * read off an AGENT KIND's trait, and follow-up triage would be readable off the pipeline's own
 * per-step toggles (it has no constant here because it is deliberately not enumerated, see
 * {@link parkSurfacesOf}), both of which a deployment's own registrations flow through, so a custom
 * interviewer is seen here and a custom wait gate is not. Closing the gap means a gate declaring
 * `pollExhaustion` at REGISTRATION time rather than only on the built definition; that is a change
 * to the registry seam, ranked in `docs/initiatives/public-api-additions.md` rather than smuggled
 * in behind a park-surface slice.
 */
export { HUMAN_WAIT_GATE_KINDS }

/**
 * The route that frees an abandoned park, per public START surface. Named here rather than inlined
 * at each call site because {@link parkingRefusalMessage} puts one of them in front of an operator:
 * a route that only exists as a literal in a controller and a second literal in a test is a route
 * that can be renamed in one of the two.
 */
export const PUBLIC_JOB_CANCEL_PATH = 'POST /api/v1/jobs/:id/cancel'
export const PUBLIC_TASK_STOP_PATH = 'POST /api/v1/tasks/:taskId/stop'

/**
 * The park surfaces `/api/v1/runs/:runId/decisions` can actually ANSWER today.
 *
 * Deliberately a SEPARATE set from {@link PARKING_INLINE_KINDS}, because the asymmetry between the
 * two is the thing worth stating: admission decides what a `decide` key may set in motion, and
 * this decides what the refusal is allowed to PROMISE it can then answer.
 *
 * Keeping the answerable set EXPLICIT rather than implied is what stops the refusal below drifting
 * from what the surface really serves: landing a slice moves a member here and the message it
 * builds updates itself, where a hand-written sentence would keep promising an answer path that
 * does not exist — which is exactly the defect this replaced.
 *
 * The gap is now down to ONE member of {@link parkSurfacesOf}: `human-review`, and it is not a
 * slice waiting to be built. Its answer is a person approving the pull request on the VCS host,
 * not an API call this surface could offer, so a run parked there is honestly reported as
 * `parked: true` with nothing to answer and the refusal says as much. See
 * `docs/initiatives/public-api-additions.md`.
 */
export const PUBLICLY_ANSWERABLE_PARK_SURFACES = new Set<string>([
  REQUIREMENTS_REVIEW_AGENT_KIND,
  CLARITY_REVIEW_AGENT_KIND,
  REQUIREMENTS_BRAINSTORM_AGENT_KIND,
  ARCHITECTURE_BRAINSTORM_AGENT_KIND,
  INPUT_GATE_PARK_SURFACE,
  APPROVAL_GATE_PARK_SURFACE,
  INTERVIEW_PARK_SURFACE,
])

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
 * container work or a GitHub write through the jobs surface, whatever its scope.
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
 * Whether a pipeline can PARK the run on a human decision: an approval gate on an enabled step, one
 * of the {@link PARKING_INLINE_KINDS} review/brainstorm kinds, or one of the
 * {@link HUMAN_WAIT_GATE_KINDS} unbounded-wait gates. Parking is not a defect: it is the
 * clarification loop. It just needs an answerer, which is what the `decide` scope asserts.
 */
export function canParkOnHuman(
  pipeline: AdmissiblePipelineShape,
  registry: AgentKindRegistry,
): boolean {
  return parkSurfacesOf(pipeline, registry).length > 0
}

/**
 * Every park surface an ENABLED step of `pipeline` can put the run on, in step order and deduped.
 * Four mechanisms, each a separate check because each parks for a different reason:
 *
 *  1. an approval gate flag on the step ({@link APPROVAL_GATE_PARK_SURFACE});
 *  2. the step's own kind being an inline review/brainstorm ({@link PARKING_INLINE_KINDS});
 *  3. the step's own kind being a polling gate that waits on a human with no deadline
 *     ({@link HUMAN_WAIT_GATE_KINDS});
 *  4. the step's own kind carrying the `interview-gate` TRAIT ({@link INTERVIEW_PARK_SURFACE}).
 *
 * This is the single enumeration {@link canParkOnHuman} derives its boolean from, so the predicate
 * and the explanation a caller is given can never disagree about what parks.
 *
 * Case 4 arrived after the first three had shipped, which is the lesson the human-wait gates
 * already taught repeating itself: an enumeration written against the park mechanisms somebody
 * thought of misses the ones they did not, so ask what each entry is DERIVED from. Cases 2, 3 and 4
 * each derive from a declaration (a kind list, a `pollExhaustion` value pinned by a drift guard, a
 * registered trait) rather than from a hand-kept list of pipelines. Whatever is added next should
 * be derivable too.
 *
 * THREE THINGS ARE DELIBERATELY NOT HERE, and they are absent for three different reasons:
 *
 *  - A park raised dynamically mid-run (an agent-raised decision, a judge `park` disposition) is
 *    not knowable from the step chain at start time, so the rule cannot see it and does not pretend
 *    to. ADR 0032.
 *  - An unbounded human-wait gate a DEPLOYMENT registered itself cannot be read at request time;
 *    see the note on {@link HUMAN_WAIT_GATE_KINDS}. It is the only mechanism here a deployment's own
 *    registration escapes: a custom interviewer carries the trait case 4 reads and IS seen.
 *  - FOLLOW-UP TRIAGE is knowable (the companion is seeded on a Coder step unless the pipeline's
 *    per-step `followUps` toggle turns it off) and is deliberately left out anyway, because
 *    counting it would refuse a plain `write` key EVERY board pipeline that builds anything: the
 *    companion is on by default on every Coder step, so `pl_simple` and `pl_build` (the presets
 *    whose selling point is that they never pause) would become `decide`-only. Taking that much
 *    capability off live keys is a bigger break than the gap it closes, and the gap is no longer
 *    the one this rule exists to prevent: the park HAS a public answer path now
 *    (`…/decisions/follow-ups/items/:itemId/*`), so a run that stops there is recoverable with a
 *    `decide` key instead of being app-only. Reconsider if the companion's default ever flips off.
 *    Recorded in `docs/initiatives/public-api-additions.md` so it is not re-proposed as an
 *    oversight.
 */
export function parkSurfacesOf(
  pipeline: AdmissiblePipelineShape,
  registry: AgentKindRegistry,
): string[] {
  const surfaces = new Set<string>()
  for (const { kind, i } of enabledSteps(pipeline)) {
    if (pipeline.gates?.[i]) surfaces.add(APPROVAL_GATE_PARK_SURFACE)
    if (PARKING_INLINE_KINDS.has(kind) || HUMAN_WAIT_GATE_KINDS.has(kind)) surfaces.add(kind)
    if (hasTrait(kind, INTERVIEW_GATE_TRAIT, registry)) surfaces.add(INTERVIEW_PARK_SURFACE)
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
 * Both public start paths apply the parking rule now: `POST /jobs` always has, and
 * `POST /tasks/:taskId/start` adopted it with the API-stability commitment (the tracker's open
 * question, settled): a `write` key must not be able to set in motion a park it is by definition
 * not trusted to answer.
 *
 * `cancelPath` is REQUIRED rather than defaulted, because which route frees an abandoned park is a
 * property of the START SURFACE and every surface answers differently: a headless job is cancelled
 * at `POST /api/v1/jobs/:id/cancel`, a board task is stopped at `POST /api/v1/tasks/:taskId/stop`.
 * Defaulting it to either one is wrong for the other and wrong-but-plausible for a third, which is
 * precisely the defect this message exists to fix: a refusal must not steer a caller at a route that
 * 404s for the run it is about. Required means a new start surface that forgets to say which route
 * it offers fails to typecheck, rather than shipping another surface's exit as advice.
 */
export function parkingRefusalMessage(surfaces: string[], options: { cancelPath: string }): string {
  const { cancelPath } = options
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
      `The public decision surface cannot answer ${unanswerable.join(', ')} yet, so a run that parks there can only be answered in the app or ended with ${cancelPath}.`,
    )
  }
  return parts.join(' ')
}

/**
 * Every park surface a public run against `pipeline` can end up on, pipeline-shape and task-shape
 * together. This is what both public START surfaces gate on, and what the refusal is built from.
 *
 * `inputGateBlocks` is REQUIRED rather than defaulted, for the same reason `cancelPath` is above: a
 * default is a claim, and both possible defaults are wrong somewhere. `false` re-opens the exact
 * hole this closes (a `write` key starting a run that parks with nothing able to answer it) and
 * `true` refuses runs that were never going to park. Required means a new start surface has to
 * answer the question rather than inherit somebody else's answer.
 */
export function publicRunParkSurfaces(
  pipeline: AdmissiblePipelineShape,
  registry: AgentKindRegistry,
  options: { inputGateBlocks: boolean },
): string[] {
  const surfaces = parkSurfacesOf(pipeline, registry)
  // Prepended: the gate parks BEFORE the first dispatch, so if it is going to hold this run it
  // holds it before any of the pipeline's own park surfaces are reached.
  return options.inputGateBlocks ? [INPUT_GATE_PARK_SURFACE, ...surfaces] : surfaces
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
  return isInlineOnlyPipeline(pipeline, registry) && !canParkOnHuman(pipeline, registry)
}
