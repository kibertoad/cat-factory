import type { Clock, Logger, ProvisioningOutcome } from '@cat-factory/kernel'
import type { EnvironmentRecord, EnvironmentRegistryRepository } from '@cat-factory/kernel'
import type { SecretCipher } from '@cat-factory/kernel'
import type { EnvironmentHandle } from '@cat-factory/kernel'
import { assertFound, noopLogger, runBestEffort } from '@cat-factory/kernel'
import type { EnvironmentConnectionService } from './EnvironmentConnectionService.js'
import { recordToHandle } from './environments.logic.js'
import type { ProvisioningLogRecorder } from '../provisioning-logs/ProvisioningLogService.js'

// EnvironmentTeardownService: destroys provisioned environments — on demand and,
// via `sweepExpired`, when their TTL elapses (driven by the cron). Best-effort:
// the local record is always tombstoned so an unreachable provider can't leave
// the registry wedged; the provider call surfaces errors to the caller.

/**
 * Notified after a teardown ATTEMPT has been recorded in the provisioning log, whether it
 * succeeded or failed. Its one consumer today is the run's PR verification report, whose
 * environment-lifecycle proof cannot be closed by the run itself: the TTL sweep that reclaims the
 * environment fires long after the last step settled, so without this edge the PR says "still
 * live" about an environment the platform destroyed on schedule.
 *
 * The FAILURE edge matters as much as the success one, and for the same reason. A run that has
 * settled has no step hook left to fire, so an environment the provider refuses to reclaim would
 * otherwise sit on the PR as "nobody has torn this down yet" rather than as the thing an operator
 * has to go and do: the same unreachable-leg hole one state over. The hook is therefore fired
 * from the ONE place that records the attempt, so a future third teardown path cannot forget it.
 *
 * Strictly best-effort and swallowed by the service: reclaiming infrastructure must never
 * depend on a downstream bookkeeping write.
 */
export type EnvironmentTeardownRecordedHook = (
  record: EnvironmentRecord,
  outcome: ProvisioningOutcome,
) => Promise<void>

export interface EnvironmentTeardownServiceDependencies {
  connectionService: EnvironmentConnectionService
  environmentRegistryRepository: EnvironmentRegistryRepository
  secretCipher: SecretCipher
  clock: Clock
  /** Best-effort provisioning-event log; absent ⇒ teardown is unchanged. */
  provisioningLog?: ProvisioningLogRecorder
  /** Structured logger for the best-effort hook below; absent ⇒ its failures are unreported. */
  logger?: Logger
}

export class EnvironmentTeardownService {
  private readonly log: Logger
  /**
   * Late-bound because the engine that consumes it is constructed AFTER this service (it is
   * injected into the provisioning service, which the engine takes). Same shape as
   * `setInitiativeLoop` in the composition root, and for the same reason.
   */
  private teardownRecordedHook: EnvironmentTeardownRecordedHook | undefined

  constructor(private readonly deps: EnvironmentTeardownServiceDependencies) {
    this.log = deps.logger ?? noopLogger
  }

  /** Late-bind the teardown-recorded notification. Unset ⇒ nothing is notified. */
  setTeardownRecordedHook(hook: EnvironmentTeardownRecordedHook | undefined): void {
    this.teardownRecordedHook = hook
  }

  /** Tear down a single environment and tombstone its record. */
  async teardown(workspaceId: string, id: string): Promise<EnvironmentHandle> {
    const record = assertFound(
      await this.deps.environmentRegistryRepository.get(workspaceId, id),
      'Environment',
      id,
    )
    await this.teardownRecord(record)
    return recordToHandle({ ...record, status: 'torn_down' })
  }

  /** Tear down every environment whose TTL has elapsed. Returns the count swept. */
  async sweepExpired(now: number): Promise<number> {
    const expired = await this.deps.environmentRegistryRepository.listExpired(now)
    let swept = 0
    for (const record of expired) {
      try {
        await this.teardownRecord(record)
        swept++
      } catch {
        // Best-effort: a failing provider must not block the rest of the sweep.
        // The record stays live and is retried on the next pass.
      }
    }
    return swept
  }

  private async teardownRecord(record: EnvironmentRecord): Promise<void> {
    // Resolve the provider from the RECORD's stored provision type/engine (the handler that stood
    // it up), not the workspace-primary — so a workspace with several per-type handlers tears each
    // env down through the right one.
    const resolved = await this.deps.connectionService
      .resolveProviderForRecord(record)
      .catch(() => null)
    // If the provider was unregistered we can't call its API; just tombstone.
    if (resolved) {
      const provisionFields = await this.decryptFields(record.provisionFieldsCipher)
      try {
        await resolved.provider.teardown({
          manifest: resolved.manifest,
          externalId: record.externalId,
          provisionFields,
          resolveSecret: resolved.resolveSecret,
        })
      } catch (error) {
        // Log the verbatim provider error before it propagates (the sweep swallows
        // it; an on-demand teardown surfaces it). The local record is NOT tombstoned
        // on a provider failure, matching the existing retry-next-pass behaviour.
        await this.recordTeardownAttempt(
          record,
          'failure',
          error instanceof Error ? error.message : String(error),
        )
        throw error
      }
    }
    await this.deps.environmentRegistryRepository.softDelete(
      record.workspaceId,
      record.id,
      this.deps.clock.now(),
    )
    await this.recordTeardownAttempt(record, 'success', null)
  }

  /**
   * Append the attempt to the provisioning log and then notify, in that order and in ONE place.
   * The ordering is what makes the notification usable: its consumer reads the log back, so a
   * hook fired before the row landed would report the state the edge exists to correct. Keeping
   * both here is what makes the FAILURE edge structural rather than a line someone remembered to
   * add beside the success one.
   */
  private async recordTeardownAttempt(
    record: EnvironmentRecord,
    outcome: ProvisioningOutcome,
    error: string | null,
  ): Promise<void> {
    await this.deps.provisioningLog?.record({
      workspaceId: record.workspaceId,
      subsystem: 'environment',
      operation: 'teardown',
      targetId: record.id,
      providerId: record.providerId,
      blockId: record.blockId,
      executionId: record.executionId,
      outcome,
      error,
      detail: null,
    })
    const hook = this.teardownRecordedHook
    if (!hook) return
    await runBestEffort(this.log, 'environment.teardownRecordedHook', () => hook(record, outcome), {
      workspaceId: record.workspaceId,
      environmentId: record.id,
      executionId: record.executionId,
      outcome,
    })
  }

  private async decryptFields(cipher: string | null): Promise<Record<string, string>> {
    if (!cipher) return {}
    const parsed = JSON.parse(await this.deps.secretCipher.decrypt(cipher))
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {}
  }
}
