import type {
  ProvisioningOperation,
  ProvisioningOutcome,
  ProvisioningSubsystem,
} from '../domain/types.js'

// Persistence port for the unified provisioning event log. One row is appended
// for every attempt to spin up / tear down throwaway infrastructure — ephemeral
// environments AND the runner-pool / per-run containers — with the verbatim
// provider/runtime error on failure. It backs the "View logs" buttons in the
// provider config panels and the env-lifecycle surface in a run's details.
//
// The table is deliberately kept in a PHYSICALLY SEPARATE store from the main DB
// (its own Postgres schema on Node, its own D1 binding on Cloudflare) because it
// is high-churn. The domain depends only on this interface; each facade
// implements it over its separate store. Writes go through the best-effort
// ProvisioningLogRecorder (integrations) so a log failure never breaks a
// provisioning operation.

/** One appended provisioning attempt. */
export interface ProvisioningLogRecord {
  id: string
  workspaceId: string
  subsystem: ProvisioningSubsystem
  operation: ProvisioningOperation
  /** Environment id / run id / job id the attempt acted on, when known. */
  targetId: string | null
  /** The provider/manifest id (environment + runner-pool), when known. */
  providerId: string | null
  /** The board block this attempt relates to, when known. */
  blockId: string | null
  /** The run this attempt belongs to — the key the run-details surface filters on. */
  executionId: string | null
  outcome: ProvisioningOutcome
  /** The verbatim provider/runtime error message on a failure, else null. */
  error: string | null
  /** Optional structured context, serialized as JSON (dispatch kind, instance type, …). */
  detail: string | null
  /** When the attempt completed (epoch ms). */
  createdAt: number
}

/** Filter for {@link ProvisioningLogRepository.list}. Newest rows are returned first. */
export interface ProvisioningLogQuery {
  subsystem?: ProvisioningSubsystem
  executionId?: string
  targetId?: string
  /** Cap on rows returned (the read service clamps to a hard maximum). */
  limit?: number
  /** Keyset on `createdAt` (exclusive) for paging older rows. */
  before?: number
}

export interface ProvisioningLogRepository {
  /** Append one provisioning attempt. */
  append(record: ProvisioningLogRecord): Promise<void>
  /** Rows for a workspace matching the query, newest first. */
  list(workspaceId: string, query?: ProvisioningLogQuery): Promise<ProvisioningLogRecord[]>
  /**
   * Retention: delete rows older than `epochMs` (exclusive), returning how many
   * were removed. The store is high-churn, so it is pruned to a configured window
   * alongside the other unbounded tables.
   */
  deleteOlderThan(epochMs: number): Promise<number>
}
