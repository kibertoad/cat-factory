import type { ExecutionInstance, PipelineStep } from '@cat-factory/kernel'
import { type AgentKindRegistry, hasTrait, INTERVIEW_GATE_TRAIT } from '@cat-factory/agents'
import {
  ARCHITECTURE_BRAINSTORM_AGENT_KIND,
  CLARITY_REVIEW_AGENT_KIND,
  HUMAN_TEST_AGENT_KIND,
  REQUIREMENTS_BRAINSTORM_AGENT_KIND,
  REQUIREMENTS_REVIEW_AGENT_KIND,
  VISUAL_CONFIRM_AGENT_KIND,
} from './ci.logic.js'

// ---------------------------------------------------------------------------
// Which surface OWNS a parked step.
//
// `step.approval` is the engine's generic parking mechanism, and a lot of specialised gates ride
// it: the requirements / clarity reviews, both brainstorms, the human-verdict gates, an interview
// gate, a companion at its rework cap, the follow-up companion with undecided items, and a coder
// waiting on an implementation-fork choice. Each of those is driven by its OWN verbs, and
// answering one with the generic approve/request-changes/reject would advance the run past the
// loop it exists to run.
//
// So "this step has a pending approval" is NOT the same question as "this is an approval gate",
// and every surface that offers a human the generic verbs has to make the distinction. Stating it
// once here is what stops those surfaces disagreeing: `StepDecisionController` turns a non-null
// answer into the `ConflictError` that refuses the generic resolvers, and the public API's
// decision projection turns it into which DECISION KIND the park is reported as. A rule spelled
// out twice would eventually refuse a park on one surface and offer it on the other.
//
// (The SPA's `dedicatedParkView` answers the adjacent question of which OVERLAY a step click
// opens, and still carries its own copy of the shared cases. It cannot import this: the kind
// constants live in this package and the frontend cannot see it. Converging the two means moving
// the built-in gate kinds into `@cat-factory/contracts` first — tracked in
// `docs/initiatives/public-api-additions.md`.)
// ---------------------------------------------------------------------------

/**
 * The dedicated surfaces a parked step can belong to. `companion-cap` is the odd member: unlike
 * the others it is answered by a verb on the APPROVAL surface itself (`resolve-exceeded`) rather
 * than a separate window, so a caller offering the generic verbs must recognise it without
 * routing it elsewhere.
 */
export type DedicatedParkSurface =
  | 'input-gate'
  | 'requirements-review'
  | 'clarity-review'
  | 'brainstorm'
  | 'human-test'
  | 'visual-confirmation'
  | 'interview'
  | 'companion-cap'
  | 'follow-ups'
  | 'fork-decision'

/**
 * The dedicated surface that owns this step's park, or `null` when the park is an ORDINARY
 * approval gate (a pipeline step marked `requiresApproval` holding its proposal up for a person).
 *
 * Callers pass a step they have already established is parked; this answers only WHOSE park it is.
 *
 * The PRE-TOKEN INPUT GATE is checked off the INSTANCE rather than the step, because that is where
 * its verdict lives: the gate guards a step's DISPATCH, so it parks whatever step 0 happens to be
 * and leaves nothing kind-specific behind for a step-only check to recognise. Treating it as an
 * ordinary approval would mark that first step done and advance past the work the run exists to
 * do — the same short-circuit as the fork park, one step earlier.
 */
export function dedicatedParkSurface(
  instance: Pick<ExecutionInstance, 'inputGate'>,
  step: PipelineStep,
  registry: AgentKindRegistry,
): DedicatedParkSurface | null {
  if (instance.inputGate?.status === 'blocked') return 'input-gate'
  if (step.agentKind === REQUIREMENTS_REVIEW_AGENT_KIND) return 'requirements-review'
  if (step.agentKind === CLARITY_REVIEW_AGENT_KIND) return 'clarity-review'
  if (
    step.agentKind === REQUIREMENTS_BRAINSTORM_AGENT_KIND ||
    step.agentKind === ARCHITECTURE_BRAINSTORM_AGENT_KIND
  ) {
    return 'brainstorm'
  }
  if (step.agentKind === HUMAN_TEST_AGENT_KIND) return 'human-test'
  if (step.agentKind === VISUAL_CONFIRM_AGENT_KIND) return 'visual-confirmation'
  if (hasTrait(step.agentKind, INTERVIEW_GATE_TRAIT, registry)) return 'interview'
  if (step.companion?.exceeded) return 'companion-cap'
  if (step.followUps?.enabled && step.followUps.items.some((i) => i.status === 'pending')) {
    return 'follow-ups'
  }
  if (
    step.forkDecision?.status === 'awaiting_choice' ||
    step.forkDecision?.status === 'answering'
  ) {
    return 'fork-decision'
  }
  return null
}
