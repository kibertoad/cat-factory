import type { Clock, IdGenerator } from '@cat-factory/kernel'
import type {
  EnvironmentConnectionRecord,
  EnvironmentRecord,
  EnvironmentRegistryRepository,
} from '@cat-factory/kernel'
import type {
  DeployCloneTarget,
  DeployProvisionInputs,
  DeployProvisionJob,
  EnvironmentManifest,
  EnvironmentProvider,
  InfraEngine,
  ProvisionContext,
  ProvisionEnvironmentRequest,
  ProvisionType,
  ProvisionedEnvironment,
  RecipeStepLog,
  ResolveRunRepoContext,
  RunnerDispatchKind,
  RunnerDispatchOptions,
  RunnerJobRef,
  RunnerJobView,
  RunRepoContext,
  SecretResolver,
  ServiceProvisioning,
  UrlSafetyPolicy,
} from '@cat-factory/kernel'
import type { SecretCipher } from '@cat-factory/kernel'
import type { EnvironmentAccessHandle, EnvironmentHandle } from '@cat-factory/kernel'
import {
  assertFound,
  getErrorMessage,
  PREVIEW_PROVISION_TYPE,
  STRICT_URL_SAFETY_POLICY,
  ValidationError,
} from '@cat-factory/kernel'
import type { EnvironmentConnectionService } from './EnvironmentConnectionService.js'
import {
  assertSafeEnvironmentUrl,
  type EnvironmentIdentity,
  recordToHandle,
  shouldTeardownSuperseded,
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
  /**
   * Resolve a user's per-type infra handler OVERRIDES (local mode), as connection records the
   * resolver layers over the workspace handlers — a personal Docker/k3s the run initiator
   * pointed a provision type at. Wired only by the local facade; absent (Worker/Node) ⇒ no
   * per-user override and the workspace handler always wins. See
   * docs/initiatives/per-service-provision-types.md.
   */
  resolveUserHandlerOverrides?: (
    userId: string,
    workspaceId: string,
  ) => Promise<EnvironmentConnectionRecord[]>
  /**
   * Dispatch / poll / release a CONTAINER-backed deploy job (real `kubectl`/`kustomize`/`helm`)
   * through the workspace's runner transport — the async-provision lifecycle a provider exposes
   * via {@link AsyncProvisionCapability}. Absent ⇒ container provisioning is unavailable, so a
   * config that needs rendering fails loudly (the synchronous in-Worker REST path is unaffected).
   * Wired by each facade in the same place the agent executor's transport is. Typed structurally
   * (not the server's `RunnerJobClient`) so integrations stays runtime-neutral.
   */
  deployJobClient?: DeployJobClient
  /**
   * Resolve the manifests-repo clone target (HTTPS URL + ref + short-lived token) a deploy
   * container clones — VCS-specific, server-layer work the stateless provider can't do itself.
   * Absent (or a block-less provision) ⇒ no clone target, so a render-needing config makes
   * `buildProvisionJob` throw loudly. The synchronous raw-manifest path never needs it.
   */
  resolveDeployCloneTarget?: (
    workspaceId: string,
    blockId: string,
    ref?: string,
  ) => Promise<DeployCloneTarget | null>
  /**
   * Tear a superseded environment's real infrastructure down (best-effort) when a new provision
   * targets a DIFFERENT provider identity (a config change → different namespace, a provider/type
   * switch, or an `infraless` flip where nothing replaces it). Typed structurally (not the concrete
   * `EnvironmentTeardownService`) to avoid a construction-order coupling. Absent ⇒ supersede is
   * tombstone-only (the prior behaviour; tests/conformance and the identity-unchanged path).
   */
  environmentTeardown?: { teardown(workspaceId: string, id: string): Promise<unknown> }
}

/**
 * The structural subset of the server's `RunnerJobClient` the provisioning service needs to
 * run a container-backed deploy job: dispatch it, poll its view, and release its runner.
 * Defined here (not imported from `@cat-factory/server`) so the integrations layer stays
 * runtime-neutral; the facade passes its `RunnerJobClient`, which is structurally compatible.
 */
