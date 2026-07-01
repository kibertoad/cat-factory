import type { Clock } from '@cat-factory/kernel'
import type {
  RunnerPoolConnectionRecord,
  RunnerPoolConnectionRepository,
} from '@cat-factory/kernel'
import type { SecretCipher } from '@cat-factory/kernel'
import type { UrlSafetyPolicy } from '@cat-factory/kernel'
import type {
  ConnectionTestResult,
  ProviderDescriptor,
  RunnerBackendConfig,
  RunnerPoolConnection,
  RunnerPoolProvider,
  RunnerTransport,
  TestRunnerPoolConnectionInput,
} from '@cat-factory/kernel'
import { ConflictError, ValidationError } from '@cat-factory/kernel'
import { requireWorkspace } from '@cat-factory/kernel'
import type { WorkspaceRepository } from '@cat-factory/kernel'
import { missingRequiredConfigKeys } from '../environments/environments.logic.js'
import type { RunnerBackendRegistry } from './runner-backends.js'

// RunnerPoolConnectionService: owns the binding between a workspace and its "agent
// runner backend" — the place repo-operating coding jobs run. This generalises the
// original self-hosted runner pool into a discriminated backend (`manifest` |
// `kubernetes` | future kinds): registration stores the validated discriminated
// config and an *encrypted* bundle of the per-tenant credentials; only safe
// metadata (incl. which secret keys are set) is ever exposed back to clients.
//
// WHICH backend a `kind` maps to lives entirely in the runner-backend provider
// registry (`runner-backends.ts`); this service is kind-agnostic — it resolves the
// stored `kind` to a registered provider and delegates validation / transport
// construction / connection tests to it. So adding Nomad/EKS later touches only the
// registry + the contracts variant, never this service.

export interface RunnerPoolConnectionServiceDependencies {
  runnerPoolConnectionRepository: RunnerPoolConnectionRepository
  workspaceRepository: WorkspaceRepository
  secretCipher: SecretCipher
  clock: Clock
  /** URL/host safety policy applied to a manifest backend. Defaults to strict. */
  urlPolicy?: UrlSafetyPolicy
  /**
   * Whether this deployment runtime can honor a backend's custom TLS trust material
   * (a private CA / insecure-skip). The Cloudflare Worker cannot, so it sets `false`
   * and a Kubernetes config with a CA is rejected at registration. Absent ⇒ supported.
   */
  customTlsSupported?: boolean
  /** Injected manifest HTTP provider (its OAuth cache shared / a native pool adapter). */
  runnerPoolProvider?: RunnerPoolProvider
  /** The app-owned registry resolving a stored backend `kind` to its provider. */
  runnerBackendRegistry: RunnerBackendRegistry
}

/** A resolved runner backend: the live transport + its identity (for provisioning logs). */
export interface ResolvedRunnerBackend {
  transport: RunnerTransport
  kind: string
  providerId: string
}

export class RunnerPoolConnectionService {
  constructor(private readonly deps: RunnerPoolConnectionServiceDependencies) {}

  /** The per-call context a backend provider needs to build/test a transport. */
  private context(resolveSecret: (key: string) => string | undefined) {
    return {
      resolveSecret,
      ...(this.deps.urlPolicy ? { urlPolicy: this.deps.urlPolicy } : {}),
      ...(this.deps.runnerPoolProvider ? { runnerPoolProvider: this.deps.runnerPoolProvider } : {}),
    }
  }

  private provider(kind: string) {
    const provider = this.deps.runnerBackendRegistry.get(kind)
    if (!provider) throw new ValidationError(`Unknown runner backend kind: '${kind}'`)
    return provider
  }

  /** The write-boundary safety options (URL policy + this runtime's TLS capability). */
  private safetyOptions() {
    return {
      ...(this.deps.urlPolicy ? { urlPolicy: this.deps.urlPolicy } : {}),
      ...(this.deps.customTlsSupported !== undefined
        ? { customTlsSupported: this.deps.customTlsSupported }
        : {}),
    }
  }

  /** Register (or replace) a workspace's runner backend. */
  async register(
    workspaceId: string,
    input: { config: RunnerBackendConfig; secrets: Record<string, string> },
  ): Promise<RunnerPoolConnection> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    const config = input.config
    const provider = this.provider(config.kind)
    provider.assertConfigSafe(config, this.safetyOptions())

    const missing = provider.referencedSecretKeys(config).filter((key) => !(key in input.secrets))
    if (missing.length) {
      throw new ValidationError(`Missing secret values for: ${missing.join(', ')}`)
    }

