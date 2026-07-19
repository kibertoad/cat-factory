import type {
  AgentRunResult,
  Block,
  BlockRepository,
  ContainerEvictionKind,
  EnvironmentHandle,
  ExecutionInstance,
  PipelineStep,
  ProvisionContext,
  RunnerJobRef,
  ServiceProvisioning,
} from '@cat-factory/kernel'
import { getErrorMessage, getErrorReason } from '@cat-factory/kernel'
import { frameProfile, frontendOriginsForService } from '@cat-factory/contracts'
import { moduleSlug } from '@cat-factory/agents'
import type {
  EnvironmentProvisioningService,
  ProvisionArgs,
  ProvisionDispatch,
} from '@cat-factory/integrations'
import { deployEvictionEpoch, deployJobId, orderProvisionTargets } from './deployer.logic.js'
import { frameOf, validInvolvedServiceFrames } from './frame.logic.js'
import { TESTER_AGENT_KIND, UI_TESTER_AGENT_KIND } from './ci.logic.js'
import type { AgentContextBuilder } from './AgentContextBuilder.js'
import type { RunStateMachine } from './RunStateMachine.js'
import type { AdvanceResult } from './advance.js'

/**
 * Step kinds whose run details surface the ephemeral-environment lifecycle: the
 * `deployer` provisions it and the `tester`/`playwright` exercise it. Used to gate
 * the per-poll env projection so the `getByBlock` read never hits the hot path for
 * the many container steps that have no env to show (see attachEnvironmentProjection).
 */
const ENV_PROJECTION_KINDS = new Set<string>([
  'deployer',
  TESTER_AGENT_KIND,
  UI_TESTER_AGENT_KIND,
  'playwright',
])

/** One service frame a `deployer` step provisions an environment for (own or an involved peer). */
interface DeployTarget {
  frameId: string
  /** The task's OWN service frame (implicitly involved); false for a connected involved service. */
  isPrimary: boolean
  provisioning: ServiceProvisioning | undefined
  frame: Block
}

/**
 * The `peerEnvUrls` provision input for the frame about to be provisioned: a comma-joined set of
 * `slug=url` pairs for every target frame whose env is ALREADY ready this run — so a later
 * provider (own frame, provisioned last in provider-before-consumer order) can template a
 * connected service's URL into its manifest via `{{input.peerEnvUrls}}`. Empty when no peer is
 * ready yet. Documented limitation: a provider needing its consumer's URL (a cyclic env
 * dependency) is out of scope — there is no reconfigure pass.
 */
function buildPeerEnvUrls(
  targets: readonly DeployTarget[],
  done: NonNullable<PipelineStep['deployEnvs']>,
): string {
  const parts: string[] = []
  const seen = new Map<string, number>()
  for (const target of targets) {
    const env = done[target.frameId]
    if (env?.status !== 'ready' || !env.url) continue
    // Two ready providers can slugify to the same name; suffix the collision with an ordinal so a
    // second provider's URL isn't silently dropped (or its entry made ambiguous) in the joined set.
    const base = moduleSlug(target.frame.title)
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    const slug = count === 0 ? base : `${base}-${count + 1}`
    parts.push(`${slug}=${env.url}`)
  }
  return parts.join(',')
}

/**
 * Parse `owner`/`repo` from a GitHub pull-request URL (`https://github.com/o/r/pull/42`).
 * Returns undefined for any URL that doesn't carry both segments. Host-agnostic on
 * purpose (GitHub Enterprise hosts work too); only the `/owner/repo/...` shape matters.
 */
function parseRepoFromPullUrl(url: string): { owner: string; repo: string } | undefined {
  const match = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\//.exec(url)
  if (!match) return undefined
  return { owner: match[1]!, repo: match[2]! }
}

/**
 * Collaborators + the {@link RunDispatcher} seams the deployer step family needs. The
 * completion hub (`recordStepResult`) and the shared poll folds / eviction recovery stay on
 * the dispatcher (the agent path uses them too) and are injected as callbacks, so the two
 * paths can't drift on budgets or fold semantics.
 */
export interface DeployerStepControllerDeps {
  blockRepository: BlockRepository
  contextBuilder: AgentContextBuilder
  runStateMachine: RunStateMachine
  environmentProvisioning?: EnvironmentProvisioningService
  recordStepResult: (
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    isFinalStep: boolean,
    result: AgentRunResult,
  ) => Promise<AdvanceResult>
  applyContainerRunning: (
    step: PipelineStep,
    update: { phase?: string; container?: { id?: string; url?: string } },
  ) => boolean
  applySubtaskProgress: (step: PipelineStep, counts: PipelineStep['subtasks']) => boolean
  recoverContainerEviction: (
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    error: string | undefined,
    evicted: ContainerEvictionKind | undefined,
    onBeforeRedispatch?: () => Promise<void>,
  ) => Promise<AdvanceResult | null>
}

/**
 * The deterministic `deployer` step family, extracted out of {@link RunDispatcher}: the
 * multi-frame provision fan-out (own frame + involved-service peers, provider-before-consumer),
 * the async container-backed deploy-job poll, the per-frame settle/failure bookkeeping on
 * `step.deployEnvs`, and the environment projection every env-aware step surfaces on its run
 * details. No LLM and no token usage anywhere in this family — the deployer provisions
 * environments through the {@link EnvironmentProvisioningService} provider only. Pure code
 * movement from the dispatcher; no behaviour changes.
 */
