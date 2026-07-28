// Pre-PR validation-check shapes: the per-service-frame commands the executor-harness runs
// against the checkout before opening a PR, and the report it produces.
//
// All wire shapes are sourced from @cat-factory/contracts (single source of truth).

export type {
  ValidationCheck,
  ValidationCheckOutcome,
  ValidationReport,
  ServiceValidationConfig,
  UpsertServiceValidationConfigInput,
  DetectedValidationChecks,
  ValidationDetectionStatus,
  ValidationEcosystem,
} from '@cat-factory/contracts'
export {
  VALIDATION_DEFAULT_MAX_ATTEMPTS,
  VALIDATION_MAX_ATTEMPTS_CEILING,
  VALIDATION_MAX_CHECKS,
} from '@cat-factory/contracts'