    const existing = await this.deps.runnerPoolConnectionRepository.getByWorkspace(workspaceId)
    const meta = provider.connectionMeta(config)
    const secretsCipher = await this.deps.secretCipher.encrypt(JSON.stringify(input.secrets))
    const record: RunnerPoolConnectionRecord = {
      workspaceId,
      kind: config.kind,
      providerId: meta.providerId,
      label: meta.label,
      baseUrl: meta.baseUrl,
      configJson: JSON.stringify(config),
      secretsCipher,
      createdAt: existing?.createdAt ?? this.deps.clock.now(),
      deletedAt: null,
    }
    await this.deps.runnerPoolConnectionRepository.upsert(record)
    return this.toConnection(record, Object.keys(input.secrets))
  }

  /** Rotate/replace the secret bundle without re-sending the config. */
  async updateSecrets(
    workspaceId: string,
    secrets: Record<string, string>,
  ): Promise<RunnerPoolConnection> {
    const { record, config } = await this.requireConnection(workspaceId)
    const provider = this.provider(record.kind)
    const missing = provider.referencedSecretKeys(config).filter((key) => !(key in secrets))
    if (missing.length) {
      throw new ValidationError(`Missing secret values for: ${missing.join(', ')}`)
    }
    const secretsCipher = await this.deps.secretCipher.encrypt(JSON.stringify(secrets))
    const updated: RunnerPoolConnectionRecord = { ...record, secretsCipher }
    await this.deps.runnerPoolConnectionRepository.upsert(updated)
    return this.toConnection(updated, Object.keys(secrets))
  }

  /**
   * Describe the backend's config fields + test availability for the UI. With no `kind`,
   * describes the workspace's stored connection. With an explicit `kind`, validates it is a
   * REGISTERED backend (throws on unknown) and describes it even when not connected yet — so
   * the SPA can render the connect form before the first connect. The stored config/secrets
   * are folded in only when the requested kind matches the stored one.
   *
   * A NATIVE backend (Kubernetes / EKS) exposes a `form` descriptor, so it returns a `native`
   * descriptor of typed flat fields + the config skeleton the SPA overlays them onto — the SPA
   * renders one generic form for every such backend and never learns which kinds exist. A
   * manifest/custom kind rides the generic manifest body (no `form`), so — like the built-in
   * manifest backend — it uses the shared flat manifest form, falling back to the raw editor.
   */
  async describeProvider(workspaceId: string, kind?: string): Promise<ProviderDescriptor> {
    const record = await this.deps.runnerPoolConnectionRepository.getByWorkspace(workspaceId)
    // Resolve + validate the backend kind exactly like the environment service: an explicit
    // (e.g. not-yet-connected custom) kind must be a registered backend, else the stored or
    // default `manifest` kind.
    const resolvedKind = kind ?? record?.kind ?? 'manifest'
    const backend = this.provider(resolvedKind)

    // NATIVE backend: a typed flat form. Overlay values onto the STORED config when connected
    // (so advanced API-only fields survive a re-save), else the empty skeleton.
    if (backend.form) {
      const connected = !!record && resolvedKind === record.kind
      const storedConfig = connected
        ? (JSON.parse(record!.configJson) as RunnerBackendConfig)
        : undefined
      const fields = backend.form.fields()
      const values = storedConfig ? backend.form.valuesFromConfig(storedConfig) : {}
      const storedSecretKeys = connected ? Object.keys(await this.decryptSecrets(record!)) : []
      return {
        providerId: connected ? record!.providerId : resolvedKind,
        label: connected ? record!.label : (backend.displayLabel ?? resolvedKind),
        kind: 'native',
        configFields: fields,
        supportsTest: true,
        missingRequired: missingRequiredConfigKeys(fields, [
          ...Object.keys(values),
          ...storedSecretKeys,
        ]),
        configTemplate: (storedConfig ?? backend.form.skeleton()) as unknown as Record<
          string,
          unknown
        >,
        values,
      }
    }

    const useStored = !!record && resolvedKind === record.kind
    const config = useStored ? (JSON.parse(record!.configJson) as RunnerBackendConfig) : undefined
    // Both the built-in `manifest` backend AND a custom kind ride the generic
    // `{ kind, manifest }` member, so unwrap the manifest for either to drive the flat field
    // form (secret-ref keys + baseUrl); only the native `kubernetes` backend has no flat fields.
    const manifest = config && 'manifest' in config ? config.manifest : undefined
    const configFields = manifest
      ? (this.deps.runnerPoolProvider?.describeConfig?.(manifest) ?? [])
      : []
    const storedKeys = useStored ? Object.keys(await this.decryptSecrets(record!)) : []
    if (manifest?.baseUrl) storedKeys.push('baseUrl')
    const provider = this.deps.runnerPoolProvider
    return {
      providerId: useStored ? record!.providerId : 'http',
      label: useStored ? record!.label : 'Agent runner backend',
      // `kind` here is the UI FORM-STYLE discriminator (manifest editor vs native flat
      // form), not the runner-backend kind: only the manifest backend uses this
      // descriptor-driven form, so it stays 'manifest'. The actual backend kind is
      // surfaced on the connection (`connection.kind` + the non-secret `config`), which
      // is what the tab's backend selector + the Kubernetes form read.
      kind: 'manifest',
      configFields,
      supportsTest: true,
      missingRequired: missingRequiredConfigKeys(configFields, storedKeys),
      ...(manifest ? { savedManifest: manifest as unknown as Record<string, unknown> } : {}),
      ...(manifest && provider?.describeManifestTemplate
        ? { manifestTemplate: provider.describeManifestTemplate() as Record<string, unknown> }
        : {}),
    }
  }

  /** Probe a candidate backend connection before saving (nothing is persisted). */
  async testConnection(
    workspaceId: string,
    input: TestRunnerPoolConnectionInput,
  ): Promise<ConnectionTestResult> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    if (!input.config) return { ok: true, message: 'Nothing to test.' }
    const provider = this.provider(input.config.kind)
    provider.assertConfigSafe(input.config, this.safetyOptions())
    const secrets = input.secrets ?? {}
    return provider.testConnection(
      input.config,
      this.context((key) => secrets[key]),
    )
  }

  /** The workspace's current connection (safe metadata), or null. */
  async getConnection(workspaceId: string): Promise<RunnerPoolConnection | null> {
    const record = await this.deps.runnerPoolConnectionRepository.getByWorkspace(workspaceId)
    if (!record) return null
    const keys = Object.keys(await this.decryptSecrets(record))
    return this.toConnection(record, keys)
  }

  /** Resolve the live connection + parsed config, or throw if not registered. */
  async requireConnection(
    workspaceId: string,
  ): Promise<{ record: RunnerPoolConnectionRecord; config: RunnerBackendConfig }> {
    const record = await this.deps.runnerPoolConnectionRepository.getByWorkspace(workspaceId)
    if (!record) {
      throw new ConflictError(`Workspace '${workspaceId}' has no runner backend registered`)
    }
    const config = JSON.parse(record.configJson) as RunnerBackendConfig
    return { record, config }
  }

  /**
   * Resolve the workspace's runner backend into a live {@link RunnerTransport} (the
   * provider builds it from the stored config + a secret resolver over its decrypted
   * bundle), or null when it has no live backend registered / its kind is no longer
   * registered. Used by the wiring to pick the dispatch backend per job.
   */
  async resolve(workspaceId: string): Promise<ResolvedRunnerBackend | null> {
    const record = await this.deps.runnerPoolConnectionRepository.getByWorkspace(workspaceId)
    if (!record) return null
    const provider = this.deps.runnerBackendRegistry.get(record.kind)
    if (!provider) return null
    const config = JSON.parse(record.configJson) as RunnerBackendConfig
    const bundle = await this.decryptSecrets(record)
    const transport = provider.buildTransport(
      config,
      this.context((key) => bundle[key]),
    )
    return { transport, kind: record.kind, providerId: record.providerId }
  }

  /** Unregister the backend (tombstones the binding). */
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
    // The stored config holds NO secrets (those live in the separate encrypted bundle),
    // so it is safe to expose so the connect form can prefill the non-secret fields on
    // edit (namespace/image/… for kubernetes) instead of forcing a full re-entry.
    const config = this.parseConfig(record)
    return {
      kind: record.kind,
      providerId: record.providerId,
      label: record.label,
      baseUrl: record.baseUrl,
      connectedAt: record.createdAt,
      secretKeys,
      ...(config ? { config } : {}),
    }
  }

  /** Parse the stored discriminated config, tolerating a malformed/legacy blob. */
  private parseConfig(record: RunnerPoolConnectionRecord): RunnerBackendConfig | undefined {
    try {
      return JSON.parse(record.configJson) as RunnerBackendConfig
    } catch {
      return undefined
    }
  }
}
