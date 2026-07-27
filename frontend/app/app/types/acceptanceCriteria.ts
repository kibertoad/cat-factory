// Per-service acceptance-criteria shapes: the durable given/when/outcome statements of
// required behaviour a service accumulates, and the inputs for curating them.
//
// All wire shapes are sourced from @cat-factory/contracts (single source of truth).

export type {
  ServiceAcceptanceCriterion,
  ServiceAcceptanceCriteria,
  AcceptanceCriterionStatus,
  AcceptanceCriterionProvenance,
  CreateAcceptanceCriterionInput,
  UpdateAcceptanceCriterionInput,
} from '@cat-factory/contracts'
export {
  ACCEPTANCE_CRITERIA_MAX_PER_FRAME,
  ACCEPTANCE_CRITERION_MAX_TAGS,
} from '@cat-factory/contracts'
