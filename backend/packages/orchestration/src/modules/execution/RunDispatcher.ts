import type {
  AgentExecutor,
  AgentJobHandle,
  AgentRunContext,
  AgentRunResult,
  AgentStepSpec,
  Block,
  BlockRepository,
  BlueprintService,
  BrainstormSession,
  ClarityReview,
  Clock,
  EnvironmentHandle,
  ExecutionEventPublisher,
  ExecutionInstance,
  ExecutionRepository,
  FollowUpItem,
  FollowUpsStepState,
  GateContext,
  GateDefinition,
  GateHelperJobResult,
  IdGenerator,
  IssueWritebackProvider,
  PipelineStep,
  ProviderCapabilities,
  ProvisionContext,
  RepoFiles,
  RepoOp,
  RequirementConcernLevel,
  RequirementReview,
  ResolveRunRepoContext,
  ResolverContext,
  RunInitiatorScope,
  RunnerJobRef,
  RunRepoContext,
  ServiceProvisioning,
  StepCompletionResolver,
  StreamedFollowUp,
  TicketTrackerProvider,
  WorkRunner,
} from '@cat-factory/kernel'
import {
  ConflictError,
  DEFAULT_MERGE_PRESET,
  getErrorMessage,
  getProvider,
  isAsyncAgentExecutor,
  NotFoundError,
  parseLocalModelId,
  recordGateAttempt,
  registeredGateFactories,
  registeredStepResolverFactories,
  requireProvider,
  sameSubtasks,
} from '@cat-factory/kernel'
import { parseBlueprintService, parseSpecDoc } from '@cat-factory/contracts'
import {
  blueprintPostOp,
  isCompanionKind,
  isContainerBackedCompanion,
  registeredAgentStep,
  registeredPostOps,
  registeredPreOps,
  runRepoOps,
  specPostOp,
  TASK_ESTIMATOR_AGENT_KIND,
} from '@cat-factory/agents'
import { DEPLOYER_AGENT_KIND, isDeployStep } from '@cat-factory/integrations'
import type {
  EnvironmentProvisioningService,
  ProvisionArgs,
  ProvisionDispatch,
} from '@cat-factory/integrations'
import { coerceTaskEstimate, summarizeEstimate } from '../estimation/estimate.logic.js'
import { reviewableArtifactOutput } from './artifact-review.logic.js'
import { deployEvictionEpoch, deployJobId } from './deployer.logic.js'
import {
  ANALYSIS_AGENT_KIND,
  ARCHITECTURE_BRAINSTORM_AGENT_KIND,
  BLUEPRINTS_AGENT_KIND,
  CLARITY_REVIEW_AGENT_KIND,
  CONFLICTS_AGENT_KIND,
  HUMAN_TEST_AGENT_KIND,
  isTesterKind,
  MERGER_AGENT_KIND,
  REQUIREMENTS_BRAINSTORM_AGENT_KIND,
  REQUIREMENTS_REVIEW_AGENT_KIND,
  SPEC_WRITER_AGENT_KIND,
  TESTER_AGENT_KIND,
  TRACKER_AGENT_KIND,
  UI_TESTER_AGENT_KIND,
  VISUAL_CONFIRM_AGENT_KIND,
} from './ci.logic.js'
import {
  followUpsToSendBack,
  hasPendingFollowUps,
  renderFollowUpRework,
  shouldLoopCoder,
} from './followUp.logic.js'
import {
  agentFailureKindFromCause,
  classifyAgentFailure,
  isContainerEvictionError,
  isTransientEviction,
  MAX_EVICTION_RECOVERIES,
  MAX_TRANSIENT_EVICTION_RECOVERIES,
} from './job.logic.js'
import { AgentContextBuilder } from './AgentContextBuilder.js'
import { CompanionController } from './CompanionController.js'
import { HumanTestController } from './HumanTestController.js'
import { MergeResolver } from './MergeResolver.js'
import { ReviewGateController, type ReviewKind } from './ReviewGateController.js'
import { RunStateMachine } from './RunStateMachine.js'
import { StepGraph } from './StepGraph.js'
import { TesterController } from './TesterController.js'
import { VisualConfirmationController } from './VisualConfirmationController.js'
import {
  FALLTHROUGH_STEP_HANDLER_ORDER,
  type StepCompletionContext,
  type StepCompletionInterceptor,
  type StepHandler,
  type StepHandlerContext,
} from './step-handler-registry.js'
import type { AdvanceOptions, AdvanceResult } from './advance.js'
import type { NotificationService } from '../notifications/NotificationService.js'
import type { SpendService } from '@cat-factory/spend'
import type { BlueprintReconciler } from './ExecutionService.js'

/**
 * The task's fully-resolved merge-threshold preset (block pin → workspace default →
 * built-in). The dispatcher only reads the gate-relevant fields; the full shape is kept so
 * a gate's `attemptBudget(preset)` sees every knob. Mirrors {@link ExecutionService.resolveMergePreset}.
 */
type ResolvedMergePreset = {
  maxComplexity: number
  maxRisk: number
  maxImpact: number
  ciMaxAttempts: number
  maxRequirementIterations: number
  maxRequirementConcernAllowed: RequirementConcernLevel
  releaseWatchWindowMinutes: number
  releaseMaxAttempts: number
  humanReviewGraceMinutes: number
}

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

/**
 * The inline review/brainstorm gate kinds, all driven through the {@link ReviewGateController}
 * by the dispatcher's `review-gate` StepHandler. Kept in sync with the handler's `switch`.
 */
const REVIEW_GATE_AGENT_KINDS: ReadonlySet<string> = new Set([
  REQUIREMENTS_REVIEW_AGENT_KIND,
  CLARITY_REVIEW_AGENT_KIND,
  REQUIREMENTS_BRAINSTORM_AGENT_KIND,
  ARCHITECTURE_BRAINSTORM_AGENT_KIND,
])

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

/** Collaborators + leaf dependencies the {@link RunDispatcher} needs. */
export interface RunDispatcherDeps {
  blockRepository: BlockRepository
  executionRepository: ExecutionRepository
  agentExecutor: AgentExecutor
  workRunner: WorkRunner
  events: ExecutionEventPublisher
  idGenerator: IdGenerator
  clock: Clock
  spend: SpendService
  stepGraph: StepGraph
  runStateMachine: RunStateMachine
  contextBuilder: AgentContextBuilder
  mergeResolver: MergeResolver
  companionController: CompanionController
  testerController: TesterController
  humanTestController: HumanTestController
  visualConfirmationController: VisualConfirmationController
  reviewGate: ReviewGateController
  requirementsKind: ReviewKind<RequirementReview>
  clarityKind: ReviewKind<ClarityReview>
  requirementsBrainstormKind: ReviewKind<BrainstormSession>
  architectureBrainstormKind: ReviewKind<BrainstormSession>
  runInitiatorScope: RunInitiatorScope
  environmentProvisioning?: EnvironmentProvisioningService
  ticketTrackerProvider?: TicketTrackerProvider
  issueWriteback?: IssueWritebackProvider
  notificationService?: NotificationService
  blueprintReconciler?: BlueprintReconciler
  resolveRunRepoContext?: ResolveRunRepoContext
  resolveProviderCapabilities?: (
    workspaceId: string,
    initiatedBy?: string | null,
  ) => Promise<ProviderCapabilities>
  /** Resolve a task's merge preset (stays on the engine, shared with the merge subgraph). */
  resolveMergePreset: (workspaceId: string, block: Block) => Promise<ResolvedMergePreset>
  /** Whether a resolved model id incurs metered monetary cost (the start gate's predicate). */
  modelIdIsMetered: (id: string | undefined, caps: ProviderCapabilities) => boolean
}

/**
 * The per-step dispatch + completion spine of the execution engine. It owns the four
 * registries (step handlers, completion interceptors, post-completion / terminal resolvers,
 * polling gates), the completion hub (`recordStepResult` / `handleAgentStep`), the gate
 * machinery (`evaluateGate` / `dispatchGateHelper` / `pollGate` / `resolveGatePollExhaustion`),
 * the deterministic `deployer` / `tracker` steps, the registered pre/post-op cluster, the
 * structured-artifact ingest helpers, and the follow-up companion gate + its human-action API.
 *
 * Extracted out of `ExecutionService` so the handlers depend on a cohesive surface rather than
 * a fat per-callback bag. It composes the existing collaborators ({@link RunStateMachine} /
 * {@link StepGraph} / the five gate controllers / {@link MergeResolver}); the merge/auto-start
 * subgraph deliberately STAYS on the engine, reached only through the injected
 * `resolveMergePreset` callback + the {@link MergeResolver} (which itself closes over the
 * engine's `finalizeMerge`). `ExecutionService.stepInstance` / `pollAgentJob` / `pollGate`
 * delegate here; no behaviour changes in the move.
 */
export class RunDispatcher {
  private readonly blockRepository: BlockRepository
  private readonly executionRepository: ExecutionRepository
  private readonly agentExecutor: AgentExecutor
  private readonly workRunner: WorkRunner
  private readonly events: ExecutionEventPublisher
  private readonly idGenerator: IdGenerator
  private readonly clock: Clock
  private readonly spend: SpendService
  private readonly stepGraph: StepGraph
  private readonly runStateMachine: RunStateMachine
  private readonly contextBuilder: AgentContextBuilder
  private readonly mergeResolver: MergeResolver
  private readonly companionController: CompanionController
  private readonly testerController: TesterController
  private readonly humanTestController: HumanTestController
  private readonly visualConfirmationController: VisualConfirmationController
  private readonly reviewGate: ReviewGateController
  private readonly requirementsKind: ReviewKind<RequirementReview>
  private readonly clarityKind: ReviewKind<ClarityReview>
  private readonly requirementsBrainstormKind: ReviewKind<BrainstormSession>
  private readonly architectureBrainstormKind: ReviewKind<BrainstormSession>
  private readonly runInitiatorScope: RunInitiatorScope
  private readonly environmentProvisioning?: EnvironmentProvisioningService
  private readonly ticketTrackerProvider?: TicketTrackerProvider
  private readonly issueWriteback?: IssueWritebackProvider
  private readonly notificationService?: NotificationService
  private readonly blueprintReconciler?: BlueprintReconciler
  private readonly resolveRunRepoContext?: ResolveRunRepoContext
  private readonly resolveProviderCapabilities?: (
    workspaceId: string,
    initiatedBy?: string | null,
  ) => Promise<ProviderCapabilities>
  private readonly resolveMergePreset: (
    workspaceId: string,
    block: Block,
  ) => Promise<ResolvedMergePreset>
  private readonly modelIdIsMetered: (id: string | undefined, caps: ProviderCapabilities) => boolean

  /** Lazily-built polling-gate registry, keyed by `agentKind`. See {@link gateFor}. */
  private gateRegistryCache?: Map<string, GateDefinition>
  /** Lazily-built post-completion resolver registry, keyed by `agentKind`. */
  private stepResolverCache?: Map<string, StepCompletionResolver>
  /** Lazily-built, order-sorted per-step-kind handler list. See {@link dispatchStepHandler}. */
  private stepHandlerCache?: StepHandler[]
  /** Lazily-built, order-sorted completion-path interceptor list. */
  private stepCompletionInterceptorCache?: StepCompletionInterceptor[]

  constructor(deps: RunDispatcherDeps) {
    this.blockRepository = deps.blockRepository
    this.executionRepository = deps.executionRepository
    this.agentExecutor = deps.agentExecutor
    this.workRunner = deps.workRunner
    this.events = deps.events
    this.idGenerator = deps.idGenerator
    this.clock = deps.clock
    this.spend = deps.spend
    this.stepGraph = deps.stepGraph
    this.runStateMachine = deps.runStateMachine
    this.contextBuilder = deps.contextBuilder
    this.mergeResolver = deps.mergeResolver
    this.companionController = deps.companionController
    this.testerController = deps.testerController
    this.humanTestController = deps.humanTestController
    this.visualConfirmationController = deps.visualConfirmationController
    this.reviewGate = deps.reviewGate
    this.requirementsKind = deps.requirementsKind
    this.clarityKind = deps.clarityKind
    this.requirementsBrainstormKind = deps.requirementsBrainstormKind
    this.architectureBrainstormKind = deps.architectureBrainstormKind
    this.runInitiatorScope = deps.runInitiatorScope
    this.environmentProvisioning = deps.environmentProvisioning
    this.ticketTrackerProvider = deps.ticketTrackerProvider
    this.issueWriteback = deps.issueWriteback
    this.notificationService = deps.notificationService
    this.blueprintReconciler = deps.blueprintReconciler
    this.resolveRunRepoContext = deps.resolveRunRepoContext
    this.resolveProviderCapabilities = deps.resolveProviderCapabilities
    this.resolveMergePreset = deps.resolveMergePreset
    this.modelIdIsMetered = deps.modelIdIsMetered
  }