export class DeployerStepController {
  private readonly blockRepository: BlockRepository
  private readonly contextBuilder: AgentContextBuilder
  private readonly runStateMachine: RunStateMachine
  private readonly environmentProvisioning?: EnvironmentProvisioningService
  private readonly recordStepResult: DeployerStepControllerDeps['recordStepResult']
  private readonly applyContainerRunning: DeployerStepControllerDeps['applyContainerRunning']
  private readonly applySubtaskProgress: DeployerStepControllerDeps['applySubtaskProgress']
  private readonly recoverContainerEviction: DeployerStepControllerDeps['recoverContainerEviction']

  constructor(deps: DeployerStepControllerDeps) {
    this.blockRepository = deps.blockRepository
    this.contextBuilder = deps.contextBuilder
    this.runStateMachine = deps.runStateMachine
    this.environmentProvisioning = deps.environmentProvisioning
    this.recordStepResult = deps.recordStepResult
    this.applyContainerRunning = deps.applyContainerRunning
    this.applySubtaskProgress = deps.applySubtaskProgress
    this.recoverContainerEviction = deps.recoverContainerEviction
  }

  /**
   * Stamp `step.environment` from the block's live ephemeral environment so a run's
   * details show its spinning-up / running / shut-down / errored state + the exact
   * error. Best-effort: a no-op when the env integration isn't wired, and never
   * throws (a projection failure must not break the run). Returns whether it changed,
   * so the poll path can fold it into its single emit. The `human-test` gate keeps
   * its own `humanTest.environment`, so this is for the other env-consuming steps
   * (tester/coder/deployer).
   */
  async attachEnvironmentProjection(
    workspaceId: string,
    blockId: string,
    step: PipelineStep,
    frameId?: string,
  ): Promise<boolean> {
    if (!this.environmentProvisioning) return false
    // Only the env-aware kinds run against an ephemeral environment (the `deployer`
    // provisions it; the `tester`/`playwright` exercise it). Gating here keeps the
    // per-poll `getByBlock` read off the hot path for the many container steps
    // (coder/merger/ci-fixer/…) that never have an env to surface.
    if (!ENV_PROJECTION_KINDS.has(step.agentKind)) return false
    try {
      // Project the SPECIFIED service frame's env when given (the in-flight / failed frame of a
      // multi-env deploy); otherwise the task's OWN frame (a task provisions several envs under
      // one block, so an un-keyed newest-wins read could surface a peer's). Absent frame ⇒ own.
      const resolvedFrameId =
        frameId ??
        (await this.contextBuilder.resolveServiceFrameId(workspaceId, blockId)) ??
        undefined
      const handle = await this.environmentProvisioning.getHandleForBlock(
        workspaceId,
        blockId,
        resolvedFrameId,
      )
      const next = handle
        ? {
            id: handle.id,
            url: handle.url,
            status: handle.status,
            expiresAt: handle.expiresAt,
            lastError: handle.lastError,
            provisionType: handle.provisionType ?? null,
            engine: handle.engine ?? null,
          }
        : null
      const prev = step.environment ?? null
      if (
        prev?.id === next?.id &&
        prev?.status === next?.status &&
        prev?.url === next?.url &&
        (prev?.lastError ?? null) === (next?.lastError ?? null)
      ) {
        return false
      }
      step.environment = next
      return true
    } catch {
      return false
    }
  }

  /**
   * Deterministically provision an ephemeral environment for a `deployer` step and turn the
   * outcome into the step's advance result (no LLM, no token usage). On success the env
   * summary is recorded as the step output. On a provisioning failure — the provider threw
   * OR returned `status:'failed'` — the breakage is surfaced as a real, DISPLAYED step
   * failure rather than a green step with the error buried in its prose output: `step.environment`
   * is stamped with the errored env (its `lastError` renders in the step's Environment panel)
   * and a structured `environment` failure is returned (the board's failure card). A deployer
   * that can't provision IS failed — the downstream tester/coder steps need that environment.
   *
   * The failure is TERMINAL and surfaced for a human/`Retry`, NOT auto-retried by the durable
   * driver — DELIBERATELY, and symmetric with `handleAgentStep`'s dispatch-failure path
   * (a container that never started is likewise terminal regardless of `rethrowAgentErrors`).
   * Environment provisioning is infra spin-up, not agent execution: treating it like the
   * `dispatch` failure (surface the verbatim cause + one-click retry) keeps the `environment`
   * classification and the provider's real error visible, where rethrowing for the driver's
   * per-step retry would re-collapse it into a generic `agent` failure on exhaustion and bury
   * the root cause. So do NOT reintroduce a `rethrowAgentErrors` branch here.
   */
  async runDeployerStep(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    block: Block,
    isFinalStep: boolean,
  ): Promise<AdvanceResult> {
    // A set `jobId` means a prior (possibly replayed) dispatch already started an async deploy
    // job for the IN-FLIGHT frame — re-attach by polling instead of re-provisioning (mirrors
    // `handleAgentStep`). Short-circuit BEFORE resolving targets so a parked re-attach
    // skips the workspace block-list read.
    if (step.jobId) {
      return { kind: 'awaiting_job', jobId: step.jobId, stepIndex: instance.currentStep }
    }
    // Fan out over every service frame this run provisions an env for — the task's OWN frame plus
    // each still-valid involved-service frame (the connections initiative), ordered provider-
    // before-consumer. Resolve the target set ONCE here (one workspace block-list read); the
    // synchronous/infraless recursion threads it rather than re-reading per frame.
    const targets = await this.resolveDeployTargets(workspaceId, block, step.deployPrimaryFrameId)
    // Pin the primary (own) frame once, so every later re-entry/replay classifies it identically
    // regardless of a mid-flight reparent (see {@link resolveDeployTargets}). Persisted with the
    // first synchronous-settle / async-park upsert below.
    step.deployPrimaryFrameId ??= targets.find((t) => t.isPrimary)?.frameId
    return this.advanceDeployerFrames(workspaceId, instance, step, block, isFinalStep, targets)
  }

