import type { AgentKind, ConsensusStrategy } from '@cat-factory/kernel'
import { assignAgentTraits, registerAgentTrait, traitsFor } from '@cat-factory/agents'
import { TASK_ESTIMATOR_AGENT_KIND } from '@cat-factory/agents'

// The group of consensus CAPABILITY traits an agent kind can carry. Each marks the
// kind eligible for one consensus strategy: when a step's kind carries the trait, the
// pipeline builder offers that strategy under "Enable Consensus". They are pure marker
// traits (no prompt guidance — their effect lives in the consensus executor + the
// builder UI), registered alongside the built-in `code-aware` / `spec-aware` traits.

export const SPECIALIST_PANEL_CAPABLE = 'specialist-panel-capable'
export const DEBATE_CAPABLE = 'debate-capable'
export const RANKED_VOTING_CAPABLE = 'ranked-voting-capable'

/** Map a strategy to the trait that gates its eligibility. */
export const STRATEGY_TRAIT: Record<ConsensusStrategy, string> = {
  'specialist-panel': SPECIALIST_PANEL_CAPABLE,
  debate: DEBATE_CAPABLE,
  'ranked-voting': RANKED_VOTING_CAPABLE,
}

/** All consensus capability traits. */
export const CONSENSUS_TRAITS = [
  SPECIALIST_PANEL_CAPABLE,
  DEBATE_CAPABLE,
  RANKED_VOTING_CAPABLE,
] as const

/**
 * The default-eligible kinds, each carrying all three consensus traits. A deployment
 * can extend this with {@link assignAgentTraits}. NOTE: `architect` and `analysis` run
 * in a container against a real checkout in their standard mode; in CONSENSUS mode they
 * reason inline over the provided context (spec + requirements + prior outputs) rather
 * than exploring the checkout — a deliberate trade made worthwhile by the gating, which
 * only triggers consensus for high-complexity/risk/impact tasks.
 *
 *  - architect      → a well-reasoned architecture document
 *  - analysis       → a deep investigation / aggregate of observations
 *  - reviewer       → a rigorous, high-confidence code review (the companion verdict)
 *  - task-estimator → an accurate complexity/risk/impact estimate (ranked-scoring)
 */
export const DEFAULT_CONSENSUS_ELIGIBLE_KINDS: AgentKind[] = [
  'architect',
  'analysis',
  'reviewer',
  TASK_ESTIMATOR_AGENT_KIND,
]

/**
 * Register the consensus capability traits and assign them to the default-eligible
 * kinds. A startup import side-effect each facade calls when consensus is enabled,
 * mirroring the custom-agent / model-provider registry seams. Idempotent.
 *
 * @param kinds override the default-eligible set (e.g. a deployment's own kinds).
 */
export function registerConsensusTraits(
  kinds: AgentKind[] = DEFAULT_CONSENSUS_ELIGIBLE_KINDS,
): void {
  for (const trait of CONSENSUS_TRAITS) registerAgentTrait({ id: trait })
  for (const kind of kinds) assignAgentTraits(kind, CONSENSUS_TRAITS)
}

/** The consensus strategies a kind is eligible for, derived from its traits. */
export function consensusStrategiesFor(kind: AgentKind): ConsensusStrategy[] {
  const traits = traitsFor(kind)
  return (Object.keys(STRATEGY_TRAIT) as ConsensusStrategy[]).filter((s) =>
    traits.has(STRATEGY_TRAIT[s]),
  )
}

/** Whether a kind is eligible for at least one consensus strategy. */
export function isConsensusEligible(kind: AgentKind): boolean {
  return consensusStrategiesFor(kind).length > 0
}
