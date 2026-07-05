import type { Clock } from '@cat-factory/kernel'
import type {
  CustomManifestType,
  CustomManifestTypeRecord,
  CustomManifestTypeRepository,
  EnvironmentConnectionRecord,
  EnvironmentConnectionRepository,
} from '@cat-factory/kernel'
import type { SecretCipher } from '@cat-factory/kernel'
import type { SecretResolver, UrlSafetyPolicy } from '@cat-factory/kernel'
import type {
  BootstrapEnvironmentRepoInput,
  BootstrapRepoResult,
  ConnectionTestResult,
  EnvironmentBackendConfig,
  EnvironmentConnection,
  EnvironmentManifest,
  EnvironmentProvider,
  InfraEngine,
  InfraHandlerConfig,
  ProviderDescriptor,
  ProvisionType,
  RepairAgentSpec,
  RepoValidationIssue,
  RepoValidationResult,
  RunRepoContext,
  ServiceProvisioning,
  TestEnvironmentConnectionInput,
  TestEnvironmentHandlerInput,
  ValidateEnvironmentRepoInput,
} from '@cat-factory/kernel'
import { ConflictError, ValidationError } from '@cat-factory/kernel'
import { requireWorkspace } from '@cat-factory/kernel'
import type { WorkspaceRepository } from '@cat-factory/kernel'
import type {
  DetectFrontendConfigInput,
  DetectServiceProvisioningInput,
  FrontendConfigRecommendation,
  ProvisioningRecommendation,
  RepairCustomManifestInput,
} from '@cat-factory/contracts'
import { detectCustomManifest, detectKubernetesProvisioning } from './provision-detect.logic.js'
import { detectFrontendConfig } from './frontend-detect.logic.js'
import type {
  EnvironmentBackendProvider,
  EnvironmentBackendRegistry,
} from './environment-backends.js'
import {
  aggregateCustomManifestTypes,
  type CustomManifestTypeRegistry,
} from './custom-manifest-types.js'
import {
  buildInfraHandlerFields,
  handlerConfigToBackendConfig,
  overlaySecrets,
  resolveHandlerBackend,
  type ServiceProvisioningInputs,
  toManifestId,
} from './infra-handler-build.js'
import { missingRequiredConfigKeys, stringifyProviderConfig } from './environments.logic.js'
import {
  type InfraHandlerLike,
  type InfraHandlerResolution,
  resolveInfraHandler,
} from './infra-handler.logic.js'
import type { ProvisioningLogRecorder } from '../provisioning-logs/ProvisioningLogService.js'

// ---------------------------------------------------------------------------
// Per-provision-type handler model (the "how"): a workspace registers one infra HANDLER
// per provision type (plus one per pinned custom manifest id). The service builds a live
// `EnvironmentProvider` for a service's declared type by resolving its handler and MERGING
// the service-owned `manifestSource` (the "what + where") into the engine config at provision
// time. The pre-reshape single-connection surface (register/getConnection/updateSecrets/
// unregister/describeProvider/resolveProvider/…) is preserved as a COMPAT BRIDGE over the
// primary handler so the existing controller + frontend keep working until the per-type HTTP
// surface lands (slices 4–5). See docs/initiatives/per-service-provision-types.md.
// ---------------------------------------------------------------------------

/** Map a resolved engine back to the provision type it serves. */
function engineToProvisionType(engine: InfraEngine): ProvisionType {
  switch (engine) {
    case 'local-docker':
      return 'docker-compose'
    case 'local-k3s':
    case 'remote-kubernetes':
      return 'kubernetes'
    case 'remote-custom':
      return 'custom'
    case 'none':
      return 'infraless'
  }
}

/**
 * Coordinates + a workspace id for a config-repair agent dispatch, plus the issues that
 * triggered it. The orchestration layer wires an implementation that builds the prompt
 * from the provider's `describeRepairAgent`, dispatches a coding agent, and returns the
 * post-repair validation. Absent ⇒ no agent fallback.
 */
export interface ConfigRepairDispatch {
  workspaceId: string
  owner: string
  repo: string
  gitRef: string
  issues: RepoValidationIssue[]
  inputs?: Record<string, string>
  /**
   * Explicit repair prompt. When set, the agent is dispatched with THIS prompt instead of the
   * provider's `describeRepairAgent` — used by the custom-manifest generate/fix flow, whose
   * prompt comes from the custom-manifest-type definition rather than the connection provider.
   */
  promptOverride?: RepairAgentSpec
  /**
   * The single repo-relative file the agent should create/fix (the custom manifest path). Kept
   * for the prompt/commit message; the agent still pushes onto `gitRef` with no PR.
   */
  manifestPath?: string
}

/** Deterministic head branch for the PR-mode config bootstrap (idempotent re-runs). */
const BOOTSTRAP_CONFIG_BRANCH = 'cat-factory/env-config'

/**
 * Compose the coding-agent prompt for a custom-manifest generate/fix run: the custom type's own
 * `fixerPrompt` framed with the concrete target path, whether the file exists (generate vs fix),
 * and any validation issues found. Keeps the agent scoped to the one file and pushing on-branch.
 */
function buildCustomManifestRepairPrompt(args: {
  basePrompt: string
  label: string
  manifestPath: string
  exists: boolean
  issues: RepoValidationIssue[]
}): RepairAgentSpec {
  const { basePrompt, label, manifestPath, exists, issues } = args
  const situation = exists
    ? `The manifest file at \`${manifestPath}\` already exists but may be invalid or incomplete — validate it and make the minimal edits needed to bring it into a valid state.`
    : `The manifest file at \`${manifestPath}\` does not exist yet — create it.`
  // Build the sections explicitly and join with blank lines so each stays its own paragraph.
  // (Don't push `''` separators through `filter(Boolean)` — it strips them, collapsing the
  // structure.) The issue list is conditional, included only when validation found something.
  const sections = [
    `You are setting up the "${label}" custom deployment manifest for a service.`,
    situation,
    basePrompt,
  ]
  if (issues.length) {
    sections.push(
      `Validation reported these issues to address:\n${issues.map((i) => `- [${i.severity}] ${i.path ? `${i.path}: ` : ''}${i.message}`).join('\n')}`,
    )
  }
  sections.push(
    `Write ONLY the manifest at \`${manifestPath}\` (create the directory if needed); leave the rest of the repository untouched. Commit and push your changes; do NOT open a pull request.`,
  )
  return { prompt: sections.join('\n\n') }
}

