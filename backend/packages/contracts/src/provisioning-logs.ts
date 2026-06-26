import * as v from 'valibot'

// ---------------------------------------------------------------------------
// Wire contracts for the unified provisioning event log — the append-only
// history behind the "View logs" buttons in the ephemeral-environment provider
// and self-hosted runner-pool config panels, and the env-lifecycle surface in a
// run's details.
//
// One row is appended for every attempt to spin up / tear down throwaway
// infrastructure across two subsystems: ephemeral environments (the `deployer`
// step + EnvironmentProvisioningService/TeardownService) and the runner-pool /
// per-run containers (the RunnerTransport implementations). Each row records the
// operation, whether it succeeded, and — crucially — the EXACT provider/runtime
// error when it didn't.
//
// The store is deliberately physically separate from the main DB (its own
// Postgres schema on Node, its own D1 binding on Cloudflare) because it is
// high-churn; it is pruned to a retention window like the other unbounded tables.
// ---------------------------------------------------------------------------

/** Which throwaway-infrastructure subsystem an event belongs to. */
export const provisioningSubsystemSchema = v.picklist(['environment', 'runner-pool', 'container'])
export type ProvisioningSubsystem = v.InferOutput<typeof provisioningSubsystemSchema>

/**
 * The lifecycle operation an event records. `provision`/`teardown`/`status` are
 * the ephemeral-environment verbs; `dispatch`/`release` are the runner-pool /
 * container spin-up / spin-down verbs; `poll-failure` captures a failure (an
 * eviction / crash) detected while polling a running job — routine successful
 * polls are deliberately NOT logged (they would swamp the store).
 */
export const provisioningOperationSchema = v.picklist([
  'provision',
  'teardown',
  'status',
  'dispatch',
  'release',
  'poll-failure',
])
export type ProvisioningOperation = v.InferOutput<typeof provisioningOperationSchema>

/** Whether the recorded attempt succeeded. */
export const provisioningOutcomeSchema = v.picklist(['success', 'failure'])
export type ProvisioningOutcome = v.InferOutput<typeof provisioningOutcomeSchema>

/** One provisioning attempt, as exposed to clients (the logs drawer + run details). */
export const provisioningLogEntrySchema = v.object({
  id: v.string(),
  workspaceId: v.string(),
  subsystem: provisioningSubsystemSchema,
  operation: provisioningOperationSchema,
  /** Environment id / run id / job id the attempt acted on, when known. */
  targetId: v.nullable(v.string()),
  /** The provider/manifest id (environment + runner-pool), when known. */
  providerId: v.nullable(v.string()),
  /** The board block this attempt relates to, when known. */
  blockId: v.nullable(v.string()),
  /** The run this attempt belongs to — the key the run-details surface filters on. */
  executionId: v.nullable(v.string()),
  outcome: provisioningOutcomeSchema,
  /** The verbatim provider/runtime error message on a failure, else null. */
  error: v.nullable(v.string()),
  /** Optional structured context (JSON text): dispatch kind, instance type, etc. */
  detail: v.nullable(v.string()),
  /** When the attempt completed (epoch ms). */
  createdAt: v.number(),
})
export type ProvisioningLogEntry = v.InferOutput<typeof provisioningLogEntrySchema>

const positiveInt = v.pipe(v.string(), v.transform(Number), v.number(), v.integer(), v.minValue(1))

/** Query params for `GET /workspaces/:ws/provisioning-logs`. */
export const provisioningLogQuerySchema = v.object({
  /** Filter to one subsystem (the logs drawer passes the panel's subsystem). */
  subsystem: v.optional(provisioningSubsystemSchema),
  /** Filter to one run (the run-details surface). */
  executionId: v.optional(v.pipe(v.string(), v.minLength(1))),
  /** Filter to one target (environment / run / job id). */
  targetId: v.optional(v.pipe(v.string(), v.minLength(1))),
  /** Cap the rows returned; the service clamps to a hard maximum. */
  limit: v.optional(positiveInt),
  /** Keyset on `createdAt` (exclusive) for paging older rows. */
  before: v.optional(positiveInt),
})
export type ProvisioningLogQueryInput = v.InferOutput<typeof provisioningLogQuerySchema>

/** Response of `GET /workspaces/:ws/provisioning-logs`. */
export const provisioningLogsResponseSchema = v.object({
  entries: v.array(provisioningLogEntrySchema),
})
export type ProvisioningLogsResponse = v.InferOutput<typeof provisioningLogsResponseSchema>