  /**
   * The generic container/inline-agent step — the lowest-priority StepHandler, claiming
   * every step no more-specific handler did (coder, architect, spec-writer, merger,
   * task-estimator, the container-backed companions, …). Builds the agent context, runs the
   * kind's pre-ops, then either dispatches an async container job and parks (the durable
   * driver polls between sleeps) or runs the inline LLM call and records the result. This is
   * what the dispatch chain falls through to; all the deterministic / gate / inline-review
   * kinds are claimed earlier by their own handlers (see {@link buildStepHandlerRegistry}).
   */
  private async handleAgentStep(ctx: StepHandlerContext): Promise<AdvanceResult> {
    const { workspaceId, instance, step, block, isFinalStep, options } = ctx

    // Async (container) steps don't block: dispatch the job and park. The durable
    // driver polls `pollAgentJob` between sleeps so the run can span far longer
    // than a single durable step's timeout, while each step stays short. A set
    // `jobId` means a prior (possibly replayed) dispatch already started the job,
    // so we re-attach instead of starting a duplicate.
    const context = await this.contextBuilder.buildContext(
      workspaceId,
      instance,
      step,
      isFinalStep,
      block,
    )
    // A registered custom kind's PRE-ops run deterministic backend repo work before the
    // agent dispatches (e.g. read a baseline `spec/` shard into the prompt). Gated on the
    // step not having dispatched yet so a Workflows replay (jobId already set) doesn't
    // re-run them; a no-op for built-in kinds and when GitHub isn't wired.
    if (!step.jobId) {
      await this.runRegisteredPreOps(workspaceId, block, step, context)
    }
    const executor = this.agentExecutor
    if (isAsyncAgentExecutor(executor) && executor.runsAsync(context)) {
      if (!step.jobId) {
        // The model is fixed the moment its ref resolves (block pin > workspace
        // default > env routing) — long before the container is up — so name it on
        // the very first "spinning up container" emit instead of waiting for the
        // dispatch to return. startJob confirms the same value below.
        const previewModel = await this.previewStepModel(context)
        if (previewModel) step.model = previewModel
        // Surface the explicit container lifecycle for the cold-boot window: dispatch
        // blocks until the per-run container is up and has accepted the job, so emitting
        // `starting` now lets the details show the boot (and then the live phase + the
        // container id/url) instead of a blank "working" state.
        step.container = { status: 'starting' }
        // Surface the block's ephemeral environment (if any) alongside the cold-boot
        // phase, so a run's details show the env spinning up next to the container.
        await this.attachEnvironmentProjection(workspaceId, instance.blockId, step)
        await this.executionRepository.upsert(workspaceId, instance)
        await this.runStateMachine.emitInstance(workspaceId, instance)

        let handle: AgentJobHandle
        try {
          handle = await executor.startJob(context)
        } catch (error) {
          // The container/runner never accepted the job (a dispatch HTTP error, a
          // missing backend, a capacity blip). Surface the EXACT provider/runtime
          // response and classify it as a `dispatch` failure ("container failed to
          // start") so the run details say the container never started — not a generic
          // "run failed". A dispatch-time eviction still routes to the evicted framing.
          step.container = { status: 'errored' }
          await this.executionRepository.upsert(workspaceId, instance)
          await this.runStateMachine.emitInstance(workspaceId, instance)
          const message = getErrorMessage(error)
          const evicted = isContainerEvictionError(message)
          return {
            kind: 'job_failed',
            error: evicted ? message : 'The container failed to start.',
            failureKind: evicted ? 'evicted' : 'dispatch',
            detail: message,
          }
        }
        step.jobId = handle.jobId
        // Record the model at dispatch — the poll site can't resolve it later.
        if (handle.model) step.model = handle.model
        // The dispatch returned, so the container is up and the job is accepted; the
        // live phase + the container id/url arrive on the first poll.
        step.container = { status: 'up' }
        await this.executionRepository.upsert(workspaceId, instance)
        await this.runStateMachine.emitInstance(workspaceId, instance)
      }
      return { kind: 'awaiting_job', jobId: step.jobId, stepIndex: instance.currentStep }
    }

    // Inline path: the model is resolved before the (blocking) LLM call, so surface
    // it now — the board names the model while the step is querying instead of only
    // once the result lands. recordStepResult re-asserts it from the result.
    const previewModel = await this.previewStepModel(context)
    if (previewModel && previewModel !== step.model) {
      step.model = previewModel
      await this.executionRepository.upsert(workspaceId, instance)
      await this.runStateMachine.emitInstance(workspaceId, instance)
    }

    const result = await this.runAgent(context, options)
    return this.recordStepResult(workspaceId, instance, step, isFinalStep, result)
  }

  /**
   * Preview the model a step will run (`provider:model`) ahead of the work, so the
   * board can show it during the inline query / container cold-boot rather than only
   * once the result or job handle lands. Best-effort: the executor may not implement
   * a preview, and a resolution failure (e.g. an unwired container kind that fails at
   * dispatch anyway) must never break the run — both yield undefined.
   */
  async previewStepModel(context: AgentRunContext): Promise<string | undefined> {
    if (!this.agentExecutor.resolveModel) return undefined
    try {
      return await this.agentExecutor.resolveModel(context)
    } catch {
      return undefined
    }
  }

  /**
   * Whether the current step incurs NO metered monetary LLM cost, so the spend gate can
   * let it proceed even when the budget is exhausted. Two non-metered cases:
   *  - a flat-rate SUBSCRIPTION (quota) model — Claude Code / Codex on a pooled token;
   *    resolved through the executor (the authority on "subscriptions always win").
   *  - a LOCAL-runner model (Ollama / LM Studio / …) — keyless, runs on the user's own
   *    endpoint, so it costs the deployment nothing; detected off the resolved model id.
   * This is what makes a `0` budget mean "no PAID spend" without bricking a workspace that
   * deliberately runs only local models or subscriptions (see the spend-budget docs).
   *
   * Once the executor resolves the step's concrete model id, the metered/non-metered
   * decision is delegated to the SAME {@link modelIdIsMetered} predicate the up-front
   * {@link assertBudgetAllowsPipeline} gate uses, so the two gates can't classify a model
   * differently (a divergence would let a run pass the start gate then immediately pause,
   * or vice versa). The executor's `isQuotaBased` is still consulted first as the
   * authoritative subscription-routing signal; the shared predicate covers local-runner +
   * subscription-by-capability + Cloudflare classification identically to the start gate.
   * Falls back to a bare local-id check when no capability resolver is wired.
   *
   * Best-effort and side-effect-free: an executor without the capability, a missing block,
   * or any resolution error all report false (treated as budget-metered, the prior
   * behaviour). Only consulted on the over-budget path, so it never touches the happy path.
   */
  async currentStepIsNonMetered(
    workspaceId: string,
    instance: ExecutionInstance,
    step: ExecutionInstance['steps'][number],
  ): Promise<boolean> {
    try {
      const block = await this.blockRepository.get(workspaceId, instance.blockId)
      if (!block) return false
      const isFinalStep = instance.currentStep === instance.steps.length - 1
      const context = await this.contextBuilder.buildContext(
        workspaceId,
        instance,
        step,
        isFinalStep,
        block,
      )
      if (this.agentExecutor.isQuotaBased && (await this.agentExecutor.isQuotaBased(context))) {
        return true
      }
      if (this.agentExecutor.resolveModel) {
        const modelId = await this.agentExecutor.resolveModel(context)
        // Classify the resolved id through the shared predicate (same as the start gate)
        // when capabilities are wired; else fall back to the bare local-runner check.
        if (this.resolveProviderCapabilities) {
          const caps = await this.resolveProviderCapabilities(workspaceId, instance.initiatedBy)
          if (!this.modelIdIsMetered(modelId, caps)) return true
        } else if (parseLocalModelId(modelId)) {
          return true
        }
      }
      return false
    } catch {
      return false
    }
  }

  /**
   * Poll the asynchronous job a parked step dispatched. Returns `awaiting_job`
   * while it runs (the driver keeps polling), records the result and advances on
   * success, or reports `job_failed` so the driver can fail the run. Reading run
   * state from storage on every call keeps it safe under Workflows replay/retry:
   * once a job's result is recorded the step's `jobId` is cleared, so a re-poll
   * simply lets the driver advance the now-current step.
   */
  async pollAgentJob(workspaceId: string, executionId: string): Promise<AdvanceResult> {
    const instance = await this.executionRepository.get(workspaceId, executionId)
    if (!instance || (instance.status !== 'running' && instance.status !== 'paused')) {
      return { kind: 'noop' }
    }
    const step = instance.steps[instance.currentStep]
    if (!step) return { kind: 'noop' }
    // No job in flight: a prior poll already recorded it (and advanced). Let the
    // driver loop and advance whatever step is now current.
    if (!step.jobId) return { kind: 'continue' }

    // A `deployer` step's async job is a CONTAINER-backed deploy (kustomize/helm), polled
    // through the environment provisioning service — NOT the agent executor. Route it before
    // the executor resolution below (the deployer never goes through the agent executor).
    if (isDeployStep(step.agentKind) && this.environmentProvisioning) {
      return this.pollDeployerJob(workspaceId, instance, step)
    }

    const executor = this.agentExecutor
    if (!isAsyncAgentExecutor(executor)) return { kind: 'noop' }

    // Re-supply the run id alongside the per-step job id so the executor can address
    // the same per-run container at the poll site (it only stored the per-step jobId).
    // The agent kind is supplied too: the container executor maps a migrated
    // `merger`/`on-call`'s structured result into `mergeAssessment`/`onCallAssessment`
    // KIND-AWARE in `toRunResult`, so without it that coercion no-ops and the merge gate /
    // post-release-health gate would see no assessment.
    const update = await executor.pollJob({
      jobId: step.jobId,
      runId: executionId,
      workspaceId,
      agentKind: step.agentKind,
    })
    if (update.state === 'running') {
      // A successful poll proves the container is up, so the cold-boot phase is
      // over (defensive: a replay may have left the flag set). Surface live subtask
      // progress (e.g. 3/8 todos done) without advancing the step. Only persist +
      // emit when something actually changed so an idle poll doesn't churn storage
      // or the event stream.
      let changed = false
      // A successful poll proves the container is up: reflect that, the live phase
      // (clone / agent / push) and the container's id/url the transport surfaced.
      if (this.applyContainerRunning(step, update)) changed = true
      if (this.applySubtaskProgress(step, update.subtasks)) changed = true
      // Append any forward-looking items the Coder streamed since the last poll so the
      // Follow-up companion lights up + accrues items LIVE while the container still runs.
      if (this.appendStreamedFollowUps(step, update.followUps)) changed = true
      // Refresh the env projection so its status transitions (provisioning→ready→
      // expired/torn_down) and any error stay live in the run details during the run.
      if (await this.attachEnvironmentProjection(workspaceId, instance.blockId, step)) {
        changed = true
      }
      if (changed) {
        await this.executionRepository.upsert(workspaceId, instance)
        await this.runStateMachine.emitInstance(workspaceId, instance)
      }
      return { kind: 'awaiting_job', jobId: step.jobId, stepIndex: instance.currentStep }
    }

    // A gate whose helper INVESTIGATES instead of fixing (post-release-health → on-call)
    // declares a `resolveHelperCompletion` hook on its definition. When such a helper's job
    // settles — done OR failed — we call the hook INSTEAD of re-probing the precheck
    // (re-probing an investigate-don't-fix helper would just regress again and burn the
    // budget) and finish the gate step with the output it returns. The gate raises its own
    // `release_regression` notification + enriches any open incident inside the hook (from the
    // signals stashed at escalation); the run then completes for a human to act out-of-band.
    const completionGate = this.gateFor(step.agentKind)
    if (
      completionGate?.resolveHelperCompletion &&
      step.gate?.phase === 'working' &&
      (update.state === 'done' || update.state === 'failed')
    ) {
      const block = await this.blockRepository.get(workspaceId, instance.blockId)
      step.jobId = undefined
      step.subtasks = undefined
      if (!block) return { kind: 'noop' }
      const isFinalStep = instance.currentStep === instance.steps.length - 1
      const jobResult: GateHelperJobResult =
        update.state === 'done'
          ? { state: 'done', result: update.result }
          : { state: 'failed', error: update.error ?? null }
      const resolution = await completionGate.resolveHelperCompletion({
        workspaceId,
        instance,
        block,
        step,
        result: jobResult,
      })
      // Preserve the done-result's fields (usage metering etc.) while recording the gate's
      // resolved output; a failed investigation has no result to carry.
      const base: AgentRunResult = update.state === 'done' ? update.result : { output: '' }
      return this.recordStepResult(workspaceId, instance, step, isFinalStep, {
        ...base,
        output: resolution.output,
      })
    }

    // A polling gate step's in-flight job is its helper agent (ci-fixer /
    // conflict-resolver), NOT the step's own work: when it finishes (or fails) we
    // don't record a result or advance — we drop the handle, return the gate to
    // `checking`, and re-run the precheck (the helper's push triggers a fresh CI run /
    // updates mergeability). A helper that failed without pushing leaves the precheck
    // negative, so the next check re-dispatches (until the attempt budget is spent).
    const reprobeGate = this.gateFor(step.agentKind)
    if (reprobeGate) {
      // A gate may need deterministic GitHub-side bookkeeping to land BEFORE the re-probe
      // reads it (the human-review gate replies to + RESOLVES the threads it handed the
      // fixer, so the next probe counts them addressed). Run that side-effect hook first;
      // it does NOT replace the re-probe (unlike resolveHelperCompletion).
      if (reprobeGate.onHelperComplete && step.gate) {
        const block = await this.blockRepository.get(workspaceId, instance.blockId)
        if (block) {
          const jobResult: GateHelperJobResult =
            update.state === 'done'
              ? { state: 'done', result: update.result }
              : { state: 'failed', error: update.error ?? null }
          await this.runInitiatorScope(instance.initiatedBy, () =>
            reprobeGate.onHelperComplete!({
              workspaceId,
              instance,
              block,
              step,
              result: jobResult,
            }),
          )
        }
      }
      // Record the just-finished helper attempt before re-probing. The gate's next
      // precheck stays the source of truth for pass/fail, but the helper's own account
      // (what it did, and for the conflict-resolver which files it left conflicting) is
      // otherwise discarded here — leaving the gate window with only a bare attempt
      // count. Capture it so the UI can show what each attempt tried.
      if (step.gate) {
        const attempt = recordGateAttempt(
          step.gate,
          update.state === 'done'
            ? { state: 'done', output: update.result.output ?? null }
            : { state: 'failed', error: update.error ?? null },
          this.clock.now(),
        )
        step.gate.attemptLog = [...(step.gate.attemptLog ?? []), attempt]
        // The conflicts gate's precheck carries no failure detail of its own (GitHub
        // reports mergeability as a single bit), so surface the resolver's account as
        // the gate's last failure summary. CI's probe already sets a richer summary
        // (the red checks) — don't clobber it with the fixer's push note.
        if (step.agentKind === CONFLICTS_AGENT_KIND && attempt.summary) {
          step.gate.lastFailureSummary = attempt.summary
        }
      }
      step.jobId = undefined
      step.subtasks = undefined
      if (step.gate) step.gate.phase = 'checking'
      await this.executionRepository.upsert(workspaceId, instance)
      await this.runStateMachine.emitInstance(workspaceId, instance)
      return { kind: 'awaiting_gate', stepIndex: instance.currentStep }
    }

    // A `tester` step in its `fixing` phase has a Fixer job in flight, NOT the
    // step's own work: when it finishes (or fails) we drop the handle, return to
    // `testing`, and re-dispatch the Tester against the (now-fixed) branch — its
    // fresh report then drives greenlight-or-loop again. Mirrors the CI gate.
    if (isTesterKind(step.agentKind) && step.test?.phase === 'fixing') {
      // Record this fixer round (what it was handed + how it ended) so the test window can
      // show an inspectable timeline of the otherwise-opaque fixer sub-jobs. Persisted as
      // part of the re-dispatch below.
      this.testerController.recordFixerOutcome(
        step,
        update.state === 'done'
          ? { state: 'done', output: update.result.output ?? null }
          : { state: 'failed', error: update.error ?? null },
        this.clock.now(),
      )
      step.jobId = undefined
      step.subtasks = undefined
      step.test.phase = 'testing'
      const block = await this.blockRepository.get(workspaceId, instance.blockId)
      if (!block) return { kind: 'noop' }
      // Reclaim the finished Fixer container before re-dispatching the Tester so it
      // boots fresh against the just-pushed fixes (rather than re-attaching to the
      // completed job by run id).
      await this.runStateMachine.stopRunContainer(workspaceId, instance)
      return this.testerController.dispatchTester(workspaceId, instance, step, block)
    }

    // A `human-test` gate in its `fixing` / `resolving_conflicts` phase has a helper job
    // (fixer / conflict-resolver) in flight, NOT the step's own work: when it settles —
    // done OR failed — record the round's outcome, rebuild the environment against the
    // (now-updated) branch and re-park the human. We never fail the run here; the human is
    // in control. Mirrors the Tester→Fixer loop.
    if (
      step.agentKind === HUMAN_TEST_AGENT_KIND &&
      (step.humanTest?.phase === 'fixing' || step.humanTest?.phase === 'resolving_conflicts')
    ) {
      return this.humanTestController.onHelperComplete(workspaceId, instance, step, {
        state: update.state === 'failed' ? 'failed' : 'done',
      })
    }

    // A `visual-confirmation` gate in its `fixing` phase has a `fixer` job in flight: when it
    // settles, record the round, refresh the screenshot pairs, and re-park the human.
    if (step.agentKind === VISUAL_CONFIRM_AGENT_KIND && step.visualConfirm?.phase === 'fixing') {
      return this.visualConfirmationController.onHelperComplete(workspaceId, instance, step, {
        state: update.state === 'failed' ? 'failed' : 'done',
      })
    }

    if (update.state === 'failed') {
      // A container eviction (the per-run container vanished, its in-memory job is gone) is
      // usually transient. The shared recovery drops the dead handle and returns `continue` so
      // the driver re-dispatches the SAME step to a fresh container, within the per-flavour
      // budget (transient infra churn vs a crash/OOM); once the budget is spent it fails the run
      // as `evicted`. Returns null for a genuine agent/job failure, handled below.
      const recovered = await this.recoverContainerEviction(
        workspaceId,
        instance,
        step,
        update.error,
      )
      if (recovered) return recovered
      // Not an eviction: a genuine agent/job failure. Prefer the harness's STRUCTURED cause
      // to classify it (→ AgentFailureKind), falling back to the error-string regex when an
      // older image (or a pool transport that doesn't forward the cause) reported none — the
      // same regex the bootstrap path uses, so a watchdog timeout still classifies as `timeout`
      // rather than a generic `agent`. The extended diagnostic surfaces as the failure detail.
      // Mark the container errored and persist so the failed details show it (failRun
      // re-reads from storage, so an in-memory-only mutation would be lost; failRun emits
      // the terminal frame, so markContainerErrored deliberately doesn't).
      await this.markContainerErrored(workspaceId, instance, step)
      return {
        kind: 'job_failed',
        error: update.error,
        failureKind:
          agentFailureKindFromCause(update.failureCause) ?? classifyAgentFailure(update.error),
        detail: update.detail ?? update.error,
      }
    }

    const block = await this.blockRepository.get(workspaceId, instance.blockId)
    if (!block) return { kind: 'noop' }
    const isFinalStep = instance.currentStep === instance.steps.length - 1
    // Capture any final burst of follow-up items the harness drained on the SAME poll that
    // observed completion (the tailer is flushed before the job is marked done), so the
    // completion gate below sees the last items — notably a question that must hold the run.
    this.appendStreamedFollowUps(step, update.followUps)
    // Clear the handle before recording so a replay re-attaches to nothing.
    step.jobId = undefined
    return this.recordStepResult(workspaceId, instance, step, isFinalStep, update.result)
  }

