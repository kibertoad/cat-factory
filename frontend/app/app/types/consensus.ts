// Frontend mirror of the consensus + task-estimate wire contracts in
// `@cat-factory/contracts` (src/consensus.ts). Hand-synced, like the other type mirrors.
//
// All wire shapes are sourced from @cat-factory/contracts (single source of truth).

export type {
  ConsensusStrategy,
  ConsensusParticipant,
  ConsensusGating,
  StepGating,
  ConsensusStepConfig,
  TaskEstimate,
  ConsensusScore,
  ConsensusContribution,
  ConsensusRound,
  ConsensusSessionStatus,
  ConsensusSession,
} from '@cat-factory/contracts'
