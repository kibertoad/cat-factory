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
// when the audit store is down), and the store is reached through one method (so nothing in the
// platform can rewrite or re-order what was recorded).
//
// The append is AWAITED, and that is the deliberate half of the design people get wrong first.
// Fire-and-forget looks strictly better (`record` returns instantly, the audited mutation is
// never coupled to the log) and is WRONG on the primary runtime: an un-awaited promise on the
// Worker is dropped when the isolate freezes after the response, which is precisely the rule
// `@cat-factory/server`'s `http/waitUntil.ts` exists to state. The audit row would then be
// missing exactly where it matters, in production, while every test driving a fake recorder went
// on passing. So a caller waits for one insert; what it never does is FAIL because of one, which
// is what `runBestEffort` below is for. (The same trade, for the same reason, as the awaited
// context snapshot in `ContainerAgentExecutor.startJob`.)
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
   * Resolves once the row is committed, or once the failure to commit it has been WARNED: a
   * store outage costs the audit row and never the membership change the operator asked for, so
   * this settles rather than rejects. See the class comment for why it is awaited at all.
   */
  async record(event: AuditEvent): Promise<void> {
    const record = {
      ...event,
      id: this.deps.idGenerator.next('aud'),
      at: this.deps.clock.now(),
    }
    await runBestEffort(
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
   * Unlike {@link record} this does NOT swallow: a viewer that silently renders an empty page
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
