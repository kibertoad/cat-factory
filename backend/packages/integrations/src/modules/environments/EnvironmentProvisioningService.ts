import type { Clock, IdGenerator } from '@cat-factory/kernel'
import type { EnvironmentRecord, EnvironmentRegistryRepository } from '@cat-factory/kernel'
import type {
  EnvironmentManifest,
  EnvironmentProvider,
  ProvisionContext,
  ProvisionedEnvironment,
  ResolveRunRepoContext,
  RunRepoContext,
  SecretResolver,
  ServiceProvisioning,
  UrlSafetyPolicy,
} from '@cat-factory/kernel'
import type { SecretCipher } from '@cat-factory/kernel'
import type { EnvironmentAccessHandle, EnvironmentHandle } from '@cat-factory/kernel'
import { assertFound, STRICT_URL_SAFETY_POLICY, ValidationError } from '@cat-factory/kernel'
import type { EnvironmentConnectionService } from './EnvironmentConnectionService.js'
import {
  assertSafeEnvironmentUrl,
  recordToHandle,
  stringifyProviderConfig,
} from './environments.logic.js'
import type { ProvisioningLogRecorder } from '../provisioning-logs/ProvisioningLogService.js'

// EnvironmentProvisioningService: orchestrates provisioning an environment from a
// workspace's registered provider. Deterministic and side-effecting via the
// EnvironmentProvider port — never an LLM. The provisioned env's access creds and
// the fields needed for later status/teardown are encrypted before they touch D1.

export interface EnvironmentProvisioningServiceDependencies {
  connectionService: EnvironmentConnectionService
  environmentRegistryRepository: EnvironmentRegistryRepository
  secretCipher: SecretCipher
  idGenerator: IdGenerator
  clock: Clock
  /** URL/host safety policy applied to the URL a provider returns. Defaults to strict. */
  urlPolicy?: UrlSafetyPolicy
  /** Best-effort provisioning-event log; absent ⇒ provisioning is unchanged. */
  provisioningLog?: ProvisioningLogRecorder
  /**
   * Resolve the VCS-neutral, run-repo-bound RepoFiles for a block, so provisioning can
   * pre-flight `provider.validateRepo` BEFORE calling the provider — failing fast with a
   * clear error instead of an async failed environment — and so a native adapter (the
   * Kubernetes backend) can read CO-LOCATED manifests from the block's repo. Absent (or a
   * block-less manual provision) ⇒ no run repo.
   */
  resolveRunRepoContext?: ResolveRunRepoContext
  /**
   * Resolve a checkout-free RepoFiles bound to an ARBITRARY repo — so a native adapter (the
   * Kubernetes backend) can read manifests from a SEPARATE repo. Absent ⇒ separate-repo
   * sources report "no VCS connection".
   */
  resolveRepoFilesForWorkspace?: (
    workspaceId: string,
    coords: { owner: string; repo: string; provider?: 'github' | 'gitlab' },
  ) => Promise<RunRepoContext | null>
}

export interface ProvisionArgs {
  workspaceId: string
  blockId?: string | null
  executionId?: string | null
  inputs?: Record<string, string>
  /** Typed git/PR/repo context; passed to the provider and flattened into `inputs`. */
  context?: ProvisionContext
  /**
   * The service's declared provisioning (the "what + where"). When given, the provider is
   * resolved by matching its type to a workspace handler and merging the service's
   * `manifestSource` — the per-provision-type path. Absent ⇒ the legacy single-connection
   * resolution. `infraless` is rejected here (callers short-circuit it).
   */
  serviceProvisioning?: ServiceProvisioning
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
    let manifest: EnvironmentManifest
    let provider: EnvironmentProvider
    let resolveSecret: SecretResolver
    if (args.serviceProvisioning) {
      if (args.serviceProvisioning.type === 'infraless') {
        throw new ValidationError('An infraless service provisions no environment')
      }
      const resolved = await this.deps.connectionService.resolveProviderForType(
        workspaceId,
        args.serviceProvisioning,
      )
      manifest = resolved.manifest
      provider = resolved.provider
      resolveSecret = resolved.resolveSecret
    } else {
      const resolved = await this.deps.connectionService.resolveProvider(workspaceId)
      manifest = resolved.manifest
      provider = resolved.provider
      resolveSecret = await this.deps.connectionService.resolveSecrets(workspaceId)
    }