  /**
   * Fold a running poll's container signals into `step.container`: a successful poll
   * proves the container is `up`, and the harness's live phase (clone / agent / push)
   * plus the transport's container id/url enrich it. Returns whether anything changed,
   * so the caller only persists + emits on a real transition (an idle poll is a no-op).
   * Prior id/url/phase are preserved when a poll omits them (drain-on-read semantics).
   */
  private applyContainerRunning(
    step: PipelineStep,
    update: { phase?: string; container?: { id?: string; url?: string } },
  ): boolean {
    const prev = step.container ?? undefined
    const next = {
      status: 'up' as const,
      phase: update.phase ?? prev?.phase ?? null,
      id: update.container?.id ?? prev?.id ?? null,
      url: update.container?.url ?? prev?.url ?? null,
    }
    if (
      prev?.status === next.status &&
      (prev?.phase ?? null) === next.phase &&
      (prev?.id ?? null) === next.id &&
      (prev?.url ?? null) === next.url
    ) {
      return false
    }
    step.container = next
    return true
  }

  /**
   * Apply an async step's live subtask counts to the step (and the derived 0..1 progress
   * fraction), returning whether anything changed. Shared by {@link pollAgentJob} (the agent
   * executor's `update.subtasks`) and {@link pollDeployerJob} (the deploy job's `view.progress`)
   * so the progress-fraction math lives in one place.
   */
  private applySubtaskProgress(step: PipelineStep, counts: PipelineStep['subtasks']): boolean {
    if (!counts || sameSubtasks(step.subtasks, counts)) return false
    step.subtasks = counts
    step.progress = counts.total > 0 ? counts.completed / counts.total : 0
    return true
  }

  /**
   * Shared container-eviction recovery for an async step (agent or deployer). When `error` is a
   * container-eviction error and the per-flavour budget (transient vs genuine) isn't spent, resets
   * the step so the driver re-dispatches a fresh container (returns `continue`); once the budget is
   * spent, marks the container errored and returns the terminal `job_evicted`. Returns null when
   * `error` is NOT an eviction, so the caller proceeds with its own genuine-failure handling.
   * `onBeforeRedispatch` runs the kind-specific reclaim (the deployer releases its separately
   * dispatched deploy-job runner) before the step state is reset. Keeps the eviction budgets +
   * the user-facing "still evicting…" wording uniform across the agent and deployer paths.
   */
  private async recoverContainerEviction(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    error: string | undefined,
    onBeforeRedispatch?: () => Promise<void>,
  ): Promise<AdvanceResult | null> {
    if (!isContainerEvictionError(error)) return null
    const transient = isTransientEviction(error)
    const limit = transient ? MAX_TRANSIENT_EVICTION_RECOVERIES : MAX_EVICTION_RECOVERIES
    const recoveries = transient
      ? (step.transientEvictionRecoveries ?? 0)
      : (step.evictionRecoveries ?? 0)
    if (recoveries < limit) {
      if (transient) step.transientEvictionRecoveries = recoveries + 1
      else step.evictionRecoveries = recoveries + 1
      if (onBeforeRedispatch) await onBeforeRedispatch()
      step.jobId = undefined
      step.subtasks = undefined
      step.progress = 0
      // The container vanished and a fresh one is about to boot for the re-dispatch, so the
      // details show it spinning up again rather than a stale "up".
      step.container = { status: 'starting' }
      await this.executionRepository.upsert(workspaceId, instance)
      await this.runStateMachine.emitInstance(workspaceId, instance)
      return { kind: 'continue' }
    }
    // Eviction budget spent — the container is gone for good. Mark it errored and persist so the
    // failed details show the errored container (failRun re-reads the run from storage, so an
    // in-memory-only mutation would be lost; it emits the terminal frame, so markContainerErrored
    // deliberately doesn't).
    await this.markContainerErrored(workspaceId, instance, step)
    return {
      kind: 'job_evicted',
      error: transient
        ? `${error} (still evicting after ${recoveries} automatic restarts through the infrastructure churn — treating as deterministic)`
        : `${error ?? 'Container evicted'} (still evicting after ${recoveries} automatic container restart${recoveries === 1 ? '' : 's'} — treating as deterministic)`,
    }
  }

  /**
   * Mark a container step's container `errored` (preserving the id/url/phase it reached) and
   * PERSIST it, so a failed run's details show the errored container. Called on the genuine
   * job-failure / exhausted-eviction paths before the result funnels to `failRun`, which
   * re-reads the run from storage (so an in-memory-only mutation here would be lost) and emits
   * the terminal frame itself — so we deliberately persist WITHOUT emitting here, to avoid a
   * redundant transient "errored but still running" broadcast right before the "failed" one.
   */
  private async markContainerErrored(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
  ): Promise<void> {
    step.container = { ...step.container, status: 'errored' }
    await this.executionRepository.upsert(workspaceId, instance)
  }

  /**
   * Re-run a polling gate step's precheck from the durable driver's `awaiting_gate`
   * loop: which gate (ci / conflicts) is resolved from the current step's `agentKind`,
   * and it returns the same outcomes as the initial evaluation (precheck passes →
   * advance, still computing → keep polling, fails → dispatch a helper or give up).
   * Safe under replay: reads run state fresh each call. A no-op unless the current
   * step is a gate actively in its `checking` phase.
   */
  async pollGate(workspaceId: string, executionId: string): Promise<AdvanceResult> {
    const instance = await this.executionRepository.get(workspaceId, executionId)
    if (!instance || (instance.status !== 'running' && instance.status !== 'paused')) {
      return { kind: 'noop' }
    }
    const step = instance.steps[instance.currentStep]
    // The human-testing gate rides the same `awaiting_gate` poll loop while its ephemeral
    // environment provisions — re-poll the env status (ready → park the human; still
    // provisioning → keep polling; failed → degrade to manual mode).
    if (step?.agentKind === HUMAN_TEST_AGENT_KIND) {
      return this.humanTestController.pollEnvironment(workspaceId, instance)
    }
    const gate = step ? this.gateFor(step.agentKind) : undefined
    if (!step || !gate) return { kind: 'continue' }
    // A helper job is in flight — the driver should be polling it, not the gate; let
    // the job-poll loop drive (defensive; a replay could route here).
    if (step.jobId)
      return { kind: 'awaiting_job', jobId: step.jobId, stepIndex: instance.currentStep }
    const block = await this.blockRepository.get(workspaceId, instance.blockId)
    if (!block) return { kind: 'noop' }
    const isFinalStep = instance.currentStep === instance.steps.length - 1
    return this.evaluateGate(workspaceId, instance, step, block, isFinalStep, gate)
  }

