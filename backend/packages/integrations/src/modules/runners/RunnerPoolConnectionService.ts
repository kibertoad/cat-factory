import type { Clock } from '@cat-factory/kernel'
import type {
  RunnerPoolConnectionRecord,
  RunnerPoolConnectionRepository,
} from '@cat-factory/kernel'
import type { SecretCipher } from '@cat-factory/kernel'
import type { SecretResolver, UrlSafetyPolicy } from '@cat-factory/kernel'
import type {
  ConnectionTestResult,
  ProviderDescriptor,
  RunnerPoolConnection,
  RunnerPoolManifest,
  RunnerPoolProvider,
  TestRunnerPoolConnectionInput,
} from '@cat-factory/kernel'
import { ConflictError, STRICT_URL_SAFETY_POLICY, ValidationError } from '@cat-factory/kernel'
import { requireWorkspace } from '@cat-factory/kernel'
import type { WorkspaceRepository } from '@cat-factory/kernel'
import { assertManifestUrlsSafe, referencedSecretKeys } from './runners.logic.js'

// RunnerPoolConnectionService: owns the binding between a workspace and a
// self-hosted runner pool. Registration stores the validated manifest and an
// *encrypted* bundle of the per-tenant scheduler-API secrets; only safe metadata
// (incl. which secret keys are set) is ever exposed back to clients. Mirrors
// EnvironmentConnectionService.

export interface RunnerPoolConnectionServiceDependencies {
  runnerPoolConnectionRepository: RunnerPoolConnectionRepository
  workspaceRepository: WorkspaceRepository
  secretCipher: SecretCipher
  clock: Clock
  /** URL/host safety policy applied to a registered manifest. Defaults to strict. */
  urlPolicy?: UrlSafetyPolicy
  /** The injected pool provider, so the service can surface describe/test to the UI. */
  runnerPoolProvider?: RunnerPoolProvider
  /** What the injected provider is (see EnvironmentConnectionService). Defaults `manifest`. */
  providerKind?: 'native' | 'manifest'
  providerId?: string
  providerLabel?: string
}

export interface ResolvedRunnerPool {
  manifest: RunnerPoolManifest
  resolveSecret: SecretResolver
}

export class RunnerPoolConnectionService {
  constructor(private readonly deps: RunnerPoolConnectionServiceDependencies) {}

  /** Register (or replace) a workspace's runner pool. */
  async register(
    workspaceId: string,
    input: { manifest: RunnerPoolManifest; secrets: Record<string, string> },
  ): Promise<RunnerPoolConnection> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    const manifest = input.manifest
    assertManifestUrlsSafe(manifest, this.deps.urlPolicy ?? STRICT_URL_SAFETY_POLICY)

    const missing = referencedSecretKeys(manifest).filter((key) => !(key in input.secrets))
    if (missing.length) {
      throw new ValidationError(`Missing secret values for: ${missing.join(', ')}`)
    }

