import type { Clock, IdGenerator } from '@cat-factory/kernel'
import type { EnvironmentRecord, EnvironmentRegistryRepository } from '@cat-factory/kernel'
import type { EnvironmentProvider, ProvisionedEnvironment } from '@cat-factory/kernel'
import type { SecretCipher } from '@cat-factory/kernel'
import type { EnvironmentAccessHandle, EnvironmentHandle } from '@cat-factory/kernel'
import { assertFound } from '@cat-factory/kernel'
import type { EnvironmentConnectionService } from './EnvironmentConnectionService'
import { assertSafeEnvironmentUrl, recordToHandle } from './environments.logic'

// EnvironmentProvisioningService: orchestrates provisioning an environment from a
// workspace's registered provider. Deterministic and side-effecting via the
// EnvironmentProvider port — never an LLM. The provisioned env's access creds and
// the fields needed for later status/teardown are encrypted before they touch D1.

export interface EnvironmentProvisioningServiceDependencies {
  connectionService: EnvironmentConnectionService
  environmentProvider: EnvironmentProvider
  environmentRegistryRepository: EnvironmentRegistryRepository
  secretCipher: SecretCipher
  idGenerator: IdGenerator
  clock: Clock
}

export interface ProvisionArgs {
  workspaceId: string
  blockId?: string | null
  executionId?: string | null
  inputs?: Record<string, string>
}

/** The compact env view injected into a downstream agent's run context. */
export interface ResolvedEnvironment {
  url: string | null
  status: EnvironmentHandle['status']
  access: EnvironmentAccessHandle | null
  expiresAt: number | null
}

export class EnvironmentProvisioningService {
  constructor(private readonly deps: EnvironmentProvisioningServiceDependencies) {}

  /** Provision an environment, persisting an encrypted record keyed by block/run. */
  async provision(args: ProvisionArgs): Promise<EnvironmentHandle> {
    const { workspaceId } = args
    const { manifest } = await this.deps.connectionService.requireConnection(workspaceId)
    const resolveSecret = await this.deps.connectionService.resolveSecrets(workspaceId)

    // Expose the block id as `{{input.blockId}}` even on a manual provision, so a
    // manifest can template against it without the caller having to repeat it.
    // Explicit inputs win over the derived block id.
    const inputs: Record<string, string> = {}
    if (args.blockId) inputs.blockId = args.blockId
    Object.assign(inputs, args.inputs)
    const provisioned = await this.deps.environmentProvider.provision({
      manifest,
      inputs,
      resolveSecret,
    })
    if (provisioned.url) assertSafeEnvironmentUrl(provisioned.url, 'environment URL')

    // A block holds at most one live environment: supersede any prior one.
    if (args.blockId) {
      const prior = await this.deps.environmentRegistryRepository.getByBlock(
        workspaceId,
        args.blockId,
      )
      if (prior) {
        await this.deps.environmentRegistryRepository.softDelete(
          workspaceId,
          prior.id,
          this.deps.clock.now(),
        )
      }
    }

    const now = this.deps.clock.now()
    const record: EnvironmentRecord = {
      id: this.deps.idGenerator.next('env'),
      workspaceId,
      blockId: args.blockId ?? null,
      executionId: args.executionId ?? null,
      providerId: manifest.providerId,
      externalId: provisioned.externalId,
      url: provisioned.url,
      status: provisioned.status,
      accessCipher: await this.encryptAccess(provisioned.access),
      provisionFieldsCipher: await this.deps.secretCipher.encrypt(
        JSON.stringify(provisioned.fields),
      ),
      createdAt: now,
      expiresAt: this.resolveExpiry(provisioned, manifest.defaultTtlMs, now),
      lastError: provisioned.status === 'failed' ? 'Provisioning failed' : null,
      deletedAt: null,
    }
    await this.deps.environmentRegistryRepository.insert(record)
    return recordToHandle(record)
  }

  /** Re-poll the provider for an environment's status and persist any change. */
  async refreshStatus(workspaceId: string, id: string): Promise<EnvironmentHandle> {
    const record = assertFound(
      await this.deps.environmentRegistryRepository.get(workspaceId, id),
      'Environment',
      id,
    )
    const { manifest } = await this.deps.connectionService.requireConnection(workspaceId)
    const resolveSecret = await this.deps.connectionService.resolveSecrets(workspaceId)
    const provisionFields = await this.decryptFields(record.provisionFieldsCipher)

    const provisioned = await this.deps.environmentProvider.status({
      manifest,
      externalId: record.externalId,
      provisionFields,
      resolveSecret,
    })
    if (provisioned.url) assertSafeEnvironmentUrl(provisioned.url, 'environment URL')

    const patch = {
      status: provisioned.status,
      url: provisioned.url,
      externalId: provisioned.externalId ?? record.externalId,
      expiresAt: this.resolveExpiry(provisioned, manifest.defaultTtlMs, record.createdAt),
      accessCipher: await this.encryptAccess(provisioned.access),
    }
    await this.deps.environmentRegistryRepository.update(workspaceId, id, patch)
    return recordToHandle({ ...record, ...patch })
  }

  /** List a workspace's environments (no creds). */
  async listHandles(workspaceId: string): Promise<EnvironmentHandle[]> {
    const records = await this.deps.environmentRegistryRepository.listByWorkspace(workspaceId)
    return records.map((r) => recordToHandle(r))
  }

  /** A single environment handle (no creds), or null. */
  async getHandle(workspaceId: string, id: string): Promise<EnvironmentHandle | null> {
    const record = await this.deps.environmentRegistryRepository.get(workspaceId, id)
    return record ? recordToHandle(record) : null
  }

  /** A single environment handle WITH decrypted access creds, or null. */
  async getHandleWithAccess(workspaceId: string, id: string): Promise<EnvironmentHandle | null> {
    const record = await this.deps.environmentRegistryRepository.get(workspaceId, id)
    if (!record) return null
    return recordToHandle(record, await this.decryptAccess(record.accessCipher))
  }

  /**
   * The live environment provisioned for a block, with decrypted access — the
   * discovery entry point the execution engine calls to enrich tester context.
   */
  async resolveForBlock(workspaceId: string, blockId: string): Promise<ResolvedEnvironment | null> {
    const record = await this.deps.environmentRegistryRepository.getByBlock(workspaceId, blockId)
    if (!record) return null
    return {
      url: record.url,
      status: record.status,
      access: await this.decryptAccess(record.accessCipher),
      expiresAt: record.expiresAt,
    }
  }

  private resolveExpiry(
    provisioned: ProvisionedEnvironment,
    defaultTtlMs: number | undefined,
    base: number,
  ): number | null {
    if (provisioned.expiresAt !== null) return provisioned.expiresAt
    if (defaultTtlMs) return base + defaultTtlMs
    return null
  }

  private async encryptAccess(access: EnvironmentAccessHandle | null): Promise<string | null> {
    if (!access) return null
    return this.deps.secretCipher.encrypt(JSON.stringify(access))
  }

  private async decryptAccess(cipher: string | null): Promise<EnvironmentAccessHandle | null> {
    if (!cipher) return null
    return JSON.parse(await this.deps.secretCipher.decrypt(cipher)) as EnvironmentAccessHandle
  }

  private async decryptFields(cipher: string | null): Promise<Record<string, string>> {
    if (!cipher) return {}
    const parsed = JSON.parse(await this.deps.secretCipher.decrypt(cipher))
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {}
  }
}
