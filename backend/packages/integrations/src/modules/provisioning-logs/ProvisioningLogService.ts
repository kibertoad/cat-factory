import type {
  Clock,
  IdGenerator,
  ProvisioningLogQuery,
  ProvisioningLogRecord,
  ProvisioningLogRepository,
} from '@cat-factory/kernel'

// The provisioning event log has two seams:
//   - ProvisioningLogRecorder (WRITE) — the single, best-effort entry point every
//     emitting site (env provision/teardown, runner dispatch/release, container
//     dispatch/poll-failure) calls. It mints the id/createdAt and appends. The
//     entire body is wrapped so a log failure can NEVER break a provisioning
//     operation — the same posture as `attachStepMetrics` / notification channels.
//   - ProvisioningLogService (READ) — what the controller calls to list rows for
//     the "View logs" drawers and the run-details surface, plus the retention prune.
//
// Both are optional dependencies everywhere (default-off), so an unconfigured
// facade or a test that doesn't wire the separate store is entirely unchanged.

/** The hard maximum a single `list` call returns (the rows are cheap, but bound them). */
export const PROVISIONING_LOG_MAX_LIMIT = 500

/** The event an emitting site hands the recorder (id/createdAt are minted here). */
export type ProvisioningLogEvent = Omit<ProvisioningLogRecord, 'id' | 'createdAt'>

export interface ProvisioningLogRecorderDependencies {
  repository: ProvisioningLogRepository
  idGenerator: IdGenerator
  clock: Clock
  /** Optional observer for a swallowed log-write failure (telemetry / tests). */
  onError?: (error: unknown, event: ProvisioningLogEvent) => void
}

/**
 * Best-effort writer for the provisioning log. `record()` never throws: a failed
 * append (or a clock/id failure) is swallowed so the caller's provisioning path is
 * unaffected. This is the ONLY write seam the emitting services touch.
 */
export class ProvisioningLogRecorder {
  constructor(private readonly deps: ProvisioningLogRecorderDependencies) {}

  async record(event: ProvisioningLogEvent): Promise<void> {
    try {
      await this.deps.repository.append({
        ...event,
        id: this.deps.idGenerator.next('plog'),
        createdAt: this.deps.clock.now(),
      })
    } catch (error) {
      this.deps.onError?.(error, event)
    }
  }
}

export interface ProvisioningLogServiceDependencies {
  repository: ProvisioningLogRepository
}

/** Read side of the provisioning log: the controller's list + the retention prune. */
export class ProvisioningLogService {
  constructor(private readonly deps: ProvisioningLogServiceDependencies) {}

  /** Rows for a workspace matching the query, newest first (limit clamped). */
  async list(workspaceId: string, query: ProvisioningLogQuery = {}): Promise<ProvisioningLogRecord[]> {
    const limit = Math.min(query.limit ?? PROVISIONING_LOG_MAX_LIMIT, PROVISIONING_LOG_MAX_LIMIT)
    return this.deps.repository.list(workspaceId, { ...query, limit })
  }

  /** Retention prune: delete rows older than `epochMs`, returning how many were removed. */
  async deleteOlderThan(epochMs: number): Promise<number> {
    return this.deps.repository.deleteOlderThan(epochMs)
  }
}