export interface DeployJobClient {
  dispatch(
    workspaceId: string | undefined,
    ref: RunnerJobRef,
    spec: Record<string, unknown>,
    kind: RunnerDispatchKind,
    options?: RunnerDispatchOptions,
  ): Promise<void>
  poll(workspaceId: string | undefined, ref: RunnerJobRef): Promise<RunnerJobView>
  release(workspaceId: string | undefined, ref: RunnerJobRef): Promise<void>
}

/** The provider + manifest + secret resolver + resolved type/engine for one provision. */
interface ResolvedProvision {
  manifest: EnvironmentManifest
  provider: EnvironmentProvider
  resolveSecret: SecretResolver
  /** The resolved provision type + engine (the per-type path); null on the legacy connection. */
  provisionType: ProvisionType | null
  engine: InfraEngine | null
}

/**
 * The outcome of {@link EnvironmentProvisioningService.startProvision}: either the environment
 * was provisioned SYNCHRONOUSLY (the in-Worker REST path for raw manifests — `handle` is final)
 * or a CONTAINER-backed deploy job was dispatched (`ref`) and the caller must park on it and poll
 * via {@link EnvironmentProvisioningService.pollProvisionJob} until it settles.
 */
export type ProvisionDispatch =
  | { kind: 'completed'; handle: EnvironmentHandle }
  | { kind: 'dispatched'; ref: RunnerJobRef }

export interface ProvisionArgs {
  workspaceId: string
  blockId?: string | null
  /**
   * The service FRAME the provisioning block belongs to (the deployer's block walked up to its
   * enclosing frame). Recorded on the env so a cross-frame consumer — a `frontend` frame's
   * `service` binding — can resolve the live env by the bound service FRAME id, not the task the
   * deployer ran on (`blockId`). Absent ⇒ null (a manual/frame-less provision).
   */
  frameId?: string | null
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
  /**
   * The run initiator's user id. In local mode their per-type handler overrides
   * (`resolveUserHandlerOverrides`) layer over the workspace handlers, so a personal
   * engine wins for THIS run. Absent / no override seam ⇒ the workspace handler resolves.
   */
  initiatedBy?: string | null
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

  /**
   * Whether the workspace can provision a service's declared provisioning — the lightweight
   * start-time check the Tester's infra gate uses (no provider build / no secret decrypt).
   * `infraless` resolves trivially (it provisions nothing); any other type needs a workspace
   * handler that resolves for it (a bare `custom` must be unambiguous). Mirrors exactly what
   * {@link provision} would resolve, so a run that passes the gate also provisions.
   */
  async canProvision(
    workspaceId: string,
    service: ServiceProvisioning,
  ): Promise<{ ok: boolean; reason?: 'no-handler' | 'type-mismatch' }> {
    if (service.type === 'infraless') return { ok: true }
    const resolution = await this.deps.connectionService.resolveHandlerForType(workspaceId, service)
    return resolution.ok ? { ok: true } : { ok: false, reason: resolution.reason }
  }

  /**
   * Whether the workspace has a legacy single-connection environment provider registered — the
   * compat-bridge path a service with NO declared provision type provisions through. The deployer
   * consults this so an UNDECLARED frame stands an env up only when one is actually configured
   * (else the injected deployer is a safe no-op instead of failing on "no connection").
   */
  async hasLegacyConnection(workspaceId: string): Promise<boolean> {
    return this.deps.connectionService.hasConnection(workspaceId)
  }

  /** Provision an environment, persisting an encrypted record keyed by block/run. */
  async provision(args: ProvisionArgs): Promise<EnvironmentHandle> {
    const resolved = await this.resolveProvision(args)
    // Pre-flight gate: if the provider declares repo-config expectations (e.g. Kargo's
    // `.kargo.yml`), verify them against the block's repo BEFORE provisioning, so a
    // missing/malformed config fails synchronously here instead of as an async failed
    // environment. Skipped for a block-less manual provision or an unconfigured workspace.
    await this.preflightValidateRepo(
      resolved.provider,
      args,
      resolved.manifest,
      resolved.resolveSecret,
    )
    const req = await this.buildProvisionRequest(
      args,
      resolved.manifest,
      resolved.resolveSecret,
      undefined,
      { resolveClone: true },
    )
    return this.provisionSync(args, resolved, req)
  }

