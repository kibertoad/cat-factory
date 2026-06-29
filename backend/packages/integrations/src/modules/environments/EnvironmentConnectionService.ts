import type { Clock } from '@cat-factory/kernel'
import type {
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
  ProviderDescriptor,
  RepoValidationIssue,
  RepoValidationResult,
  RunRepoContext,
  TestEnvironmentConnectionInput,
  ValidateEnvironmentRepoInput,
} from '@cat-factory/kernel'
import { ConflictError, ValidationError } from '@cat-factory/kernel'
import { requireWorkspace } from '@cat-factory/kernel'
import type { WorkspaceRepository } from '@cat-factory/kernel'
import { environmentBackend, type EnvironmentBackendProvider } from './environment-backends.js'
import { missingRequiredConfigKeys, stringifyProviderConfig } from './environments.logic.js'
import type { ProvisioningLogRecorder } from '../provisioning-logs/ProvisioningLogService.js'

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
}

/** Deterministic head branch for the PR-mode config bootstrap (idempotent re-runs). */
const BOOTSTRAP_CONFIG_BRANCH = 'cat-factory/env-config'

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
   * NOT a public seam — a native backend registers via `registerEnvironmentBackend`. It
   * exists only for the cross-runtime conformance suite (fake validate-repo / repair
   * providers injected through the schema-locked connect API). Absent ⇒ the registry path.
   */
  environmentProvider?: EnvironmentProvider
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
    input: { config: EnvironmentBackendConfig; secrets: Record<string, string> },
  ): Promise<EnvironmentConnection> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    const backend = this.requireBackend(input.config.kind)
    backend.assertConfigSafe(input.config, {
      ...(this.deps.urlPolicy ? { urlPolicy: this.deps.urlPolicy } : {}),
      ...(this.deps.customTlsSupported !== undefined
        ? { customTlsSupported: this.deps.customTlsSupported }
        : {}),
    })

    // Every secret the chosen backend references must be supplied.
    const missing = backend
      .referencedSecretKeys(input.config)
      .filter((key) => !(key in input.secrets))
    if (missing.length) {
      throw new ValidationError(`Missing secret values for: ${missing.join(', ')}`)
    }

    const meta = backend.connectionMeta(input.config)
    const manifest = backend.toManifest(input.config)
    const existing = await this.deps.environmentConnectionRepository.getByWorkspace(workspaceId)
    const secretsCipher = await this.deps.secretCipher.encrypt(JSON.stringify(input.secrets))
    const record: EnvironmentConnectionRecord = {
      workspaceId,
      kind: input.config.kind,
      providerId: meta.providerId,
      label: meta.label,
      baseUrl: meta.baseUrl,
      manifestJson: JSON.stringify(manifest),
      secretsCipher,
      createdAt: existing?.createdAt ?? this.deps.clock.now(),
      deletedAt: null,
    }
    await this.deps.environmentConnectionRepository.upsert(record)
    return this.toConnection(record, Object.keys(input.secrets))
  }

  /** Rotate/replace the secret bundle without re-sending the config. */
  async updateSecrets(
    workspaceId: string,
    secrets: Record<string, string>,
  ): Promise<EnvironmentConnection> {
    const { record, manifest } = await this.requireConnection(workspaceId)
    const backend = this.requireBackend(record.kind)
    const config = backend.fromManifest(manifest)
    const missing = backend.referencedSecretKeys(config).filter((key) => !(key in secrets))
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
    const record = await this.deps.environmentConnectionRepository.getByWorkspace(workspaceId)
    const resolvedKind = kind ?? record?.kind ?? 'manifest'
    const backend = this.requireBackend(resolvedKind)
    const provider = this.deps.environmentProvider ?? this.buildProvider(backend)
    const overridden = !!this.deps.environmentProvider
    // Fold in the stored manifest/secrets only when describing the kind that is actually
    // connected; describing a different (e.g. not-yet-connected custom) kind starts blank.
    const useStored = !!record && resolvedKind === record.kind
    const manifest = useStored
      ? (JSON.parse(record!.manifestJson) as EnvironmentManifest)
      : undefined
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
    const { record, manifest } = await this.requireConnection(workspaceId)
    const provider =
      this.deps.environmentProvider ?? this.buildProvider(this.requireBackend(record.kind))
    return { provider, manifest }
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

  /** The workspace's current connection (safe metadata), or null. */
  async getConnection(workspaceId: string): Promise<EnvironmentConnection | null> {
    const record = await this.deps.environmentConnectionRepository.getByWorkspace(workspaceId)
    if (!record) return null
    const keys = Object.keys(await this.decryptSecrets(record))
    return this.toConnection(record, keys)
  }

  /**
   * Resolve the parsed manifest if the workspace has a registered connection, else
   * undefined — the non-throwing sibling of {@link requireConnection}.
   */
  async optionalManifest(workspaceId: string): Promise<EnvironmentManifest | undefined> {
    const record = await this.deps.environmentConnectionRepository.getByWorkspace(workspaceId)
    if (!record) return undefined
    return JSON.parse(record.manifestJson) as EnvironmentManifest
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

  // --- internals ----------------------------------------------------------

  private requireBackend(kind: string): EnvironmentBackendProvider {
    const backend = environmentBackend(kind)
    if (!backend) throw new ValidationError(`Unknown environment backend kind '${kind}'`)
    return backend
  }

  private buildProvider(backend: EnvironmentBackendProvider): EnvironmentProvider {
    return backend.buildProvider(this.deps.urlPolicy ? { urlPolicy: this.deps.urlPolicy } : {})
  }

  /** The provider for the workspace's stored kind (or the manifest default when none). */
  private async providerForWorkspace(workspaceId: string): Promise<EnvironmentProvider> {
    if (this.deps.environmentProvider) return this.deps.environmentProvider
    const record = await this.deps.environmentConnectionRepository.getByWorkspace(workspaceId)
    return this.buildProvider(this.requireBackend(record?.kind ?? 'manifest'))
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
    let config: EnvironmentBackendConfig | undefined
    try {
      const backend = this.requireBackend(record.kind)
      config = backend.fromManifest(JSON.parse(record.manifestJson) as EnvironmentManifest)
    } catch {
      config = undefined
    }
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
}
