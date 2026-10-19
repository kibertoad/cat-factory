import {
  ConflictError,
  DEFAULT_WORKSPACE_SETTINGS,
  describeError,
  noopLogger,
  requireWorkspace,
  ValidationError,
  type AccountRunnerPoolRecord,
  type AccountRunnerPoolRepository,
  type Clock,
  type ConnectionTestResult,
  type Logger,
  type ProviderDescriptor,
  type RunnerBackendConfig,
  type RunnerPoolConnection,
  type RunnerPoolConnectionRecord,
  type RunnerPoolConnectionRepository,
  type RunnerPoolProvider,
  type RunnerTransport,
  type SavedConnectionProbe,
  type SecretCipher,
  type TestRunnerPoolConnectionInput,
  type UrlSafetyPolicy,
  type WorkspaceRepository,
  type WorkspaceSettingsRepository,
} from '@cat-factory/kernel'
import type {
  AccountRunnerPoolSummary,
  RegisterRunnerPoolInput,
  RunnerPoolSource,
} from '@cat-factory/contracts'
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
  /**
   * The account tier a board without its own pool falls back to. Both members travel together: the
   * fallback reads the account's row AND the board's `inheritAccountRunnerPool` marker, and a
   * resolver that could read one without the other would either ignore the opt-out or never
   * inherit. Absent ⇒ no account tier (the previous behaviour, byte for byte).
   */
  accountRunnerPool?: {
    repository: AccountRunnerPoolRepository
    workspaceSettingsRepository: WorkspaceSettingsRepository
  }
  /** Optional so the service stays unit-testable standalone; every facade wires the real one. */
  logger?: Logger
}

/** A deployment- or admin-supplied runner pool: what {@link RunnerPoolConnectionService.validate} checks. */
export type RunnerPoolInput = RegisterRunnerPoolInput

/** A resolved runner backend: the live transport + its identity (for provisioning logs). */
export interface ResolvedRunnerBackend {
  transport: RunnerTransport
  kind: string
  providerId: string
}