  /**
   * Start provisioning a SERVICE's environment for a run, either synchronously (the in-Worker
   * REST path for raw manifests — returns a final `completed` handle) or by dispatching a
   * CONTAINER-backed deploy job (kustomize / helm / image overrides / secret injections —
   * returns `dispatched` with the job ref for the caller to park on and poll). The provider's
   * {@link AsyncProvisionCapability.buildProvisionJob} decides which path applies; this is the
   * deployer step's entry point. The synchronous path is identical to {@link provision}.
   */
  async startProvision(args: ProvisionArgs, ref: RunnerJobRef): Promise<ProvisionDispatch> {
    const resolved = await this.resolveProvision(args)
    await this.preflightValidateRepo(
      resolved.provider,
      args,
      resolved.manifest,
      resolved.resolveSecret,
    )
    // Resolve the deploy inputs (job ref + clone target) when the async seam is wired, so a
    // provider that renders in a container gets what it needs; absent ⇒ a render-needing config
    // makes `buildProvisionJob` throw loudly (surfaced as a failed env below).
    const deploy = await this.resolveDeployInputs(args, ref)
    const req = await this.buildProvisionRequest(
      args,
      resolved.manifest,
      resolved.resolveSecret,
      deploy,
      { resolveClone: true },
    )
    let job: DeployProvisionJob | null = null
    try {
      job = resolved.provider.asyncProvision?.buildProvisionJob(req) ?? null
    } catch (error) {
      // `buildProvisionJob` throws when rendering is needed but the deploy inputs aren't wired.
      // Persist a failed env so the deployer step shows the cause, then propagate.
      await this.captureProvisionFailure(args, resolved, getErrorMessage(error))
      throw error
    }
    if (!job) {
      // Raw manifests / no async provider: the synchronous in-Worker REST path.
      const handle = await this.provisionSync(args, resolved, req)
      return { kind: 'completed', handle }
    }
    if (!this.deps.deployJobClient) {
      const message =
        'This environment needs the container deploy adapter, but no runner transport is wired.'
      await this.captureProvisionFailure(args, resolved, message)
      throw new ValidationError(message)
    }
    try {
      await this.deps.deployJobClient.dispatch(
        args.workspaceId,
        job.ref,
        job.spec,
        job.kind,
        job.options,
      )
    } catch (error) {
      await this.captureProvisionFailure(args, resolved, getErrorMessage(error))
      throw error
    }
    // Persist a `provisioning` record so the run details show the env spinning up while the
    // deploy container renders + applies. {@link finalizeProvision} supersedes it with the
    // mapped outcome once the job settles. BEST-EFFORT: the job is already dispatched and its
    // ref is about to be persisted on the step, so a failed projection write must NOT propagate
    // — that would strand the live deploy container (the caller turns a `startProvision` throw
    // into a terminal, non-retried provisioning failure) for a display-only row. The real record
    // is written by `finalizeProvision` regardless.
    try {
      await this.recordProvisioned(
        args,
        resolved.manifest,
        {
          externalId: null,
          url: null,
          status: 'provisioning',
          expiresAt: null,
          access: null,
          fields: {},
        },
        resolved.provisionType,
        resolved.engine,
      )
    } catch {
      // Ignore — the `provisioning` row is a spinning-up display nicety; the job is in flight.
    }
    return { kind: 'dispatched', ref: job.ref }
  }

  /** Poll a dispatched deploy job's current view. Throws when no runner transport is wired. */
  async pollProvisionJob(workspaceId: string, ref: RunnerJobRef): Promise<RunnerJobView> {
    if (!this.deps.deployJobClient) {
      throw new Error('No runner transport is wired to poll the deploy job')
    }
    return this.deps.deployJobClient.poll(workspaceId, ref)
  }

