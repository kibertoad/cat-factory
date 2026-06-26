import type { Clock, IdGenerator } from '@cat-factory/kernel'
import type { EnvironmentRecord, EnvironmentRegistryRepository } from '@cat-factory/kernel'
import type {
  EnvironmentProvider,
  ProvisionContext,
  ProvisionedEnvironment,
  UrlSafetyPolicy,
} from '@cat-factory/kernel'
import type { SecretCipher } from '@cat-factory/kernel'
import type { EnvironmentAccessHandle, EnvironmentHandle } from '@cat-factory/kernel'
import { assertFound, STRICT_URL_SAFETY_POLICY } from '@cat-factory/kernel'
import type { EnvironmentConnectionService } from './EnvironmentConnectionService.js'
import { assertSafeEnvironmentUrl, recordToHandle } from './environments.logic.js'
import type { ProvisioningLogRecorder } from '../provisioning-logs/ProvisioningLogService.js'

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
  /** URL/host safety policy applied to the URL a provider returns. Defaults to strict. */
  urlPolicy?: UrlSafetyPolicy
  /** Best-effort provisioning-event log; absent ⇒ provisioning is unchanged. */
  provisioningLog?: ProvisioningLogRecorder
}

export interface ProvisionArgs {
  workspaceId: string
  blockId?: string | null
  executionId?: string | null
  inputs?: Record<string, string>
  /** Typed git/PR/repo context; passed to the provider and flattened into `inputs`. */
  context?: ProvisionContext
}

/** Flatten a typed provision context into `{{input.*}}` string vars (skips empties). */
function contextInputs(context: ProvisionContext | undefined): Record<string, string> {
  if (!context) return {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(context)) {
    if (value !== undefined && value !== null && value !== '') out[key] = String(value)
  }
  return out
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

  private get urlPolicy(): UrlSafetyPolicy {
    return this.deps.urlPolicy ?? STRICT_URL_SAFETY_POLICY
  }

  /** Provision an environment, persisting an encrypted record keyed by block/run. */
  async provision(args: ProvisionArgs): Promise<EnvironmentHandle> {
    const { workspaceId } = args
    const { manifest } = await this.deps.connectionService.requireConnection(workspaceId)
    const resolveSecret = await this.deps.connectionService.resolveSecrets(workspaceId)

    // Expose the block id as `{{input.blockId}}` even on a manual provision, so a
    // manifest can template against it without the caller having to repeat it. The
    // typed git/PR/repo context is flattened into the same namespace for the manifest
    // path. Explicit inputs win over the derived block id + context.
    const inputs: Record<string, string> = {}
    if (args.blockId) inputs.blockId = args.blockId
    Object.assign(inputs, contextInputs(args.context))
    Object.assign(inputs, args.inputs)
    let provisioned: ProvisionedEnvironment
    try {
      provisioned = await this.deps.environmentProvider.provision({
        manifest,
        inputs,
        ...(args.context ? { provisionContext: args.context } : {}),
        resolveSecret,
      })
    } catch (error) {
      // The provider call threw (network/auth/4xx) — log the verbatim error before
      // it bubbles to the caller, so the attempt shows in the env provider's logs.
      await this.deps.provisioningLog?.record({
        workspaceId,
        subsystem: 'environment',
        operation: 'provision',
        targetId: null,
        providerId: manifest.providerId,
        blockId: args.blockId ?? null,
        executionId: args.executionId ?? null,
        outcome: 'failure',
        error: error instanceof Error ? error.message : String(error),
        detail: null,
      })
      throw error
    }
    if (provisioned.url) {
      assertSafeEnvironmentUrl(provisioned.url, 'environment URL', this.urlPolicy)
    }

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
    // A provider that returns `status:'failed'` (rather than throwing) is still a
    // failed spin-up — log it as such with the captured `lastError`.
    await this.deps.provisioningLog?.record({
      workspaceId,
      subsystem: 'environment',
      operation: 'provision',
      targetId: record.id,
      providerId: manifest.providerId,
      blockId: record.blockId,
      executionId: record.executionId,
      outcome: provisioned.status === 'failed' ? 'failure' : 'success',
      error: record.lastError,
      detail: JSON.stringify({ status: provisioned.status }),
    })
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

    let provisioned: ProvisionedEnvironment
    try {
      provisioned = await this.deps.environmentProvider.status({
        manifest,
        externalId: record.externalId,
        provisionFields,
        resolveSecret,
      })
    } catch (error) {
      await this.deps.provisioningLog?.record({
        workspaceId,
        subsystem: 'environment',
        operation: 'status',
        targetId: record.id,
        providerId: manifest.providerId,
        blockId: record.blockId,
        executionId: record.executionId,
        outcome: 'failure',
        error: error instanceof Error ? error.message : String(error),
        detail: null,
      })
      throw error
    }
    if (provisioned.url) {
      assertSafeEnvironmentUrl(provisioned.url, 'environment URL', this.urlPolicy)
    }

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

  /**
   * The live environment provisioned for a block, as a handle (no creds, but WITH
   * `id` and `lastError`) — the run-details surface uses this to show the env's
   * lifecycle state + the exact error next to a consuming step (tester/coder).
   * Unlike {@link resolveForBlock} (which strips `id`/`lastError` for agent context).
   */
  async getHandleForBlock(workspaceId: string, blockId: string): Promise<EnvironmentHandle | null> {
    const record = await this.deps.environmentRegistryRepository.getByBlock(workspaceId, blockId)
    return record ? recordToHandle(record) : null
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
