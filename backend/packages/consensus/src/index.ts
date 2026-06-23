// @cat-factory/consensus — the optional consensus-orchestration mechanism. A deployment
// mixes it in as a dependency and wires `ConsensusAgentExecutor` (wrapping the standard
// composite) into each runtime facade; without it the product runs exactly as before.

export {
  ConsensusAgentExecutor,
  type ConsensusAgentExecutorDependencies,
} from './ConsensusAgentExecutor.js'
export { decideConsensusMode, type ConsensusMode } from './gating.js'
export {
  SPECIALIST_PANEL_CAPABLE,
  DEBATE_CAPABLE,
  RANKED_VOTING_CAPABLE,
  CONSENSUS_TRAITS,
  STRATEGY_TRAIT,
  DEFAULT_CONSENSUS_ELIGIBLE_KINDS,
  registerConsensusTraits,
  consensusStrategiesFor,
  isConsensusEligible,
} from './traits.js'
export { runSpecialistPanel } from './strategies/specialistPanel.js'
export { runDebate } from './strategies/debate.js'
export { runRankedVoting, parseScoreMap } from './strategies/rankedVoting.js'
export { defaultGenerate } from './strategies/shared.js'
export type {
  ConsensusUsage,
  GenerateArgs,
  GenerateFn,
  GenerateResult,
  ObsTags,
  ResolvedParticipant,
  StrategyInput,
  StrategyResult,
} from './strategies/types.js'
