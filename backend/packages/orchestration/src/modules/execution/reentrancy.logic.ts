import type { AgentKindRegistry } from '@cat-factory/agents'
import { hasTrait, INTERVIEW_GATE_TRAIT } from '@cat-factory/agents'
import type { PipelineStep } from '@cat-factory/kernel'
import {
  ARCHITECTURE_BRAINSTORM_AGENT_KIND,
  CLARITY_REVIEW_AGENT_KIND,
  HUMAN_TEST_AGENT_KIND,
  REQUIREMENTS_BRAINSTORM_AGENT_KIND,
  REQUIREMENTS_REVIEW_AGENT_KIND,
  VISUAL_CONFIRM_AGENT_KIND,
} from './ci.logic.js'
import { FORK_DECISION_PRODUCER_KIND } from './forkDecision.logic.js'

/**
 * Whether a `waiting_decision` step should FALL THROUGH and re-evaluate its gate in the durable
 * driver instead of immediately re-parking on its decision id. Several gates are re-entrant: a
 * human action records a `pending*` marker on the parked step and wakes the driver, and the step
 * handler must run the (slow) resume work — folding/re-reviewing requirements, running the
 * Requirement Writer, dispatching a human-test/visual-confirm helper, running the next interview
 * pass, or computing a grounded fork-chat reply — rather than re-parking on the stale id. Extracted
 * from {@link ExecutionService.stepInstance} to keep its cyclomatic complexity down.
 */
export function isReentrantDecisionResume(
  step: PipelineStep,
  agentKindRegistry: AgentKindRegistry,
): boolean {
  // The requirements gate is re-entrant: when the human answers the findings and asks to
  // incorporate (`pendingIncorporation`), or asks the Requirement Writer to recommend answers
  // (`pendingRecommendation`), a marker is set on the parked step and the run is signalled to
  // wake. Every other parked step (and a requirements gate with nothing pending) re-parks on its
  // durable decision id.
  const reentrantRequirements =
    (step.agentKind === REQUIREMENTS_REVIEW_AGENT_KIND ||
      step.agentKind === CLARITY_REVIEW_AGENT_KIND ||
      step.agentKind === REQUIREMENTS_BRAINSTORM_AGENT_KIND ||
      step.agentKind === ARCHITECTURE_BRAINSTORM_AGENT_KIND) &&
    (!!step.pendingIncorporation || !!step.pendingRecommendation)
  // The human-testing gate is likewise re-entrant: a human action (confirm / request a fix / pull
  // main / recreate) records a `pendingAction` on the parked step and wakes the driver.
  const reentrantHumanTest =
    step.agentKind === HUMAN_TEST_AGENT_KIND && !!step.humanTest?.pendingAction
  // The visual-confirmation gate is likewise re-entrant on a human action.
  const reentrantVisualConfirm =
    step.agentKind === VISUAL_CONFIRM_AGENT_KIND && !!step.visualConfirm?.pendingAction
  // The interactive-interviewer gates (marked with the `interview-gate` trait) ride the shared
  // InterviewGateController spine, which resumes by re-running the (slow) interviewer LLM in the
  // durable driver: `continue`/`proceed` set `pendingInterview` on the parked step and wake the
  // driver. Trait-based (not kind-based) so a new interviewer needs no engine change.
  const reentrantInterview =
    hasTrait(step.agentKind, INTERVIEW_GATE_TRAIT, agentKindRegistry) && !!step.pendingInterview
  // The implementation-fork decision phase is re-entrant on a chat turn: the human sent a grounded
  // question about the surfaced forks, which sets `pendingForkChat` on the parked coder step and
  // wakes the driver.
  const reentrantForkDecision =
    step.agentKind === FORK_DECISION_PRODUCER_KIND && !!step.pendingForkChat
  return (
    reentrantRequirements ||
    reentrantHumanTest ||
    reentrantVisualConfirm ||
    reentrantInterview ||
    reentrantForkDecision
  )
}