  /**
   * Advance a `deployer` fan-out over its already-resolved `targets`: dispatch the first un-settled
   * frame (parking on an async deploy job) or, once every frame has settled, complete the step. One
   * deploy job per frame, dispatched SEQUENTIALLY (parking between) so a later provider can receive
   * the already-ready peers' URLs. `step.deployEnvs` records each frame's TERMINAL outcome, so a
   * replay resumes at the first un-settled frame. Re-entered (with the SAME targets) after each
   * synchronous/infraless/failed-peer frame settles — never re-reading the block list per frame.
   */
  private async advanceDeployerFrames(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    block: Block,
    isFinalStep: boolean,
    targets: readonly DeployTarget[],
  ): Promise<AdvanceResult> {
    const done = step.deployEnvs ?? {}
    const next = targets.find((t) => !done[t.frameId])
    if (!next) {
      // Every frame settled: finish the step (all ready → done; a primary failure short-circuited).
      return this.completeDeployerStep(workspaceId, instance, step, isFinalStep, targets)
    }
    // The deployer is the SINGLE environment provisioner: it stands the frame's env up whenever
    // there is genuinely one to stand up, so every downstream consumer (tester / human-test /
    // playwright) can depend on a pre-provisioned env rather than standing infra up itself:
    //  - a DECLARED `kubernetes`/`custom` type (resolved through its per-type handler), OR
    //  - a DECLARED `docker-compose` type on a workspace with a compose handler configured (the
    //    setup wizard saves one) — the per-PR compose stack is provisioned HERE (attaching shared
    //    stacks / running preflights), and the tester then targets that provisioned env (see
    //    `testerInfraSpec`). A compose chain that reaches a tester with no resolvable handler is now
    //    refused at run start (`assertTesterInfraConfigured`), so this stays the sole compose path, OR
    //  - an UNDECLARED frame on a workspace with a legacy single-connection registered (the compat
    //    bridge — preserved so existing single-connection deployments keep provisioning).
    // Every other frame stands nothing up HERE — `infraless`/none, an undeclared frame with NO
    // connection, or a frontend frame — so the deployer records `{status:'skipped'}` and re-enters
    // for the next frame. This makes the deployer a safe NO-OP prefix that can be injected before
    // every tester/human-test step without failing services that never configured provisioning.
    // A `library` frame (not `deployable`) is never deployed — a declared compose path is repo-local
    // TEST infra, not an environment — so it stands nothing up here regardless of its provisioning.
    // Gating every env branch on `deployable` forces the skip record below (mirroring `infraless`).
    const deployable = frameProfile(next.frame.type).deployable
    const provisionType = next.provisioning?.type
    const declaresEnv = deployable && (provisionType === 'kubernetes' || provisionType === 'custom')
    const composeEnv =
      deployable &&
      provisionType === 'docker-compose' &&
      next.provisioning !== undefined &&
      // Thread the run initiator so a local per-user handler OVERRIDE resolves exactly as it does at
      // provision time (and in the start-time gate) — else an override-only compose setup that
      // passed `assertDeployerConfigured` would silently no-op here (the very dead-end the gate closes).
      ((
        await this.environmentProvisioning?.canProvision(
          workspaceId,
          next.provisioning,
          instance.initiatedBy,
        )
      )?.ok ??
        false)
    const legacyEnv =
      deployable &&
      provisionType === undefined &&
      (await this.environmentProvisioning?.hasLegacyConnection(workspaceId))
    if (!declaresEnv && !composeEnv && !legacyEnv) {
      await this.environmentProvisioning?.supersedeForBlock(workspaceId, block.id, next.frameId)
      step.deployEnvs = { ...done, [next.frameId]: { status: 'skipped' } }
      // Persist this frame's TERMINAL outcome BEFORE processing the next frame, so a crash/replay
      // mid-fan-out resumes at the first un-settled frame rather than re-doing an already-settled
      // one (which, on the synchronous REST path, would re-hit the provider — no idempotency guard
      // there, unlike the deterministic async job ref).
      await this.runStateMachine.casPersist(workspaceId, instance)
      return this.advanceDeployerFrames(workspaceId, instance, step, block, isFinalStep, targets)
    }
    // Start provisioning the next frame: a raw-manifest config provisions SYNCHRONOUSLY over REST
    // (a final handle); a config that needs rendering dispatches a CONTAINER-backed deploy job we
    // park on and poll. The job ref is DETERMINISTIC (run id + deployer kind + FRAME + eviction
    // epoch), so a Workflows replay reproduces the same id and the transport re-attaches instead
    // of double-dispatching. The frame discriminator keeps each fanned-out job distinct.
    const ref: RunnerJobRef = {
      runId: instance.id,
      jobId: deployJobId(instance.id, deployEvictionEpoch(step), next.frameId),
    }
    const peerEnvUrls = buildPeerEnvUrls(targets, done)
    let dispatch: ProvisionDispatch
    try {
      dispatch = await this.environmentProvisioning!.startProvision(
        await this.deployerProvisionArgs(workspaceId, instance, block, next, peerEnvUrls),
        ref,
      )
    } catch (error) {
      return this.settleDeployerFailure(
        workspaceId,
        instance,
        step,
        block,
        isFinalStep,
        targets,
        next,
        null,
        getErrorMessage(error),
        // Propagate the provider's machine-readable cause (e.g. `deploy_runner_unwired`) so the
        // SPA can render precise, runtime-specific guidance rather than string-matching the prose.
        getErrorReason(error),
      )
    }
    if (dispatch.kind === 'completed') {
      // Synchronous provision: record this frame's outcome, then continue to the next frame.
      return this.settleDeployerFrame(
        workspaceId,
        instance,
        step,
        block,
        isFinalStep,
        targets,
        next,
        dispatch.handle,
      )
    }
    // An async deploy job was dispatched: park on this frame. `dispatch` blocked until the job was
    // accepted, so the container is up; the live phase + the provisioned outcome arrive on the
    // deployer poll branch. Surface the frame's env spinning up alongside the parked step.
    step.jobId = dispatch.ref.jobId
    step.deployFrameId = next.frameId
    step.container = { status: 'up' }
    // Pin the provisioning config the container was built from, so the later poll/finalize maps
    // the job against THIS config rather than a fresh read of the frame (which a person may edit
    // mid-flight). Absent for the undeclared legacy path, which re-resolution handles harmlessly.
    step.deployProvisioning = next.provisioning
    await this.attachEnvironmentProjection(workspaceId, instance.blockId, step, next.frameId)
    await this.runStateMachine.casPersist(workspaceId, instance)
    await this.runStateMachine.emitInstance(workspaceId, instance)
    return { kind: 'awaiting_job', jobId: step.jobId, stepIndex: instance.currentStep }
  }

