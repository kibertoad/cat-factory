import type {
  AuditEvent,
  AuditEventPage,
  AuditEventRepository,
  AuditRecorder,
  Clock,
  IdGenerator,
  Logger,
} from '@cat-factory/kernel'
import { noopLogger, runBestEffort } from '@cat-factory/kernel'

// ---------------------------------------------------------------------------
// AuditService: the ONE writer of the account audit log.
//
// It exists as a service rather than services calling the repository directly for three
// reasons, each of which would otherwise be re-decided at every call site: the id and timestamp
// are assigned in one place (so `at` is the commit time by one clock, not whatever each caller
// reached for), the write is best-effort in one place (so no caller has to decide what to do
// when the audit store is down), and `record` is fire-and-forget in one place (so an audited
// mutation is not slowed by, or coupled to, the audit write).
//
// Fire-and-forget is the deliberate shape, and it is what makes `AuditRecorder.record` return
// `void`: an audit row must never be able to fail, delay, or reorder the action it describes.
// The cost is that a caller cannot await the row, which is why nothing in the platform reads an
// event back to decide anything. The log is for humans.
// ---------------------------------------------------------------------------

export interface AuditServiceDependencies {
  auditEventRepository: AuditEventRepository
  idGenerator: IdGenerator
  clock: Clock
  /**
   * Where a failed audit write is reported. Optional so the service is unit-testable
   * standalone, normalised once to `noopLogger`, per the kernel logging convention.
   */
  logger?: Logger
}

export class AuditService implements AuditRecorder {
  private readonly log: Logger

  constructor(private readonly deps: AuditServiceDependencies) {
    this.log = deps.logger ?? noopLogger
  }

  /**
   * Record one audited action.
   *
   * Returns immediately: the append runs behind `runBestEffort`, so a store outage costs the
   * audit row and logs a warning, never the membership change the operator asked for. The
   * `void` on the call is deliberate rather than a floating promise — see the class comment for
   * why nothing awaits this.
   */
  record(event: AuditEvent): void {
    const record = {
      ...event,
      id: this.deps.idGenerator.next('aud'),
      at: this.deps.clock.now(),
    }
    void runBestEffort(
      this.log,
      'audit.append',
      () => this.deps.auditEventRepository.append(record),
      {
        accountId: event.accountId,
        action: event.action,
        actorKind: event.actor.kind,
      },
    )
  }

  /**
   * One page of an account's events, newest first.
   *
   * Unlike {@link record} this is NOT best-effort: a viewer that silently renders an empty page
   * when the store is unreachable tells an admin the opposite of the truth. The read propagates
   * and the caller surfaces the failure.
   */
  listByAccount(
    accountId: string,
    options?: { cursor?: string | null; limit?: number },
  ): Promise<AuditEventPage> {
    return this.deps.auditEventRepository.listByAccount(accountId, options)
  }
}
