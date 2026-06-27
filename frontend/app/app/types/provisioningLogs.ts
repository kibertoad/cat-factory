// Frontend mirror of the unified provisioning event-log wire shapes
// (`@cat-factory/contracts` provisioning-logs.ts). Drives the "View logs" drawers in
// the environment-provider + runner-pool config panels and the run-details env surface.
//
// All wire shapes are sourced from @cat-factory/contracts (single source of truth).

export type {
  ProvisioningSubsystem,
  ProvisioningOperation,
  ProvisioningOutcome,
  ProvisioningLogEntry,
} from '@cat-factory/contracts'