// EnvironmentConnectionService: owns the binding between a workspace and an
// environment provider. The connect config is discriminated by `kind`; the registered
// EnvironmentBackendProvider for that kind validates it, translates it to the stored
// manifest, and builds the live provider. Registration stores the manifest + an
// *encrypted* bundle of the per-tenant secrets; only safe metadata (incl. which secret
// keys are set) is ever exposed back to clients.

export interface EnvironmentConnectionServiceDependencies {
  environmentConnectionRepository: EnvironmentConnectionRepository
  workspaceRepository: WorkspaceRepository
  secretCipher: SecretCipher
  clock: Clock
  /** URL/host safety policy applied to a registered manifest. Defaults to strict. */
  urlPolicy?: UrlSafetyPolicy
  /**
   * Whether this runtime can honor a backend's custom TLS material (a private CA /
   * insecure-skip). The Cloudflare Worker can't (no undici), so it sets `false` and a
   * kubernetes config with CA/insecure is rejected at registration. Absent/`true` ⇒ ok.
   */
  customTlsSupported?: boolean
  /**
   * Resolve a VCS-neutral, workspace+repo-bound RepoFiles for on-demand repo
   * validation / config bootstrap. Built by the runtime from the workspace's VCS
   * connection + the supplied repo coords (GitHub today, GitLab later). Absent ⇒ repo
   * validation/bootstrap report "no VCS connection".
   */
  resolveRepoFilesForWorkspace?: (
    workspaceId: string,
    coords: { owner: string; repo: string; provider?: 'github' | 'gitlab' },
  ) => Promise<RunRepoContext | null>
  /**
   * START a durable, asynchronous config-repair run — it dispatches a coding agent that
   * fixes a malformed/partial provider config and pushes the fix back onto the target
   * branch, then RETURNS IMMEDIATELY with the run's `jobId`. Wired by a runtime over the
   * orchestration `EnvConfigRepairService`. Absent ⇒ no agent fallback.
   */
  dispatchConfigRepair?: (input: ConfigRepairDispatch) => Promise<{ jobId: string }>
  /** Best-effort provisioning-event log; absent ⇒ no logging. */
  provisioningLog?: ProvisioningLogRecorder
  /**
   * INTERNAL override: when set, this provider is used for every resolved-provider path
   * (provision/status/teardown/validate/bootstrap/describe) instead of the kind registry.
   * NOT a public seam — a native backend registers into the injected
   * {@link environmentBackendRegistry}. It exists only for the cross-runtime conformance
   * suite (fake validate-repo / repair providers injected through the schema-locked connect
   * API). Absent ⇒ the registry path.
   */
  environmentProvider?: EnvironmentProvider
  /** The app-owned registry resolving a stored backend `kind` to its provider. */
  environmentBackendRegistry: EnvironmentBackendRegistry
  /**
   * Workspace-defined custom-manifest-type catalog rows (the UI-editable half of the custom
   * provision-type catalog). Absent ⇒ the catalog is the registered types only and custom-type
   * CRUD throws `unavailable`.
   */
  customManifestTypeRepository?: CustomManifestTypeRepository
  /** The app-owned registry of code-defined custom manifest types (merged into the catalog). */
  customManifestTypeRegistry?: CustomManifestTypeRegistry
}

export interface ResolvedConnection {
  record: EnvironmentConnectionRecord
  manifest: EnvironmentManifest
}

/** Register (or replace) one per-type infra handler. */
export interface RegisterHandlerInput {
  provisionType: ProvisionType
  /** For a `custom` type keyed to a specific manifest id; absent ⇒ the bare (single) custom handler. */
  manifestId?: string | null
  config: InfraHandlerConfig
  /**
   * The env-backend registry kind that builds the provider. Absent ⇒ resolved from the
   * config's engine (the generic backend for that engine). Pin it to select a specific
   * custom backend that rides a shared engine (e.g. `remote-custom`).
   */
  backendKind?: string
  secrets: Record<string, string>
}

/** A workspace handler as exposed to clients (never secret values). */
export interface EnvironmentHandlerView {
  provisionType: ProvisionType
  manifestId: string | null
  engine: InfraEngine
  providerId: string
  label: string
  baseUrl: string
  connectedAt: number
  secretKeys: string[]
  acceptsManifestId: string | null
  /**
   * The registry backend kind that builds this handler's provider (`manifest`, `kubernetes`,
   * or a deployment-registered custom kind), so the connect form can pre-select it on edit.
   */
  backendKind: string
  /** The stored handler config, sans secrets, for connect-form prefill on edit. */
  config?: InfraHandlerConfig
}

/** The resolved live provider for a service's declared provision type. */
export interface ResolvedTypeProvider {
  provider: EnvironmentProvider
  manifest: EnvironmentManifest
  provisionType: ProvisionType
  engine: InfraEngine
  resolveSecret: SecretResolver
}

export class EnvironmentConnectionService {
  constructor(private readonly deps: EnvironmentConnectionServiceDependencies) {}

  // ---- per-type handlers (the final API) ---------------------------------

  /** Every handler the workspace has registered, sans secret values (batched). */
  async listHandlers(workspaceId: string): Promise<EnvironmentHandlerView[]> {
    const records = await this.deps.environmentConnectionRepository.listByWorkspace(workspaceId)
    // The secret-key NAMES are derived from the (non-secret) config rather than decrypting
    // each bundle: registration/rotation guarantee every referenced key is present, so the
    // referenced set equals the stored set — no per-record decrypt needed just to list names.
    return records.map((record) =>
      this.toHandlerView(record, this.referencedSecretKeyNames(record)),
    )
  }

  /** Secret key NAMES a stored handler requires, derived from its non-secret config (no decrypt). */
  private referencedSecretKeyNames(record: EnvironmentConnectionRecord): string[] {
    try {
      const { backend, backendConfig } = this.buildFromRecord(record)
      return backend.referencedSecretKeys(backendConfig)
    } catch {
      // A handler whose backend is no longer registered can't be introspected (it can't
      // provision either) — list it with no key names rather than failing the whole bundle.
      return []
    }
  }

  /** Register (or replace) the handler for one provision type (+ optional custom manifest id). */
  async registerHandler(
    workspaceId: string,
    input: RegisterHandlerInput,
  ): Promise<EnvironmentHandlerView> {
    const record = await this.storeHandler(workspaceId, input)
    // Derive the stored secret-key names from the PERSISTED record (not the request body), so a
    // secret preserved on edit (the operator left the field blank to keep the saved token) still
    // reports as set. Mirrors listHandlers.
    return this.toHandlerView(record, this.referencedSecretKeyNames(record))
  }