    // Pre-flight gate: if the provider declares repo-config expectations (e.g. Kargo's
    // `.kargo.yml`), verify them against the block's repo BEFORE provisioning, so a
    // missing/malformed config fails synchronously here instead of as an async failed
    // environment. Skipped for a block-less manual provision or an unconfigured workspace.
    await this.preflightValidateRepo(provider, args, manifest, resolveSecret)

    // Expose the block id as `{{input.blockId}}` even on a manual provision, so a
    // manifest can template against it without the caller having to repeat it. The
    // typed git/PR/repo context is flattened into the same namespace for the manifest
    // path. Explicit inputs win over the derived block id + context.
    const inputs: Record<string, string> = {}
    if (args.blockId) inputs.blockId = args.blockId
    Object.assign(inputs, contextInputs(args.context))
    Object.assign(inputs, args.inputs)
    // A native adapter (the Kubernetes backend) reads manifests from the run repo
    // (co-located) or a separate repo; resolve both seams when available.
    const runRepo =
      args.blockId && this.deps.resolveRunRepoContext
        ? await this.deps.resolveRunRepoContext(workspaceId, args.blockId)
        : null
    let provisioned: ProvisionedEnvironment
    try {
      provisioned = await provider.provision({
        manifest,
        inputs,
        ...(args.context ? { provisionContext: args.context } : {}),
        resolveSecret,
        ...(runRepo ? { runRepo } : {}),
        ...(this.deps.resolveRepoFilesForWorkspace
          ? {
              resolveRepoFiles: (coords) =>
                this.deps.resolveRepoFilesForWorkspace!(workspaceId, {
                  owner: coords.owner,
                  repo: coords.repo,
                  ...(coords.provider ? { provider: coords.provider } : {}),
                }),
            }
          : {}),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
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
        error: message,
        detail: null,
      })
      // Persist a `failed` record carrying the REAL provider error so the deployer step's
      // details can project it (`step.environment.lastError`), even though the provider
      // threw before returning anything. Best-effort — symmetric with the returned-`failed`
      // branch below, which already leaves a record behind.
      await this.persistFailedEnvironment(workspaceId, args, manifest, message)
      throw error
    }
    if (provisioned.url) {
      assertSafeEnvironmentUrl(provisioned.url, 'environment URL', this.urlPolicy)
    }

    // A block holds at most one live environment: supersede any prior one.
    await this.supersedePriorEnvironment(workspaceId, args.blockId ?? null)

    const now = this.deps.clock.now()
    const record = this.buildEnvironmentRecord({
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
      // A provider that reports `status:'failed'` without throwing still carries its real
      // reason on `provisioned.error` — surface that verbatim (not a generic literal) so the
      // deployer step's Environment panel shows the actual root cause; fall back only when the
      // provider gave none.
      lastError:
        provisioned.status === 'failed' ? provisioned.error?.trim() || 'Provisioning failed' : null,
      // Recorded by the deployer step once per-service provision types land (slice 3).
      provisionType: null,
      engine: null,
    })
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

  /**
   * Run the provider's repo-config validation as a provision pre-flight. Throws a
   * {@link ValidationError} (and logs a failure) when the repo does not satisfy the
   * provider. No-op when the provider has no `validateRepo`, no run-repo resolver is
   * wired, the provision is block-less, or the repo can't be resolved (unconfigured).
   */
  private async preflightValidateRepo(
    provider: EnvironmentProvider,
    args: ProvisionArgs,
    manifest: EnvironmentManifest,
    resolveSecret: SecretResolver,
  ): Promise<void> {
    if (!provider.validateRepo || !this.deps.resolveRunRepoContext || !args.blockId) return
    const bound = await this.deps.resolveRunRepoContext(args.workspaceId, args.blockId)
    if (!bound) return
    const gitRef = args.context?.branch ?? bound.baseBranch
    const config = stringifyProviderConfig(manifest.providerConfig)
    const result = await provider.validateRepo({
      readRepoFile: (path, ref) => bound.repo.getFile(path, ref ?? gitRef),
      defaultGitRef: gitRef,
      ...(args.context?.repoOwner ? { repoOwner: args.context.repoOwner } : {}),
      ...(args.context?.repoName ? { repoName: args.context.repoName } : {}),
      ...(config ? { config } : {}),
      resolveSecret,
    })
    if (result.ok) return
    const summary =
      result.issues
        .filter((i) => i.severity === 'error')
        .map((i) => (i.path ? `${i.path}: ` : '') + i.message)
        .join('; ') || 'repo does not satisfy the provider configuration'
    await this.deps.provisioningLog?.record({
      workspaceId: args.workspaceId,
      subsystem: 'environment',
      operation: 'provision',
      targetId: null,
      providerId: manifest.providerId,
      blockId: args.blockId ?? null,
      executionId: args.executionId ?? null,
      outcome: 'failure',
      error: `Repo validation failed: ${summary}`,
      detail: null,
    })
    throw new ValidationError(`Repo validation failed: ${summary}`)
  }

