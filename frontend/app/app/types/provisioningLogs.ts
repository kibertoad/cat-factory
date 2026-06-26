// Frontend mirror of the unified provisioning event-log wire shapes
// (`@cat-factory/contracts` provisioning-logs.ts). Drives the "View logs" drawers in
// the environment-provider + runner-pool config panels and the run-details env surface.

export type ProvisioningSubsystem = 'environment' | 'runner-pool' | 'container'

export type ProvisioningOperation =
  | 'provision'
  | 'teardown'
  | 'status'
  | 'dispatch'
  | 'release'
  | 'poll-failure'

export type ProvisioningOutcome = 'success' | 'failure'

/** One provisioning attempt (spin-up / tear-down), as returned by the logs endpoint. */
export interface ProvisioningLogEntry {
  id: string
  workspaceId: string
  subsystem: ProvisioningSubsystem
  operation: ProvisioningOperation
  targetId: string | null
  providerId: string | null
  blockId: string | null
  executionId: string | null
  outcome: ProvisioningOutcome
  /** The verbatim provider/runtime error on a failure, else null. */
  error: string | null
  detail: string | null
  createdAt: number
}