  /** Rotate the secret bundle for one handler without re-sending its config. */
  async updateHandlerSecrets(
    workspaceId: string,
    provisionType: ProvisionType,
    manifestId: string | null,
    secrets: Record<string, string>,
  ): Promise<EnvironmentHandlerView> {
    const record = await this.requireHandler(workspaceId, provisionType, manifestId)
    const { backend, backendConfig } = this.buildFromRecord(record)
    const missing = backend.referencedSecretKeys(backendConfig).filter((key) => !(key in secrets))
    if (missing.length) {
      throw new ValidationError(`Missing secret values for: ${missing.join(', ')}`)
    }
    const secretsCipher = await this.deps.secretCipher.encrypt(JSON.stringify(secrets))
    const updated: EnvironmentConnectionRecord = { ...record, secretsCipher }
    await this.deps.environmentConnectionRepository.upsert(updated)
    return this.toHandlerView(updated, Object.keys(secrets))
  }

  /** Remove one handler. */
  async unregisterHandler(
    workspaceId: string,
    provisionType: ProvisionType,
    manifestId: string | null,
  ): Promise<void> {
    await this.deps.environmentConnectionRepository.softDelete(
      workspaceId,
      provisionType,
      manifestId,
      this.deps.clock.now(),
    )
  }

  /**
   * Resolve the live provider for a SERVICE's declared provisioning (the "what + where") by
   * matching its type to a workspace handler (the "how") and MERGING the service-owned
   * `manifestSource` into the engine config. Throws a {@link ConflictError} when no handler
   * serves the type (or a bare `custom` is ambiguous). `infraless` has no provider — callers
   * short-circuit it before calling this.
   */
  /**
   * Resolve WHICH workspace handler (if any) serves a service's declared provisioning —
   * the lightweight resolution shared by {@link resolveProviderForType} and the Tester's
   * start-time infra gate (`canProvision`). One batched `listByWorkspace` + the pure
   * {@link resolveInfraHandler}; no provider build / secret decrypt. `infraless` is the
   * caller's concern (it has no handler) and is rejected here.
   */
  async resolveHandlerForType(
    workspaceId: string,
    service: ServiceProvisioning,
    userOverrides: EnvironmentConnectionRecord[] = [],
  ): Promise<InfraHandlerResolution<EnvironmentConnectionRecord & InfraHandlerLike>> {
    const handlers = await this.deps.environmentConnectionRepository.listByWorkspace(workspaceId)
    return resolveInfraHandler<EnvironmentConnectionRecord & InfraHandlerLike>(
      { type: service.type, ...(service.manifestId ? { manifestId: service.manifestId } : {}) },
      handlers,
      userOverrides,
    )
  }

  async resolveProviderForType(
    workspaceId: string,
    service: ServiceProvisioning,
    userOverrides: EnvironmentConnectionRecord[] = [],
  ): Promise<ResolvedTypeProvider> {
    if (service.type === 'infraless') {
      throw new ValidationError('infraless services have no environment provider')
    }
    const resolution = await this.resolveHandlerForType(workspaceId, service, userOverrides)
    if (!resolution.ok) {
      const message =
        resolution.reason === 'type-mismatch'
          ? `Multiple '${service.type}' handlers match this service; pin a manifest id to disambiguate.`
          : `This workspace has no handler configured for provision type '${service.type}'.`
      throw new ConflictError(message, 'provision_type_unhandled', { provisionType: service.type })
    }
    const record = resolution.handler!
    const { provider, manifest } = this.buildFromRecord(record, {
      ...(service.manifestSource ? { manifestSource: service.manifestSource } : {}),
      ...(service.images ? { images: service.images } : {}),
      ...(service.helmReleases ? { helmReleases: service.helmReleases } : {}),
      ...(service.secretInjections ? { secretInjections: service.secretInjections } : {}),
      ...(service.recipe ? { recipe: service.recipe } : {}),
    })
    return {
      provider,
      manifest,
      provisionType: service.type,
      engine: resolution.engine,
      resolveSecret: await this.buildResolveSecret(record),
    }
  }

  // ---- custom-manifest-type catalog --------------------------------------

  /** The full custom-manifest-type catalog (registered code types + workspace rows). */
  async listCustomTypes(workspaceId: string): Promise<CustomManifestType[]> {
    const registered = this.deps.customManifestTypeRegistry?.list() ?? []
    const rows = (await this.deps.customManifestTypeRepository?.listByWorkspace(workspaceId)) ?? []
    return aggregateCustomManifestTypes(registered, rows)
  }

