// Initiative wire shapes, re-exported from the shared contracts package (the single
// source of truth across the wire boundary). The SPA imports these through
// `~/types/domain` like every other domain type.
export type {
  CreateInitiativeInput,
  Initiative,
  InitiativeDecision,
  InitiativeDeviation,
  InitiativeEstimate,
  InitiativeExecutionPolicy,
  InitiativeFollowUp,
  InitiativeItem,
  InitiativeItemStatus,
  InitiativePhase,
  InitiativePipelineRule,
  InitiativeQa,
  InitiativeStatus,
} from '@cat-factory/contracts'