    const existing = await this.deps.runnerPoolConnectionRepository.getByWorkspace(workspaceId)
    const secretsCipher = await this.deps.secretCipher.encrypt(JSON.stringify(input.secrets))
    const record: RunnerPoolConnectionRecord = {
      workspaceId,
      providerId: manifest.providerId,
      label: manifest.label,
      baseUrl: manifest.baseUrl,
      manifestJson: JSON.stringify(manifest),
      secretsCipher,
      createdAt: existing?.createdAt ?? this.deps.clock.now(),
      deletedAt: null,
    }
    await this.deps.runnerPoolConnectionRepository.upsert(record)
    return this.toConnection(record, Object.keys(input.secrets))
  }

  /** Rotate/replace the secret bundle without re-sending the manifest. */
  async updateSecrets(
    workspaceId: string,
    secrets: Record<string, string>,
  ): Promise<RunnerPoolConnection> {
    const { record, manifest } = await this.requireConnection(workspaceId)
    const missing = referencedSecretKeys(manifest).filter((key) => !(key in secrets))
    if (missing.length) {
      throw new ValidationError(`Missing secret values for: ${missing.join(', ')}`)
    }
    const secretsCipher = await this.deps.secretCipher.encrypt(JSON.stringify(secrets))
    const updated: RunnerPoolConnectionRecord = { ...record, secretsCipher }
    await this.deps.runnerPoolConnectionRepository.upsert(updated)
    return this.toConnection(updated, Object.keys(secrets))
  }

  /** Describe the pool provider's config fields + test availability for the UI. */
  async describeProvider(workspaceId: string): Promise<ProviderDescriptor> {
    const provider = this.deps.runnerPoolConnectionRepository
    const record = await provider.getByWorkspace(workspaceId)
    const manifest = record ? (JSON.parse(record.manifestJson) as RunnerPoolManifest) : undefined
    return {
      providerId: this.deps.providerId ?? manifest?.providerId ?? 'http',
      label: this.deps.providerLabel ?? manifest?.label ?? 'Custom HTTP pool',
      kind: this.deps.providerKind ?? 'manifest',
      configFields: this.deps.runnerPoolProvider?.describeConfig?.(manifest) ?? [],
      supportsTest: typeof this.deps.runnerPoolProvider?.testConnection === 'function',
    }
  }

  /** Probe a candidate pool connection before saving (nothing is persisted). */
  async testConnection(
    workspaceId: string,
    input: TestRunnerPoolConnectionInput,
  ): Promise<ConnectionTestResult> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    const provider = this.deps.runnerPoolProvider
    if (!provider?.testConnection) {
      return { ok: true, message: 'This pool provider has no connection test.' }
    }
    if (input.manifest) {
      assertManifestUrlsSafe(input.manifest, this.deps.urlPolicy ?? STRICT_URL_SAFETY_POLICY)
    }
    const secrets = input.secrets ?? {}
    return provider.testConnection({
      manifest: input.manifest,
      config: input.config ?? {},
      resolveSecret: (key) => secrets[key],
    })
  }

  /** The workspace's current connection (safe metadata), or null. */
  async getConnection(workspaceId: string): Promise<RunnerPoolConnection | null> {
    const record = await this.deps.runnerPoolConnectionRepository.getByWorkspace(workspaceId)
    if (!record) return null
    const keys = Object.keys(await this.decryptSecrets(record))
    return this.toConnection(record, keys)
  }

  /** Resolve the live connection + parsed manifest, or throw if not registered. */
  async requireConnection(
    workspaceId: string,
  ): Promise<{ record: RunnerPoolConnectionRecord; manifest: RunnerPoolManifest }> {
    const record = await this.deps.runnerPoolConnectionRepository.getByWorkspace(workspaceId)
    if (!record) {
      throw new ConflictError(`Workspace '${workspaceId}' has no runner pool registered`)
    }
    const manifest = JSON.parse(record.manifestJson) as RunnerPoolManifest
    return { record, manifest }
  }

  /**
   * Resolve the workspace's pool (parsed manifest + a secret resolver over its
   * decrypted bundle), or null when it has no live pool registered. Used by the
   * container executor to pick the self-hosted runner backend per job.
   */
  async resolve(workspaceId: string): Promise<ResolvedRunnerPool | null> {
    const record = await this.deps.runnerPoolConnectionRepository.getByWorkspace(workspaceId)
    if (!record) return null
    const manifest = JSON.parse(record.manifestJson) as RunnerPoolManifest
    const bundle = await this.decryptSecrets(record)
    return { manifest, resolveSecret: (key: string) => bundle[key] }
  }

  /** Unregister the pool (tombstones the binding). */
  async unregister(workspaceId: string): Promise<void> {
    const record = await this.deps.runnerPoolConnectionRepository.getByWorkspace(workspaceId)
    if (!record) return
    await this.deps.runnerPoolConnectionRepository.softDelete(workspaceId, this.deps.clock.now())
  }

  private async decryptSecrets(
    record: RunnerPoolConnectionRecord,
  ): Promise<Record<string, string>> {
    if (!record.secretsCipher) return {}
    const parsed = JSON.parse(await this.deps.secretCipher.decrypt(record.secretsCipher))
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {}
  }

  private toConnection(
    record: RunnerPoolConnectionRecord,
    secretKeys: string[],
  ): RunnerPoolConnection {
    return {
      providerId: record.providerId,
      label: record.label,
      baseUrl: record.baseUrl,
      connectedAt: record.createdAt,
      secretKeys,
    }
  }
}