  /**
   * Resolve the ordered set of service frames a `deployer` step provisions environments for: the
   * task's OWN service frame (always, `isPrimary`) plus each involved-service frame (read-time
   * stale-filtered to ids that are still a connection neighbour AND resolve to a `service` frame
   * WITH declared provisioning — an involved frame with none stands nothing up here). Ordered
   * PROVIDER-before-CONSUMER over the connection edges among the targets (see
   * {@link orderProvisionTargets}) so a later provision can receive its ready peers' URLs. One
   * workspace block-list read; no per-frame point read.
   *
   * `pinnedPrimaryFrameId` (from {@link PipelineStep.deployPrimaryFrameId}, set on the first
   * resolution) keeps the OWN/primary frame STABLE across re-entries: once the fan-out has started,
   * a mid-flight reparent must not re-classify which frame is primary — that would flip an
   * own-frame failure from terminal to a non-terminal peer failure. Prefer the pinned frame when it
   * still resolves; fall back to a fresh `frameOf` walk otherwise.
   */
  private async resolveDeployTargets(
    workspaceId: string,
    block: Block,
    pinnedPrimaryFrameId?: string,
  ): Promise<DeployTarget[]> {
    const blocks = await this.blockRepository.listByWorkspace(workspaceId)
    const byId = new Map(blocks.map((b) => [b.id, b]))
    const ownFrame =
      (pinnedPrimaryFrameId ? byId.get(pinnedPrimaryFrameId) : undefined) ??
      frameOf(byId, block.id) ??
      block
    const targets: DeployTarget[] = [
      {
        frameId: ownFrame.id,
        isPrimary: true,
        provisioning: ownFrame.provisioning,
        frame: ownFrame,
      },
    ]
    // The connected involved-service frames, read-time stale-filtered by the shared helper (kept in
    // sync with `AgentContextBuilder.resolveInvolvedServices`). Include each regardless of declared
    // provisioning — like the OWN frame, an undeclared service falls through to the legacy
    // single-connection compat bridge, and an `infraless` one is skipped by the dispatch loop. Only
    // the dispatch decides what actually stands up.
    for (const frame of validInvolvedServiceFrames(blocks, block, ownFrame.id)) {
      if (targets.some((t) => t.frameId === frame.id)) continue
      targets.push({
        frameId: frame.id,
        isPrimary: false,
        provisioning: frame.provisioning,
        frame,
      })
    }
    const targetIds = new Set(targets.map((t) => t.frameId))
    const providersOf = new Map<string, Set<string>>()
    for (const target of targets) {
      const providers = new Set<string>()
      for (const connection of target.frame.serviceConnections ?? []) {
        if (
          connection.serviceBlockId !== target.frameId &&
          targetIds.has(connection.serviceBlockId)
        ) {
          providers.add(connection.serviceBlockId)
        }
      }
      providersOf.set(target.frameId, providers)
    }
    const order = orderProvisionTargets(
      targets.map((t) => ({ frameId: t.frameId, isPrimary: t.isPrimary })),
      providersOf,
    )
    const byFrame = new Map(targets.map((t) => [t.frameId, t]))
    return order.map((id) => byFrame.get(id)!)
  }

