import type { Clock } from '@cat-factory/kernel'
import type {
  EnvironmentConnectionRecord,
  EnvironmentConnectionRepository,
} from '@cat-factory/kernel'
import type { SecretCipher } from '@cat-factory/kernel'
import type { SecretResolver, UrlSafetyPolicy } from '@cat-factory/kernel'
import type {
  ConnectionTestResult,
  EnvironmentConnection,
  EnvironmentManifest,
  EnvironmentProvider,
  ProviderDescriptor,
  TestEnvironmentConnectionInput,
} from '@cat-factory/kernel'
import { ConflictError, STRICT_URL_SAFETY_POLICY, ValidationError } from '@cat-factory/kernel'
import { requireWorkspace } from '@cat-factory/kernel'
import type { WorkspaceRepository } from '@cat-factory/kernel'
import { assertSafeEnvironmentUrl } from './environments.logic.js'

// EnvironmentConnectionService: owns the binding between a workspace and an
// environment provider. Registration stores the validated manifest and an
// *encrypted* bundle of the per-tenant management-API secrets; only safe
// metadata (incl. which secret keys are set) is ever exposed back to clients.

export interface EnvironmentConnectionServiceDependencies {
  environmentConnectionRepository: EnvironmentConnectionRepository
  workspaceRepository: WorkspaceRepository
  secretCipher: SecretCipher
  clock: Clock
  /** URL/host safety policy applied to a registered manifest. Defaults to strict. */
  urlPolicy?: UrlSafetyPolicy
  /**
   * The injected provider, so the service can surface its `describeConfig` /
   * `testConnection` to the UI. Optional — absent ⇒ no descriptor/test (the SPA
   * falls back to the manifest editor with no test button).
   */
  environmentProvider?: EnvironmentProvider
  /**
   * What the injected provider is: a `native` adapter (its own auth, fully
   * described by `describeConfig`) or the generic `manifest` HTTP provider.
   * The facade that wires the provider knows which it injected. Defaults to
   * `manifest`. `providerId`/`providerLabel` override the descriptor identity
   * for a native provider (else the manifest's own values are used).
   */
  providerKind?: 'native' | 'manifest'
  providerId?: string
  providerLabel?: string
}

/** Collect every secret key a manifest's auth scheme references. */
export function referencedSecretKeys(manifest: EnvironmentManifest): string[] {
  const auth = manifest.auth
  switch (auth.type) {
    case 'none':
      return []
    case 'api_key':
    case 'bearer':
      return [auth.secretRef.key]
    case 'basic':
      return [auth.usernameSecretRef.key, auth.passwordSecretRef.key]
    case 'oauth2_client_credentials':
      return [auth.clientIdSecretRef.key, auth.clientSecretSecretRef.key]
    case 'custom_headers':
      return auth.headers.map((h) => h.secretRef.key)
  }
}

/** Validate every URL a manifest will fetch (defence against SSRF). */
function assertManifestUrlsSafe(manifest: EnvironmentManifest, policy: UrlSafetyPolicy): void {
  assertSafeEnvironmentUrl(manifest.baseUrl, 'base URL', policy)
  if (manifest.auth.type === 'oauth2_client_credentials') {
    assertSafeEnvironmentUrl(manifest.auth.tokenUrl, 'OAuth token URL', policy)
  }
}

export interface ResolvedConnection {
  record: EnvironmentConnectionRecord
  manifest: EnvironmentManifest
}

export class EnvironmentConnectionService {
  constructor(private readonly deps: EnvironmentConnectionServiceDependencies) {}

  /** Register (or replace) a workspace's environment provider. */
  async register(
    workspaceId: string,
    input: { manifest: EnvironmentManifest; secrets: Record<string, string> },
  ): Promise<EnvironmentConnection> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    // The manifest is validated against the Valibot schema at the controller
    // (jsonBody); here we enforce the additional SSRF + secret-completeness rules.
    const manifest = input.manifest
    assertManifestUrlsSafe(manifest, this.deps.urlPolicy ?? STRICT_URL_SAFETY_POLICY)

    // Every secret the manifest references must be supplied.
    const missing = referencedSecretKeys(manifest).filter((key) => !(key in input.secrets))
    if (missing.length) {
      throw new ValidationError(`Missing secret values for: ${missing.join(', ')}`)
    }