  /** Re-poll the provider for an environment's status and persist any change. */
  async refreshStatus(workspaceId: string, id: string): Promise<EnvironmentHandle> {
    const record = assertFound(
      await this.deps.environmentRegistryRepository.get(workspaceId, id),
      'Environment',
      id,
    )
    const { manifest, provider } = await this.deps.connectionService.resolveProvider(workspaceId)
    const resolveSecret = await this.deps.connectionService.resolveSecrets(workspaceId)
    const provisionFields = await this.decryptFields(record.provisionFieldsCipher)

    let provisioned: ProvisionedEnvironment
    try {
      provisioned = await provider.status({
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

  /**
   * Build an {@link EnvironmentRecord} from its discriminating fields, owning the shared
   * scaffolding (a fresh id + `deletedAt: null`) ONCE so the success path and the
   * failed-provision path can't drift when the record shape gains a column — a new field on
   * `EnvironmentRecord` becomes a compile error at both call sites instead of a silent miss.
   */
  private buildEnvironmentRecord(
    fields: Omit<EnvironmentRecord, 'id' | 'deletedAt'>,
  ): EnvironmentRecord {
    return { id: this.deps.idGenerator.next('env'), deletedAt: null, ...fields }
  }

  /** A block holds at most one live environment: tombstone any prior one. No-op block-less. */
  private async supersedePriorEnvironment(
    workspaceId: string,
    blockId: string | null,
  ): Promise<void> {
    if (!blockId) return
    const prior = await this.deps.environmentRegistryRepository.getByBlock(workspaceId, blockId)
    if (prior) {
      await this.deps.environmentRegistryRepository.softDelete(
        workspaceId,
        prior.id,
        this.deps.clock.now(),
      )
    }
  }

  /**
   * Persist a `failed` environment record (superseding any prior live one) so a broken
   * provision is STORED and projectable onto the deployer step's details — even when the
   * provider threw before returning anything. Best-effort: its own persistence failure must
   * not mask the original provisioning error, so it swallows errors — but it records the
   * swallow in the provisioning log so a broken registry (DB outage / schema drift) is
   * OBSERVABLE rather than silently dropping the very root-cause projection it exists to
   * provide.
   */
  private async persistFailedEnvironment(
    workspaceId: string,
    args: ProvisionArgs,
    manifest: EnvironmentManifest,
    lastError: string,
  ): Promise<void> {
    try {
      await this.supersedePriorEnvironment(workspaceId, args.blockId ?? null)
      const record = this.buildEnvironmentRecord({
        workspaceId,
        blockId: args.blockId ?? null,
        executionId: args.executionId ?? null,
        providerId: manifest.providerId,
        externalId: null,
        url: null,
        status: 'failed',
        accessCipher: null,
        provisionFieldsCipher: null,
        createdAt: this.deps.clock.now(),
        expiresAt: null,
        lastError,
        provisionType: null,
        engine: null,
      })
      await this.deps.environmentRegistryRepository.insert(record)
    } catch (persistError) {
      // best-effort — never mask the original provisioning error, but leave a breadcrumb so a
      // broken registry doesn't silently swallow the failed-env record (which would render the
      // deployer step's lastError empty with no signal). Doubly-guarded: the log is itself
      // best-effort and must not throw out of the catch.
      await this.deps.provisioningLog
        ?.record({
          workspaceId,
          subsystem: 'environment',
          operation: 'provision',
          targetId: null,
          providerId: manifest.providerId,
          blockId: args.blockId ?? null,
          executionId: args.executionId ?? null,
          outcome: 'failure',
          error: `failed to persist the failed-environment record: ${
            persistError instanceof Error ? persistError.message : String(persistError)
          }`,
          detail: null,
        })
        .catch(() => undefined)
    }
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