  /**
   * Record one frame's TERMINAL deploy outcome onto `step.deployEnvs`, then continue the fan-out.
   * A `ready` handle records the env and re-enters {@link advanceDeployerFrames} for the next
   * frame; a `failed` handle routes to {@link settleDeployerFailure} (terminal only for the own
   * frame). Shared by the synchronous-provision and async-finalized paths.
   */
  private async settleDeployerFrame(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    block: Block,
    isFinalStep: boolean,
    targets: readonly DeployTarget[],
    target: DeployTarget,
    handle: EnvironmentHandle,
  ): Promise<AdvanceResult> {
    if (handle.status === 'failed') {
      return this.settleDeployerFailure(
        workspaceId,
        instance,
        step,
        block,
        isFinalStep,
        targets,
        target,
        handle.url,
        handle.lastError ?? 'Provisioning failed.',
      )
    }
    if (handle.status !== 'ready' && !target.isPrimary) {
      // A PEER env that isn't `ready` (`provisioning`, `expired`, `tearing_down`, …) is not usable
      // context: `deployEnvs` can only record `ready`/`failed`/`skipped`, and recording it `ready`
      // would BOTH advertise it "Provisioned involved-service environment …" AND inject its not-live
      // URL into a consumer's `peerEnvUrls`. Drop it as a non-terminal peer failure instead. (The
      // OWN frame keeps the historical behaviour — its env is the deploy's product; its live status
      // is surfaced via the Environment projection, and the run proceeds as before.)
      return this.settleDeployerFailure(
        workspaceId,
        instance,
        step,
        block,
        isFinalStep,
        targets,
        target,
        handle.url,
        `Environment not ready (status: ${handle.status}).`,
      )
    }
    const done = step.deployEnvs ?? {}
    step.deployEnvs = { ...done, [target.frameId]: { status: 'ready', url: handle.url } }
    // Persist this frame's TERMINAL outcome BEFORE provisioning the next frame (see the infraless
    // branch) so a crash/replay resumes at the first un-settled frame, not re-provisioning this one.
    await this.runStateMachine.casPersist(workspaceId, instance)
    return this.advanceDeployerFrames(workspaceId, instance, step, block, isFinalStep, targets)
  }

  /**
   * Record a frame's FAILED deploy outcome and decide whether it is terminal. The task's OWN
   * (primary) service frame failing fails the whole deploy step (unchanged from the single-env
   * path). An involved PEER frame failing is NON-terminal — the peer's env is best-effort context
   * enrichment, so the run proceeds to the remaining frames without that peer's URL rather than
   * failing a task because a service it merely "involves" has a misconfigured provider. The failed
   * outcome is still recorded (surfaced in {@link completeDeployerStep}).
   */
  private async settleDeployerFailure(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    block: Block,
    isFinalStep: boolean,
    targets: readonly DeployTarget[],
    target: DeployTarget,
    url: string | null | undefined,
    error: string,
    /** Machine-readable cause (e.g. `deploy_runner_unwired`) carried to the failure record. */
    reason?: string,
  ): Promise<AdvanceResult> {
    const done = step.deployEnvs ?? {}
    step.deployEnvs = { ...done, [target.frameId]: { status: 'failed', url: url ?? null, error } }
    if (target.isPrimary) {
      return this.failDeployerStep(workspaceId, instance, step, target.frameId, error, reason)
    }
    // A PEER failure is non-terminal — persist it BEFORE moving to the next frame so a replay
    // doesn't re-attempt this failed peer (same rationale as the ready/infraless settle paths).
    await this.runStateMachine.casPersist(workspaceId, instance)
    return this.advanceDeployerFrames(workspaceId, instance, step, block, isFinalStep, targets)
  }