    const existing = await this.deps.environmentConnectionRepository.getByWorkspace(workspaceId)
    const secretsCipher = await this.deps.secretCipher.encrypt(JSON.stringify(input.secrets))
    const record: EnvironmentConnectionRecord = {
      workspaceId,
      providerId: manifest.providerId,
      label: manifest.label,
      baseUrl: manifest.baseUrl,
      manifestJson: JSON.stringify(manifest),
      secretsCipher,
      createdAt: existing?.createdAt ?? this.deps.clock.now(),
      deletedAt: null,
    }
    await this.deps.environmentConnectionRepository.upsert(record)
    return this.toConnection(record, Object.keys(input.secrets))
  }

  /** Rotate/replace the secret bundle without re-sending the manifest. */
  async updateSecrets(
    workspaceId: string,
    secrets: Record<string, string>,
  ): Promise<EnvironmentConnection> {
    const { record, manifest } = await this.requireConnection(workspaceId)
    const missing = referencedSecretKeys(manifest).filter((key) => !(key in secrets))
    if (missing.length) {
      throw new ValidationError(`Missing secret values for: ${missing.join(', ')}`)
    }
    const secretsCipher = await this.deps.secretCipher.encrypt(JSON.stringify(secrets))
    const updated: EnvironmentConnectionRecord = { ...record, secretsCipher }
    await this.deps.environmentConnectionRepository.upsert(updated)
    return this.toConnection(updated, Object.keys(secrets))
  }

  /**
   * Describe the provider's config fields for the UI (what to render and whether a
   * connection test is available). For a manifest provider the fields reflect the
   * secret keys the current manifest references; for a native provider they come
   * from the provider's own `describeConfig`.
   */
  async describeProvider(workspaceId: string): Promise<ProviderDescriptor> {
    const provider = this.deps.environmentProvider
    const record = await this.deps.environmentConnectionRepository.getByWorkspace(workspaceId)
    const manifest = record ? (JSON.parse(record.manifestJson) as EnvironmentManifest) : undefined
    return {
      providerId: this.deps.providerId ?? manifest?.providerId ?? 'http',
      label: this.deps.providerLabel ?? manifest?.label ?? 'Custom HTTP provider',
      kind: this.deps.providerKind ?? 'manifest',
      configFields: provider?.describeConfig?.(manifest) ?? [],
      supportsTest: typeof provider?.testConnection === 'function',
    }
  }

  /**
   * Probe a candidate connection before saving (nothing is persisted). Builds a
   * secret resolver over the supplied (unsaved) secret values and delegates to the
   * provider's `testConnection`; a provider without one reports "nothing to test".
   */
  async testConnection(
    workspaceId: string,
    input: TestEnvironmentConnectionInput,
  ): Promise<ConnectionTestResult> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    const provider = this.deps.environmentProvider
    if (!provider?.testConnection) {
      return { ok: true, message: 'This provider has no connection test.' }
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
  async getConnection(workspaceId: string): Promise<EnvironmentConnection | null> {
    const record = await this.deps.environmentConnectionRepository.getByWorkspace(workspaceId)
    if (!record) return null
    const keys = Object.keys(await this.decryptSecrets(record))
    return this.toConnection(record, keys)
  }

  /** Resolve the live connection + parsed manifest, or throw if not registered. */
  async requireConnection(workspaceId: string): Promise<ResolvedConnection> {
    const record = await this.deps.environmentConnectionRepository.getByWorkspace(workspaceId)
    if (!record) {
      throw new ConflictError(`Workspace '${workspaceId}' has no environment provider registered`)
    }
    const manifest = JSON.parse(record.manifestJson) as EnvironmentManifest
    return { record, manifest }
  }

  /** Build a secret resolver from the workspace's decrypted secret bundle. */
  async resolveSecrets(workspaceId: string): Promise<SecretResolver> {
    const record = await this.deps.environmentConnectionRepository.getByWorkspace(workspaceId)
    if (!record) return () => undefined
    const bundle = await this.decryptSecrets(record)
    return (key: string) => bundle[key]
  }

  /** Unregister the provider (tombstones the binding). */
  async unregister(workspaceId: string): Promise<void> {
    const record = await this.deps.environmentConnectionRepository.getByWorkspace(workspaceId)
    if (!record) return
    await this.deps.environmentConnectionRepository.softDelete(workspaceId, this.deps.clock.now())
  }

  private async decryptSecrets(
    record: EnvironmentConnectionRecord,
  ): Promise<Record<string, string>> {
    if (!record.secretsCipher) return {}
    const parsed = JSON.parse(await this.deps.secretCipher.decrypt(record.secretsCipher))
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {}
  }

  private toConnection(
    record: EnvironmentConnectionRecord,
    secretKeys: string[],
  ): EnvironmentConnection {
    return {
      providerId: record.providerId,
      label: record.label,
      baseUrl: record.baseUrl,
      connectedAt: record.createdAt,
      secretKeys,
    }
  }
}
