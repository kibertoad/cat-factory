import type { Clock } from '@cat-factory/kernel'
import type {
  EnvironmentRecord,
  EnvironmentRegistryRepository,
} from '@cat-factory/kernel'
import type { EnvironmentProvider } from '@cat-factory/kernel'
import type { SecretCipher } from '@cat-factory/kernel'
import type { EnvironmentHandle } from '@cat-factory/kernel'
import { assertFound } from '@cat-factory/kernel'
import type { EnvironmentConnectionService } from './EnvironmentConnectionService'
import { recordToHandle } from './environments.logic'

// EnvironmentTeardownService: destroys provisioned environments — on demand and,
// via `sweepExpired`, when their TTL elapses (driven by the cron). Best-effort:
// the local record is always tombstoned so an unreachable provider can't leave
// the registry wedged; the provider call surfaces errors to the caller.

export interface EnvironmentTeardownServiceDependencies {
  connectionService: EnvironmentConnectionService
  environmentProvider: EnvironmentProvider
  environmentRegistryRepository: EnvironmentRegistryRepository
  secretCipher: SecretCipher
  clock: Clock
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
    const connection = await this.deps.connectionService
      .requireConnection(record.workspaceId)
      .catch(() => null)
    // If the provider was unregistered we can't call its API; just tombstone.
    if (connection) {
      const resolveSecret = await this.deps.connectionService.resolveSecrets(record.workspaceId)
      const provisionFields = await this.decryptFields(record.provisionFieldsCipher)
      await this.deps.environmentProvider.teardown({
        manifest: connection.manifest,
        externalId: record.externalId,
        provisionFields,
        resolveSecret,
      })
    }
    await this.deps.environmentRegistryRepository.softDelete(
      record.workspaceId,
      record.id,
      this.deps.clock.now(),
    )
  }

  private async decryptFields(cipher: string | null): Promise<Record<string, string>> {
    if (!cipher) return {}
    const parsed = JSON.parse(await this.deps.secretCipher.decrypt(cipher))
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {}
  }
}