  /**
   * Poll a `deployer` step's dispatched CONTAINER-backed deploy job (the async kustomize/helm
   * path) through the environment provisioning service — NOT the agent executor. Mirrors
   * `pollAgentJob`: surfaces live container/subtask progress while running, recovers a
   * container eviction by re-dispatching a fresh deploy job (within the same budgets), and on a
   * genuine terminal state finalizes the job into an environment record + the step result.
   */
  async pollDeployerJob(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
  ): Promise<AdvanceResult> {
    const ref: RunnerJobRef = { runId: instance.id, jobId: step.jobId! }
    // The service frame this in-flight deploy job is provisioning (a multi-env fan-out dispatches
    // one job per frame). Falls back to the own frame for a single-frame deploy that predates the
    // discriminator / never fanned out.
    const inFlightFrameId = step.deployFrameId ?? undefined
    // Let a status-read failure THROW to the driver, exactly as `pollAgentJob` lets
    // `executor.pollJob` throw: the driver counts consecutive read failures and fast-fails the
    // run as `timeout` once `jobPollFailureTolerance` is hit. Swallowing it here would hide every
    // read failure from that counter, so an unreachable deploy container would only stop at the
    // full `jobMaxPolls` budget with a misleading "did not finish" message.
    const view = await this.environmentProvisioning!.pollProvisionJob(workspaceId, ref)
    if (view.state === 'running') {
      let changed = false
      if (this.applyContainerRunning(step, view)) changed = true
      if (this.applySubtaskProgress(step, view.progress)) changed = true
      if (
        await this.attachEnvironmentProjection(workspaceId, instance.blockId, step, inFlightFrameId)
      ) {
        changed = true
      }
      if (changed) {
        await this.runStateMachine.casPersist(workspaceId, instance)
        // Progress-only deploy-job fold: skip the LLM-metrics rollup (same reason as the
        // agent running fold — a deploy job makes no LLM calls anyway).
        await this.runStateMachine.emitInstance(workspaceId, instance, { rollUpMetrics: false })
      }
      return { kind: 'awaiting_job', jobId: step.jobId!, stepIndex: instance.currentStep }
    }

    // The deploy container vanished (evicted/crashed). The shared recovery re-dispatches a fresh
    // deploy job (the driver loops back into `runDeployerStep`, which re-provisions the same
    // un-settled frame since `step.jobId` is cleared) within the same per-flavour budgets as the
    // agent path, reclaiming the dead job's runner first. Null for a non-eviction failure.
    if (view.state === 'failed') {
      const recovered = await this.recoverContainerEviction(
        workspaceId,
        instance,
        step,
        view.error,
        view.evicted,
        () => this.environmentProvisioning!.releaseProvisionJob(workspaceId, ref).catch(() => {}),
      )
      if (recovered) return recovered
    }

    // Genuine terminal (done, or a non-eviction failure): finalize the deploy job into an
    // environment record and record this frame's outcome. A `failed` view maps to a failed env,
    // which `settleDeployerFrame` surfaces as a displayed step failure.
    const block = await this.blockRepository.get(workspaceId, instance.blockId)
    if (!block) return { kind: 'noop' }
    const isFinalStep = instance.currentStep === instance.steps.length - 1
    // Resolve the full target set once (also drives the remaining-frames fan-out after this one
    // settles), honouring the pinned primary frame. Derive the own/primary frame id from that set
    // rather than a SECOND `resolveServiceFrameId` point-read walk — the primary target's frame id
    // is the own frame (pinned, so a mid-flight reparent can't flip an own failure to a peer one).
    const targets = await this.resolveDeployTargets(workspaceId, block, step.deployPrimaryFrameId)
    const ownFrameId =
      step.deployPrimaryFrameId ?? targets.find((t) => t.isPrimary)?.frameId ?? block.id
    const frameId = inFlightFrameId ?? ownFrameId
    // Recover the in-flight frame's real service-frame block from the target set so finalize
    // provisions with the FRAME's identity/inputs (a peer's env must not reuse the task block's —
    // see {@link deployerProvisionArgs}); fall back to a point-read (then the task block) if a
    // connection was removed mid-flight so the frame is no longer a target.
    const known = targets.find((t) => t.frameId === frameId)
    const frame = known?.frame ?? (await this.blockRepository.get(workspaceId, frameId)) ?? block
    // Map the job against the provisioning config the container was BUILT from (pinned at
    // dispatch), not a fresh read of the frame a person may have edited mid-flight — else a
    // config flip (e.g. → `infraless`) would fail a deploy whose container already succeeded. The
    // pinned config is the in-flight frame's; the fallback resolution is only ever hit for the
    // undeclared-own compat path (which resolves the own frame correctly).
    const provisioning =
      step.deployProvisioning ?? (await this.resolveServiceProvisioning(workspaceId, block))
    const target: DeployTarget = { frameId, isPrimary: frameId === ownFrameId, provisioning, frame }
    step.jobId = undefined
    step.deployFrameId = undefined
    step.subtasks = undefined
    // The one-shot deploy container reached a terminal state: reclaim its runner now rather than
    // letting it idle out its sleepAfter window (billed-but-useless compute) / leak a self-hosted
    // pool slot. The deploy job is dispatched SEPARATELY from the shared per-run container, so the
    // agent path's `stopRunContainer` (final step only, run-id keyed) never reclaims it.
    // Best-effort/idempotent.
    await this.environmentProvisioning!.releaseProvisionJob(workspaceId, ref).catch(() => {})
    let handle
    try {
      handle = await this.environmentProvisioning!.finalizeProvision(
        await this.deployerProvisionArgs(workspaceId, instance, block, target, ''),
        view,
      )
    } catch (error) {
      // The deploy container is gone (released above) but finalize failed: stamp the container
      // errored so the failed details don't keep showing it "up". A primary failure is terminal; a
      // peer's is not (the fan-out proceeds), so route through `settleDeployerFailure`.
      if (step.container) step.container = { ...step.container, status: 'errored' }
      step.deployProvisioning = undefined
      return this.settleDeployerFailure(
        workspaceId,
        instance,
        step,
        block,
        isFinalStep,
        targets,
        target,
        null,
        getErrorMessage(error),
      )
    }
    step.deployProvisioning = undefined
    // Reflect the container's terminal state from the RESOLVED outcome, not the raw view: a `done`
    // view the provider maps to a FAILED env (e.g. the harness exited 0 but the namespace is
    // missing) must still show the container errored — keying off `view.state` alone missed that.
    if (handle.status === 'failed' && step.container) {
      step.container = { ...step.container, status: 'errored' }
    }
    return this.settleDeployerFrame(
      workspaceId,
      instance,
      step,
      block,
      isFinalStep,
      targets,
      target,
      handle,
    )
  }