  /**
   * Settle a deploy job that reached a terminal state: map its view into a
   * {@link ProvisionedEnvironment} via the provider's
   * {@link AsyncProvisionCapability.finalizeProvision} and persist the env record (superseding
   * the `provisioning` row from {@link startProvision}). A failed view becomes a `failed` env
   * carrying the harness error, so the deployer step's details project it.
   */
  async finalizeProvision(args: ProvisionArgs, view: RunnerJobView): Promise<EnvironmentHandle> {
    const resolved = await this.resolveProvision(args)
    const capability = resolved.provider.asyncProvision
    if (!capability) {
      throw new Error('The resolved provider has no async deploy capability to finalize')
    }
    // finalizeProvision only reads the manifest + inputs (it maps the harness view), so the
    // deploy clone inputs aren't needed here — skip minting a fresh clone token.
    const req = await this.buildProvisionRequest(args, resolved.manifest, resolved.resolveSecret)
    const provisioned = capability.finalizeProvision(view, req)
    if (provisioned.url) {
      assertSafeEnvironmentUrl(provisioned.url, 'environment URL', this.urlPolicy)
    }
    return this.recordProvisioned(
      args,
      resolved.manifest,
      provisioned,
      resolved.provisionType,
      resolved.engine,
    )
  }

  /** Best-effort reclaim a deploy job's runner (e.g. before an eviction re-dispatch). */
  async releaseProvisionJob(workspaceId: string, ref: RunnerJobRef): Promise<void> {
    await this.deps.deployJobClient?.release(workspaceId, ref)
  }

  /**
   * Resolve the provider + manifest + secret resolver for a provision: the SERVICE-declared
   * per-type handler (matching the type to a workspace handler, layering the run initiator's
   * local per-user override, and recording the resolved type/engine) or — undeclared — the
   * legacy single-connection path. `infraless` is rejected (callers short-circuit it).
   */
  private async resolveProvision(args: ProvisionArgs): Promise<ResolvedProvision> {
    const { workspaceId } = args
    if (args.serviceProvisioning) {
      if (args.serviceProvisioning.type === 'infraless') {
        throw new ValidationError('An infraless service provisions no environment')
      }
      // In local mode the run initiator's personal handlers layer over the workspace's.
      const userOverrides =
        args.initiatedBy && this.deps.resolveUserHandlerOverrides
          ? await this.deps.resolveUserHandlerOverrides(args.initiatedBy, workspaceId)
          : []
      const resolved = await this.deps.connectionService.resolveProviderForType(
        workspaceId,
        args.serviceProvisioning,
        userOverrides,
      )
      return {
        manifest: resolved.manifest,
        provider: resolved.provider,
        resolveSecret: resolved.resolveSecret,
        provisionType: resolved.provisionType,
        engine: resolved.engine,
      }
    }
    const resolved = await this.deps.connectionService.resolveProvider(workspaceId)
    return {
      manifest: resolved.manifest,
      provider: resolved.provider,
      resolveSecret: await this.deps.connectionService.resolveSecrets(workspaceId),
      provisionType: null,
      engine: null,
    }
  }