  /** Create/replace a workspace-defined custom manifest type. */
  async upsertCustomType(
    workspaceId: string,
    manifestId: string,
    input: {
      label: string
      acceptsInputHint?: string
      description?: string
      defaultManifestPath?: string
      fixerPrompt?: string
    },
  ): Promise<CustomManifestType> {
    const repo = this.deps.customManifestTypeRepository
    if (!repo) throw new ConflictError('Custom manifest types are not configured')
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    const existing = (await repo.listByWorkspace(workspaceId)).find(
      (t) => t.manifestId === manifestId,
    )
    const now = this.deps.clock.now()
    const record: CustomManifestTypeRecord = {
      workspaceId,
      manifestId,
      label: input.label,
      acceptsInputHint: input.acceptsInputHint ?? null,
      description: input.description ?? null,
      defaultManifestPath: input.defaultManifestPath ?? null,
      fixerPrompt: input.fixerPrompt ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    await repo.upsert(record)
    return {
      manifestId,
      label: record.label,
      source: 'workspace',
      ...(record.acceptsInputHint ? { acceptsInputHint: record.acceptsInputHint } : {}),
      ...(record.description ? { description: record.description } : {}),
      ...(record.defaultManifestPath ? { defaultManifestPath: record.defaultManifestPath } : {}),
      ...(record.fixerPrompt ? { fixerPrompt: record.fixerPrompt } : {}),
    }
  }

  /** Remove a workspace-defined custom manifest type. */
  async removeCustomType(workspaceId: string, manifestId: string): Promise<void> {
    await this.deps.customManifestTypeRepository?.remove(workspaceId, manifestId)
  }

  // ---- compat bridge (pre-reshape single-connection surface) -------------

  /** Register (or replace) a workspace's environment provider (legacy single-connection API). */
  async register(
    workspaceId: string,
    input: { config: EnvironmentBackendConfig; secrets: Record<string, string> },
  ): Promise<EnvironmentConnection> {
    const backend = this.requireBackend(input.config.kind)
    const engines = backend.engines()
    // A registered connection is a "remote" handler where the backend offers one.
    const engine = (engines.find((e) => e.startsWith('remote-')) ??
      engines[0] ??
      'remote-custom') as InfraEngine
    const handlerConfig = this.toHandlerConfig(input.config, engine)
    const record = await this.storeHandler(workspaceId, {
      provisionType: engineToProvisionType(engine),
      config: handlerConfig,
      backendKind: input.config.kind,
      secrets: input.secrets,
    })
    // The legacy surface owns exactly ONE live handler per workspace. A register that switches
    // provider kind lands on a different (workspace, provisionType, manifestId) key, so without
    // this the prior kind's row would survive and `primaryRecord` (oldest-first) would keep
    // resolving it — getConnection/resolveProvider/updateSecrets/unregister would all act on the
    // stale connection. Tombstone any other handler so the just-registered one is unambiguous.
    await this.clearOtherHandlers(workspaceId, record)
    return this.toConnection(record, Object.keys(input.secrets))
  }

  /** Tombstone every live handler for the workspace except `keep` (compat-bridge single-row). */
  private async clearOtherHandlers(
    workspaceId: string,
    keep: EnvironmentConnectionRecord,
  ): Promise<void> {
    // Bounded by the handful of provision types the legacy bridge can create (not data-scaling),
    // and over the one already-fetched list — not an N+1 point-read loop.
    const handlers = await this.deps.environmentConnectionRepository.listByWorkspace(workspaceId)
    const now = this.deps.clock.now()
    for (const handler of handlers) {
      if (handler.provisionType === keep.provisionType && handler.manifestId === keep.manifestId) {
        continue
      }
      await this.deps.environmentConnectionRepository.softDelete(
        workspaceId,
        handler.provisionType,
        handler.manifestId,
        now,
      )
    }
  }

  /** Rotate/replace the secret bundle without re-sending the config (legacy single-connection API). */
  async updateSecrets(
    workspaceId: string,
    secrets: Record<string, string>,
  ): Promise<EnvironmentConnection> {
    const record = await this.requirePrimary(workspaceId)
    const { backend, backendConfig } = this.buildFromRecord(record)
    const missing = backend.referencedSecretKeys(backendConfig).filter((key) => !(key in secrets))
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
   * connection test is available). With no `kind`, describes the workspace's stored
   * connection (or the default `manifest` backend when none is registered). With an
   * explicit `kind`, describes that REGISTERED backend even when it isn't connected yet —
   * so the SPA can render a custom kind's connect form before the first connect. The
   * stored manifest/secrets are folded in only when the requested kind matches the stored
   * one (a different kind starts blank).
   */
  async describeProvider(workspaceId: string, kind?: string): Promise<ProviderDescriptor> {
    const record = await this.primaryRecord(workspaceId)
    const recordKind = record?.backendKind
    const resolvedKind = kind ?? recordKind ?? 'manifest'
    const backend = this.requireBackend(resolvedKind)
    const provider = this.deps.environmentProvider ?? this.buildProvider(backend)
    const overridden = !!this.deps.environmentProvider
    // Fold in the stored manifest/secrets only when describing the kind that is actually
    // connected; describing a different (e.g. not-yet-connected custom) kind starts blank.
    const useStored = !!record && resolvedKind === recordKind
    const manifest = useStored ? this.buildFromRecord(record!).manifest : undefined
    const configFields = provider.describeConfig?.(manifest) ?? []
    const storedKeys: string[] = []
    if (useStored) {
      storedKeys.push(...Object.keys(await this.decryptSecrets(record!)))
      if (manifest?.providerConfig) storedKeys.push(...Object.keys(manifest.providerConfig))
      if (manifest?.baseUrl) storedKeys.push('baseUrl')
    }
    return {
      providerId: useStored ? record!.providerId : resolvedKind,
      label: useStored ? record!.label : (backend.displayLabel ?? resolvedKind),
      kind: overridden || resolvedKind !== 'manifest' ? 'native' : 'manifest',
      configFields,
      supportsTest: typeof provider.testConnection === 'function',
      supportsRepoValidation: typeof provider.validateRepo === 'function',
      supportsRepoBootstrap: typeof provider.bootstrapProviderConfiguration === 'function',
      ...(provider.describeBootstrapInputs
        ? { bootstrapInputs: provider.describeBootstrapInputs() }
        : {}),
      missingRequired: missingRequiredConfigKeys(configFields, storedKeys),
      ...(manifest ? { savedManifest: manifest as unknown as Record<string, unknown> } : {}),
      ...(provider.describeManifestTemplate
        ? { manifestTemplate: provider.describeManifestTemplate() as Record<string, unknown> }
        : {}),
    }
  }

  /**
   * Probe a candidate connection before saving (nothing is persisted). Builds the
   * backend's provider from the candidate config + a resolver over the supplied
   * (unsaved) secrets and delegates to the provider's `testConnection`.
   */
  async testConnection(
    workspaceId: string,
    input: TestEnvironmentConnectionInput,
  ): Promise<ConnectionTestResult> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    if (!input.config) return { ok: true, message: 'Nothing to test.' }
    const backend = this.requireBackend(input.config.kind)
    backend.assertConfigSafe(input.config, {
      ...(this.deps.urlPolicy ? { urlPolicy: this.deps.urlPolicy } : {}),
      ...(this.deps.customTlsSupported !== undefined
        ? { customTlsSupported: this.deps.customTlsSupported }
        : {}),
    })
    const provider = this.buildProvider(backend)
    if (!provider.testConnection) {
      return { ok: true, message: 'This provider has no connection test.' }
    }
    const manifest = backend.toManifest(input.config)
    const secrets = input.secrets ?? {}
    return provider.testConnection({
      manifest,
      config: {},
      resolveSecret: (key) => secrets[key],
    })
  }

  /**
   * Probe a candidate per-type infra HANDLER connection before saving (nothing persisted).
   * Lowers the engine-discriminated handler config to the backend config — with a placeholder
   * manifest source, since a connectivity probe reads only the apiserver/token, never the
   * (service-owned) source — and delegates to {@link testConnection}. So the per-type engine
   * form (e.g. a `local-k3s` / `remote-kubernetes` Kubernetes engine) can verify the apiserver
   * is reachable and the token authenticates before the operator commits the handler.
   */
  async testHandler(
    workspaceId: string,
    input: TestEnvironmentHandlerInput,
  ): Promise<ConnectionTestResult> {
    const backend = resolveHandlerBackend(
      this.deps.environmentBackendRegistry,
      input.config.engine,
      input.backendKind,
    )
    const backendConfig = handlerConfigToBackendConfig(input.config, backend.kind)
    // Fall back to the SAVED handler's stored secrets so an operator can (re)test an existing
    // connection — or edit a non-secret field and test it — WITHOUT re-entering the write-only
    // token the edit form never surfaces. A freshly-typed secret still overrides the stored one;
    // a blank/omitted value preserves it (see overlaySecrets).
    const provisionType = engineToProvisionType(input.config.engine)
    const manifestId =
      input.config.engine === 'remote-custom' ? input.config.acceptsManifestId : null
    const stored = await this.storedSecretsFor(workspaceId, provisionType, manifestId)
    const secrets = overlaySecrets(stored, input.secrets)
    return this.testConnection(workspaceId, { config: backendConfig, secrets })
  }

