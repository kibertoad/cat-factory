import type { Clock } from '@cat-factory/kernel'
import type {
  EnvironmentConnectionRecord,
  EnvironmentUserHandlerRecord,
  EnvironmentUserHandlerRepository,
  InfraEngine,
  InfraHandlerConfig,
  ProvisionType,
  SecretCipher,
  UrlSafetyPolicy,
} from '@cat-factory/kernel'
import type { EnvironmentBackendRegistry } from './environment-backends.js'
import type {
  EnvironmentHandlerView,
  RegisterHandlerInput,
} from './EnvironmentConnectionService.js'
import {
  buildInfraHandlerFields,
  handlerConfigToBackendConfig,
  resolveHandlerBackend,
} from './infra-handler-build.js'

// ---------------------------------------------------------------------------
// Per-USER infra handler overrides (local mode): the per-user layer over a workspace's
// per-type handlers. A developer points a provision type at their OWN engine (a personal
// Docker / k3s), and that override wins for the runs they initiate. Mirrors
// `LocalModelEndpointService` (a per-user store, validated the same way the workspace
// handler is). The local-only behaviour is enforced by the controller mount + the fact that
// ONLY the local facade wires this service — not a runtime branch in shared code. See
// docs/initiatives/per-service-provision-types.md.
// ---------------------------------------------------------------------------

export interface EnvironmentUserHandlerServiceDependencies {
  userHandlerRepository: EnvironmentUserHandlerRepository
  /** Resolves a stored backend `kind` / engine to the provider that validates + builds it. */
  environmentBackendRegistry: EnvironmentBackendRegistry
  secretCipher: SecretCipher
  clock: Clock
  /** URL/host safety policy applied to a registered handler. Defaults to strict. */
  urlPolicy?: UrlSafetyPolicy
  /** Whether this runtime can honor custom TLS material (a private CA / insecure-skip). */
  customTlsSupported?: boolean
  /** Optional structural logger for best-effort diagnostics (e.g. a dropped override). */
  logger?: { info(obj: Record<string, unknown>, msg?: string): void }
}

export class EnvironmentUserHandlerService {
  constructor(private readonly deps: EnvironmentUserHandlerServiceDependencies) {}

  /** Every override the user has set for a workspace, sans secret values (batched). */
  async list(userId: string, workspaceId: string): Promise<EnvironmentHandlerView[]> {
    const records = await this.deps.userHandlerRepository.listByUserWorkspace(userId, workspaceId)
    // Secret-key NAMES are derived from the (non-secret) config — upsert guarantees every
    // referenced key is present — so listing needs no per-record decrypt.
    return records.map((record) => this.toView(record, this.referencedSecretKeyNames(record)))
  }

  /** Register (or replace) the user's override for one provision type (+ optional custom id). */
  async upsert(
    userId: string,
    workspaceId: string,
    input: RegisterHandlerInput,
  ): Promise<EnvironmentHandlerView> {
    const fields = buildInfraHandlerFields(this.deps.environmentBackendRegistry, input, {
      ...(this.deps.urlPolicy ? { urlPolicy: this.deps.urlPolicy } : {}),
      ...(this.deps.customTlsSupported !== undefined
        ? { customTlsSupported: this.deps.customTlsSupported }
        : {}),
    })
    const existing = (
      await this.deps.userHandlerRepository.listByUserWorkspace(userId, workspaceId)
    ).find((h) => h.provisionType === fields.provisionType && h.manifestId === fields.manifestId)
    const secretsCipher = await this.deps.secretCipher.encrypt(JSON.stringify(input.secrets))
    const now = this.deps.clock.now()
    const record: EnvironmentUserHandlerRecord = {
      userId,
      workspaceId,
      provisionType: fields.provisionType,
      manifestId: fields.manifestId,
      engine: fields.engine,
      providerId: fields.providerId,
      label: fields.label,
      baseUrl: fields.baseUrl,
      handlerJson: fields.handlerJson,
      acceptsManifestId: fields.acceptsManifestId,
      secretsCipher,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    await this.deps.userHandlerRepository.upsert(record)
    return this.toView(record, Object.keys(input.secrets))
  }

  /** Remove one override. */
  async remove(
    userId: string,
    workspaceId: string,
    provisionType: ProvisionType,
    manifestId: string | null,
  ): Promise<void> {
    await this.deps.userHandlerRepository.remove(userId, workspaceId, provisionType, manifestId)
  }

  /**
   * The user's overrides as connection records the resolver layers over the workspace
   * handlers (the `resolveUserHandlerOverrides` seam the provisioning service consumes). The
   * per-user table carries no `backendKind` column (it's local-only, where each engine maps
   * 1:1 to a backend), so it's re-derived from the engine here. `upsert` already rejects an
   * override whose engine has no registered backend, so the drop below only fires if the
   * backend registry changed shape after the override was stored; it's logged (not silent) so
   * a fallen-back-to-workspace-handler override is observable rather than a mystery.
   */
  async resolveOverrides(
    userId: string,
    workspaceId: string,
  ): Promise<EnvironmentConnectionRecord[]> {
    const records = await this.deps.userHandlerRepository.listByUserWorkspace(userId, workspaceId)
    const out: EnvironmentConnectionRecord[] = []
    for (const record of records) {
      const backendKind = this.backendKindFor(record.engine as InfraEngine)
      if (!backendKind) {
        this.deps.logger?.info(
          { userId, workspaceId, provisionType: record.provisionType, engine: record.engine },
          'Dropping per-user environment handler override: no backend registered for its engine',
        )
        continue
      }
      out.push({
        workspaceId,
        provisionType: record.provisionType,
        manifestId: record.manifestId,
        engine: record.engine,
        backendKind,
        providerId: record.providerId,
        label: record.label,
        baseUrl: record.baseUrl,
        handlerJson: record.handlerJson,
        acceptsManifestId: record.acceptsManifestId,
        secretsCipher: record.secretsCipher,
        createdAt: record.createdAt,
        deletedAt: null,
      })
    }
    return out
  }

  /** The registered backend kind for an engine, or null when none is registered. */
  private backendKindFor(engine: InfraEngine): string | null {
    try {
      return resolveHandlerBackend(this.deps.environmentBackendRegistry, engine, undefined).kind
    } catch {
      return null
    }
  }

  /** Secret key NAMES an override requires, derived from its non-secret config (no decrypt). */
  private referencedSecretKeyNames(record: EnvironmentUserHandlerRecord): string[] {
    try {
      const config = JSON.parse(record.handlerJson) as InfraHandlerConfig
      const backend = resolveHandlerBackend(
        this.deps.environmentBackendRegistry,
        record.engine as InfraEngine,
        undefined,
      )
      return backend.referencedSecretKeys(handlerConfigToBackendConfig(config, backend.kind))
    } catch {
      return []
    }
  }

  private toView(
    record: EnvironmentUserHandlerRecord,
    secretKeys: string[],
  ): EnvironmentHandlerView {
    let config: InfraHandlerConfig | undefined
    try {
      config = JSON.parse(record.handlerJson) as InfraHandlerConfig
    } catch {
      config = undefined
    }
    return {
      provisionType: record.provisionType as ProvisionType,
      manifestId: record.manifestId,
      engine: record.engine as InfraEngine,
      providerId: record.providerId,
      label: record.label,
      baseUrl: record.baseUrl,
      connectedAt: record.createdAt,
      secretKeys,
      acceptsManifestId: record.acceptsManifestId,
      ...(config ? { config } : {}),
    }
  }
}