  /**
   * Build the {@link ProvisionEnvironmentRequest} from the provision args + resolved manifest:
   * the `{{input.*}}` vars (block id + typed context + explicit inputs), the run/separate repo
   * seams a native adapter reads manifests through, and — for an ASYNC container provision — the
   * deploy inputs (job ref + clone target). Shared by the synchronous and async paths.
   */
  private async buildProvisionRequest(
    args: ProvisionArgs,
    manifest: EnvironmentManifest,
    resolveSecret: SecretResolver,
    deploy?: DeployProvisionInputs,
    opts?: { resolveClone?: boolean },
  ): Promise<ProvisionEnvironmentRequest> {
    const { workspaceId } = args
    // Expose the block id as `{{input.blockId}}` even on a manual provision, so a manifest can
    // template against it without the caller repeating it. The typed git/PR/repo context is
    // flattened into the same namespace. Explicit inputs win over the derived block id + context.
    // A deployer step also passes `inputs.frontendOrigins` (comma-joined) — the browser origins
    // of the `frontend` frames that bind this service — so a manifest can fold them into the
    // backend's CORS allow-list via `{{input.frontendOrigins}}` (the reverse of the frontend's
    // `backendBindings`). It is absent when no frontend binds the service.
    const inputs: Record<string, string> = {}
    if (args.blockId) inputs.blockId = args.blockId
    Object.assign(inputs, contextInputs(args.context))
    Object.assign(inputs, args.inputs)
    // A native adapter (the Kubernetes backend) reads manifests from the run repo (co-located)
    // or a separate repo; resolve both seams when available. Resolve by the SERVICE FRAME being
    // provisioned (`frameId`), not the task `blockId` — so an involved-service frame's env clones
    // that peer's repo, not the task's own (the own frame resolves the same repo either way, since
    // repos are linked at the frame level and the ancestry walk from the task reaches it).
    const repoBlockId = args.frameId ?? args.blockId
    const runRepo =
      repoBlockId && this.deps.resolveRunRepoContext
        ? await this.deps.resolveRunRepoContext(workspaceId, repoBlockId)
        : null
    // LAZY clone target for a SYNCHRONOUS provider that needs a working tree (Docker Compose
    // build-from-source). Exposed as a memoized thunk so ONLY the build-mode provider that
    // actually clones pays the token mint — image-mode compose / custom / k8s-sync provisions
    // never invoke it, and `finalizeProvision` (no `resolveClone`) can't mint at all. Reuse the
    // async deploy inputs' already-resolved clone when present so one provision never mints twice.
    let clonePromise: Promise<DeployCloneTarget | undefined> | undefined
    const clone = opts?.resolveClone
      ? () =>
          (clonePromise ??= (async () =>
            deploy?.clone ??
            (this.deps.resolveDeployCloneTarget && repoBlockId
              ? ((await this.deps.resolveDeployCloneTarget(
                  workspaceId,
                  repoBlockId,
                  args.context?.branch,
                )) ?? undefined)
              : undefined))())
      : undefined
    // Best-effort per-step provisioning-log sink for a multi-step STACK RECIPE. Bound to the
    // block/run/provider identity here (the provider only names the step + its verdict), so a
    // long compose bring-up streams a per-step entry into the same env log the provision outcome
    // lands in — filterable by run in the "View logs" drawer. Wired only when the log is; the
    // recorder itself never throws.
    const recordStep = this.deps.provisioningLog
      ? async (log: RecipeStepLog): Promise<void> => {
          await this.deps.provisioningLog!.record({
            workspaceId,
            subsystem: 'environment',
            operation: 'provision',
            targetId: null,
            providerId: manifest.providerId,
            blockId: args.blockId ?? null,
            executionId: args.executionId ?? null,
            outcome: log.outcome,
            error: log.error ?? null,
            detail: JSON.stringify({
              step: log.name,
              durationMs: log.durationMs,
              ...(log.detail ? { note: log.detail } : {}),
            }),
          })
        }
      : undefined
    return {
      manifest,
      inputs,
      ...(args.context ? { provisionContext: args.context } : {}),
      resolveSecret,
      ...(runRepo ? { runRepo } : {}),
      ...(clone ? { clone } : {}),
      ...(recordStep ? { recordStep } : {}),
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
      ...(deploy ? { deploy } : {}),
    }
  }

  /**
   * Resolve the async deploy inputs ({@link DeployProvisionInputs}: the job ref + the
   * manifests-repo clone target) for a run block. Returns undefined when the clone-target seam is
   * unwired or the provision is block-less — so `buildProvisionJob` either uses the synchronous
   * path (raw manifests) or throws loudly (a render-needing config with no transport).
   */
  private async resolveDeployInputs(
    args: ProvisionArgs,
    ref: RunnerJobRef,
  ): Promise<DeployProvisionInputs | undefined> {
    // Clone the SERVICE FRAME's repo (`frameId`) — an involved-service frame provisions from that
    // peer's repo, the own frame from its own. The ref is the task's PR branch when the context
    // carries one (the own frame's deploy targets the PR); an involved frame passes no branch, so
    // the clone target falls back to that repo's default branch.
    const repoBlockId = args.frameId ?? args.blockId
    if (!this.deps.resolveDeployCloneTarget || !repoBlockId) return undefined
    const clone = await this.deps.resolveDeployCloneTarget(
      args.workspaceId,
      repoBlockId,
      args.context?.branch,
    )
    if (!clone) return undefined
    return { ref, clone }
  }