  /**
   * Validate a target repo against the provider's expectations on demand (nothing
   * persisted). Provider-absent ⇒ ok; no VCS resolver / no repo match ⇒ a single error
   * issue; else delegate to the provider with a VCS-neutral reader.
   */
  async validateRepo(
    workspaceId: string,
    input: ValidateEnvironmentRepoInput,
  ): Promise<RepoValidationResult> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    const provider = await this.providerForWorkspace(workspaceId)
    if (!provider.validateRepo) return { ok: true, issues: [] }
    const bound = await this.resolveRepo(workspaceId, input.owner, input.repo, input.provider)
    if (!bound) {
      return {
        ok: false,
        issues: [
          {
            severity: 'error',
            message: 'No VCS connection is configured for this workspace; cannot read the repo.',
          },
        ],
      }
    }
    const manifest = await this.optionalManifest(workspaceId)
    const resolveSecret = await this.resolveSecrets(workspaceId)
    const gitRef = input.gitRef ?? bound.baseBranch
    return this.runProviderValidate(
      provider,
      bound,
      gitRef,
      input.owner,
      input.repo,
      stringifyProviderConfig(manifest?.providerConfig),
      resolveSecret,
    )
  }

  /**
   * Auto-detect a NON-BINDING recommended provisioning config for a service's repo, read
   * checkout-free over the workspace-bound {@link RepoFiles} (no provider/connection needed —
   * detection is pure repo introspection). Nothing is persisted; the SPA prefills the confirm
   * form from the recommendation. No VCS resolver / no repo match ⇒ an `infraless` result with
   * an explanatory note rather than an error.
   */
  async detectServiceProvisioning(
    workspaceId: string,
    input: DetectServiceProvisioningInput,
  ): Promise<ProvisioningRecommendation> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    const bound = await this.resolveRepo(workspaceId, input.owner, input.repo, input.provider)
    if (!bound) {
      return {
        detected: false,
        provisioning: { type: 'infraless' },
        notes: [
          {
            field: 'provisionType',
            confidence: 'low',
            message:
              'No VCS connection is configured for this workspace; cannot read the repo to detect provisioning.',
          },
        ],
      }
    }
    // `custom`: detect the in-repo manifest PATH from the selected type's default (monorepo-aware),
    // rather than the kubernetes/compose heuristic. Requires a selected `manifestId` to look up
    // the default; without one there's nothing type-specific to detect.
    if (input.prefer === 'custom' && input.manifestId) {
      const type = (await this.listCustomTypes(workspaceId)).find(
        (t) => t.manifestId === input.manifestId,
      )
      return detectCustomManifest(bound.repo, {
        gitRef: input.gitRef ?? bound.baseBranch,
        ...(input.directory ? { directory: input.directory } : {}),
        manifestId: input.manifestId,
        ...(type?.defaultManifestPath ? { defaultPath: type.defaultManifestPath } : {}),
        ...(input.currentManifestPath ? { currentPath: input.currentManifestPath } : {}),
      })
    }
    return detectKubernetesProvisioning(bound.repo, {
      gitRef: input.gitRef ?? bound.baseBranch,
      ...(input.directory ? { directory: input.directory } : {}),
      ...(input.prefer ? { prefer: input.prefer } : {}),
    })
  }

  /**
   * Auto-detect a NON-BINDING recommended FRONTEND config for a repo, read checkout-free over the
   * workspace-bound {@link RepoFiles} (pure repo introspection — no provider/connection needed).
   * Nothing is persisted; the SPA prefills a preview the user applies. No VCS resolver / no repo
   * match ⇒ a `detected: false` result with an explanatory note rather than an error (symmetric
   * with {@link detectServiceProvisioning}).
   */
  async detectFrontendConfig(
    workspaceId: string,
    input: DetectFrontendConfigInput,
  ): Promise<FrontendConfigRecommendation> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    const bound = await this.resolveRepo(workspaceId, input.owner, input.repo, input.provider)
    if (!bound) {
      return {
        detected: false,
        config: { backendBindings: [] },
        notes: [
          {
            field: 'packageManager',
            confidence: 'low',
            message:
              'No VCS connection is configured for this workspace; cannot read the repo to detect the frontend config.',
          },
        ],
      }
    }
    return detectFrontendConfig(bound.repo, {
      gitRef: input.gitRef ?? bound.baseBranch,
      ...(input.directory ? { directory: input.directory } : {}),
    })
  }

  /**
   * Mechanically bootstrap the provider's config file into a target repo from the
   * collected `inputs`, commit it (or open a PR), then re-validate — falling back to the
   * repair agent when mechanical generation can't produce a valid config and the caller
   * opted in. Nothing about secrets is persisted.
   */
  async bootstrapRepo(
    workspaceId: string,
    input: BootstrapEnvironmentRepoInput,
  ): Promise<BootstrapRepoResult> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    const provider = await this.providerForWorkspace(workspaceId)
    const fail = (issues: RepoValidationIssue[]): BootstrapRepoResult => ({
      ok: false,
      committed: false,
      issues,
    })
    if (!provider.bootstrapProviderConfiguration) {
      return fail([
        { severity: 'error', message: 'This provider does not support config bootstrap.' },
      ])
    }
    const bound = await this.resolveRepo(workspaceId, input.owner, input.repo, input.provider)
    if (!bound) {
      return fail([
        {
          severity: 'error',
          message:
            'No VCS connection is configured for this workspace; cannot read or write the repo.',
        },
      ])
    }
    const manifest = await this.optionalManifest(workspaceId)
    const resolveSecret = await this.resolveSecrets(workspaceId)
    const config = stringifyProviderConfig(manifest?.providerConfig)
    const targetBranch = input.gitRef ?? bound.baseBranch
    const readRepoFile = (path: string, ref?: string) =>
      bound.repo.getFile(path, ref ?? targetBranch)

    const generated = await provider.bootstrapProviderConfiguration({
      inputs: input.inputs,
      readRepoFile,
      defaultGitRef: targetBranch,
      repoOwner: input.owner,
      repoName: input.repo,
      ...(config ? { config } : {}),
      resolveSecret,
    })

    let committed = false
    let writeBranch = targetBranch
    if (!generated.needsAgent && generated.files.length) {
      const prMode = !!input.openPr
      let prBranchHead: string | null = null
      if (prMode) {
        writeBranch = BOOTSTRAP_CONFIG_BRANCH
        prBranchHead = await bound.repo.headSha(writeBranch)
      }
      const compareBranch = prMode && prBranchHead ? writeBranch : targetBranch

      const changed: { path: string; content: string }[] = []
      for (const file of generated.files) {
        const existing = await readRepoFile(file.path, compareBranch)
        if (!existing || existing.content !== file.content) changed.push(file)
      }
      if (changed.length) {
        const message = generated.commitMessage ?? 'chore: bootstrap environment provider config'
        if (prMode) {
          if (!prBranchHead) {
            const base = await bound.repo.headSha(targetBranch)
            if (base) await bound.repo.createBranch(writeBranch, base)
          }
          await bound.repo.commitFiles({ branch: writeBranch, message, files: changed })
          if (!prBranchHead) {
            await bound.repo.openPullRequest({
              title: message,
              head: writeBranch,
              base: targetBranch,
              body: 'Automated provider configuration bootstrap.',
            })
          }
        } else {
          await bound.repo.commitFiles({ branch: writeBranch, message, files: changed })
        }
        committed = true
      }
    }

    let validation = await this.runProviderValidate(
      provider,
      bound,
      writeBranch,
      input.owner,
      input.repo,
      config,
      resolveSecret,
    )

    let usedAgent = false
    let repairJobId: string | undefined
    if (
      !validation.ok &&
      input.allowAgentFallback &&
      provider.describeRepairAgent &&
      this.deps.dispatchConfigRepair
    ) {
      usedAgent = true
      if (input.openPr && writeBranch === targetBranch) {
        const prBranchHead = await bound.repo.headSha(BOOTSTRAP_CONFIG_BRANCH)
        if (!prBranchHead) {
          const base = await bound.repo.headSha(targetBranch)
          if (base) {
            await bound.repo.createBranch(BOOTSTRAP_CONFIG_BRANCH, base)
            await bound.repo.openPullRequest({
              title: 'chore: repair environment provider config',
              head: BOOTSTRAP_CONFIG_BRANCH,
              base: targetBranch,
              body: 'Automated provider configuration repair.',
            })
          }
        }
        writeBranch = BOOTSTRAP_CONFIG_BRANCH
      }
      const started = await this.deps.dispatchConfigRepair({
        workspaceId,
        owner: input.owner,
        repo: input.repo,
        gitRef: writeBranch,
        issues: validation.issues,
        inputs: input.inputs,
      })
      repairJobId = started.jobId
    }

    await this.deps.provisioningLog?.record({
      workspaceId,
      subsystem: 'environment',
      operation: 'provision',
      targetId: null,
      providerId: manifest?.providerId ?? null,
      blockId: null,
      executionId: null,
      outcome: validation.ok ? 'success' : 'failure',
      error: validation.ok
        ? null
        : usedAgent
          ? 'Provider config needs agent repair; a repair run was dispatched'
          : 'Provider config bootstrap did not produce a valid config',
      detail: JSON.stringify({ committed, usedAgent, branch: writeBranch, repairJobId }),
    })

    const generatedIssues = generated.issues ?? []
    return {
      ok: usedAgent ? false : validation.ok,
      committed,
      branch: writeBranch,
      ...(usedAgent ? { usedAgent: true, ...(repairJobId ? { repairJobId } : {}) } : {}),
      issues: [...generatedIssues, ...validation.issues],
    }
  }

  /**
   * Generate (when absent) or fix (when present but invalid) a service's CUSTOM manifest file by
   * dispatching the fixer coding agent with the selected custom-manifest-type's `fixerPrompt`.
   * The run is a durable, asynchronous `env-config-repair` run (returns immediately with
   * `usedAgent`/`repairJobId`), tracked exactly like {@link bootstrapRepo}'s agent fallback.
   *
   * Validation policy (lean toward diligence): if a `remote-custom` provider with `validateRepo`
   * is connected we run it to enrich the prompt with concrete issues, but the agent is dispatched
   * regardless — an undefined/ok validation still gets a double-check pass.
   */
  async repairCustomManifest(
    workspaceId: string,
    input: RepairCustomManifestInput,
  ): Promise<BootstrapRepoResult> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    const fail = (issues: RepoValidationIssue[]): BootstrapRepoResult => ({
      ok: false,
      committed: false,
      issues,
    })

    const type = (await this.listCustomTypes(workspaceId)).find(
      (t) => t.manifestId === input.manifestId,
    )
    if (!type?.fixerPrompt) {
      return fail([
        {
          severity: 'error',
          message: `The custom manifest type "${input.manifestId}" defines no fixer prompt, so it can't generate or fix its manifest automatically.`,
        },
      ])
    }
    if (!this.deps.dispatchConfigRepair) {
      return fail([
        { severity: 'error', message: 'Automated manifest generation is not available.' },
      ])
    }

    const bound = await this.resolveRepo(workspaceId, input.owner, input.repo, input.provider)
    if (!bound) {
      return fail([
        {
          severity: 'error',
          message:
            'No VCS connection is configured for this workspace; cannot read or write the repo.',
        },
      ])
    }
    const targetBranch = input.gitRef ?? bound.baseBranch
    const manifestPath = input.manifestPath.trim()

    // Existence drives the generate-vs-fix framing of the prompt.
    const existing = await bound.repo.getFile(manifestPath, targetBranch)
    const exists = existing !== null

    // Best-effort provider validation to enrich the prompt (skipped when no provider/connection).
    let issues: RepoValidationIssue[] = []
    if (exists) {
      try {
        const provider = await this.providerForWorkspace(workspaceId)
        const manifest = await this.optionalManifest(workspaceId)
        const resolveSecret = await this.resolveSecrets(workspaceId)
        const validation = await this.runProviderValidate(
          provider,
          bound,
          targetBranch,
          input.owner,
          input.repo,
          stringifyProviderConfig(manifest?.providerConfig),
          resolveSecret,
        )
        issues = validation.issues
      } catch {
        // No connected provider (or it can't validate) — the agent still double-checks the file.
      }
    }

    const promptOverride = buildCustomManifestRepairPrompt({
      basePrompt: type.fixerPrompt,
      label: type.label,
      manifestPath,
      exists,
      issues,
    })

    const started = await this.deps.dispatchConfigRepair({
      workspaceId,
      owner: input.owner,
      repo: input.repo,
      gitRef: targetBranch,
      issues,
      promptOverride,
      manifestPath,
    })

    await this.deps.provisioningLog?.record({
      workspaceId,
      subsystem: 'environment',
      operation: 'provision',
      targetId: null,
      providerId: input.manifestId,
      blockId: null,
      executionId: null,
      outcome: 'success',
      error: null,
      detail: JSON.stringify({ manifestPath, exists, repairJobId: started.jobId }),
    })

    return {
      ok: false,
      committed: false,
      usedAgent: true,
      branch: targetBranch,
      repairJobId: started.jobId,
      issues,
    }
  }

  /**
   * Re-validate a repo's provider config after the async repair agent pushed its fix.
   * The callback {@link EnvConfigRepairService.pollJob} invokes on a successful repair.
   */
  async revalidate(input: {
    workspaceId: string
    owner: string
    repo: string
    gitRef: string
  }): Promise<RepoValidationResult> {
    const { workspaceId, owner, repo, gitRef } = input
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    const provider = await this.providerForWorkspace(workspaceId)
    const bound = await this.resolveRepo(workspaceId, owner, repo)
    if (!bound) {
      return {
        ok: false,
        issues: [
          {
            severity: 'error',
            message:
              'No VCS connection is configured for this workspace; cannot re-validate the repo.',
          },
        ],
      }
    }
    const manifest = await this.optionalManifest(workspaceId)
    const resolveSecret = await this.resolveSecrets(workspaceId)
    const config = stringifyProviderConfig(manifest?.providerConfig)
    return this.runProviderValidate(provider, bound, gitRef, owner, repo, config, resolveSecret)
  }

  /**
   * The live provider + stored manifest for a workspace, for the provisioning/teardown
   * services. Throws when the workspace has no registered connection.
   */
  async resolveProvider(
    workspaceId: string,
  ): Promise<{ provider: EnvironmentProvider; manifest: EnvironmentManifest }> {
    const record = await this.requirePrimary(workspaceId)
    const { provider, manifest } = this.buildFromRecord(record)
    return { provider: this.deps.environmentProvider ?? provider, manifest }
  }

  /** Resolve a VCS-neutral bound RepoFiles for the workspace+coords, or null. */
  private async resolveRepo(
    workspaceId: string,
    owner: string,
    repo: string,
    provider?: 'github' | 'gitlab',
  ): Promise<RunRepoContext | null> {
    return (
      (await this.deps.resolveRepoFilesForWorkspace?.(workspaceId, {
        owner,
        repo,
        ...(provider ? { provider } : {}),
      })) ?? null
    )
  }

  /** Run the given provider's `validateRepo` with a VCS-neutral reader bound to `gitRef`. */
  private async runProviderValidate(
    provider: EnvironmentProvider,
    bound: RunRepoContext,
    gitRef: string,
    owner: string,
    repo: string,
    config: Record<string, string> | undefined,
    resolveSecret: (key: string) => string | undefined,
  ): Promise<RepoValidationResult> {
    if (!provider.validateRepo) return { ok: true, issues: [] }
    return provider.validateRepo({
      readRepoFile: (path, ref) => bound.repo.getFile(path, ref ?? gitRef),
      defaultGitRef: gitRef,
      repoOwner: owner,
      repoName: repo,
      ...(config ? { config } : {}),
      resolveSecret,
    })
  }

  /** The workspace's primary connection (safe metadata), or null. */
  async getConnection(workspaceId: string): Promise<EnvironmentConnection | null> {
    const record = await this.primaryRecord(workspaceId)
    if (!record) return null
    const keys = Object.keys(await this.decryptSecrets(record))
    return this.toConnection(record, keys)
  }

  /**
   * Whether a primary handler is registered for the workspace — a presence probe that does NOT
   * decrypt the secret bundle (unlike {@link getConnection}). Used by the infra-setup snapshot
   * projection, which only needs the yes/no and runs on the hot board-load path.
   */
  async hasConnection(workspaceId: string): Promise<boolean> {
    return (await this.primaryRecord(workspaceId)) !== null
  }

  /**
   * Resolve the parsed manifest of the workspace's primary handler, else undefined — the
   * non-throwing sibling of {@link requireConnection}.
   */
  async optionalManifest(workspaceId: string): Promise<EnvironmentManifest | undefined> {
    const record = await this.primaryRecord(workspaceId)
    if (!record) return undefined
    return this.buildFromRecord(record).manifest
  }

  /** Resolve the primary handler + parsed manifest, or throw if none is registered. */
  async requireConnection(workspaceId: string): Promise<ResolvedConnection> {
    const record = await this.requirePrimary(workspaceId)
    return { record, manifest: this.buildFromRecord(record).manifest }
  }

  /** Build a secret resolver from the workspace's primary handler secret bundle. */
  async resolveSecrets(workspaceId: string): Promise<SecretResolver> {
    const record = await this.primaryRecord(workspaceId)
    if (!record) return () => undefined
    return this.buildResolveSecret(record)
  }

  /** Unregister the primary handler (tombstones it). */
  async unregister(workspaceId: string): Promise<void> {
    const record = await this.primaryRecord(workspaceId)
    if (!record) return
    await this.deps.environmentConnectionRepository.softDelete(
      workspaceId,
      record.provisionType,
      record.manifestId,
      this.deps.clock.now(),
    )
  }

  // --- internals ----------------------------------------------------------

  private requireBackend(kind: string): EnvironmentBackendProvider {
    const backend = this.deps.environmentBackendRegistry.get(kind)
    if (!backend) throw new ValidationError(`Unknown environment backend kind '${kind}'`)
    return backend
  }

  private buildProvider(backend: EnvironmentBackendProvider): EnvironmentProvider {
    return backend.buildProvider(this.deps.urlPolicy ? { urlPolicy: this.deps.urlPolicy } : {})
  }

  /** The workspace's primary (first-registered) handler, or null. */
  private async primaryRecord(workspaceId: string): Promise<EnvironmentConnectionRecord | null> {
    const records = await this.deps.environmentConnectionRepository.listByWorkspace(workspaceId)
    return records[0] ?? null
  }

  /** The workspace's primary handler, or throw when none is registered. */
  private async requirePrimary(workspaceId: string): Promise<EnvironmentConnectionRecord> {
    const record = await this.primaryRecord(workspaceId)
    if (!record) {
      throw new ConflictError(`Workspace '${workspaceId}' has no environment provider registered`)
    }
    return record
  }

  /** One handler for a provision type, or throw. */
  private async requireHandler(
    workspaceId: string,
    provisionType: ProvisionType,
    manifestId: string | null,
  ): Promise<EnvironmentConnectionRecord> {
    const record = await this.deps.environmentConnectionRepository.getByWorkspaceAndType(
      workspaceId,
      provisionType,
      manifestId,
    )
    if (!record) {
      throw new ConflictError(`No handler registered for provision type '${provisionType}'`)
    }
    return record
  }

  /** The provider for the workspace's primary handler (or the manifest default when none). */
  private async providerForWorkspace(workspaceId: string): Promise<EnvironmentProvider> {
    if (this.deps.environmentProvider) return this.deps.environmentProvider
    const record = await this.primaryRecord(workspaceId)
    return record
      ? this.buildFromRecord(record).provider
      : this.buildProvider(this.requireBackend('manifest'))
  }

  /**
   * Validate + persist one handler: lower its `InfraHandlerConfig` to the backend config,
   * SSRF/secret-check it, and upsert keyed by (workspace, provisionType, manifestId).
   */
  private async storeHandler(
    workspaceId: string,
    input: RegisterHandlerInput,
  ): Promise<EnvironmentConnectionRecord> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    // Resolve the existing row up-front so an EDIT can PRESERVE write-only secrets the operator
    // didn't re-enter: a blank/omitted secret keeps the stored value, so changing a non-secret
    // field (or re-saving) never wipes the token. A supplied non-empty value replaces it. A first
    // registration has no stored bundle, so every referenced key must be supplied — enforced by
    // buildInfraHandlerFields over the merged bundle below. (buildInfraHandlerFields derives the
    // persisted provisionType/manifestId straight from the input, so this lookup key matches it.)
    const existing = await this.deps.environmentConnectionRepository.getByWorkspaceAndType(
      workspaceId,
      input.provisionType,
      input.manifestId ?? null,
    )
    const secrets = existing
      ? overlaySecrets(await this.decryptSecrets(existing), input.secrets)
      : input.secrets
    const fields = buildInfraHandlerFields(
      this.deps.environmentBackendRegistry,
      { ...input, secrets },
      {
        ...(this.deps.urlPolicy ? { urlPolicy: this.deps.urlPolicy } : {}),
        ...(this.deps.customTlsSupported !== undefined
          ? { customTlsSupported: this.deps.customTlsSupported }
          : {}),
      },
    )
    const secretsCipher = await this.deps.secretCipher.encrypt(JSON.stringify(secrets))
    const record: EnvironmentConnectionRecord = {
      workspaceId,
      ...fields,
      secretsCipher,
      createdAt: existing?.createdAt ?? this.deps.clock.now(),
      deletedAt: null,
    }
    await this.deps.environmentConnectionRepository.upsert(record)
    return record
  }

  /** The decrypted secret bundle of a stored handler (or {} when none is registered). */
  private async storedSecretsFor(
    workspaceId: string,
    provisionType: ProvisionType,
    manifestId: string | null,
  ): Promise<Record<string, string>> {
    const record = await this.deps.environmentConnectionRepository.getByWorkspaceAndType(
      workspaceId,
      provisionType,
      manifestId,
    )
    return record ? this.decryptSecrets(record) : {}
  }

  /** Lower a legacy backend config into a per-type {@link InfraHandlerConfig}. */
  private toHandlerConfig(
    config: EnvironmentBackendConfig,
    engine: InfraEngine,
  ): InfraHandlerConfig {
    if (engine === 'local-k3s' || engine === 'remote-kubernetes') {
      if (!('kubernetes' in config)) throw new ValidationError('Expected a kubernetes config')
      // Keep the workspace-owned `manifestSource` inline (the per-type model puts it on the
      // service, but a legacy kube connection set it here): dropping it would silently provision
      // every kube env from the repo root. `handlerConfigToBackendConfig` reads it back.
      return { engine, kubernetes: config.kubernetes }
    }
    if (engine === 'remote-custom') {
      if (!('manifest' in config)) throw new ValidationError('Expected a manifest config')
      // `providerId` permits a leading `-`, which `manifestIdSchema` forbids; coerce it to a
      // valid manifest id so the stored handler re-validates and can match a service `manifestId`.
      return {
        engine,
        manifest: config.manifest,
        acceptsManifestId: toManifestId(config.manifest.providerId),
      }
    }
    if (engine === 'local-docker') {
      if (!('manifest' in config)) throw new ValidationError('Expected a compose config')
      return { engine, manifest: config.manifest }
    }
    throw new ValidationError(`Cannot bridge a connection onto engine '${engine}'`)
  }

  /**
   * Build the live provider + stored manifest from a handler record, merging the SERVICE's
   * provisioning inputs (a kube engine needs the manifests + render inputs from the service)
   * when given.
   */
  private buildFromRecord(
    record: EnvironmentConnectionRecord,
    service?: ServiceProvisioningInputs,
  ): {
    backend: EnvironmentBackendProvider
    provider: EnvironmentProvider
    manifest: EnvironmentManifest
    backendConfig: EnvironmentBackendConfig
  } {
    const config = JSON.parse(record.handlerJson) as InfraHandlerConfig
    const backend = this.requireBackend(record.backendKind)
    // Pass the service inputs through (or undefined): a legacy bridge row carries its own kube
    // source inline, and `handlerConfigToBackendConfig` falls back to it before the placeholder.
    const backendConfig = handlerConfigToBackendConfig(config, backend.kind, service)
    return {
      backend,
      provider: this.buildProvider(backend),
      manifest: backend.toManifest(backendConfig),
      backendConfig,
    }
  }

  private async buildResolveSecret(record: EnvironmentConnectionRecord): Promise<SecretResolver> {
    const bundle = await this.decryptSecrets(record)
    return (key: string) => bundle[key]
  }

  private async decryptSecrets(
    record: EnvironmentConnectionRecord,
  ): Promise<Record<string, string>> {
    if (!record.secretsCipher) return {}
    const parsed = JSON.parse(await this.deps.secretCipher.decrypt(record.secretsCipher))
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {}
  }

  /** The per-type handler view (safe metadata + non-secret config for prefill). */
  private toHandlerView(
    record: EnvironmentConnectionRecord,
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
      backendKind: record.backendKind,
      ...(config ? { config } : {}),
    }
  }

  /** The legacy single-connection view (safe metadata), derived from a handler record. */
  private toConnection(
    record: EnvironmentConnectionRecord,
    secretKeys: string[],
  ): EnvironmentConnection {
    let config: EnvironmentBackendConfig | undefined
    try {
      config = this.buildFromRecord(record).backendConfig
    } catch {
      config = undefined
    }
    return {
      kind: record.backendKind,
      providerId: record.providerId,
      label: record.label,
      baseUrl: record.baseUrl,
      connectedAt: record.createdAt,
      secretKeys,
      ...(config ? { config } : {}),
    }
  }
}