/** JSON with object keys sorted, so two values that differ only in key order compare equal. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : item,
  )
}

export class RunnerPoolConnectionService {
  private readonly log: Logger

  constructor(private readonly deps: RunnerPoolConnectionServiceDependencies) {
    this.log = deps.logger ?? noopLogger
  }

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

  /**
   * The ONE admission check for a runner pool, shared by an admin's registration and a
   * deployment's seed so the two cannot disagree: the backend kind is registered, its URLs pass
   * the safety policy, and every secret the config references is present. Throws a
   * {@link ValidationError}; returns the resolved provider so a caller needs no second lookup.
   */
  validate(input: RunnerPoolInput) {
    const provider = this.provider(input.config.kind)
    provider.assertConfigSafe(input.config, this.safetyOptions())
    const missing = provider
      .referencedSecretKeys(input.config)
      .filter((key) => !(key in input.secrets))
    if (missing.length) {
      throw new ValidationError(`Missing secret values for: ${missing.join(', ')}`)
    }
    return provider
  }

  /**
   * Register an ACCOUNT's runner pool unless it already has one: the write a deployment's seed
   * makes. Validated like any registration, sealed under the same cipher, and inserted in one
   * conflict-targeted statement, so two seeders racing on the same account leave exactly one row
   * and an existing row is never replaced here ({@link reseedAccount} is the write that updates
   * one). Returns whether this call inserted.
   */
  async seedAccount(accountId: string, input: RunnerPoolInput): Promise<boolean> {
    const repository = this.requireAccountPoolRepository()
    return repository.insertIfAbsent(await this.sealAccountRecord(accountId, input))
  }

  /**
   * Bring an account's existing pool in line with what the deployment declares now: the write a
   * seed's boot backfill makes, so a rotated token or a new image reaches accounts seeded on earlier
   * boots. Compared by CONTENT (the stored config, and the secrets decrypted), because the cipher
   * seals the same secrets differently each time; an equal row is left alone. A stored bundle that
   * no longer decrypts counts as different, since the seed is the only thing that can repair it.
   * Validated like any registration first. Returns whether this call replaced the row.
   */
  async reseedAccount(current: AccountRunnerPoolRecord, input: RunnerPoolInput): Promise<boolean> {
    const repository = this.requireAccountPoolRepository()
    const record = await this.sealAccountRecord(current.accountId, input)
    if (await this.holdsSeed(current, input)) return false
    return repository.replace(record)
  }

  private requireAccountPoolRepository(): AccountRunnerPoolRepository {
    const accountPool = this.deps.accountRunnerPool
    if (!accountPool) throw new ConflictError('The account runner pool is not wired')
    return accountPool.repository
  }

  /** Validate a declared pool and seal it into the account's row shape. */
  private async sealAccountRecord(
    accountId: string,
    input: RunnerPoolInput,
  ): Promise<AccountRunnerPoolRecord> {
    const provider = this.validate(input)
    const meta = provider.connectionMeta(input.config)
    return {
      accountId,
      kind: input.config.kind,
      providerId: meta.providerId,
      label: meta.label,
      baseUrl: meta.baseUrl,
      configJson: JSON.stringify(input.config),
      secretsCipher: await this.deps.secretCipher.encrypt(JSON.stringify(input.secrets)),
      createdAt: this.deps.clock.now(),
    }
  }

  /** Whether the account's stored row already holds exactly this config and these secrets. */
  private async holdsSeed(
    current: AccountRunnerPoolRecord,
    input: RunnerPoolInput,
  ): Promise<boolean> {
    let storedConfig: unknown
    let storedSecrets: unknown
    try {
      storedConfig = JSON.parse(current.configJson)
      storedSecrets = JSON.parse(await this.deps.secretCipher.decrypt(current.secretsCipher))
    } catch (error) {
      this.log.warn('stored account runner pool could not be read; the declared seed replaces it', {
        accountId: current.accountId,
        ...describeError(error),
      })
      return false
    }
    return (
      canonicalJson(storedConfig) === canonicalJson(input.config) &&
      canonicalJson(storedSecrets) === canonicalJson(input.secrets)
    )
  }

  /**
   * The ONE dispatch-time resolver: the board's own live row, else its account's row, else
   * nothing. The account tier applies only to a board that belongs to an account (a legacy board
   * has none and keeps registering per workspace) and has not opted out through
   * `inheritAccountRunnerPool`. The account's row is returned in the board's record shape, so
   * every caller reads one type whichever tier answered.
   *
   * Every READ of "the board's pool" goes through here; only the writes (`register`,
   * `updateSecrets`, `unregister`) address the board's own row directly.
   */
  private async effective(workspaceId: string): Promise<RunnerPoolConnectionRecord | null> {
    return (await this.effectiveWithSource(workspaceId))?.record ?? null
  }

  /** {@link effective}, naming the tier that answered. */
  private async effectiveWithSource(
    workspaceId: string,
  ): Promise<{ record: RunnerPoolConnectionRecord; source: RunnerPoolSource } | null> {
    const own = await this.deps.runnerPoolConnectionRepository.getByWorkspace(workspaceId)
    if (own) return { record: own, source: 'workspace' }
    const account = await this.accountTier(workspaceId)
    if (!account) return null
    const settings = await account.workspaceSettingsRepository.get(workspaceId)
    const inherit = (settings ?? DEFAULT_WORKSPACE_SETTINGS).inheritAccountRunnerPool
    if (!inherit) return null
    const row = await account.repository.getByAccount(account.accountId)
    return row ? { record: { ...row, workspaceId, deletedAt: null }, source: 'account' } : null
  }

  /**
   * The account tier as it applies to this board: wired, and the board belongs to an account (a
   * legacy board has none). Null otherwise.
   */
  private async accountTier(workspaceId: string) {
    const accountPool = this.deps.accountRunnerPool
    if (!accountPool) return null
    const accountId = await this.deps.workspaceRepository.accountOf(workspaceId)
    return accountId ? { ...accountPool, accountId } : null
  }

  /**
   * The board's ACCOUNT's pool as safe metadata, whether or not the board uses it (it may have its
   * own, or may have opted out), so an admin can see what removing the board's pool or opting back
   * in would route to. Null when the board has no account tier or its account has no pool.
   */
  async getAccountPool(workspaceId: string): Promise<AccountRunnerPoolSummary | null> {
    const account = await this.accountTier(workspaceId)
    if (!account) return null
    const row = await account.repository.getByAccount(account.accountId)
    return row
      ? { kind: row.kind, providerId: row.providerId, label: row.label, baseUrl: row.baseUrl }
      : null
  }

  /** Register (or replace) a workspace's runner backend. */
  async register(
    workspaceId: string,
    input: { config: RunnerBackendConfig; secrets: Record<string, string> },
  ): Promise<RunnerPoolConnection> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    const config = input.config
    const provider = this.validate(input)

    // The board's OWN row only: an inherited account pool is not this board's to carry over.
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
    // Each gap the provider reports costs a recovery/cleanup path that is otherwise invisible
    // until an incident (a release-less manifest leaks a runner on every cancelled run). Log it
    // at REGISTRATION rather than per dispatch, where `resolve()` would re-emit the same line
    // for every job. This is the deployment-operator's copy; the person who pasted the config
    // sees the same gaps on their connection test, which is the surface they are looking at.
    for (const warning of provider.warnings?.(config) ?? []) {
      this.log.warn(`Runner backend registered with a gap: ${warning.message}`, {
        workspaceId,
        kind: config.kind,
        providerId: meta.providerId,
        warning: warning.code,
      })
    }
    return this.toConnection(record, Object.keys(input.secrets), 'workspace')
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
    return this.toConnection(updated, Object.keys(secrets), 'workspace')
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
    const record = await this.effective(workspaceId)
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
        configTemplate: storedConfig ?? backend.form.skeleton(),
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
      ...(manifest ? { savedManifest: manifest } : {}),
      ...(manifest && provider?.describeManifestTemplate
        ? { manifestTemplate: provider.describeManifestTemplate() as Record<string, unknown> }
        : {}),
    }
  }

  /**
   * Probe a candidate backend connection before saving (nothing is persisted), and report the
   * config's non-fatal gaps alongside the probe.
   *
   * The gaps ride the test rather than a surface of their own because this is the one moment
   * the operator is looking at THIS config, and they are the same person who can fix it. They
   * are independent of `ok`: a manifest with no `release` template connects perfectly well and
   * still leaks a runner on every cancelled run.
   */
  async testConnection(
    workspaceId: string,
    input: TestRunnerPoolConnectionInput,
  ): Promise<ConnectionTestResult> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    if (!input.config) return { ok: true, message: 'Nothing to test.' }
    const config = input.config
    const provider = this.provider(config.kind)
    provider.assertConfigSafe(config, this.safetyOptions())
    const secrets = input.secrets ?? {}
    const result = await provider.testConnection(
      config,
      this.context((key) => secrets[key]),
    )
    const warnings = provider.warnings?.(config) ?? []
    return warnings.length ? { ...result, warnings } : result
  }

  /** The workspace's current connection (safe metadata), or null. */
  async getConnection(workspaceId: string): Promise<RunnerPoolConnection | null> {
    const effective = await this.effectiveWithSource(workspaceId)
    if (!effective) return null
    const keys = Object.keys(await this.decryptSecrets(effective.record))
    return this.toConnection(effective.record, keys, effective.source)
  }

  /**
   * Whether a runner-pool connection is registered for the workspace — a presence probe that does
   * NOT decrypt the secret bundle (unlike {@link getConnection}). Used by the infra-setup snapshot
   * projection, which only needs the yes/no and runs on the hot board-load path.
   */
  async hasConnection(workspaceId: string): Promise<boolean> {
    return (await this.effective(workspaceId)) !== null
  }

  /**
   * Resolve the board's OWN live connection + parsed config, or throw if it has none. Deliberately
   * not the effective pool: its caller rotates secrets, and rotating an inherited account pool's
   * secrets onto a board row would silently fork the board off the account's pool.
   */
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
    const record = await this.effective(workspaceId)
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

  /**
   * Probe the workspace's SAVED backend, for the reachability watcher.
   *
   * The sibling {@link testConnection} answers "would this config work" for an operator staring at
   * a form; this answers "does what we already stored still answer", which is the question a
   * background sweep asks. So it resolves the stored record + its own secret bundle rather than
   * taking candidate values, and it makes NO safety assertion: `assertConfigSafe` guards what an
   * operator may SAVE, and re-running it here would report an already-persisted pool as an outage
   * the moment a deployment tightened its URL policy. The config warnings are irrelevant to
   * reachability, so unlike `testConnection` they are not folded in.
   *
   * Never `{ ok: false }` for anything but a provider that actually ANSWERED negatively: the three
   * {@link SavedConnectionProbe} states keep "no backend registered" (a fact — no outage to report,
   * and any recorded one must be forgotten) apart from "we could not ask" (its kind is no longer in
   * the registry, or its stored config blob won't parse — leave the record alone) apart from a real
   * verdict. A de-registered kind that read as `{ ok: false }` would show as permanently down.
   */
  async probeSavedConnection(workspaceId: string): Promise<SavedConnectionProbe> {
    const record = await this.effective(workspaceId)
    if (!record) return { state: 'absent' }
    const provider = this.deps.runnerBackendRegistry.get(record.kind)
    if (!provider) {
      return { state: 'unprobeable', reason: `Runner backend kind '${record.kind}' is not wired.` }
    }
    const config = this.parseConfig(record)
    if (!config) {
      return { state: 'unprobeable', reason: 'The stored runner-pool config could not be parsed.' }
    }
    const bundle = await this.decryptSecrets(record)
    return {
      state: 'answered',
      result: await provider.testConnection(
        config,
        this.context((key) => bundle[key]),
      ),
    }
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
    source: RunnerPoolSource,
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
      source,
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