  /**
   * Run the SYNCHRONOUS provider provision (the in-Worker REST path), capture a thrown or
   * returned failure as a `failed` env record, and persist the outcome. Shared by
   * {@link provision} and {@link startProvision}'s raw-manifest fallback.
   */
  private async provisionSync(
    args: ProvisionArgs,
    resolved: ResolvedProvision,
    req: ProvisionEnvironmentRequest,
  ): Promise<EnvironmentHandle> {
    let provisioned: ProvisionedEnvironment
    try {
      provisioned = await resolved.provider.provision(req)
    } catch (error) {
      // The provider call threw (network/auth/4xx) — record the verbatim error as a failed env
      // (so the deployer step projects it) and re-throw.
      await this.captureProvisionFailure(args, resolved, getErrorMessage(error))
      throw error
    }
    if (provisioned.url) {
      assertSafeEnvironmentUrl(provisioned.url, 'environment URL', this.urlPolicy)
    }
    return this.recordProvisioned(
      args,
      resolved.manifest,
      provisioned,
      resolved.provisionType,
      resolved.engine,
    )
  }

  /**
   * Log + persist a `failed` env record carrying the REAL provisioning error, so the deployer
   * step's details project it (`step.environment.lastError`) even when the provider threw (or
   * the deploy job couldn't be built/dispatched) before any environment existed. Best-effort.
   */
  private async captureProvisionFailure(
    args: ProvisionArgs,
    resolved: ResolvedProvision,
    message: string,
  ): Promise<void> {
    await this.deps.provisioningLog?.record({
      workspaceId: args.workspaceId,
      subsystem: 'environment',
      operation: 'provision',
      targetId: null,
      providerId: resolved.manifest.providerId,
      blockId: args.blockId ?? null,
      executionId: args.executionId ?? null,
      outcome: 'failure',
      error: message,
      detail: null,
    })
    await this.persistFailedEnvironment(
      args.workspaceId,
      args,
      resolved.manifest,
      message,
      resolved.provisionType,
      resolved.engine,
    )
  }