  /**
   * The {@link ProvisionArgs} for provisioning ONE target frame's environment (synchronous or
   * async). The env is keyed by the task `block.id` + the target `frameId` — so a task's own env
   * and each involved-service env coexist under the same block, discriminated by frame (see the
   * per-`(blockId, frameId)` supersede). The repo/clone the provider resolves is the TARGET
   * FRAME's (via `frameId`), so an involved-service env clones that peer's repo at its default
   * branch, while the OWN frame targets the task's PR branch (its git/PR context); a peer carries
   * no PR context. The `{{input.*}}` identity (blockId/title/…) is the TARGET FRAME's for a peer
   * (see {@link deployTargetInputs}) so each peer's provider namespace is distinct — the task-
   * scoped inputs would collapse every peer onto one namespace. Injects `frontendOrigins` (the
   * browser origins binding this service) and `peerEnvUrls` (the already-ready peers) too.
   */
  private async deployerProvisionArgs(
    workspaceId: string,
    instance: ExecutionInstance,
    block: Block,
    target: DeployTarget,
    peerEnvUrls: string,
  ): Promise<ProvisionArgs> {
    const frontendOrigins = await this.frontendOriginsInput(workspaceId, target.frameId)
    // The OWN frame deploys the task's PR branch (its git/PR context); an involved peer carries no
    // PR context, so its clone target falls back to that repo's default branch.
    const context = target.isPrimary ? this.deployContext(block) : { blockId: block.id }
    return {
      workspaceId,
      blockId: block.id,
      frameId: target.frameId,
      executionId: instance.id,
      inputs: {
        ...this.deployTargetInputs(block, target),
        ...(frontendOrigins ? { frontendOrigins } : {}),
        ...(peerEnvUrls ? { peerEnvUrls } : {}),
      },
      context,
      ...(target.provisioning ? { serviceProvisioning: target.provisioning } : {}),
      initiatedBy: instance.initiatedBy,
    }
  }

  /**
   * The `{{input.*}}` identity a target frame provisions with. The OWN frame keeps the historical
   * task-scoped inputs (its namespace is uniquified by the task's PR repo/number). An involved PEER
   * frame is scoped to the PEER FRAME's identity, with a `(task, peer)` composite `blockId` — so
   * the provider namespace derived from `{{input.blockId}}` is distinct per peer AND per task,
   * where the task-scoped inputs would collapse every peer of a task onto ONE namespace (each
   * clobbering the previous, teardown deleting the wrong one).
   */
  private deployTargetInputs(block: Block, target: DeployTarget): Record<string, string> {
    if (target.isPrimary) return this.deployInputs(block)
    return {
      blockId: `${block.id}-${target.frameId}`,
      title: target.frame.title,
      type: target.frame.type,
      description: target.frame.description,
    }
  }

  /**
   * The `frontendOrigins` provision input for a service frame: the comma-joined browser origins
   * of every `frontend` frame that binds this service (see `frontendOriginsForService`), for a
   * manifest to fold into the backend's CORS allow-list via `{{input.frontendOrigins}}`. Empty
   * string when no frontend binds it (the key is then omitted). One workspace block-list read —
   * no per-frame point read (mirrors the visual-pipeline gate).
   */
  async frontendOriginsInput(workspaceId: string, serviceFrameId: string): Promise<string> {
    const blocks = await this.blockRepository.listByWorkspace(workspaceId)
    return frontendOriginsForService(serviceFrameId, blocks).join(',')
  }

