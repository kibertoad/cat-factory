// Frontend mirror of the consensus + task-estimate wire contracts in
// `@cat-factory/contracts` (src/consensus.ts). Hand-synced, like the other type mirrors.

export type ConsensusStrategy = 'specialist-panel' | 'debate' | 'ranked-voting'

export interface ConsensusParticipant {
  id: string
  role: string
  systemFraming?: string
  modelId?: string
}

export interface ConsensusGating {
  enabled: boolean
  minComplexity?: number
  minRisk?: number
  minImpact?: number
  onMissingEstimate?: 'consensus' | 'standard'
}

export interface ConsensusStepConfig {
  enabled: boolean
  strategy: ConsensusStrategy
  participants: ConsensusParticipant[]
  synthesizerModelId?: string
  rounds?: number
  ratify?: boolean
  gating?: ConsensusGating
}

/** The task-estimator's triage of a task (each axis 0..1). */
export interface TaskEstimate {
  complexity: number
  risk: number
  impact: number
  rationale: string
  model?: string | null
  createdAt: number
}

export interface ConsensusScore {
  dimension: string
  value: number
  rationale?: string
}

export interface ConsensusContribution {
  participantId: string
  text: string
  scores?: ConsensusScore[]
}

export interface ConsensusRound {
  index: number
  kind?: 'draft' | 'critique' | 'score'
  contributions: ConsensusContribution[]
}

export type ConsensusSessionStatus = 'running' | 'synthesizing' | 'done' | 'failed'

export interface ConsensusSession {
  id: string
  blockId: string
  executionId: string | null
  stepIndex: number
  agentKind: string
  strategy: ConsensusStrategy
  status: ConsensusSessionStatus
  participants: ConsensusParticipant[]
  rounds: ConsensusRound[]
  synthesis: string | null
  confidence?: number | null
  dissent?: string[]
  error?: string | null
  createdAt: number
  updatedAt: number
}
