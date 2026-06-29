import type { Clock } from '@cat-factory/kernel'
import type { EnvironmentRecord, EnvironmentRegistryRepository } from '@cat-factory/kernel'
import type { SecretCipher } from '@cat-factory/kernel'
import type { EnvironmentHandle } from '@cat-factory/kernel'
import { assertFound } from '@cat-factory/kernel'
import type { EnvironmentConnectionService } from './EnvironmentConnectionService.js'
import { recordToHandle } from './environments.logic.js'
import type { ProvisioningLogRecorder } from '../provisioning-logs/ProvisioningLogService.js'

// EnvironmentTeardownService: destroys provisioned environments — on demand and,
// via `sweepExpired`, when their TTL elapses (driven by the cron). Best-effort:
// the local record is always tombstoned so an unreachable provider can't leave
// the registry wedged; the provider call surfaces errors to the caller.

export interface EnvironmentTeardownServiceDependencies {
  connectionService: EnvironmentConnectionService
  environmentRegistryRepository: EnvironmentRegistryRepository
  secretCipher: SecretCipher
  clock: Clock
  /** Best-effort provisioning-event log; absent ⇒ teardown is unchanged. */
  provisioningLog?: ProvisioningLogRecorder
}

export class EnvironmentTeardownService {
  constructor(private readonly deps: EnvironmentTeardownServiceDependencies) {}

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
    const resolved = await this.deps.connectionService
      .resolveProvider(record.workspaceId)
      .catch(() => null)
    // If the provider was unregistered we can't call its API; just tombstone.
    if (resolved) {
      const resolveSecret = await this.deps.connectionService.resolveSecrets(record.workspaceId)
      const provisionFields = await this.decryptFields(record.provisionFieldsCipher)
      try {
        await resolved.provider.teardown({
          manifest: resolved.manifest,
          externalId: record.externalId,
          provisionFields,
          resolveSecret,
        })
      } catch (error) {
        // Log the verbatim provider error before it propagates (the sweep swallows
        // it; an on-demand teardown surfaces it). The local record is NOT tombstoned
        // on a provider failure, matching the existing retry-next-pass behaviour.
        await this.logTeardown(
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
    await this.logTeardown(record, 'success', null)
  }

  private async logTeardown(
    record: EnvironmentRecord,
    outcome: 'success' | 'failure',
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
  }

  private async decryptFields(cipher: string | null): Promise<Record<string, string>> {
    if (!cipher) return {}
    const parsed = JSON.parse(await this.deps.secretCipher.decrypt(cipher))
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {}
  }
}