  /**
   * Turn a provisioned environment handle into the `deployer` step's advance result: a `failed`
   * env is surfaced as a displayed step failure (its `lastError` renders in the Environment
   * panel); otherwise the env summary (status / URL / provision type / engine) is recorded as the
   * step output. Shared by the synchronous and async-finalized provision paths.
   */
  private async completeDeployerStep(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    isFinalStep: boolean,
    targets: readonly DeployTarget[],
  ): Promise<AdvanceResult> {
    const byFrame = new Map(targets.map((t) => [t.frameId, t]))
    const primaryFrameId = step.deployPrimaryFrameId ?? targets.find((t) => t.isPrimary)?.frameId
    // Re-project the now-final OWN environment (ready/expired + URL) so the deployer step's
    // Environment panel + the downstream tester see the task's own service env, not a peer's or the
    // dispatch-time `provisioning` snapshot the async poll last wrote. Pass the pinned primary frame
    // so it needn't re-walk the tree to find the own frame.
    await this.attachEnvironmentProjection(workspaceId, instance.blockId, step, primaryFrameId)
    // Summarise from the recorded per-frame OUTCOMES (`deployEnvs`), NOT the current `targets`: a
    // mid-flight involved-services / connection edit can drop a frame from `targets` while its env
    // is still recorded and live, so iterating outcomes keeps that env visible (never silently
    // orphaned). Titles come from the target set when the frame is still resolvable, else the id.
    const done = step.deployEnvs ?? {}
    const titleOf = (frameId: string): string => byFrame.get(frameId)?.frame.title ?? frameId
    const isPrimaryFrame = (frameId: string): boolean =>
      byFrame.get(frameId)?.isPrimary ?? frameId === primaryFrameId
    const readyEntries = Object.entries(done).filter(([, env]) => env.status === 'ready')
    if (readyEntries.length === 0) {
      // Every target was `infraless`/library/skipped — nothing stood up (the single-service
      // infraless case plus the all-infraless fan-out). A `library` frame reports its own reason
      // (it is never deployed) so the run timeline stays explainable, per the frame profile.
      const primaryFrame = primaryFrameId ? byFrame.get(primaryFrameId)?.frame : undefined
      const output =
        primaryFrame && !frameProfile(primaryFrame.type).deployable
          ? 'Library frame; no deployment or environment provisioned.'
          : 'Service is infraless; no environment provisioned.'
      return this.recordStepResult(workspaceId, instance, step, isFinalStep, {
        output,
        model: 'environment:none',
      })
    }
    const own = step.environment
    const lines: string[] = []
    for (const [frameId, env] of readyEntries) {
      const url = env.url ?? '(pending)'
      lines.push(
        isPrimaryFrame(frameId)
          ? `Provisioned ephemeral environment for '${titleOf(frameId)}': ${url}`
          : `Provisioned involved-service environment for '${titleOf(frameId)}': ${url}`,
      )
    }
    // A PEER frame that failed is non-terminal (the own deploy proceeded); note it so the failure
    // is visible rather than silently absent from the fan-out summary. (A primary failure never
    // reaches here — it fails the step in `settleDeployerFailure`.)
    for (const [frameId, env] of Object.entries(done)) {
      if (env.status !== 'failed' || isPrimaryFrame(frameId)) continue
      lines.push(
        `Involved-service environment for '${titleOf(frameId)}' failed: ${env.error ?? 'unknown error'}`,
      )
    }
    if (own?.expiresAt) lines.push(`Expires: ${new Date(own.expiresAt).toISOString()}`)
    if (own?.provisionType) lines.push(`Provision type: ${own.provisionType}`)
    if (own?.engine) lines.push(`Engine: ${own.engine}`)
    return this.recordStepResult(workspaceId, instance, step, isFinalStep, {
      output: lines.join('\n'),
      model: `environment:${readyEntries.length > 1 ? 'multi' : (own?.engine ?? 'single')}`,
    })
  }

  /**
   * Resolve the SERVICE frame's declared provisioning for a run block. The run may target a
   * task/module nested under the frame, so walk up to the frame (mirrors the blueprint /
   * tester-gate resolution) and read its `provisioning`. Returns null when undeclared.
   */
  private async resolveServiceProvisioning(
    workspaceId: string,
    block: Block,
  ): Promise<ServiceProvisioning | undefined> {
    const frameId =
      (await this.contextBuilder.resolveServiceFrameId(workspaceId, block.id)) ?? block.id
    const frame =
      frameId === block.id ? block : await this.blockRepository.get(workspaceId, frameId)
    return frame?.provisioning
  }

  /**
   * Stamp the errored environment onto the deployer step (so its details show the verbatim
   * `lastError`), persist + emit, then return a structured `environment` failure carrying the
   * provider's message as the detail. Mirrors `handleAgentStep`'s dispatch-failure path.
   */
  private async failDeployerStep(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    frameId: string,
    message: string,
    /** Machine-readable cause (e.g. `deploy_runner_unwired`) surfaced on the failure so the SPA
     *  renders precise guidance without string-matching the prose. */
    reason?: string,
  ): Promise<AdvanceResult> {
    // Project the FAILED frame's env (so its `lastError` renders in the Environment panel) — for a
    // single-frame deploy that is the own env; for a failed involved-service env it surfaces the
    // peer's error rather than a sibling's healthy env.
    await this.attachEnvironmentProjection(workspaceId, instance.blockId, step, frameId)
    await this.runStateMachine.casPersist(workspaceId, instance)
    await this.runStateMachine.emitInstance(workspaceId, instance)
    return {
      kind: 'job_failed',
      error: 'Environment provisioning failed.',
      failureKind: 'environment',
      detail: message,
      ...(reason ? { reason } : {}),
    }
  }

  /** Provision inputs (`{{input.*}}`) derived from the block under deployment. */
  deployInputs(block: Block): Record<string, string> {
    const inputs: Record<string, string> = {
      blockId: block.id,
      title: block.title,
      type: block.type,
      description: block.description,
    }
    return inputs
  }

  /**
   * Typed git/PR/repo context for the deployer, derived from the block's PR ref. A
   * PR-environment provider (e.g. an in-house adapter) needs the branch/repo to target
   * the right environment; the same values are also flattened into `{{input.*}}` for
   * the manifest path. `owner`/`repo` are parsed from the PR url when present.
   */
  deployContext(block: Block): ProvisionContext {
    const context: ProvisionContext = { blockId: block.id }
    const pr = block.pullRequest
    if (!pr) return context
    if (pr.branch) context.branch = pr.branch
    if (pr.number !== undefined) context.pullNumber = pr.number
    if (pr.url) {
      context.pullUrl = pr.url
      const repo = parseRepoFromPullUrl(pr.url)
      if (repo) {
        context.repoOwner = repo.owner
        context.repoName = repo.repo
      }
    }
    return context
  }
}