  /**
   * Persist a provisioned environment: supersede the block's prior live one, insert the encrypted
   * record (capturing the resolved type/engine + a non-throwing provider's `failed` reason), log
   * the outcome, and return the handle. Shared by the synchronous path and the async finalizer.
   */
  private async recordProvisioned(
    args: ProvisionArgs,
    manifest: EnvironmentManifest,
    provisioned: ProvisionedEnvironment,
    provisionType: ProvisionType | null,
    engine: InfraEngine | null,
  ): Promise<EnvironmentHandle> {
    const { workspaceId } = args
    // A (block, frame) pair holds at most one live environment: supersede any prior one, tearing
    // its real infra down when the new provision targets a different provider identity (else keep
    // the tombstone-only overwrite-in-place). `provisioned.externalId` is null on the async
    // `provisioning` placeholder insert — then a matching type/engine is treated as the same
    // deterministic resource (no teardown).
    await this.supersedePriorEnvironment(workspaceId, args.blockId ?? null, args.frameId ?? null, {
      provisionType,
      engine,
      externalId: provisioned.externalId,
    })

    const now = this.deps.clock.now()
    const record = this.buildEnvironmentRecord({
      workspaceId,
      blockId: args.blockId ?? null,
      frameId: args.frameId ?? null,
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
      // The resolved provision type + engine (the per-type path); null on the legacy connection.
      provisionType,
      engine,
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
    // Validate against the SERVICE FRAME's repo (`frameId`) — a peer frame's provision preflights
    // that peer's repo, not the task's own (see resolveDeployInputs / buildProvisionRequest).
    const repoBlockId = args.frameId ?? args.blockId
    if (!provider.validateRepo || !this.deps.resolveRunRepoContext || !repoBlockId) return
    const bound = await this.deps.resolveRunRepoContext(args.workspaceId, repoBlockId)
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
    // Resolve the provider from the record's stored provision type/engine (the handler that stood
    // it up), not the workspace-primary — matching the per-type resolution provisioning uses.
    const { manifest, provider, resolveSecret } =
      await this.deps.connectionService.resolveProviderForRecord(record)
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

    // A reconciliation that flips the env to `failed` (e.g. a rollout that exceeded its progress
    // deadline, or a vanished namespace — the cases the provider maps to `failed` WITHOUT
    // throwing) records a provisioning-log failure on the TRANSITION, so the run's "Infrastructure
    // attempts" shows the env stopped spinning up instead of leaving it silently stuck. Repeated
    // polls of an already-failed env don't re-log. (A read that THROWS is logged in the catch
    // above; this covers the non-throwing failed verdict.) This runs AFTER the status patch is
    // persisted and is best-effort: a logging hiccup must not throw back through refreshStatus and
    // leave the env stuck at `provisioning` again — the exact bug this surfacing is meant to fix.
    if (provisioned.status === 'failed' && record.status !== 'failed') {
      try {
        await this.deps.provisioningLog?.record({
          workspaceId,
          subsystem: 'environment',
          operation: 'status',
          targetId: record.id,
          providerId: manifest.providerId,
          blockId: record.blockId,
          executionId: record.executionId,
          outcome: 'failure',
          error: 'Environment provisioning did not complete (it never became ready).',
          detail: null,
        })
      } catch {
        // swallow: the env is already persisted as `failed`; the log entry is advisory
      }
    }

    return recordToHandle({ ...record, ...patch })
  }

  /**
   * List a workspace's environments (no creds). Browsable-preview rows share the registry table
   * but are NOT provisioned environments (they carry the {@link PREVIEW_PROVISION_TYPE}
   * discriminator and are owned by the PreviewService), so they are filtered out here — they must
   * not surface in the deployer-env listing the SPA renders.
   */
  async listHandles(workspaceId: string): Promise<EnvironmentHandle[]> {
    const records = await this.deps.environmentRegistryRepository.listByWorkspace(workspaceId)
    return records
      .filter((r) => r.provisionType !== PREVIEW_PROVISION_TYPE)
      .map((r) => recordToHandle(r))
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
  async resolveForBlock(
    workspaceId: string,
    blockId: string,
    frameId?: string,
  ): Promise<ResolvedEnvironment | null> {
    const record = await this.readRegistryRecord(workspaceId, blockId, frameId)
    // A browsable-preview row is not a provisioned environment — never resolve it as a block's
    // live env (e.g. for tester context enrichment); it is owned solely by the PreviewService.
    if (!record || record.provisionType === PREVIEW_PROVISION_TYPE) return null
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
  async getHandleForBlock(
    workspaceId: string,
    blockId: string,
    frameId?: string,
  ): Promise<EnvironmentHandle | null> {
    const record = await this.readRegistryRecord(workspaceId, blockId, frameId)
    // Exclude a browsable-preview row (see resolveForBlock) — it is not a provisioned env.
    return record && record.provisionType !== PREVIEW_PROVISION_TYPE ? recordToHandle(record) : null
  }

  /**
   * The registry record for a block, resolving the specific service frame's env when a `frameId`
   * is known (a task may provision several — its own frame's plus each involved-service frame's).
   * A frame-keyed read that misses falls back to the block's FRAME-LESS (manual / human-test) env —
   * those are written with `frame_id = NULL`, so the exact-frame read wouldn't see one — but NOT to
   * a sibling frame's env. The fallback reads the frame-less row DIRECTLY (`getFramelessByBlock`),
   * not via {@link EnvironmentRegistryRepository.getByBlock}: the latter returns the newest across
   * ALL frames, so a NEWER fan-out peer env under the same `block_id` would shadow the frame-less
   * manual env and the fallback would miss it. No `frameId` ⇒ the block's newest, as before.
   */
  private async readRegistryRecord(
    workspaceId: string,
    blockId: string,
    frameId?: string,
  ): Promise<EnvironmentRecord | null> {
    if (!frameId) return this.deps.environmentRegistryRepository.getByBlock(workspaceId, blockId)
    const framed = await this.deps.environmentRegistryRepository.getByBlockAndFrame(
      workspaceId,
      blockId,
      frameId,
    )
    return (
      framed ?? this.deps.environmentRegistryRepository.getFramelessByBlock(workspaceId, blockId)
    )
  }

  /**
   * Tombstone any live environment record for a block. Called when a service becomes
   * `infraless` (the deployer provisions nothing), so a previously-provisioned environment
   * stops showing as live in the registry instead of being orphaned. This tombstones the
   * registry projection only — real provider teardown is the teardown service's job (same as
   * the re-provision path, which also only supersedes the prior record here).
   */
  async supersedeForBlock(
    workspaceId: string,
    blockId: string | null,
    frameId: string | null = null,
  ): Promise<void> {
    // Nothing replaces the prior env (the service flipped to `infraless`), so tear its real infra
    // down (best-effort) rather than merely tombstoning the row and orphaning the namespace/project.
    await this.supersedePriorEnvironment(workspaceId, blockId, frameId, null)
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

  /**
   * A (block, service frame) pair holds at most one live environment: tombstone any prior one.
   * Keyed per `(blockId, frameId)` — NOT per block alone — because a single task can provision
   * several environments (its own service frame's plus one per involved-service frame, the
   * connections initiative), all sharing the task `blockId`; superseding by block alone would
   * clobber a sibling frame's live env. When the frame is unknown (a manual / frame-less
   * provision) it supersedes the block's FRAME-LESS env specifically (`getFramelessByBlock`), NOT
   * the block's newest across all frames — else a manual re-provision would clobber a newer
   * fan-out peer env sharing the `blockId`. No-op block-less.
   */
  private async supersedePriorEnvironment(
    workspaceId: string,
    blockId: string | null,
    frameId: string | null,
    // The incoming env's identity when a new provision replaces the prior (compared to decide
    // teardown-vs-overwrite); `null` when NOTHING replaces it (an `infraless` flip). `undefined`
    // (the default) keeps the legacy tombstone-only behaviour — used by the failed-provision path,
    // which must never tear the prior live env down.
    next?: EnvironmentIdentity | null,
  ): Promise<void> {
    if (!blockId) return
    const prior = frameId
      ? await this.deps.environmentRegistryRepository.getByBlockAndFrame(
          workspaceId,
          blockId,
          frameId,
        )
      : await this.deps.environmentRegistryRepository.getFramelessByBlock(workspaceId, blockId)
    if (!prior) return
    if (
      this.deps.environmentTeardown &&
      next !== undefined &&
      shouldTeardownSuperseded(prior, next)
    ) {
      try {
        // Reclaims the real infra AND tombstones on success (resolving the provider by the record).
        // BEST-EFFORT: a teardown failure must not fail the new provision — leave the row LIVE so
        // the TTL reaper retries (tombstoning it would orphan the un-torn-down infra beyond the
        // reaper's reach).
        await this.deps.environmentTeardown.teardown(workspaceId, prior.id)
      } catch {
        // swallowed on purpose (see above); TTL reaper is the backstop.
      }
      return
    }
    await this.deps.environmentRegistryRepository.softDelete(
      workspaceId,
      prior.id,
      this.deps.clock.now(),
    )
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
    provisionType: ProvisionType | null,
    engine: InfraEngine | null,
  ): Promise<void> {
    try {
      await this.supersedePriorEnvironment(workspaceId, args.blockId ?? null, args.frameId ?? null)
      const record = this.buildEnvironmentRecord({
        workspaceId,
        blockId: args.blockId ?? null,
        frameId: args.frameId ?? null,
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
        provisionType,
        engine,
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