  /**
   * Decide what happens when the durable driver's GATE poll budget (ciMaxPolls ×
   * ciPollInterval) is spent while a gate is still `pending` — called by both runtime
   * drivers (Cloudflare ExecutionWorkflow / Node `driveExecution`) instead of failing
   * the run directly, so the per-gate policy lives in one place. Most gates `fail`
   * (CI never went green / the PR never became mergeable). A time-windowed watch gate
   * (post-release-health, `pollExhaustion: 'pass'`) instead PASSES: the watch window
   * simply outlasted the poll budget with no regression observed, which is healthy — not
   * a timeout. Returns the result the driver should act on (it never re-fails for a fail
   * gate; it returns a `job_failed` the driver funnels through its single `failRun`).
   */
  async resolveGatePollExhaustion(
    workspaceId: string,
    executionId: string,
  ): Promise<AdvanceResult> {
    const instance = await this.executionRepository.get(workspaceId, executionId)
    if (!instance || (instance.status !== 'running' && instance.status !== 'paused')) {
      return { kind: 'noop' }
    }
    const step = instance.steps[instance.currentStep]
    // The human-testing gate never times the RUN out while provisioning: instead of failing,
    // park the human in degraded mode so they can wait, recreate, or test by hand.
    if (step?.agentKind === HUMAN_TEST_AGENT_KIND) {
      return this.humanTestController.onProvisionTimeout(workspaceId, instance)
    }
    const gate = step ? this.gateFor(step.agentKind) : undefined
    const timeoutError = 'Gate precheck did not settle within its polling budget'
    // An unbounded human-wait gate (human-review, `pollExhaustion: 'rearm'`) has no deadline:
    // running out of polls is never a verdict. Always re-arm another poll cycle — the waiting
    // is surfaced via the gate's notification (escalated by the severity sweep), not by killing
    // the run.
    if (step && gate && gate.pollExhaustion === 'rearm') {
      if (step.gate) step.gate.phase = 'checking'
      await this.executionRepository.upsert(workspaceId, instance)
      return { kind: 'awaiting_gate', stepIndex: instance.currentStep }
    }
    if (!step || !gate || gate.pollExhaustion !== 'pass') {
      return { kind: 'job_failed', error: timeoutError, failureKind: 'timeout' }
    }
    // A time-windowed watch gate (post-release-health) may be configured to watch LONGER
    // than the driver's single gate-poll budget (ciMaxPolls × ciPollInterval). Running out
    // of polls before the window has actually elapsed is NOT a healthy pass — the release
    // could still regress later in the window. Re-arm another poll cycle (the driver loops
    // back into the gate-poll loop on `awaiting_gate`) so the full configured window is
    // honoured rather than silently truncated to the poll budget.
    const watchSince = step.gate?.watchSince
    const windowMinutes = step.gate?.watchWindowMinutes
    if (watchSince != null && windowMinutes != null) {
      const windowElapsed = this.clock.now() - watchSince >= windowMinutes * 60_000
      if (!windowElapsed) {
        if (step.gate) step.gate.phase = 'checking'
        await this.executionRepository.upsert(workspaceId, instance)
        return { kind: 'awaiting_gate', stepIndex: instance.currentStep }
      }
    }
    // Window genuinely elapsed (or a non-windowed pass gate): finish as a healthy pass.
    const isFinalStep = instance.currentStep === instance.steps.length - 1
    return this.recordStepResult(workspaceId, instance, step, isFinalStep, {
      output: `${gate.kind} gate passed: watch window elapsed with no regression observed.`,
    })
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
  private async attachEnvironmentProjection(
    workspaceId: string,
    blockId: string,
    step: PipelineStep,
  ): Promise<boolean> {
    if (!this.environmentProvisioning) return false
    // Only the env-aware kinds run against an ephemeral environment (the `deployer`
    // provisions it; the `tester`/`playwright` exercise it). Gating here keeps the
    // per-poll `getByBlock` read off the hot path for the many container steps
    // (coder/merger/ci-fixer/…) that never have an env to surface.
    if (!ENV_PROJECTION_KINDS.has(step.agentKind)) return false
    try {
      const handle = await this.environmentProvisioning.getHandleForBlock(workspaceId, blockId)
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
   * Finish a gated step that was skipped (its estimate gate was not satisfied) and either
   * complete the run or advance to the next step — the deterministic finish/advance tail
   * of {@link recordStepResult}, minus all the agent-result handling (no LLM ran, so there
   * is no usage / decision / PR / artifact / approval / resolver to process). The step is
   * marked `skipped` with empty output so the UI renders "skipped (gated)".
   */
  async skipGatedStep(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    isFinalStep: boolean,
  ): Promise<AdvanceResult> {
    step.skipped = true
    step.output = ''
    step.progress = 1
    step.subtasks = undefined
    this.stepGraph.finishStep(step)

    if (isFinalStep) {
      instance.status = 'done'
      await this.runStateMachine.finalizeBlock(workspaceId, instance, undefined)
      await this.executionRepository.upsert(workspaceId, instance)
      await this.runStateMachine.emitInstance(workspaceId, instance)
      await this.runStateMachine.stopRunContainer(workspaceId, instance)
      return { kind: 'done' }
    }
    instance.currentStep += 1
    const next = instance.steps[instance.currentStep]
    if (next) this.stepGraph.startStep(next)
    await this.runStateMachine.updateBlockProgress(workspaceId, instance, 'in_progress')
    await this.executionRepository.upsert(workspaceId, instance)
    await this.runStateMachine.emitInstance(workspaceId, instance)
    return { kind: 'continue' }
  }
  /**
   * Record a completed agent step's result and report what the driver should do
   * next: meter token usage, park on a raised decision, or persist the output
   * (and any opened PR) and either finish the run or advance to the next step.
   * Shared by the inline path and the async-job poll path.
   */
  private async recordStepResult(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    isFinalStep: boolean,
    result: AgentRunResult,
  ): Promise<AdvanceResult> {
    // Meter the LLM call against the spend budget. Recorded whether the step
    // completed or raised a decision — both consumed tokens.
    if (result.usage) {
      await this.spend.record({
        workspaceId,
        executionId: instance.id,
        agentKind: step.agentKind,
        model: result.model ?? 'unknown',
        usage: result.usage,
      })
    }

    // The agent asked for a human decision and this step hasn't resolved one yet.
    if (result.decision && !step.decision?.chosen) {
      step.decision = {
        id: this.idGenerator.next('dec'),
        question: result.decision.question,
        options: [...result.decision.options],
        chosen: null,
      }
      this.stepGraph.pauseStepForInput(step)
      instance.status = 'blocked'
      await this.runStateMachine.updateBlockProgress(workspaceId, instance, 'blocked')
      await this.executionRepository.upsert(workspaceId, instance)
      await this.runStateMachine.emitInstance(workspaceId, instance)
      return { kind: 'awaiting_decision', decisionId: step.decision.id }
    }

    // Completion-path interceptors short-circuit before the normal finish/advance for the
    // few kinds whose verdict drives run flow: a container-backed companion applies its
    // threshold/rework/human-gate loop, and a Tester re-runs its `fixer` on a withheld
    // greenlight. A non-null outcome replaces the normal completion; null (a Tester
    // greenlight, or a companion whose block can't be loaded) falls through. See
    // {@link buildStepCompletionInterceptors}.
    const intercepted = await this.dispatchStepCompletionInterceptor({
      workspaceId,
      instance,
      step,
      isFinalStep,
      result,
    })
    if (intercepted) return intercepted

    // The step completed.
    step.output = result.output ?? ''
    // Surface a registered custom kind's structured JSON on the step so the SPA's
    // `generic-structured` result view can render it (a post-op consumes the same value
    // server-side). Built-in / prose kinds leave it undefined.
    if (result.custom !== undefined) step.custom = result.custom
    if (result.model) step.model = result.model
    step.progress = 1
    this.stepGraph.finishStep(step)
    // Live subtask counts only describe an in-flight run; drop them now the step
    // is done so the board doesn't show a stale "3/8" against a finished step.
    step.subtasks = undefined
    // A companion-driven rework was just consumed by this re-run; clear it so a later
    // unrelated re-run doesn't re-apply stale feedback (the companion sets fresh
    // feedback if it still rejects the new output).
    step.rework = undefined

    // A repo-operating step (the container "implementer" agent) opened a PR for
    // its work. Record it on the block so the board can surface and link to it,
    // regardless of whether this is the final step.
    if (result.pullRequest) {
      // Read the block before the update so we can tell whether this PR is newly
      // opened (vs. the same PR re-reported by a re-run/retry of the coder step).
      const priorBlock = this.issueWriteback
        ? await this.blockRepository.get(workspaceId, instance.blockId)
        : null
      await this.blockRepository.update(workspaceId, instance.blockId, {
        pullRequest: result.pullRequest,
      })
      // Best-effort writeback: comment on the task's linked tracker issue(s) that a
      // PR opened. Only when the PR is newly recorded — a retry that re-reports the
      // same PR must not re-comment (the tracker comment is not idempotent). Gated
      // inside the provider by the workspace setting + per-task override;
      // fire-and-forget so a tracker outage never fails the run.
      if (
        this.issueWriteback &&
        priorBlock &&
        priorBlock.pullRequest?.url !== result.pullRequest.url
      ) {
        await this.issueWriteback
          .onPullRequestOpened(workspaceId, priorBlock, result.pullRequest)
          .catch(() => {})
      }
    }

    // Run any POST-COMPLETION resolver registered for this step kind (blueprint/spec
    // ingestion, task-estimate persistence). It reshapes the agent's structured result into
    // domain state and may replace `step.output` (the estimator's readable summary). Its
    // POSITION is load-bearing — it runs after the output is recorded but BEFORE the
    // reviewable-output rendering and the follow-up/approval gates read `step.output`, so it
    // sits exactly where the old inline ingestion branches did. See
    // {@link buildStepResolverRegistry} and {@link StepCompletionResolver.phase}.
    const postCompletionResolver = this.stepResolverFor(step.agentKind)
    if (
      postCompletionResolver?.phase === 'post-completion' &&
      (postCompletionResolver.applies?.(result) ?? true)
    ) {
      const resolution = await postCompletionResolver.resolve({
        workspaceId,
        instance,
        step,
        result,
        isFinalStep,
      })
      if (resolution?.output !== undefined) step.output = resolution.output
    }

    // A producer that emits a STRUCTURED ARTIFACT (the spec doc, the blueprint tree, …)
    // returns its raw Pi transcript summary as `result.output` — useless for review.
    // Replace the step's reviewable output with a rendering of the artifact ITSELF, so
    // its companion grades the PRODUCT (and the SPA reader + downstream steps see it),
    // not the agent's chatter. Grading the transcript is what made the spec-companion
    // declare every pass "unreviewable" and loop the producer to its rework cap on every
    // spec task — a trap for ANY artifact-producing agent with a companion, now and
    // future, which is why this is keyed off the artifact, not a specific agentKind.
    const reviewable = reviewableArtifactOutput(result)
    if (reviewable !== undefined) step.output = reviewable

    // Follow-up companion gate: the future-looking Coder surfaced forward-looking items.
    // Hold the pipeline until every item is decided (an undecided follow-up or an unanswered
    // question parks the run), then loop the Coder for the items the human queued / answered
    // (within the loop budget) before the following steps may start. Runs BEFORE the approval
    // gate so the Coder's follow-ups settle first. A no-op when nothing was surfaced.
    if (step.followUps?.enabled) {
      const gated = await this.evaluateFollowUpGate(workspaceId, instance, step)
      if (gated) return gated
    }

    // Human approval gate: a step the pipeline marked `requiresApproval` pauses
    // here once its proposal is ready, so a human can review (and edit) it before
    // the next step runs. We reuse the durable decision wait — returning
    // `awaiting_decision` keyed by the approval id parks the run on the same named
    // event the workflow already listens for; `approveStep` / `requestStepChanges`
    // wake it. Never gates the final step (nothing downstream to feed) and is
    // idempotent: an already-approved step falls through to advance/finish.
    if (step.requiresApproval && !isFinalStep && step.approval?.status !== 'approved') {
      step.approval = {
        id: this.idGenerator.next('appr'),
        status: 'pending',
        proposal: step.output,
      }
      this.stepGraph.pauseStepForInput(step)
      instance.status = 'blocked'
      await this.runStateMachine.updateBlockProgress(workspaceId, instance, 'blocked')
      await this.executionRepository.upsert(workspaceId, instance)
      await this.runStateMachine.emitInstance(workspaceId, instance)
      return { kind: 'awaiting_decision', decisionId: step.approval.id }
    }

    // Persist the agent's reported confidence whenever a step reports it, for board
    // transparency. Position-independent: it must NOT be tied to the final step, since a
    // confidence-reporting producer (e.g. the merger) may now be followed by a gate.
    if (result.confidence !== undefined) {
      await this.blockRepository.update(workspaceId, instance.blockId, {
        confidence: result.confidence,
      })
    }

    // Run any DETERMINISTIC post-completion logic registered for this agent kind (e.g.
    // the merger performs the real GitHub merge with backend-held credentials). This is
    // POSITION-INDEPENDENT — it fires whenever the step finishes, not only when it's last
    // — so inserting a later step (post-release-health) can't silently disable it. A
    // resolver that owns the block's terminal status (the merger sets `done`/`pr_ready`)
    // tells `finalizeBlock` to leave it alone.
    const resolver = this.stepResolverFor(step.agentKind)
    let resolverOwnsTerminalStatus = false
    if (
      resolver &&
      (resolver.phase ?? 'terminal') === 'terminal' &&
      (resolver.applies?.(result) ?? true)
    ) {
      const resolution = await resolver.resolve({
        workspaceId,
        instance,
        step,
        result,
        isFinalStep,
      })
      if (resolution?.output !== undefined) step.output = resolution.output
      if (resolution?.ownsTerminalStatus) resolverOwnsTerminalStatus = true
    }

    // A registered custom kind's POST-ops run deterministic backend repo work from the
    // agent's structured result (coerce its JSON, render artifact files, commit them via
    // the checkout-free RepoFiles port — the blueprint/spec rendering that used to live in
    // the harness). Position-independent like the resolver above; a no-op for built-ins
    // and when GitHub isn't wired. A throwing op propagates to fail the step/run.
    await this.runRegisteredPostOps(workspaceId, instance, step, isFinalStep, result)

    if (isFinalStep) {
      instance.status = 'done'
      // Merge resolution (and confidence persistence) already happened above,
      // POSITION-INDEPENDENTLY: confidence at the top of recordStepResult and the merger's
      // real merge via the step-completion resolver registry (so a trailing
      // post-release-health gate doesn't disable auto-merge). Nothing merge-specific here.
      await this.runStateMachine.finalizeBlock(workspaceId, instance, result.confidence)
      await this.executionRepository.upsert(workspaceId, instance)
      await this.runStateMachine.emitInstance(workspaceId, instance)
      // The run is finished: reclaim its per-run container now instead of letting it
      // idle out its sleepAfter window (~10 min of billed-but-useless compute). All
      // pipeline steps share the one container keyed by the execution id, so this is
      // only safe on the FINAL step — never between steps. Best-effort/idempotent.
      await this.runStateMachine.stopRunContainer(workspaceId, instance)
      return { kind: 'done' }
    }
    instance.currentStep += 1
    const next = instance.steps[instance.currentStep]
    if (next) this.stepGraph.startStep(next)
    // A resolver that already set the block's TERMINAL status (the merger flips it to
    // `done`/`pr_ready` mid-pipeline) must not be clobbered back to `in_progress` as we
    // advance to a trailing step — refresh progress only, preserving that status. (The
    // final step's `finalizeBlock` then leaves a `done` block alone.)
    if (resolverOwnsTerminalStatus) {
      await this.runStateMachine.refreshBlockProgress(workspaceId, instance)
    } else {
      await this.runStateMachine.updateBlockProgress(workspaceId, instance, 'in_progress')
    }
    await this.executionRepository.upsert(workspaceId, instance)
    await this.runStateMachine.emitInstance(workspaceId, instance)
    return { kind: 'continue' }
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
   * driver — DELIBERATELY, and symmetric with {@link handleAgentStep}'s dispatch-failure path
   * (a container that never started is likewise terminal regardless of `rethrowAgentErrors`).
   * Environment provisioning is infra spin-up, not agent execution: treating it like the
   * `dispatch` failure (surface the verbatim cause + one-click retry) keeps the `environment`
   * classification and the provider's real error visible, where rethrowing for the driver's
   * per-step retry would re-collapse it into a generic `agent` failure on exhaustion and bury
   * the root cause. So do NOT reintroduce a `rethrowAgentErrors` branch here.
   */
  private async runDeployerStep(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    block: Block,
    isFinalStep: boolean,
  ): Promise<AdvanceResult> {
    // The service frame (the run may target a task/module inside it) owns the provisioning
    // config — the "what + where". Resolve it so the deployer routes to the workspace handler
    // for its declared type. A service explicitly declaring `infraless` stands nothing up —
    // record a no-op step output. An UNDECLARED service falls through to the legacy
    // single-connection path (the compat bridge), so existing workspaces keep provisioning.
    const provisioning = await this.resolveServiceProvisioning(workspaceId, block)
    if (provisioning?.type === 'infraless') {
      // A service flipped to `infraless` provisions nothing — but it may have a prior live
      // environment from when it declared a real type. Tombstone it so the block stops
      // showing a stale live environment (no-op when there's none / provisioning unwired).
      await this.environmentProvisioning?.supersedeForBlock(workspaceId, block.id)
      return this.recordStepResult(workspaceId, instance, step, isFinalStep, {
        output: 'Service is infraless; no environment provisioned.',
        model: 'environment:none',
      })
    }
    // A set `jobId` means a prior (possibly replayed) dispatch already started an async deploy
    // job — re-attach by polling instead of re-provisioning (mirrors {@link handleAgentStep}).
    if (step.jobId) {
      return { kind: 'awaiting_job', jobId: step.jobId, stepIndex: instance.currentStep }
    }
    // Start provisioning: a raw-manifest config provisions SYNCHRONOUSLY over REST (a final
    // handle); a config that needs rendering (kustomize/helm/image overrides/secret injections)
    // dispatches a CONTAINER-backed deploy job we park on and poll (see {@link pollDeployerJob}).
    // The job ref is DETERMINISTIC (run id + deployer kind + eviction epoch), so a Workflows
    // replay that re-runs this step reproduces the same id and the transport (idempotent per ref)
    // re-attaches instead of dispatching a duplicate deploy container. The epoch advances on each
    // eviction recovery so a fresh job can't re-attach to the dead container's completed job.
    const ref: RunnerJobRef = {
      runId: instance.id,
      jobId: deployJobId(instance.id, deployEvictionEpoch(step)),
    }
    let dispatch: ProvisionDispatch
    try {
      dispatch = await this.environmentProvisioning!.startProvision(
        this.deployerProvisionArgs(workspaceId, instance, block, provisioning),
        ref,
      )
    } catch (error) {
      return this.failDeployerStep(workspaceId, instance, step, getErrorMessage(error))
    }
    if (dispatch.kind === 'completed') {
      return this.completeDeployerStep(workspaceId, instance, step, isFinalStep, dispatch.handle)
    }
    // An async deploy job was dispatched: park on it. `dispatch` blocked until the job was
    // accepted, so the container is up; the live phase + the provisioned outcome arrive on the
    // deployer poll branch. Surface the env spinning up alongside the parked step.
    step.jobId = dispatch.ref.jobId
    step.container = { status: 'up' }
    // Pin the provisioning config the container was built from, so the later poll/finalize maps
    // the job against THIS config rather than a fresh read of the frame (which a person may edit
    // mid-flight). Absent for the undeclared legacy path, which re-resolution handles harmlessly.
    if (provisioning) step.deployProvisioning = provisioning
    await this.attachEnvironmentProjection(workspaceId, instance.blockId, step)
    await this.executionRepository.upsert(workspaceId, instance)
    await this.runStateMachine.emitInstance(workspaceId, instance)
    return { kind: 'awaiting_job', jobId: step.jobId, stepIndex: instance.currentStep }
  }

  /**
   * Poll a `deployer` step's dispatched CONTAINER-backed deploy job (the async kustomize/helm
   * path) through the environment provisioning service — NOT the agent executor. Mirrors
   * {@link pollAgentJob}: surfaces live container/subtask progress while running, recovers a
   * container eviction by re-dispatching a fresh deploy job (within the same budgets), and on a
   * genuine terminal state finalizes the job into an environment record + the step result.
   */
  private async pollDeployerJob(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
  ): Promise<AdvanceResult> {
    const ref: RunnerJobRef = { runId: instance.id, jobId: step.jobId! }
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
      if (await this.attachEnvironmentProjection(workspaceId, instance.blockId, step)) {
        changed = true
      }
      if (changed) {
        await this.executionRepository.upsert(workspaceId, instance)
        await this.runStateMachine.emitInstance(workspaceId, instance)
      }
      return { kind: 'awaiting_job', jobId: step.jobId!, stepIndex: instance.currentStep }
    }

    // The deploy container vanished (evicted/crashed). The shared recovery re-dispatches a fresh
    // deploy job (the driver loops back into `runDeployerStep`, which re-provisions since
    // `step.jobId` is cleared) within the same per-flavour budgets as the agent path, reclaiming
    // the dead job's runner first. Returns null for a non-eviction failure, handled below.
    if (view.state === 'failed') {
      const recovered = await this.recoverContainerEviction(
        workspaceId,
        instance,
        step,
        view.error,
        () => this.environmentProvisioning!.releaseProvisionJob(workspaceId, ref).catch(() => {}),
      )
      if (recovered) return recovered
    }

    // Genuine terminal (done, or a non-eviction failure): finalize the deploy job into an
    // environment record and turn it into the step result. A `failed` view maps to a failed env,
    // which `completeDeployerStep` surfaces as a displayed step failure.
    const block = await this.blockRepository.get(workspaceId, instance.blockId)
    if (!block) return { kind: 'noop' }
    const isFinalStep = instance.currentStep === instance.steps.length - 1
    // Map the job against the provisioning config the container was BUILT from (pinned at
    // dispatch), not a fresh read of the frame a person may have edited mid-flight — else a
    // config flip (e.g. → `infraless`) would fail a deploy whose container already succeeded.
    const provisioning =
      step.deployProvisioning ?? (await this.resolveServiceProvisioning(workspaceId, block))
    step.jobId = undefined
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
        this.deployerProvisionArgs(workspaceId, instance, block, provisioning),
        view,
      )
    } catch (error) {
      // The deploy container is gone (released above) but finalize failed: stamp the container
      // errored so the failed details don't keep showing it "up". `failDeployerStep` persists it.
      if (step.container) step.container = { ...step.container, status: 'errored' }
      return this.failDeployerStep(workspaceId, instance, step, getErrorMessage(error))
    }
    // Reflect the container's terminal state from the RESOLVED outcome, not the raw view: a `done`
    // view the provider maps to a FAILED env (e.g. the harness exited 0 but the namespace is
    // missing) must still show the container errored — keying off `view.state` alone missed that.
    if (handle.status === 'failed' && step.container) {
      step.container = { ...step.container, status: 'errored' }
    }
    return this.completeDeployerStep(workspaceId, instance, step, isFinalStep, handle)
  }

  /** The {@link ProvisionArgs} a `deployer` step provisions with (synchronous or async). */
  private deployerProvisionArgs(
    workspaceId: string,
    instance: ExecutionInstance,
    block: Block,
    provisioning: ServiceProvisioning | undefined,
  ): ProvisionArgs {
    return {
      workspaceId,
      blockId: block.id,
      executionId: instance.id,
      inputs: this.deployInputs(block),
      context: this.deployContext(block),
      ...(provisioning ? { serviceProvisioning: provisioning } : {}),
      initiatedBy: instance.initiatedBy,
    }
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
    handle: EnvironmentHandle,
  ): Promise<AdvanceResult> {
    if (handle.status === 'failed') {
      return this.failDeployerStep(
        workspaceId,
        instance,
        step,
        handle.lastError ?? 'Provisioning failed.',
      )
    }
    // Re-project the now-final environment (ready/expired + URL) so the deployer step's
    // Environment panel reflects the provisioned outcome rather than the dispatch-time
    // `provisioning` snapshot the async poll last wrote. (The failed branch above routes to
    // `failDeployerStep`, which re-projects too; the synchronous path simply surfaces its env.)
    await this.attachEnvironmentProjection(workspaceId, instance.blockId, step)
    const lines = [
      `Provisioned ephemeral environment via '${handle.providerId}'.`,
      `Status: ${handle.status}`,
      `URL: ${handle.url ?? '(pending)'}`,
    ]
    if (handle.expiresAt) lines.push(`Expires: ${new Date(handle.expiresAt).toISOString()}`)
    if (handle.provisionType) lines.push(`Provision type: ${handle.provisionType}`)
    if (handle.engine) lines.push(`Engine: ${handle.engine}`)
    return this.recordStepResult(workspaceId, instance, step, isFinalStep, {
      output: lines.join('\n'),
      model: handle.engine
        ? `environment:${handle.engine}:${handle.providerId}`
        : `environment:${handle.providerId}`,
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
   * provider's message as the detail. Mirrors {@link handleAgentStep}'s dispatch-failure path.
   */
  private async failDeployerStep(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    message: string,
  ): Promise<AdvanceResult> {
    await this.attachEnvironmentProjection(workspaceId, instance.blockId, step)
    await this.executionRepository.upsert(workspaceId, instance)
    await this.runStateMachine.emitInstance(workspaceId, instance)
    return {
      kind: 'job_failed',
      error: 'Environment provisioning failed.',
      failureKind: 'environment',
      detail: message,
    }
  }

  /**
   * File a tracking issue/ticket for a `tracker` step from the preceding `analysis`
   * output. Non-LLM and best-effort: when no provider is wired or none is configured
   * for the workspace it simply notes the skip; a filing error is folded into the
   * step output rather than failing the run (the implementation still proceeds).
   */
  private async runTracker(
    workspaceId: string,
    instance: ExecutionInstance,
    block: Block,
  ): Promise<AgentRunResult> {
    if (!this.ticketTrackerProvider) {
      return { output: 'No issue tracker configured; skipped ticket creation.' }
    }
    // The report to file is the closest preceding `analysis` output, falling back
    // to the block description when the pipeline has no analysis step.
    const analysis = instance.steps
      .slice(0, instance.currentStep)
      .filter((s) => s.agentKind === ANALYSIS_AGENT_KIND && s.output)
      .map((s) => s.output as string)
      .pop()
    const body = (analysis ?? block.description ?? '').trim() || 'Automated tech-debt remediation.'
    const frameId =
      (await this.contextBuilder.resolveServiceFrameId(workspaceId, block.id)) ?? block.id
    try {
      const ticket = await this.ticketTrackerProvider.createTicket({
        workspaceId,
        frameId,
        title: `Tech debt: ${block.title}`,
        body,
      })
      if (!ticket) {
        return { output: 'No issue tracker configured; skipped ticket creation.' }
      }
      return { output: `Filed tracking ticket ${ticket.externalId}: ${ticket.url}` }
    } catch (error) {
      return { output: `Could not file a tracking ticket: ${getErrorMessage(error)}` }
    }
  }

  /**
   * The polling-gate registry, keyed by `agentKind`. A gate runs a programmatic
   * precheck against a provider and only escalates to a helper container agent on a
   * negative verdict. Built lazily (the closures capture `this`, so the providers /
   * merge preset / notification helpers resolve at call time) and cached per instance.
   * The registry merges deployment-registered gates ({@link registeredGateFactories}),
   * which are a STARTUP import side effect — a gate registered after this cache is first
   * built is invisible to this instance, so register at startup, before serving. Returns
   * undefined for a non-gate kind. See {@link GateDefinition} and {@link evaluateGate}.
   */
  gateFor(agentKind: string): GateDefinition | undefined {
    if (!this.gateRegistryCache) this.gateRegistryCache = this.buildGateRegistry()
    return this.gateRegistryCache.get(agentKind)
  }

  /**
   * Resolve the concrete branch a registered kind's pre/post-op reads or writes, from
   * its declared clone target — mirroring the container executor's mapping so a backend
   * op and the container agent operate on the SAME branch:
   *   - `base` → the repo default branch (the ONLY way a committing op targets `main`).
   *   - `pr`   → the block's PR branch (the coder's branch); when no PR is open, the
   *              per-block work branch (created from base if missing) — NOT base, so a
   *              committing post-op can't silently land on the default branch.
   *   - `work` (default) → the per-block work branch, ENSURED to exist exactly as
   *              {@link ContainerAgentExecutor}'s `ensureWorkBranch` does. The old code
   *              returned base here whenever no PR was open yet, diverging from the
   *              container agent (which clones `cat-factory/<blockId>`) and letting a
   *              post-op commit onto the default branch.
   * The work-branch name (`cat-factory/<blockId>`) is the same convention
   * {@link ContainerAgentExecutor} uses.
   */
  private async resolveRepoOpBranch(
    step: AgentStepSpec | undefined,
    block: Block,
    runRepo: RunRepoContext,
  ): Promise<string> {
    const { repo, baseBranch } = runRepo
    const prBranch = block.pullRequest?.branch
    const workBranch = `cat-factory/${block.id}`
    switch (step?.clone?.branch) {
      case 'base':
        return baseBranch
      case 'pr':
        return prBranch ?? (await this.ensureWorkBranch(repo, workBranch, baseBranch))
      default:
        // 'work' (or unspecified): the work branch the container agent operates on. A PR
        // is normally opened on that branch, but even before one exists we ensure it so
        // the backend op and the container agent share the same branch.
        return prBranch && prBranch !== workBranch
          ? prBranch
          : await this.ensureWorkBranch(repo, workBranch, baseBranch)
    }
  }

  /**
   * Ensure the per-block work branch `cat-factory/<blockId>` exists — creating it from the
   * repo default branch's head when absent — and return it. The checkout-free analogue of
   * {@link ContainerAgentExecutor}'s `ensureWorkBranch`, so a backend pre/post-op writes
   * the SAME branch the container agent does instead of the default branch. Falls back to
   * the base branch only when the repo has no default-branch head to fork from (an empty
   * repo), so the caller always gets a real branch.
   */
  private async ensureWorkBranch(
    repo: RepoFiles,
    workBranch: string,
    baseBranch: string,
  ): Promise<string> {
    if (await repo.headSha(workBranch)) return workBranch
    const baseSha = await repo.headSha(baseBranch)
    if (!baseSha) return baseBranch
    await repo.createBranch(workBranch, baseSha)
    return workBranch
  }

  /**
   * Run a registered kind's PRE-op hooks before its agent step dispatches: deterministic
   * backend work (read a baseline artifact into the prompt, etc.) over a checkout-free
   * {@link RepoFiles}. No-op for built-in / unregistered kinds, when the kind declares no
   * pre-ops, or when GitHub isn't wired (no `resolveRunRepoContext`) — so the engine runs
   * unchanged without the feature. A throwing op propagates to fail the step.
   */
  private async runRegisteredPreOps(
    workspaceId: string,
    block: Block,
    step: PipelineStep,
    context: AgentRunContext,
  ): Promise<void> {
    const ops = registeredPreOps(step.agentKind)
    if (ops.length === 0) return
    const runRepo = await this.resolveRunRepo(workspaceId, block.id)
    if (!runRepo) return
    const branch = await this.resolveRepoOpBranch(
      registeredAgentStep(step.agentKind),
      block,
      runRepo,
    )
    await runRepoOps(ops, { repo: runRepo.repo, context, branch })
  }

  /**
   * Resolve a block's run-repo context for its pre/post-op hooks. Returns null only when
   * the resolver is UNWIRED (tests / GitHub not connected) so a deployment without the
   * feature simply skips the hooks. When the resolver IS wired, its result — including a
   * THROW from `resolveRepoTarget` for a block that isn't under a linked service — is
   * propagated as-is: a registered kind with repo hooks run on a misconfigured block fails
   * the run loudly rather than silently committing nothing (or guessing a repo), the same
   * way a container custom kind fails at dispatch.
   */
  private async resolveRunRepo(
    workspaceId: string,
    blockId: string,
  ): Promise<RunRepoContext | null> {
    if (!this.resolveRunRepoContext) return null
    return this.resolveRunRepoContext(workspaceId, blockId)
  }

  /**
   * Run a registered kind's POST-op hooks after its agent step's result is recorded:
   * deterministic backend work that consumes the agent's structured output (coerce its
   * JSON, render artifact files, commit them via {@link RepoFiles}) — the
   * blueprint/spec rendering that used to live in the harness. Same gating + symmetry as
   * {@link runRegisteredPreOps}; the agent's {@link AgentRunResult} is threaded through.
   */
  private async runRegisteredPostOps(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    isFinalStep: boolean,
    result: AgentRunResult,
  ): Promise<void> {
    const registered = registeredPostOps(step.agentKind)
    const builtIn = this.builtInPostOps(step.agentKind)
    if (registered.length === 0 && builtIn.length === 0) return
    const block = await this.blockRepository.get(workspaceId, instance.blockId)
    if (!block) return
    const runRepo = await this.resolveRunRepo(workspaceId, block.id)
    if (!runRepo) return
    const context = await this.contextBuilder.buildContext(
      workspaceId,
      instance,
      step,
      isFinalStep,
      block,
    )
    // Registered (custom) kinds resolve their branch from their declared clone target.
    if (registered.length > 0) {
      const branch = await this.resolveRepoOpBranch(
        registeredAgentStep(step.agentKind),
        block,
        runRepo,
      )
      await runRepoOps(registered, { repo: runRepo.repo, context, branch, result })
    }
    // Built-in (migrated) kinds resolve their branch to MATCH their container dispatch
    // exactly (see {@link builtInRepoOpBranch}), which differs from the generic clone
    // resolution for the no-PR case — so the post-op commits where the agent read.
    if (builtIn.length > 0) {
      const branch = await this.builtInRepoOpBranch(step.agentKind, block, runRepo)
      await runRepoOps(builtIn, { repo: runRepo.repo, context, branch, result })
    }
  }

  /**
   * The BUILT-IN (non-registry) post-ops for a migrated built-in kind, keyed by agent
   * kind — the deterministic render + commit lifted out of the executor-harness. Kept
   * OUT of the agent-kind registry on purpose: registering the built-ins would leak them
   * into `customAgentKinds` / the SPA palette. Empty for every other kind.
   */
  private builtInPostOps(agentKind: string): RepoOp[] {
    return RunDispatcher.BUILT_IN_POST_OPS[agentKind] ?? []
  }

  /**
   * The built-in (NON-registry) post-ops keyed by kind. A small map rather than an
   * `if`-chain so each migrated built-in is one entry as the strangler converts more
   * kinds; deliberately NOT the agent-kind registry (that would leak the built-ins into
   * `customAgentKinds` / the SPA palette).
   */
  private static readonly BUILT_IN_POST_OPS: Record<string, RepoOp[]> = {
    [BLUEPRINTS_AGENT_KIND]: [blueprintPostOp],
    [SPEC_WRITER_AGENT_KIND]: [specPostOp],
  }

  /**
   * The branch a built-in kind's post-op reads/commits, resolved to MATCH the kind's
   * container dispatch (so the post-op commits onto exactly the branch the explore agent
   * cloned).
   *  - blueprints clones the PR branch when one is open, else the repo's default branch —
   *    so the initial bootstrap map lands directly on the default branch, mirroring
   *    {@link ContainerAgentExecutor}'s `pr`-clone resolution (`prBranch ?? baseBranch`).
   *    Deliberately NOT {@link resolveRepoOpBranch}, whose `pr` case ensures a work branch
   *    for the no-PR case — correct for a committing CUSTOM kind, wrong for the blueprint.
   *  - spec-writer commits onto the per-block WORK branch (`cat-factory/<blockId>`), created
   *    from base when absent. It is a WRITER (not read-only), so its container dispatch
   *    always ensures + clones that work branch ({@link ContainerAgentExecutor}'s
   *    `workBranchReady ? workBranch : …` resolves to the work branch). We mirror that
   *    DETERMINISTICALLY here — NOT via {@link resolveRepoOpBranch}'s `work` case, whose
   *    PR-preferring branch would commit onto a divergent PR branch (read one tree, write
   *    another) if a PR were ever open on a branch other than `cat-factory/<blockId>`.
   */
  private async builtInRepoOpBranch(
    agentKind: string,
    block: Block,
    runRepo: RunRepoContext,
  ): Promise<string> {
    if (agentKind === SPEC_WRITER_AGENT_KIND) {
      return this.ensureWorkBranch(runRepo.repo, `cat-factory/${block.id}`, runRepo.baseBranch)
    }
    return block.pullRequest?.branch ?? runRepo.baseBranch
  }

  /**
   * The post-completion resolver for an agent kind, or undefined when the kind has none.
   * A resolver runs DETERMINISTIC backend follow-up once the step's agent finishes — e.g.
   * the merger performs the real GitHub merge — independent of the step's position in the
   * pipeline. Built lazily (closures capture `this`) and cached per instance; the registry
   * merges deployment-registered resolvers ({@link registeredStepResolverFactories}), a
   * startup import side effect (see {@link gateFor} for the same caching caveat). See
   * {@link StepCompletionResolver}.
   */
  /**
   * Dispatch a step (whose preamble already ran in {@link stepInstance}) to the first
   * registered {@link StepHandler} whose `canHandle` claims it, ordered by `order`. The
   * fallthrough handler claims everything, so this always resolves to a handler.
   */
  dispatchStepHandler(ctx: StepHandlerContext): Promise<AdvanceResult> {
    if (!this.stepHandlerCache) this.stepHandlerCache = this.buildStepHandlerRegistry()
    const handler = this.stepHandlerCache.find((h) => h.canHandle(ctx))
    // The fallthrough handler's `canHandle` is unconditional, so this is unreachable; it
    // exists only to satisfy the type and to fail loudly if that invariant is ever broken.
    if (!handler) throw new Error(`No step handler for agentKind "${ctx.step.agentKind}"`)
    return handler.handle(ctx)
  }

  /**
   * Build the order-sorted per-step-kind handler list, mirroring
   * {@link buildStepResolverRegistry} (built-ins constructed inline, closing over `this`).
   * Engine-internal: there is no public `registerStepHandler` seam. Phase 0 registers only
   * the generic fallthrough; later phases prepend more-specific handlers with lower `order`.
   */
  private buildStepHandlerRegistry(): StepHandler[] {
    const handlers: StepHandler[] = [
      // A `deployer` step provisions an ephemeral environment deterministically via the
      // provider — no LLM, no token usage — when the integration is wired. Unwired, its
      // `canHandle` is false so the step falls through to the generic agent path.
      {
        kind: DEPLOYER_AGENT_KIND,
        order: 100,
        canHandle: ({ step }) => !!this.environmentProvisioning && isDeployStep(step.agentKind),
        handle: ({ workspaceId, instance, step, block, isFinalStep }) =>
          this.runDeployerStep(workspaceId, instance, step, block, isFinalStep),
      },
      // A `tracker` step files a GitHub issue / Jira ticket from the preceding `analysis`
      // output (the tech-debt pipeline) — no LLM of its own. It is a pass-through when no
      // tracker provider is wired or none is configured for the workspace (handled inside
      // {@link runTracker}, which still records a result), so it always claims the step.
      {
        kind: TRACKER_AGENT_KIND,
        order: 110,
        canHandle: ({ step }) => step.agentKind === TRACKER_AGENT_KIND,
        handle: async ({ workspaceId, instance, step, block, isFinalStep }) => {
          const result = await this.runTracker(workspaceId, instance, block)
          return this.recordStepResult(workspaceId, instance, step, isFinalStep, result)
        },
      },
      // The `requirements-review` / `clarity-review` / `requirements-brainstorm` /
      // `architecture-brainstorm` steps are inline reviewers that park for their dedicated
      // window and drive the iterative answer → incorporate → re-review loop — NOT
      // container/prose agents. All four run through the {@link ReviewGateController},
      // parameterised by their {@link ReviewKind} (the per-case `switch` binds each kind's
      // review type so `evaluate`'s generic infers). Pass-through when the service isn't wired.
      {
        kind: 'review-gate',
        order: 120,
        canHandle: ({ step }) => REVIEW_GATE_AGENT_KINDS.has(step.agentKind),
        handle: ({ workspaceId, instance, step, block, isFinalStep }) => {
          switch (step.agentKind) {
            case REQUIREMENTS_REVIEW_AGENT_KIND:
              return this.reviewGate.evaluate(
                this.requirementsKind,
                workspaceId,
                instance,
                step,
                block,
                isFinalStep,
              )
            case CLARITY_REVIEW_AGENT_KIND:
              return this.reviewGate.evaluate(
                this.clarityKind,
                workspaceId,
                instance,
                step,
                block,
                isFinalStep,
              )
            case REQUIREMENTS_BRAINSTORM_AGENT_KIND:
              return this.reviewGate.evaluate(
                this.requirementsBrainstormKind,
                workspaceId,
                instance,
                step,
                block,
                isFinalStep,
              )
            case ARCHITECTURE_BRAINSTORM_AGENT_KIND:
              return this.reviewGate.evaluate(
                this.architectureBrainstormKind,
                workspaceId,
                instance,
                step,
                block,
                isFinalStep,
              )
            // `canHandle` admits only the kinds in REVIEW_GATE_AGENT_KINDS, so every member
            // must have an explicit case above. Throw loudly if the two ever drift (a new
            // review kind added to the Set without a case here) rather than silently routing
            // it to the wrong reviewer.
            default:
              throw new Error(`Unhandled review-gate agentKind "${step.agentKind}"`)
          }
        },
      },
      // A `human-test` gate spins up an ephemeral environment and PARKS for a human to
      // validate the change in a live URL — NOT a container/prose agent and NOT a
      // programmatic polling gate (the human is the verdict). Degrades to a manual (no-env)
      // mode when no ephemeral-environment provider is wired. See {@link HumanTestController}.
      {
        kind: HUMAN_TEST_AGENT_KIND,
        order: 130,
        canHandle: ({ step }) => step.agentKind === HUMAN_TEST_AGENT_KIND,
        handle: ({ workspaceId, instance, step, block, isFinalStep }) =>
          this.humanTestController.evaluate(workspaceId, instance, step, block, isFinalStep),
      },
      // A `visual-confirmation` gate gathers the UI tester's screenshots + uploaded reference
      // designs and PARKS for a human to review actual-vs-reference, then on demand dispatches
      // the Tester's `fixer`. Passes through when no binary-artifact store is wired.
      // See {@link VisualConfirmationController}.
      {
        kind: VISUAL_CONFIRM_AGENT_KIND,
        order: 140,
        canHandle: ({ step }) => step.agentKind === VISUAL_CONFIRM_AGENT_KIND,
        handle: ({ workspaceId, instance, step, block, isFinalStep }) =>
          this.visualConfirmationController.evaluate(
            workspaceId,
            instance,
            step,
            block,
            isFinalStep,
          ),
      },
      // A polling gate step (`ci` / `conflicts` / `post-release-health` / `human-review`) runs
      // a programmatic precheck and only escalates to a helper container agent on a negative
      // verdict — no LLM of its own. Pass-through when the gate's provider is not wired. One
      // generic machine drives every gate; see {@link evaluateGate}. `canHandle` is the gate
      // registry lookup, so this claims exactly the registered gate kinds.
      {
        kind: 'polling-gate',
        order: 150,
        canHandle: ({ step }) => this.gateFor(step.agentKind) !== undefined,
        handle: ({ workspaceId, instance, step, block, isFinalStep }) =>
          this.evaluateGate(
            workspaceId,
            instance,
            step,
            block,
            isFinalStep,
            this.gateFor(step.agentKind)!,
          ),
      },
      // An INLINE companion (architect-companion / spec-companion) grades the nearest
      // preceding producer right here and loops it back for automatic rework below the
      // threshold before any human gate. CONTAINER-backed companions (reviewer / doc-reviewer)
      // do NOT match — they fall through to the generic async container dispatch and have their
      // verdict resolved by the completion interceptor instead. See {@link CompanionController}.
      {
        kind: 'inline-companion',
        order: 160,
        canHandle: ({ step }) =>
          isCompanionKind(step.agentKind) && !isContainerBackedCompanion(step.agentKind),
        handle: ({ workspaceId, instance, step, block, isFinalStep, options }) =>
          this.companionController.evaluate(
            workspaceId,
            instance,
            step,
            block,
            isFinalStep,
            options,
          ),
      },
      // The generic container/inline-agent step — claims every step no more-specific handler
      // did. Highest order so it always runs last. See {@link handleAgentStep}.
      {
        kind: 'agent',
        order: FALLTHROUGH_STEP_HANDLER_ORDER,
        canHandle: () => true,
        handle: (ctx) => this.handleAgentStep(ctx),
      },
    ]
    return handlers.sort((a, b) => a.order - b.order)
  }

  /**
   * Run the first completion-path interceptor that claims this finished step, returning its
   * short-circuit {@link AdvanceResult} (the companion verdict loop / tester re-test) or
   * `null` to let `recordStepResult`'s normal finish/advance spine run. Engine-internal,
   * mirroring {@link dispatchStepHandler}.
   */
  private async dispatchStepCompletionInterceptor(
    ctx: StepCompletionContext,
  ): Promise<AdvanceResult | null> {
    if (!this.stepCompletionInterceptorCache) {
      this.stepCompletionInterceptorCache = this.buildStepCompletionInterceptors()
    }
    for (const interceptor of this.stepCompletionInterceptorCache) {
      if (interceptor.canIntercept(ctx)) {
        const outcome = await interceptor.intercept(ctx)
        if (outcome) return outcome
      }
    }
    return null
  }

  /**
   * Build the order-sorted completion-path interceptors (companion / tester verdict
   * short-circuits), mirroring {@link buildStepHandlerRegistry} — built-ins constructed
   * inline closing over `this`, no public registration seam.
   */
  private buildStepCompletionInterceptors(): StepCompletionInterceptor[] {
    const interceptors: StepCompletionInterceptor[] = [
      // A container-backed companion (reviewer / doc-reviewer) just finished reviewing the
      // real repository on the producer's PR branch and returned its verdict as
      // `result.custom`. Hand it to the companion loop, which parses the verdict and applies
      // the SAME threshold / rework / human-gate handling an inline companion gets. Routed
      // here (not the normal step completion) so the verdict drives the loop instead of being
      // recorded as plain output. Falls through (returns null) when the block can't be loaded.
      {
        kind: 'companion-verdict',
        order: 100,
        canIntercept: ({ step }) =>
          isCompanionKind(step.agentKind) && isContainerBackedCompanion(step.agentKind),
        intercept: async ({ workspaceId, instance, step, isFinalStep, result }) => {
          const companionBlock = await this.blockRepository.get(workspaceId, instance.blockId)
          if (!companionBlock) return null
          return this.companionController.resolveContainerVerdict(
            workspaceId,
            instance,
            step,
            companionBlock,
            isFinalStep,
            result,
          )
        },
      },
      // A `tester` step returned a structured report. On a withheld greenlight we do NOT
      // finish the step: loop the `fixer` (within the attempt budget) and re-test, mirroring
      // the CI gate. A greenlight (or no provider) returns null and falls through to the
      // normal finish/advance below. Records the report on the step either way.
      {
        kind: 'tester-verdict',
        order: 110,
        canIntercept: ({ step, result }) =>
          isTesterKind(step.agentKind) && result.testReport !== undefined,
        intercept: ({ workspaceId, instance, step, result }) =>
          this.testerController.resolveTesterResult(workspaceId, instance, step, result),
      },
    ]
    return interceptors.sort((a, b) => a.order - b.order)
  }

  private stepResolverFor(agentKind: string): StepCompletionResolver | undefined {
    if (!this.stepResolverCache) this.stepResolverCache = this.buildStepResolverRegistry()
    return this.stepResolverCache.get(agentKind)
  }

  private buildStepResolverRegistry(): Map<string, StepCompletionResolver> {
    const resolvers: StepCompletionResolver[] = [
      // The `merger` agent OWNS the merge decision, but the merge itself is mechanical
      // and uses backend-held GitHub credentials the sandboxed agent never sees — so the
      // engine performs it deterministically from the agent's assessment here, the moment
      // the merger step finishes (NOT only when it is the pipeline's last step, which is
      // why a trailing `post-release-health` step no longer disables auto-merge).
      {
        kind: MERGER_AGENT_KIND,
        applies: (result) => result.mergeAssessment !== undefined,
        resolve: async ({ workspaceId, instance, result }) => {
          // The real merge runs the engine GitHub client under the run initiator's
          // ambient context, so a per-user PAT (when set) authors the merge.
          await this.runInitiatorScope(instance.initiatedBy, () =>
            this.mergeResolver.resolveMergerStep(workspaceId, instance, result.mergeAssessment),
          )
          return { ownsTerminalStatus: true }
        },
      },
      // POST-COMPLETION resolvers — run at the early slot (after output is recorded, before
      // the follow-up/approval gates), reshaping the agent's structured result into domain
      // state. Lifted verbatim from the old inline `recordStepResult` branches.
      //
      // A Blueprinter step produced a fresh service decomposition. Validate it with the
      // authoritative schema (a bad payload must never touch the board), then reconcile it
      // in place onto the run's service frame.
      {
        kind: BLUEPRINTS_AGENT_KIND,
        phase: 'post-completion',
        resolve: async ({ workspaceId, instance, result }) => {
          if (result.blueprintService !== undefined) {
            await this.ingestBlueprint(workspaceId, instance.blockId, result.blueprintService)
          }
        },
      },
      // A spec-writer step produced the service's unified specification (`spec.json`) and
      // committed it to the implementation branch — strict-validate it then nudge clients —
      // and reports its BUSINESS-vs-TECHNICAL determination. "No business specs" (a purely
      // technical task) is a valid outcome the spec-companion's convergence later combines
      // with its `technicalCorroborated` verdict; recorded even when false so a re-run
      // reflects the latest.
      {
        kind: SPEC_WRITER_AGENT_KIND,
        phase: 'post-completion',
        resolve: async ({ workspaceId, step, result }) => {
          if (result.spec !== undefined) await this.ingestSpec(workspaceId, result.spec)
          step.noBusinessSpecs = result.noBusinessSpecs === true
        },
      },
      // A `task-estimator` step emits a JSON triage (complexity/risk/impact). Parse it
      // tolerantly, persist it on the block (used to gate consensus steps + surfaced in the
      // UI), and replace the raw JSON output with a readable summary. An unparseable estimate
      // leaves the block untouched and keeps the raw output (no run failure). Works the same
      // whether the single-actor estimator or the consensus ranked-scoring variant produced
      // the JSON. Running at the post-completion slot keeps the summary in `step.output`
      // before the approval gate reads it as the proposal.
      {
        kind: TASK_ESTIMATOR_AGENT_KIND,
        phase: 'post-completion',
        resolve: async ({ workspaceId, instance, step, result }) => {
          const estimate = coerceTaskEstimate(
            step.output ?? '',
            result.model ?? step.model ?? null,
            this.clock.now(),
          )
          if (estimate) {
            await this.blockRepository.update(workspaceId, instance.blockId, { estimate })
            return { output: summarizeEstimate(estimate) }
          }
        },
      },
    ]
    const map = new Map(resolvers.map((r) => [r.kind, r]))
    // Merge deployment-registered resolvers, mirroring the gate registry below. A
    // registered resolver of the same kind replaces the built-in (last registration wins).
    const ctx = this.makeResolverContext()
    for (const { kind, factory } of registeredStepResolverFactories()) map.set(kind, factory(ctx))
    return map
  }

  /** The shared engine seams handed to a deployment-registered step resolver's factory. */
  private makeResolverContext(): ResolverContext {
    return { runInitiatorScope: this.runInitiatorScope }
  }

  private buildGateRegistry(): Map<string, GateDefinition> {
    // The built-in gate suite (ci / conflicts / post-release-health) is no longer inline:
    // it ships as `@cat-factory/gates`, registered through the SAME public `registerGate`
    // seam any deployment uses (the dogfood — if the platform's own gates can be authored
    // as an external package, so can anyone's). The engine merely builds whatever gates were
    // registered at startup. A facade that forgot to `import '@cat-factory/gates'` then has
    // no gates and those steps fail — which the cross-runtime conformance suite catches.
    const map = new Map<string, GateDefinition>()
    const ctx = this.makeGateContext()
    for (const { kind, factory } of registeredGateFactories()) map.set(kind, factory(ctx))
    return map
  }

  /** The shared engine seams handed to a deployment-registered gate's factory. */
  private makeGateContext(): GateContext {
    return {
      clock: this.clock,
      getBlock: (workspaceId, blockId) => this.blockRepository.get(workspaceId, blockId),
      runInitiatorScope: this.runInitiatorScope,
      raiseNotification: async (workspaceId, input) => {
        await this.notificationService?.raise(workspaceId, input)
      },
      // A gate reaches its deployment-wired provider through the typed registry rather than
      // closing over a hand-authored module global; the engine just forwards to it.
      getProvider,
      requireProvider,
    }
  }

  /**
   * Evaluate a polling gate step once and decide (shared by the initial advance and the
   * durable `awaiting_gate` re-poll):
   *   - no provider wired → pass-through (advance; nothing to gate);
   *   - precheck passes   → advance to the next step (the helper agent is NEVER spun up);
   *   - still computing   → `awaiting_gate` (the driver sleeps then calls {@link pollGate});
   *   - fails, budget left → dispatch the helper container agent (`awaiting_job`);
   *   - fails, budget spent → the gate's exhaustion handler, then fail the run.
   */
  private async evaluateGate(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    block: Block,
    isFinalStep: boolean,
    gate: GateDefinition,
  ): Promise<AdvanceResult> {
    // Re-attach after a replay: a helper is already in flight for this gate.
    if (step.gate?.phase === 'working' && step.jobId) {
      return { kind: 'awaiting_job', jobId: step.jobId, stepIndex: instance.currentStep }
    }

    // Provider not wired: the gate is a pass-through so the engine works without it.
    if (!gate.wired()) {
      return this.recordStepResult(workspaceId, instance, step, isFinalStep, {
        output: gate.unwiredOutput,
      })
    }

    // Initialise the gate's state on first entry, resolving the attempt budget from the
    // task's merge preset (stable across polls once set).
    if (!step.gate) {
      const preset = await this.resolveMergePreset(workspaceId, block)
      step.gate = {
        phase: 'checking',
        attempts: 0,
        maxAttempts: gate.attemptBudget ? gate.attemptBudget(preset) : preset.ciMaxAttempts,
        headSha: null,
        // Stash the watch window once (read on every poll by a time-windowed gate's
        // probe; harmless/unused for the CI/conflicts gates).
        watchWindowMinutes: preset.releaseWatchWindowMinutes,
        // Stash the human-review grace window once (read by the human-review gate's probe;
        // harmless/unused for the other gates).
        humanReviewGraceMinutes: preset.humanReviewGraceMinutes,
      }
    }

    // A human-initiated fix request (an in-app freeform prompt, or a GitHub-comment
    // instruction) parked on the gate is dispatched immediately — bypassing the precheck +
    // grace window. Consume it at-most-once: clear + persist BEFORE the (side-effecting)
    // dispatch so a retried driver step can't re-dispatch a second fixer. Falls through to
    // the normal probe when there is no async executor to escalate to.
    if (step.gate.pendingFix && isAsyncAgentExecutor(this.agentExecutor)) {
      const fix = step.gate.pendingFix
      step.gate.pendingFix = null
      await this.executionRepository.upsert(workspaceId, instance)
      return this.dispatchGateHelper(
        workspaceId,
        instance,
        step,
        block,
        isFinalStep,
        gate,
        fix.instructions,
      )
    }
    // A time-windowed gate (post-release-health) marks when it began watching, on first
    // entry, so its probe knows whether the monitoring window has elapsed. Harmless for
    // the CI/conflicts gates, which ignore it.
    if (step.gate.watchSince == null) step.gate.watchSince = this.clock.now()

    // Resolve the gate's GitHub reads (CI checks / mergeability) under the run
    // initiator's ambient context, so a per-user PAT (when set) is preferred over the
    // deployment's App/env token — see PatPreferringAppRegistry.
    const gateState = step.gate
    const probe = await this.runInitiatorScope(instance.initiatedBy, () =>
      gate.probe(workspaceId, block.id, gateState),
    )
    step.gate.headSha = probe.headSha
    // Persist the precheck outcome so the run-detail UI can surface why the gate is
    // looping (the failing checks / conflict reason) — detail that was previously fed
    // only to the helper agent and then discarded.
    step.gate.lastVerdict = probe.status
    step.gate.lastFailureSummary = probe.failureSummary ?? null
    step.gate.failingChecks = probe.failingChecks ?? null

    if (probe.status === 'pass') {
      // Stop the moment the precheck passes — finish the step and advance.
      return this.recordStepResult(workspaceId, instance, step, isFinalStep, {
        output: probe.passOutput ?? `${gate.kind} gate passed.`,
      })
    }

    if (probe.status === 'pending') {
      // Keep polling. Persist the head sha + phase so the board can reflect it.
      step.gate.phase = 'checking'
      await this.executionRepository.upsert(workspaceId, instance)
      await this.runStateMachine.emitInstance(workspaceId, instance)
      return { kind: 'awaiting_gate', stepIndex: instance.currentStep }
    }

    // probe.status === 'fail'.
    const canEscalate = isAsyncAgentExecutor(this.agentExecutor)
    if (canEscalate && step.gate.attempts < step.gate.maxAttempts) {
      return this.dispatchGateHelper(
        workspaceId,
        instance,
        step,
        block,
        isFinalStep,
        gate,
        probe.failureSummary,
      )
    }

    // Budget spent (or no async executor to escalate to): give up.
    const { error } = await gate.onExhausted({
      workspaceId,
      instance,
      block,
      step,
      summary: probe.failureSummary,
    })
    return { kind: 'job_failed', error }
  }

  /**
   * Dispatch a gate's helper container agent on a failed precheck: build the agent
   * context with the kind overridden to the helper (it clones the PR head branch and
   * pushes — no new PR), park on the job, and flip the gate to `working`. Idempotent
   * under replay via the step's `jobId` (re-attach handled in {@link evaluateGate}).
   */
  private async dispatchGateHelper(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    block: Block,
    isFinalStep: boolean,
    gate: GateDefinition,
    failureSummary?: string,
  ): Promise<AdvanceResult> {
    const executor = this.agentExecutor
    if (!isAsyncAgentExecutor(executor)) {
      // Defensive: evaluateGate only calls this when async-capable.
      return { kind: 'job_failed', error: `No async executor available for the ${gate.kind} gate.` }
    }
    const base = await this.contextBuilder.buildContext(
      workspaceId,
      instance,
      step,
      isFinalStep,
      block,
    )
    // A gate may build richer helper context asynchronously (the on-call agent gets the
    // full Datadog evidence bundle); otherwise fall back to the simple summary prior.
    const extras = gate.gatherHelperPriorOutputs
      ? await gate.gatherHelperPriorOutputs(
          workspaceId,
          block.id,
          step.gate ?? { phase: 'checking', attempts: 0, maxAttempts: 0 },
        )
      : [gate.helperPriorOutput?.(failureSummary ?? '')].filter(
          (o): o is { agentKind: string; output: string } => o != null,
        )
    const context: AgentRunContext = {
      ...base,
      agentKind: gate.helperKind,
      priorOutputs: [...base.priorOutputs, ...extras],
    }
    const handle = await executor.startJob(context)
    step.jobId = handle.jobId
    if (handle.model) step.model = handle.model
    step.gate = {
      // Preserve the recorded verdict/failure detail (set in evaluateGate) so the UI
      // keeps showing what the helper is fixing while it works.
      ...step.gate,
      phase: 'working',
      attempts: (step.gate?.attempts ?? 0) + 1,
      maxAttempts: step.gate?.maxAttempts ?? DEFAULT_MERGE_PRESET.ciMaxAttempts,
      headSha: step.gate?.headSha ?? null,
    }
    await this.executionRepository.upsert(workspaceId, instance)
    await this.runStateMachine.emitInstance(workspaceId, instance)
    return { kind: 'awaiting_job', jobId: step.jobId, stepIndex: instance.currentStep }
  }

  // ---- Follow-up companion (future-looking Coder) -------------------------
  // The Coder streams forward-looking items (loose ends / side-tasks / questions) which
  // accrue on its `step.followUps` live (see pollAgentJob). At the Coder's completion the
  // run parks while any item is undecided, then loops the Coder for the items the human
  // queued / answered (within the loop budget) before the following steps may start.

  /**
   * Append the items the harness streamed since the last poll onto the Coder step's
   * follow-up state as fresh `pending` items. A no-op when the companion is off or nothing
   * was streamed. Returns whether anything was added (so the poller persists + emits).
   */
  private appendStreamedFollowUps(
    step: PipelineStep,
    streamed: StreamedFollowUp[] | undefined,
  ): boolean {
    if (!step.followUps?.enabled || !streamed || streamed.length === 0) return false
    const now = this.clock.now()
    for (const s of streamed) {
      const title = (s.title ?? '').trim()
      if (!title) continue
      step.followUps.items.push({
        id: this.idGenerator.next('fu'),
        kind: s.kind === 'question' ? 'question' : 'follow_up',
        title,
        detail: s.detail ?? '',
        ...(s.suggestedAction ? { suggestedAction: s.suggestedAction } : {}),
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      })
    }
    return true
  }

  /**
   * The Follow-up companion gate, evaluated when the Coder step completes: park the run on
   * a durable decision while any item is undecided; else loop the Coder for the queued /
   * answered items (within the budget); else fall through (return undefined) so the normal
   * advance/finish logic runs. Returns an {@link AdvanceResult} only when it parks or loops.
   */
  private async evaluateFollowUpGate(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
  ): Promise<AdvanceResult | undefined> {
    const state = step.followUps
    if (!state?.enabled) return undefined
    if (hasPendingFollowUps(state)) {
      await this.raiseFollowUpPending(workspaceId, instance, state)
      return this.runStateMachine.parkStepOnDecision(workspaceId, instance, step)
    }
    if (shouldLoopCoder(state)) {
      this.loopCoderForFollowUps(instance, step)
      await this.runStateMachine.updateBlockProgress(workspaceId, instance, 'in_progress')
      await this.executionRepository.upsert(workspaceId, instance)
      await this.runStateMachine.emitInstance(workspaceId, instance)
      return { kind: 'continue' }
    }
    return undefined
  }

  /**
   * Reset the Coder step and fold the human's queued follow-ups / answered questions into
   * its rework so the next pass extends the prior work. Marks those items `sentToCoder` so
   * a later completion doesn't re-loop them, and counts the loop against the budget. Shared
   * by the at-completion path ({@link evaluateFollowUpGate}) and the parked-resume path.
   */
  private loopCoderForFollowUps(instance: ExecutionInstance, step: PipelineStep): void {
    const state = step.followUps!
    const sending = followUpsToSendBack(state)
    const feedback = renderFollowUpRework(sending)
    for (const item of sending) {
      item.sentToCoder = true
      item.updatedAt = this.clock.now()
    }
    state.loops = (state.loops ?? 0) + 1
    // Reset the step for a fresh dispatch; `step.followUps` is intentionally preserved
    // (resetStepForRerun doesn't touch it) so the surfaced items survive the loop.
    this.stepGraph.resetStepForRerun(step)
    step.rework = { previousProposal: '', feedback }
    this.stepGraph.startStep(step)
    if (instance.status === 'blocked') instance.status = 'running'
  }

  /** Raise the "follow-ups need decisions" inbox card when the Coder parks on undecided items. */
  private async raiseFollowUpPending(
    workspaceId: string,
    instance: ExecutionInstance,
    state: FollowUpsStepState,
  ): Promise<void> {
    if (!this.notificationService) return
    const block = await this.blockRepository.get(workspaceId, instance.blockId)
    if (!block) return
    const pending = state.items.filter((i) => i.status === 'pending').length
    await this.notificationService.raise(workspaceId, {
      type: 'followup_pending',
      blockId: block.id,
      executionId: instance.id,
      title: `"${block.title}" surfaced ${pending} follow-up${pending === 1 ? '' : 's'} to decide`,
      body:
        'The Coder flagged forward-looking follow-ups / questions. Open the task to file ' +
        'each as an issue, send it back to the Coder, answer it, or dismiss it — the ' +
        'pipeline continues once every item is decided.',
      payload: { pipelineName: instance.pipelineName, findingCount: pending },
    })
  }

  /**
   * The run's "active" follow-up companion step for a read with no item context (the GET /
   * the inbox-card open). A pipeline may carry MORE THAN ONE follow-up-enabled Coder step,
   * so this must not blindly pick the first: prefer the step the run is currently on (a Coder
   * parked on its follow-up gate), else the latest enabled step that has surfaced items, else
   * the first enabled one.
   */
  private activeFollowUpStep(
    instance: ExecutionInstance,
  ): { step: PipelineStep; index: number } | undefined {
    const current = instance.steps[instance.currentStep]
    if (current?.followUps?.enabled) return { step: current, index: instance.currentStep }
    for (let i = instance.steps.length - 1; i >= 0; i--) {
      const s = instance.steps[i]!
      if (s.followUps?.enabled && s.followUps.items.length > 0) return { step: s, index: i }
    }
    const index = instance.steps.findIndex((s) => s.followUps?.enabled)
    return index >= 0 ? { step: instance.steps[index]!, index } : undefined
  }

  /** Read a run's live follow-up companion state (the active Coder step's items), or null. */
  async getFollowUps(workspaceId: string, executionId: string): Promise<FollowUpsStepState | null> {
    const instance = await this.executionRepository.get(workspaceId, executionId)
    if (!instance) throw new NotFoundError('Execution', executionId)
    return this.activeFollowUpStep(instance)?.step.followUps ?? null
  }

  /**
   * Locate the run + the Coder step that OWNS the addressed item + the item, throwing 404
   * when absent. Routes by item id (not "the first enabled step") so a pipeline carrying more
   * than one follow-up-enabled Coder step decides each item on the step that surfaced it —
   * otherwise a later Coder's items 404 and its gate can never be cleared.
   */
  private async loadFollowUpItem(
    workspaceId: string,
    executionId: string,
    itemId: string,
  ): Promise<{
    instance: ExecutionInstance
    step: PipelineStep
    index: number
    item: FollowUpItem
  }> {
    const instance = await this.executionRepository.get(workspaceId, executionId)
    if (!instance) throw new NotFoundError('Execution', executionId)
    const index = instance.steps.findIndex(
      (s) => s.followUps?.enabled && s.followUps.items.some((i) => i.id === itemId),
    )
    if (index < 0) throw new NotFoundError('Follow-up item', itemId)
    const step = instance.steps[index]!
    const item = step.followUps!.items.find((i) => i.id === itemId)!
    return { instance, step, index, item }
  }

  /** File a `follow_up` item as a tracker issue (GitHub / Jira), recording the ticket ref. */
  async fileFollowUp(
    workspaceId: string,
    executionId: string,
    itemId: string,
  ): Promise<FollowUpsStepState> {
    const { instance, step, index, item } = await this.loadFollowUpItem(
      workspaceId,
      executionId,
      itemId,
    )
    if (item.kind !== 'follow_up') {
      throw new ConflictError('Only follow-up items can be filed as issues')
    }
    if (!this.ticketTrackerProvider) {
      throw new ConflictError('No issue tracker is configured for this workspace')
    }
    const frameId =
      (await this.contextBuilder.resolveServiceFrameId(workspaceId, instance.blockId)) ??
      instance.blockId
    const body = [
      item.detail,
      item.suggestedAction ? `\n\nSuggested approach: ${item.suggestedAction}` : '',
    ]
      .join('')
      .trim()
    const ticket = await this.ticketTrackerProvider.createTicket({
      workspaceId,
      frameId,
      title: item.title,
      body: body || item.title,
    })
    if (!ticket) {
      throw new ConflictError('No issue tracker is configured for this workspace')
    }
    item.status = 'filed'
    item.ticketExternalId = ticket.externalId
    item.ticketUrl = ticket.url
    item.updatedAt = this.clock.now()
    await this.driveFollowUpsAfterDecision(workspaceId, instance, step, index)
    return step.followUps!
  }

  /** Queue a `follow_up` item to send back to the Coder on its next pass. */
  async queueFollowUp(
    workspaceId: string,
    executionId: string,
    itemId: string,
  ): Promise<FollowUpsStepState> {
    const { instance, step, index, item } = await this.loadFollowUpItem(
      workspaceId,
      executionId,
      itemId,
    )
    if (item.kind !== 'follow_up') {
      throw new ConflictError('Only follow-up items can be sent back to the Coder')
    }
    item.status = 'queued'
    item.sentToCoder = false
    item.updatedAt = this.clock.now()
    await this.driveFollowUpsAfterDecision(workspaceId, instance, step, index)
    return step.followUps!
  }

  /** Answer a `question` item; the answer is folded into the Coder's next pass. */
  async answerFollowUp(
    workspaceId: string,
    executionId: string,
    itemId: string,
    answer: string,
  ): Promise<FollowUpsStepState> {
    const { instance, step, index, item } = await this.loadFollowUpItem(
      workspaceId,
      executionId,
      itemId,
    )
    if (item.kind !== 'question') {
      throw new ConflictError('Only question items can be answered')
    }
    item.status = 'answered'
    item.answer = answer
    item.sentToCoder = false
    item.updatedAt = this.clock.now()
    await this.driveFollowUpsAfterDecision(workspaceId, instance, step, index)
    return step.followUps!
  }

  /** Dismiss a follow-up / question item without acting on it. */
  async dismissFollowUp(
    workspaceId: string,
    executionId: string,
    itemId: string,
  ): Promise<FollowUpsStepState> {
    const { instance, step, index, item } = await this.loadFollowUpItem(
      workspaceId,
      executionId,
      itemId,
    )
    item.status = 'dismissed'
    item.updatedAt = this.clock.now()
    await this.driveFollowUpsAfterDecision(workspaceId, instance, step, index)
    return step.followUps!
  }

  /**
   * Persist an item decision and, when the run is PARKED on this step's follow-up gate and
   * every item is now decided, drive it forward: loop the Coder for the queued / answered
   * items (within the budget), else advance past the gate. When the run is not parked (the
   * Coder is still running, or it already moved on) this only persists + emits the change.
   */
  private async driveFollowUpsAfterDecision(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    index: number,
  ): Promise<void> {
    const parkedHere =
      instance.status === 'blocked' &&
      step.approval?.status === 'pending' &&
      instance.currentStep === index
    if (!parkedHere || hasPendingFollowUps(step.followUps!)) {
      // Still collecting decisions (or the run isn't parked on this gate): just record it.
      await this.executionRepository.upsert(workspaceId, instance)
      await this.runStateMachine.emitInstance(workspaceId, instance)
      return
    }
    // Every item is decided and the run is parked here: clear the waiting card and either
    // loop the Coder for the send-back items or advance past the gate.
    await this.runStateMachine.clearWaitingNotification(workspaceId, instance)
    if (shouldLoopCoder(step.followUps!)) {
      const decisionId = step.approval!.id
      this.loopCoderForFollowUps(instance, step)
      await this.runStateMachine.updateBlockProgress(workspaceId, instance, 'in_progress')
      await this.executionRepository.upsert(workspaceId, instance)
      await this.workRunner.signalDecision(workspaceId, instance.id, decisionId, 'approved')
      await this.runStateMachine.emitInstance(workspaceId, instance)
      return
    }
    // The follow-up gate is settled and we won't loop. If this step ALSO carries a human
    // approval gate, hand off to it now instead of advancing — the follow-up park reused
    // `step.approval`, so advancing here would silently SKIP the approval. Keep the same
    // parked decision id (the durable driver is already waiting on it), refresh the proposal
    // to the step output, and re-raise the standard "waiting for input" card (we just cleared
    // the follow-up one). The human then resolves it through the normal approve / request-
    // changes path. The follow-up gate already ran BEFORE the approval gate in
    // recordStepResult, so this preserves that exact ordering across the park.
    const isFinalStep = index === instance.steps.length - 1
    if (step.requiresApproval && !isFinalStep && step.approval?.status === 'pending') {
      step.approval = { ...step.approval, proposal: step.output ?? '' }
      await this.executionRepository.upsert(workspaceId, instance)
      await this.runStateMachine.ensureWaitingNotification(workspaceId, instance)
      await this.runStateMachine.emitInstance(workspaceId, instance)
      return
    }
    await this.runStateMachine.advancePastResolvedGate(workspaceId, instance, index)
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

  /**
   * Invoke the agent for an already-built context. Failures are swallowed into the
   * step output so a run never wedges — unless `rethrowAgentErrors` is set (the
   * durable path), in which case the error propagates so the driver's per-step
   * retry can take over.
   */
  async runAgent(context: AgentRunContext, options: AdvanceOptions = {}): Promise<AgentRunResult> {
    try {
      return await this.agentExecutor.run(context)
    } catch (error) {
      // The durable driver wants real failures to surface so its per-step retry
      // can kick in (and the error gets persisted after retries are exhausted).
      if (options.rethrowAgentErrors) throw error
      // Otherwise a failed agent must not wedge the run; record and complete.
      return {
        output: `Agent error: ${getErrorMessage(error)}`,
      }
    }
  }

  /**
   * Strictly parse a Blueprinter step's tree and reconcile it onto the board. The
   * blueprint maps the whole repository, so it is reconciled onto the run block's
   * **service frame** (walked up from the block), not the task the run targeted.
   * Best-effort and reconciler-gated: a parse/reconcile failure is logged-by-throw
   * upstream only when the reconciler is wired; with no reconciler it is a no-op so
   * the blueprint's in-repo files still land.
   */
  private async ingestBlueprint(
    workspaceId: string,
    blockId: string,
    rawService: unknown,
  ): Promise<void> {
    if (!this.blueprintReconciler) return
    let service: BlueprintService
    try {
      service = parseBlueprintService(rawService)
    } catch {
      // A malformed tree must not fail the step (the in-repo files are already
      // committed); skip the board reconcile.
      return
    }
    const frameId = await this.contextBuilder.resolveServiceFrameId(workspaceId, blockId)
    await this.blueprintReconciler.reconcileBlueprint(workspaceId, frameId, service)
    // The reconcile may have created/updated module + task blocks that aren't
    // individually pushed; nudge clients to refresh the board so they appear. Name the service
    // frame so the refresh fans out to every board mounting this shared service.
    await this.events.boardChanged(workspaceId, 'blueprint-reconciled', frameId)
  }

  /**
   * Strictly validate a spec-writer step's unified specification. The canonical record
   * is the in-repo `spec/` files the harness already committed; this is the trust
   * boundary (a malformed payload is dropped, never trusted) plus a client refresh
   * nudge. A persisted board projection is a deliberate later phase.
   */
  private async ingestSpec(workspaceId: string, rawDoc: unknown): Promise<void> {
    try {
      parseSpecDoc(rawDoc)
    } catch {
      // A malformed doc must not fail the step (the in-repo files are already
      // committed); skip the refresh.
      return
    }
    // Nudge clients to refresh so they can re-read the service's spec files.
    await this.events.boardChanged(workspaceId, 'requirements-updated')
  }
}
