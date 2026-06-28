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
import { ConflictError, STRICT_URL_SAFETY_POLICY, ValidationError } from '@cat-factory/kernel'
import { requireWorkspace } from '@cat-factory/kernel'
import type { WorkspaceRepository } from '@cat-factory/kernel'
import { assertSafeEnvironmentUrl, missingRequiredConfigKeys } from './environments.logic.js'
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

/** Stringify a manifest's opaque `providerConfig` bag for a native adapter. */
function stringifyProviderConfig(
  config: Record<string, unknown> | undefined,
): Record<string, string> | undefined {
  if (!config) return undefined
  return Object.fromEntries(Object.entries(config).map(([k, v]) => [k, String(v)]))
}

/** Deterministic head branch for the PR-mode config bootstrap (idempotent re-runs). */
const BOOTSTRAP_CONFIG_BRANCH = 'cat-factory/env-config'

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
   * Dispatch a coding agent to repair a malformed/partial provider config, returning
   * the post-repair validation. Wired by orchestration over the `env-config-repair`
   * agent kind + the provider's `describeRepairAgent`. Absent ⇒ no agent fallback.
   */
  dispatchConfigRepair?: (input: ConfigRepairDispatch) => Promise<RepoValidationResult>
  /** Best-effort provisioning-event log; absent ⇒ no logging. */
  provisioningLog?: ProvisioningLogRecorder
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
    const configFields = provider?.describeConfig?.(manifest) ?? []
    // Everything already supplied for this workspace: the stored secret-bundle keys, a
    // native adapter's manifest `providerConfig` keys (its non-secret per-workspace
    // settings), and `baseUrl` when the manifest carries one. The last mirrors the connect
    // form's write path (a field keyed `baseUrl` is persisted onto the manifest's `baseUrl`,
    // NOT into providerConfig or the secret bundle) — without it a `required` baseUrl field
    // would stay in `missingRequired` forever and the banner could never clear.
    const storedKeys: string[] = []
    if (record) {
      storedKeys.push(...Object.keys(await this.decryptSecrets(record)))
      if (manifest?.providerConfig) storedKeys.push(...Object.keys(manifest.providerConfig))
      if (manifest?.baseUrl) storedKeys.push('baseUrl')
    }
    return {
      providerId: this.deps.providerId ?? manifest?.providerId ?? 'http',
      label: this.deps.providerLabel ?? manifest?.label ?? 'Custom HTTP provider',
      kind: this.deps.providerKind ?? 'manifest',
      configFields,
      supportsTest: typeof provider?.testConnection === 'function',
      supportsRepoValidation: typeof provider?.validateRepo === 'function',
      supportsRepoBootstrap: typeof provider?.bootstrapProviderConfiguration === 'function',
      ...(provider?.describeBootstrapInputs
        ? { bootstrapInputs: provider.describeBootstrapInputs() }
        : {}),
      missingRequired: missingRequiredConfigKeys(configFields, storedKeys),
      // The current saved manifest (non-secret — only secret-ref key names, never values),
      // so the native connect form overlays edits onto the real stored manifest instead of
      // the bare scaffold, preserving previously-saved providerConfig (incl. nested values).
      ...(manifest ? { savedManifest: manifest as unknown as Record<string, unknown> } : {}),
      ...(provider?.describeManifestTemplate
        ? { manifestTemplate: provider.describeManifestTemplate() as Record<string, unknown> }
        : {}),
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
    const provider = this.deps.environmentProvider
    if (!provider?.validateRepo) return { ok: true, issues: [] }
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
    const { manifest } = await this.requireConnection(workspaceId)
    const resolveSecret = await this.resolveSecrets(workspaceId)
    const gitRef = input.gitRef ?? bound.baseBranch
    return this.runProviderValidate(
      bound,
      gitRef,
      input.owner,
      input.repo,
      stringifyProviderConfig(manifest.providerConfig),
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
    const provider = this.deps.environmentProvider
    const fail = (issues: RepoValidationIssue[]): BootstrapRepoResult => ({
      ok: false,
      committed: false,
      issues,
    })
    if (!provider?.bootstrapProviderConfiguration) {
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
    const { manifest } = await this.requireConnection(workspaceId)
    const resolveSecret = await this.resolveSecrets(workspaceId)
    const config = stringifyProviderConfig(manifest.providerConfig)
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
      // Idempotent: only write files whose content actually changes.
      const changed: { path: string; content: string }[] = []
      for (const file of generated.files) {
        const existing = await readRepoFile(file.path, targetBranch)
        if (!existing || existing.content !== file.content) changed.push(file)
      }
      if (changed.length) {
        const message = generated.commitMessage ?? 'chore: bootstrap environment provider config'
        if (input.openPr) {
          writeBranch = BOOTSTRAP_CONFIG_BRANCH
          const head = await bound.repo.headSha(writeBranch)
          if (!head) {
            const base = await bound.repo.headSha(targetBranch)
            if (base) await bound.repo.createBranch(writeBranch, base)
          }
          await bound.repo.commitFiles({ branch: writeBranch, message, files: changed })
          await bound.repo.openPullRequest({
            title: message,
            head: writeBranch,
            base: targetBranch,
            body: 'Automated provider configuration bootstrap.',
          })
        } else {
          await bound.repo.commitFiles({ branch: writeBranch, message, files: changed })
        }
        committed = true
      }
    }

    let validation = await this.runProviderValidate(
      bound,
      writeBranch,
      input.owner,
      input.repo,
      config,
      resolveSecret,
    )

    let usedAgent = false
    if (
      !validation.ok &&
      input.allowAgentFallback &&
      provider.describeRepairAgent &&
      this.deps.dispatchConfigRepair
    ) {
      usedAgent = true
      validation = await this.deps.dispatchConfigRepair({
        workspaceId,
        owner: input.owner,
        repo: input.repo,
        gitRef: writeBranch,
        issues: validation.issues,
        inputs: input.inputs,
      })
    }

    await this.deps.provisioningLog?.record({
      workspaceId,
      subsystem: 'environment',
      operation: 'provision',
      targetId: null,
      providerId: manifest.providerId,
      blockId: null,
      executionId: null,
      outcome: validation.ok ? 'success' : 'failure',
      error: validation.ok ? null : 'Provider config bootstrap did not produce a valid config',
      detail: JSON.stringify({ committed, usedAgent, branch: writeBranch }),
    })

    return {
      ok: validation.ok,
      committed,
      branch: writeBranch,
      ...(usedAgent ? { usedAgent } : {}),
      issues: validation.issues,
    }
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

  /** Run the provider's `validateRepo` with a VCS-neutral reader bound to `gitRef`. */
  private async runProviderValidate(
    bound: RunRepoContext,
    gitRef: string,
    owner: string,
    repo: string,
    config: Record<string, string> | undefined,
    resolveSecret: (key: string) => string | undefined,
  ): Promise<RepoValidationResult> {
    const provider = this.deps.environmentProvider
    if (!provider?.validateRepo) return { ok: true, issues: [] }
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
