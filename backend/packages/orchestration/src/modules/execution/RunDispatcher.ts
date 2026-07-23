import type {
  AgentExecutor,
  AgentJobHandle,
  AgentJobUpdate,
  AgentRunContext,
  AgentRunResult,
  Block,
  BlockRepository,
  BlueprintService,
  BrainstormSession,
  ClarityReview,
  Clock,
  ExecutionEventPublisher,
  ExecutionInstance,
  ExecutionRepository,
  FollowUpsStepState,
  ForkDecisionStepState,
  ChooseForkInput,
  ForkChatRequestInput,
  PrReviewStepState,
  ResolvePrReviewInput,
  ChallengePrReviewFindingInput,
  GateContext,
  GateDefinition,
  GateRegistry,
  StepResolverRegistry,
  ProviderRegistry,
  GateHelperJobResult,
  IdGenerator,
  IssueWritebackProvider,
  PipelineStep,
  ProviderCapabilities,
  RequirementConcernLevel,
  StepGating,
  RequirementReview,
  ResolveRunRepoContext,
  RunInitiatorScope,
  StepCompletionResolver,
  TicketTrackerProvider,
  WorkRunner,
} from '@cat-factory/kernel'
import {
  ConflictError,
  DEFAULT_RISK_POLICY,
  getErrorMessage,
  isAsyncAgentExecutor,
  NotFoundError,
  parseLocalModelId,
  recordGateAttempt,
  RunContendedError,
  sameSubtasks,
} from '@cat-factory/kernel'
import { parseBlueprintService, parseSpecDoc } from '@cat-factory/contracts'
import {
  commitInitiativeTracker,
  FORK_PROPOSER_KIND,
  PR_REVIEWER_KIND,
  resolvePrNumber,
} from '@cat-factory/agents'
import type { AgentKindRegistry } from '@cat-factory/agents'
import { isDeployStep } from '@cat-factory/integrations'
import type {
  BugIntakeOutcome,
  BugIntakeService,
  EnvironmentProvisioningService,
} from '@cat-factory/integrations'
import { reviewableArtifactOutput } from './artifact-review.logic.js'
import { ANALYSIS_AGENT_KIND, CONFLICTS_AGENT_KIND, HUMAN_TEST_AGENT_KIND } from './ci.logic.js'
import {
  classifyDispatchFailure,
  type ContainerFailureView,
  MAX_EVICTION_RECOVERIES,
  MAX_TRANSIENT_EVICTION_RECOVERIES,
  shouldPersistActivity,
} from './job.logic.js'
import { AgentContextBuilder } from './AgentContextBuilder.js'
import { DeployerStepController } from './DeployerStepController.js'
import { FollowUpGateController } from './FollowUpGateController.js'
import { RunRepoOpsController } from './RunRepoOpsController.js'
import { CompanionController } from './CompanionController.js'
import { HumanTestController } from './HumanTestController.js'
import { MergeResolver } from './MergeResolver.js'
import { ReviewGateController, type ReviewKind } from './ReviewGateController.js'
import { ForkDecisionController } from './ForkDecisionController.js'
import { PrReviewController } from './PrReviewController.js'
import { initialPrReviewState } from './prReview.logic.js'
import { PrReviewResolutionController } from './PrReviewResolutionController.js'
import { PollCompletionController } from './PollCompletionController.js'
import {
  DEFAULT_FORK_MAX_CHAT_TURNS,
  resolveForkTriState,
  shouldProposeForkAuto,
} from './forkDecision.logic.js'
import type { InterviewGateController } from './InterviewGateController.js'
import { RunStateMachine } from './RunStateMachine.js'
import { StepGraph } from './StepGraph.js'
import { TesterController } from './TesterController.js'
import { RalphController } from './RalphController.js'
import { VisualConfirmationController } from './VisualConfirmationController.js'
import {
  type StepCompletionContext,
  type StepCompletionInterceptor,
  type StepHandler,
  type StepHandlerContext,
} from './step-handler-registry.js'
import type { AdvanceOptions, AdvanceResult } from './advance.js'
import {
  type DispatcherRegistryDeps,
  buildStepCompletionInterceptors as buildStepCompletionInterceptorsImpl,
  buildStepHandlerRegistry as buildStepHandlerRegistryImpl,
  buildStepResolverRegistry as buildStepResolverRegistryImpl,
} from './dispatcher-registries.js'
import type { NotificationService } from '../notifications/NotificationService.js'
import type { InitiativeService } from '../initiative/InitiativeService.js'
import type { SpendService } from '@cat-factory/spend'
import type { BlueprintReconciler } from './ExecutionService.js'

/**
 * The task's fully-resolved merge-threshold preset (block pin → workspace default →
 * built-in). The dispatcher only reads the gate-relevant fields; the full shape is kept so
 * a gate's `attemptBudget(preset)` sees every knob. Mirrors {@link ExecutionService.resolveRiskPolicy}.
 */
type ResolvedRiskPolicy = {
  maxComplexity: number
  maxRisk: number
  maxImpact: number
  ciMaxAttempts: number
  maxRequirementIterations: number
  maxRequirementConcernAllowed: RequirementConcernLevel
  releaseWatchWindowMinutes: number
  releaseMaxAttempts: number
  humanReviewGraceMinutes: number
  forkDecision?: StepGating | null
}

/** Collaborators + leaf dependencies the {@link RunDispatcher} needs. */
export interface RunDispatcherDeps {
  blockRepository: BlockRepository
  executionRepository: ExecutionRepository
  agentExecutor: AgentExecutor
  /** App-owned agent-kind registry: a registered kind's step spec + pre/post-op hooks. */
  agentKindRegistry: AgentKindRegistry
  /** App-owned polling-gate registry (built-ins installed by the facade via `registerBuiltinGates`). */
  gateRegistry: GateRegistry
  /** App-owned step-completion-resolver registry (deployment-registered resolvers). */
  stepResolverRegistry: StepResolverRegistry
  /** App-owned provider registry the gate machine's {@link GateContext} reads (gate data sources). */
  providerRegistry: ProviderRegistry
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
  ralphController: RalphController
  humanTestController: HumanTestController
  visualConfirmationController: VisualConfirmationController
  reviewGate: ReviewGateController
  forkDecisionController: ForkDecisionController
  prReviewController: PrReviewController
  requirementsKind: ReviewKind<RequirementReview>
  clarityKind: ReviewKind<ClarityReview>
  requirementsBrainstormKind: ReviewKind<BrainstormSession>
  architectureBrainstormKind: ReviewKind<BrainstormSession>
  /**
   * The interactive-interviewer gates wired for this deployment (initiative-planning, document
   * interview, …). Each rides the shared {@link InterviewGateController} spine and is routed by
   * the `interview-gate` TRAIT, keyed on its own `agentKind` — so adding a new interviewer wires
   * its controller here, with no new dispatch branch. Absent/unwired kinds pass through.
   */
  interviewControllers?: InterviewGateController<unknown>[]
  runInitiatorScope: RunInitiatorScope
  environmentProvisioning?: EnvironmentProvisioningService
  ticketTrackerProvider?: TicketTrackerProvider
  issueWriteback?: IssueWritebackProvider
  /** The recurring `bug-intake` step's read-and-claim helper; absent → the step is a no-op. */
  bugIntakeService?: BugIntakeService
  notificationService?: NotificationService
  blueprintReconciler?: BlueprintReconciler
  initiativeService?: InitiativeService
  resolveRunRepoContext?: ResolveRunRepoContext
  resolveProviderCapabilities?: (
    workspaceId: string,
    initiatedBy?: string | null,
  ) => Promise<ProviderCapabilities>
  /** Resolve a task's merge preset (stays on the engine, shared with the merge subgraph). */
  resolveRiskPolicy: (workspaceId: string, block: Block) => Promise<ResolvedRiskPolicy>
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
 * `resolveRiskPolicy` callback + the {@link MergeResolver} (which itself closes over the
 * engine's `finalizeMerge`). `ExecutionService.stepInstance` / `pollAgentJob` / `pollGate`
 * delegate here; no behaviour changes in the move.
 */
export class RunDispatcher {
  private readonly blockRepository: BlockRepository
  private readonly executionRepository: ExecutionRepository
  private readonly agentExecutor: AgentExecutor
  private readonly agentKindRegistry: AgentKindRegistry
  private readonly gateRegistry: GateRegistry
  private readonly stepResolverRegistry: StepResolverRegistry
  private readonly providerRegistry: ProviderRegistry
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
  private readonly ralphController: RalphController
  private readonly humanTestController: HumanTestController
  private readonly visualConfirmationController: VisualConfirmationController
  private readonly reviewGate: ReviewGateController
  private readonly forkDecisionController: ForkDecisionController
  private readonly prReviewController: PrReviewController
  private readonly requirementsKind: ReviewKind<RequirementReview>
  private readonly clarityKind: ReviewKind<ClarityReview>
  private readonly requirementsBrainstormKind: ReviewKind<BrainstormSession>
  private readonly architectureBrainstormKind: ReviewKind<BrainstormSession>
  /** Interview-gate controllers keyed by their `agentKind` — the trait-driven dispatch table. */
  private readonly interviewControllers: Map<string, InterviewGateController<unknown>>
  private readonly runInitiatorScope: RunInitiatorScope
  private readonly environmentProvisioning?: EnvironmentProvisioningService
  private readonly ticketTrackerProvider?: TicketTrackerProvider
  private readonly issueWriteback?: IssueWritebackProvider
  private readonly bugIntakeService?: BugIntakeService
  private readonly notificationService?: NotificationService
  private readonly blueprintReconciler?: BlueprintReconciler
  private readonly initiativeService?: InitiativeService
  private readonly resolveRunRepoContext?: ResolveRunRepoContext
  private readonly resolveProviderCapabilities?: (
    workspaceId: string,
    initiatedBy?: string | null,
  ) => Promise<ProviderCapabilities>
  private readonly resolveRiskPolicy: (
    workspaceId: string,
    block: Block,
  ) => Promise<ResolvedRiskPolicy>
  private readonly modelIdIsMetered: (id: string | undefined, caps: ProviderCapabilities) => boolean

  /**
   * The deterministic `deployer` step family (the multi-frame provision fan-out, the async
   * deploy-job poll, and the environment projection env-aware steps surface), extracted to
   * {@link DeployerStepController}. The completion hub + the shared poll folds are injected
   * back as callbacks so the agent and deployer paths share one implementation of each.
   */
  private readonly deployer: DeployerStepController
  private readonly repoOps: RunRepoOpsController
  /** Driver-side PR deep-review resolution (`fix` / `post`), extracted as a cohesive collaborator. */
  private readonly prReviewResolution: PrReviewResolutionController
  /** Settled-agent-poll completion (helper-phase branches + `failed` handling), extracted collaborator. */
  private readonly pollCompletion: PollCompletionController
  /**
   * The Follow-up companion gate (the future-looking Coder's streamed items, the
   * park-until-decided gate, and the human-action API), extracted to
   * {@link FollowUpGateController}. The dispatcher folds streamed items on each poll and
   * evaluates the gate at Coder completion through this; the public follow-up methods below
   * are thin pass-throughs the execution service re-exports.
   */
  private readonly followUpGate: FollowUpGateController

  /** Lazily-built polling-gate registry, keyed by `agentKind`. See {@link gateFor}. */
  private gateRegistryCache?: Map<string, GateDefinition>
  /** Lazily-built post-completion resolver registry, keyed by `agentKind`. */
  private stepResolverCache?: Map<string, StepCompletionResolver>
  /** Lazily-built, order-sorted per-step-kind handler list. See {@link dispatchStepHandler}. */
  private stepHandlerCache?: StepHandler[]
  /** Lazily-built, order-sorted completion-path interceptor list. */
  private stepCompletionInterceptorCache?: StepCompletionInterceptor[]

  /**
   * The seam the built-in dispatch-registry builders ({@link buildStepHandlerRegistryImpl} et al.)
   * close over — this dispatcher's collaborators plus bound call-backs to its own completion /
   * gate / phase methods. Assembled once at the end of the constructor; the builders live in
   * `dispatcher-registries.ts` so the large declarative registration stays out of this class.
   */
  private readonly registryDeps: DispatcherRegistryDeps

  constructor(deps: RunDispatcherDeps) {
    this.blockRepository = deps.blockRepository
    this.executionRepository = deps.executionRepository
    this.agentExecutor = deps.agentExecutor
    this.agentKindRegistry = deps.agentKindRegistry
    this.gateRegistry = deps.gateRegistry
    this.stepResolverRegistry = deps.stepResolverRegistry
    this.providerRegistry = deps.providerRegistry
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
    this.ralphController = deps.ralphController
    this.humanTestController = deps.humanTestController
    this.visualConfirmationController = deps.visualConfirmationController
    this.reviewGate = deps.reviewGate
    this.forkDecisionController = deps.forkDecisionController
    this.prReviewController = deps.prReviewController
    this.requirementsKind = deps.requirementsKind
    this.clarityKind = deps.clarityKind
    this.requirementsBrainstormKind = deps.requirementsBrainstormKind
    this.architectureBrainstormKind = deps.architectureBrainstormKind
    this.interviewControllers = new Map(
      (deps.interviewControllers ?? []).map((c) => [c.agentKind, c]),
    )
    this.runInitiatorScope = deps.runInitiatorScope
    this.environmentProvisioning = deps.environmentProvisioning
    this.ticketTrackerProvider = deps.ticketTrackerProvider
    this.issueWriteback = deps.issueWriteback
    this.bugIntakeService = deps.bugIntakeService
    this.notificationService = deps.notificationService
    this.blueprintReconciler = deps.blueprintReconciler
    this.initiativeService = deps.initiativeService
    this.resolveRunRepoContext = deps.resolveRunRepoContext
    this.resolveProviderCapabilities = deps.resolveProviderCapabilities
    this.resolveRiskPolicy = deps.resolveRiskPolicy
    this.modelIdIsMetered = deps.modelIdIsMetered
    this.deployer = new DeployerStepController({
      blockRepository: deps.blockRepository,
      contextBuilder: deps.contextBuilder,
      runStateMachine: deps.runStateMachine,
      environmentProvisioning: deps.environmentProvisioning,
      recordStepResult: (ws, instance, step, isFinalStep, result) =>
        this.recordStepResult(ws, instance, step, isFinalStep, result),
      applyContainerRunning: (step, update) => this.applyContainerRunning(step, update),
      applySubtaskProgress: (step, counts) => this.applySubtaskProgress(step, counts),
      recoverContainerEviction: (ws, instance, step, failure, onBeforeRedispatch) =>
        this.recoverContainerEviction(ws, instance, step, failure, onBeforeRedispatch),
    })
    this.followUpGate = new FollowUpGateController({
      executionRepository: deps.executionRepository,
      blockRepository: deps.blockRepository,
      contextBuilder: deps.contextBuilder,
      stepGraph: deps.stepGraph,
      runStateMachine: deps.runStateMachine,
      workRunner: deps.workRunner,
      idGenerator: deps.idGenerator,
      clock: deps.clock,
      notificationService: deps.notificationService,
      ticketTrackerProvider: deps.ticketTrackerProvider,
    })
    this.repoOps = new RunRepoOpsController({
      blockRepository: deps.blockRepository,
      contextBuilder: deps.contextBuilder,
      agentKindRegistry: deps.agentKindRegistry,
      resolveRunRepoContext: deps.resolveRunRepoContext,
      issueWriteback: deps.issueWriteback,
    })
    this.prReviewResolution = new PrReviewResolutionController({
      runStateMachine: deps.runStateMachine,
      resolveRunRepoContext: deps.resolveRunRepoContext,
      runInitiatorScope: this.runInitiatorScope,
      recordStepResult: (ws, instance, step, isFinalStep, result) =>
        this.recordStepResult(ws, instance, step, isFinalStep, result),
      handleAgentStep: (ctx, dispatchKind, augment) =>
        this.handleAgentStep(ctx, dispatchKind, augment),
    })
    this.pollCompletion = new PollCompletionController({
      blockRepository: deps.blockRepository,
      clock: deps.clock,
      runStateMachine: deps.runStateMachine,
      testerController: deps.testerController,
      humanTestController: deps.humanTestController,
      visualConfirmationController: deps.visualConfirmationController,
      prReviewController: deps.prReviewController,
      recordBackendDiagnostics: (instance, backend) =>
        this.recordBackendDiagnostics(instance, backend),
      recoverContainerEviction: (ws, instance, step, failure) =>
        this.recoverContainerEviction(ws, instance, step, failure),
      markContainerErrored: (ws, instance, step) => this.markContainerErrored(ws, instance, step),
    })
    // Assemble the seam the extracted dispatch-registry builders close over: the collaborators
    // above + bound call-backs into this dispatcher's completion / gate / phase methods, so the
    // built-ins resolve everything at call time exactly as the former inline closures did.
    this.registryDeps = {
      blockRepository: this.blockRepository,
      clock: this.clock,
      agentKindRegistry: this.agentKindRegistry,
      stepResolverRegistry: this.stepResolverRegistry,
      runInitiatorScope: this.runInitiatorScope,
      environmentProvisioning: this.environmentProvisioning,
      initiativeService: this.initiativeService,
      deployer: this.deployer,
      companionController: this.companionController,
      testerController: this.testerController,
      ralphController: this.ralphController,
      humanTestController: this.humanTestController,
      visualConfirmationController: this.visualConfirmationController,
      reviewGate: this.reviewGate,
      forkDecisionController: this.forkDecisionController,
      prReviewController: this.prReviewController,
      mergeResolver: this.mergeResolver,
      requirementsKind: this.requirementsKind,
      clarityKind: this.clarityKind,
      requirementsBrainstormKind: this.requirementsBrainstormKind,
      architectureBrainstormKind: this.architectureBrainstormKind,
      interviewControllers: this.interviewControllers,
      recordStepResult: (ws, instance, step, isFinalStep, result) =>
        this.recordStepResult(ws, instance, step, isFinalStep, result),
      runTracker: (ws, instance, block) => this.runTracker(ws, instance, block),
      runBugIntake: (ws, instance, step, block, isFinalStep) =>
        this.runBugIntake(ws, instance, step, block, isFinalStep),
      runInitiativeCommitter: (ws, block) => this.runInitiativeCommitter(ws, block),
      evaluateGate: (ws, instance, step, block, isFinalStep, gate) =>
        this.evaluateGate(ws, instance, step, block, isFinalStep, gate),
      gateFor: (kind) => this.gateFor(kind),
      handleForkDecisionPhase: (ctx) => this.handleForkDecisionPhase(ctx),
      handlePrReviewResolution: (ctx) => this.handlePrReviewResolution(ctx),
      handleAgentStep: (ctx) => this.handleAgentStep(ctx),
      ingestBlueprint: (ws, blockId, raw) => this.ingestBlueprint(ws, blockId, raw),
      ingestSpec: (ws, raw) => this.ingestSpec(ws, raw),
    }
  }

  /**
   * Run a durable-driver entry point, turning a lost optimistic-concurrency race into a
   * re-drive. A driver write ({@link RunStateMachine.casPersist}) throws {@link RunContendedError}
   * when a concurrent human action moved the row or a `cancel`/`stopRun` removed/terminated it;
   * we swallow that and return `{ kind: 'continue' }` so the durable loop re-enters
   * `advanceInstance`, reloads FRESH state, and either re-applies the mechanical step on the
   * winning snapshot or no-ops on a gone/terminal run — never clobbering the winner or
   * resurrecting a cancelled run (race-audit 2.2 driver-half / 2.3). This MUST run inside each
   * entry point (ahead of the drivers' generic `catch`→`failRun` and Cloudflare's `step.do`
   * retry); every other error propagates so real failures still fail the run.
   */
  private async redriveOnContention(run: () => Promise<AdvanceResult>): Promise<AdvanceResult> {
    try {
      return await run()
    } catch (error) {
      if (error instanceof RunContendedError) return { kind: 'continue' }
      throw error
    }
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
  private async handleAgentStep(
    ctx: StepHandlerContext,
    dispatchKind?: string,
    augmentContext?: (context: AgentRunContext) => void,
  ): Promise<AdvanceResult> {
    const { workspaceId, instance, step, block, isFinalStep, options } = ctx

    // Async (container) steps don't block: dispatch the job and park. The durable
    // driver polls `pollAgentJob` between sleeps so the run can span far longer
    // than a single durable step's timeout, while each step stays short. A set
    // `jobId` means a prior (possibly replayed) dispatch already started the job,
    // so we re-attach instead of starting a duplicate.
    //
    // `dispatchKind` overrides the dispatched agent kind WITHOUT changing `step.agentKind`
    // — used by the fork-decision phase to dispatch the read-only `fork-proposer` explore
    // job as a HELPER off the coder step (Phase A). The completion still records against the
    // coder step, and the fork-proposal interceptor keys on `step.agentKind` + the fork state.
    const context = await this.contextBuilder.buildContext(
      workspaceId,
      instance,
      step,
      isFinalStep,
      block,
      dispatchKind ? { agentKind: dispatchKind } : undefined,
    )
    // A caller re-dispatching this step under an overriding kind can fold extra context in
    // (e.g. the PR-review `fix` resolution points the Fixer at the reviewed PR's head branch and
    // hands it the selected findings). Runs before pre-ops / dispatch so the job body sees it.
    augmentContext?.(context)
    // A registered custom kind's PRE-ops run deterministic backend repo work before the
    // agent dispatches (e.g. read a baseline `spec/` shard into the prompt). Gated on the
    // step not having dispatched yet so a Workflows replay (jobId already set) doesn't
    // re-run them; a no-op for built-in kinds and when GitHub isn't wired.
    if (!step.jobId) {
      await this.repoOps.runRegisteredPreOps(workspaceId, instance, block, step, context)
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
        // Seed the in-flight PR-review state so a `pr-reviewer` run surfaces a real `reviewing`
        // phase in the deep-review window (the reviewed PR + the live slices-reviewed progress
        // off the step's todo subtasks) instead of an empty panel until the findings land. Only
        // on the reviewer's OWN first dispatch: a `fix`/`post` re-dispatch reuses this step under
        // an overriding kind and already carries `prReview` (`fixing`/`posting`), which must not
        // be reset back to `reviewing`.
        if (step.agentKind === PR_REVIEWER_KIND && !step.prReview) {
          const prUrl = block?.taskTypeFields?.prUrl?.trim() || null
          // Capture the PR head sha NOW (review start), so the `post` resolution can detect a
          // branch update between here and posting and fold drifted findings into the summary.
          const reviewedHeadSha = await this.resolveReviewedHeadSha(workspaceId, instance, block)
          step.prReview = initialPrReviewState(prUrl, step.model ?? null, reviewedHeadSha)
        }
        // Surface the block's ephemeral environment (if any) alongside the cold-boot
        // phase, so a run's details show the env spinning up next to the container.
        await this.deployer.attachEnvironmentProjection(workspaceId, instance.blockId, step)
        await this.runStateMachine.casPersist(workspaceId, instance)
        await this.runStateMachine.emitInstance(workspaceId, instance)

        let handle: AgentJobHandle
        try {
          handle = await executor.startJob(context)
        } catch (error) {
          // Classify the throw (see {@link classifyDispatchFailure}). A genuine container
          // accept failure (HTTP/network/capacity) is framed as `dispatch` ("container failed
          // to start") with the EXACT provider response as detail; a dispatch-time eviction
          // routes to `evicted`. But a job is BUILT before any container is contacted, so a
          // precondition (e.g. `github_not_connected` — no connected repo) is a `preflight`
          // rejection that surfaces its own actionable message + machine-readable reason
          // instead of the misleading container framing.
          step.container = { status: 'errored' }
          await this.runStateMachine.casPersist(workspaceId, instance)
          await this.runStateMachine.emitInstance(workspaceId, instance)
          // Hand the classifier the step's run history so a container lost AFTER work began (a
          // failed eviction-recovery re-dispatch, `evictionRecoveries > 0`) is reported as an
          // unrecoverable eviction — with elapsed minutes + any partial slice count — rather than
          // the misleading "container failed to start". See ADR 0026 D1.
          return {
            kind: 'job_failed',
            ...classifyDispatchFailure(error, {
              evictionRecoveries: step.evictionRecoveries,
              transientEvictionRecoveries: step.transientEvictionRecoveries,
              startedAt: step.startedAt,
              sliceCount: step.prReview?.slices?.length,
            }),
          }
        }
        step.jobId = handle.jobId
        // Record the model at dispatch — the poll site can't resolve it later.
        if (handle.model) step.model = handle.model
        // Surface web-search availability + provider on the step (run details), resolved
        // backend-side at dispatch. A static per-run fact, not gated by prompt telemetry.
        if (handle.search) step.search = handle.search
        // Stamp after-the-fact investigation diagnostics for this dispatch: the step's
        // agent kind, resolved model, and repo — the facts a failure post-mortem needs but
        // that are otherwise spread across DB joins / the harness transcript. The execution
        // backend (native vs. container) is unknown until the transport reports it on the
        // first poll, so `pollAgentJob` fills it in then.
        this.recordDispatchDiagnostics(instance, context, handle)
        // The dispatch returned, so the container is up and the job is accepted; the
        // live phase + the container id/url arrive on the first poll.
        step.container = { status: 'up' }
        await this.runStateMachine.casPersist(workspaceId, instance)
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
      await this.runStateMachine.casPersist(workspaceId, instance)
      await this.runStateMachine.emitInstance(workspaceId, instance)
    }

    const result = await this.runAgent(context, options)
    return this.recordStepResult(workspaceId, instance, step, isFinalStep, result)
  }

  /**
   * Stamp the run's investigation diagnostics from a container dispatch (the `lastDispatch`
   * block + the control-plane host). Mutates `instance` in place; the caller upserts. Reflects
   * the MOST RECENT dispatch — a run's failure is almost always in its latest step, and keeping
   * one block (not a per-step history) keeps the record small. `executionBackend` is left for the
   * first poll to fill (the transport reports it). Never carries a token/secret.
   */
  private recordDispatchDiagnostics(
    instance: ExecutionInstance,
    context: AgentRunContext,
    handle: AgentJobHandle,
  ): void {
    // Orchestration is runtime-neutral (no @types/node), so read `process.platform` off globalThis
    // with a guard rather than the bare global — undefined on a runtime that doesn't expose it
    // (e.g. workerd), which just omits the host block. Best-effort investigation context.
    const platform = (globalThis as { process?: { platform?: string } }).process?.platform
    instance.diagnostics = {
      ...instance.diagnostics,
      lastDispatch: {
        stepIndex: instance.currentStep,
        agentKind: context.agentKind,
        ...(handle.model ? { model: handle.model } : {}),
        ...(handle.repo ? { repo: handle.repo } : {}),
        at: this.clock.now(),
      },
      ...(platform ? { host: { platform } } : {}),
    }
  }

  /**
   * Fill in `diagnostics.lastDispatch.executionBackend` from the transport-reported backend on
   * the first poll that carries it (native host process vs. sandboxed container — the datum that
   * is otherwise indistinguishable after the fact). Idempotent: a no-op once set, or when the
   * update carries no backend / the dispatch block is missing. Returns whether it changed
   * anything (so the caller can skip a redundant upsert).
   */
  private recordBackendDiagnostics(
    instance: ExecutionInstance,
    backend: string | undefined,
  ): boolean {
    const dispatch = instance.diagnostics?.lastDispatch
    if (!backend || !dispatch || dispatch.executionBackend === backend) return false
    instance.diagnostics = {
      ...instance.diagnostics,
      lastDispatch: { ...dispatch, executionBackend: backend },
    }
    return true
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
   * Resolve the reviewed PR's head sha at review-START, stamped onto `step.prReview` when the
   * `pr-reviewer` first dispatches. The `post` resolution later re-reads the PR head and folds
   * every finding into the summary when it moved (the frozen line numbers may have drifted). Best
   * effort: null on any failure, no PR number, or a client without the `pullRequestHeadSha`
   * capability — the drift check then simply doesn't run (posting falls back to per-line filtering).
   */
  private async resolveReviewedHeadSha(
    workspaceId: string,
    instance: ExecutionInstance,
    block: Block | null | undefined,
  ): Promise<string | null> {
    if (!block) return null
    const prNumber = resolvePrNumber(block.taskTypeFields ?? undefined)
    if (prNumber == null) return null
    try {
      const runRepo = await this.resolveRunRepoContext?.(workspaceId, block.id)
      const headSha = runRepo?.repo.pullRequestHeadSha
      if (!headSha) return null
      return await this.runInitiatorScope(instance.initiatedBy, () => headSha(prNumber))
    } catch {
      return null
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
    return this.redriveOnContention(() => this.pollAgentJobInner(workspaceId, executionId))
  }

  private async pollAgentJobInner(
    workspaceId: string,
    executionId: string,
  ): Promise<AdvanceResult> {
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
      return this.deployer.pollDeployerJob(workspaceId, instance, step)
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
      return this.handleRunningPoll(workspaceId, executionId, instance, update, step.jobId)
    }

    // A gate whose helper INVESTIGATES instead of fixing (post-release-health → on-call)
    // declares a `resolveHelperCompletion` hook on its definition. When such a helper's job
    // settles — done OR failed — we call the hook INSTEAD of re-probing the precheck
    // (re-probing an investigate-don't-fix helper would just regress again and burn the
    // budget) and finish the gate step with the output it returns. The gate raises its own
    // `release_regression` notification + enriches any open incident inside the hook (from the
    // signals stashed at escalation); the run then completes for a human to act out-of-band.
    const investigated = await this.resolveInvestigateHelperCompletion(
      workspaceId,
      instance,
      step,
      update,
    )
    if (investigated) return investigated

    // A polling gate step's in-flight job is its helper agent (ci-fixer /
    // conflict-resolver), NOT the step's own work: when it finishes (or fails) we
    // don't record a result or advance — we drop the handle, return the gate to
    // `checking`, and re-run the precheck (the helper's push triggers a fresh CI run /
    // updates mergeability). A helper that failed without pushing leaves the precheck
    // negative, so the next check re-dispatches (until the attempt budget is spent).
    const reprobeGate = this.gateFor(step.agentKind)
    if (reprobeGate) {
      return this.reprobeGateAfterHelper(reprobeGate, { workspaceId, instance, step, update })
    }

    // A helper job (Fixer / conflict-resolver) in flight for a tester / human-test /
    // visual-confirmation gate is NOT the step's own work: settle that round and re-park/re-dispatch
    // instead of recording a step result. Returns null when this step has no such helper in flight.
    const phased = await this.pollCompletion.resolveHelperPhaseCompletion(
      workspaceId,
      instance,
      step,
      update,
    )
    if (phased) return phased

    if (update.state === 'failed') {
      return this.pollCompletion.handleFailedPoll(workspaceId, instance, step, update)
    }

    const block = await this.blockRepository.get(workspaceId, instance.blockId)
    if (!block) return { kind: 'noop' }
    const isFinalStep = instance.currentStep === instance.steps.length - 1
    // Capture any final burst of follow-up items the harness drained on the SAME poll that
    // observed completion (the tailer is flushed before the job is marked done), so the
    // completion gate below sees the last items — notably a question that must hold the run.
    this.followUpGate.appendStreamedFollowUps(step, update.followUps)
    // Clear the handle before recording so a replay re-attaches to nothing.
    step.jobId = undefined
    return this.recordStepResult(workspaceId, instance, step, isFinalStep, update.result)
  }

  /**
   * Handle a `running` poll: a successful poll proves the container is up, so surface live subtask
   * progress (e.g. 3/8 todos) without advancing the step. Only persist + emit when something
   * actually changed so an idle poll doesn't churn storage or the event stream. Folds the poll's
   * delta via {@link applyRunningFold} — a cheap pre-check against the loaded snapshot, then the
   * authoritative re-apply on fresh state under CAS (idempotent for the set-to-latest folds and
   * correct for the drain-on-read follow-up append). Split from {@link pollAgentJobInner} to stay
   * under the statement ceiling.
   */
  private async handleRunningPoll(
    workspaceId: string,
    executionId: string,
    instance: ExecutionInstance,
    update: Extract<AgentJobUpdate, { state: 'running' }>,
    jobId: string,
  ): Promise<AdvanceResult> {
    const foldCtx = { jobId, update, workspaceId }
    // Cheap pre-check against the loaded snapshot: skip the write entirely on an idle poll
    // (the common case). The mutation is discarded — the authoritative write re-applies the
    // same fold on fresh state under CAS below.
    if (await this.applyRunningFold(instance, foldCtx)) {
      try {
        const persisted = await this.runStateMachine.mutateInstance(
          workspaceId,
          executionId,
          async (fresh) => {
            await this.applyRunningFold(fresh, foldCtx)
          },
        )
        // Progress-only fold (subtask ticks / streamed follow-ups): skip the per-run
        // LLM-metrics GROUP BY so a live container's poll cadence doesn't re-aggregate
        // the run on every tick. The rollup refreshes on the step-boundary/terminal emit.
        await this.runStateMachine.emitInstance(workspaceId, persisted, { rollUpMetrics: false })
      } catch (error) {
        // The run was cancelled/removed mid-poll (`NotFoundError`) or stayed hot-contended
        // past the retry budget (`ConflictError`) — re-drive on fresh state rather than
        // failing the run; the next entry no-ops on a gone/terminal run.
        if (error instanceof NotFoundError || error instanceof ConflictError) {
          throw new RunContendedError(executionId)
        }
        throw error
      }
    }
    return { kind: 'awaiting_job', jobId, stepIndex: instance.currentStep }
  }

  /**
   * A gate whose helper INVESTIGATES instead of fixing (post-release-health → on-call) declares a
   * `resolveHelperCompletion` hook. When such a helper's job settles — done OR failed — call the
   * hook INSTEAD of re-probing the precheck (re-probing an investigate-don't-fix helper would just
   * regress again and burn the budget) and finish the gate step with the output it returns. Returns
   * the resulting {@link AdvanceResult}, or `null` when this branch doesn't apply (the caller falls
   * through to the re-probe / other completion paths).
   */
  private async resolveInvestigateHelperCompletion(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    update: AgentJobUpdate,
  ): Promise<AdvanceResult | null> {
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
    return null
  }

  /**
   * Fold a running poll's container signals into `step.container`: a successful poll
   * proves the container is `up`, and the harness's live phase (clone / agent / push)
   * plus the transport's container id/url enrich it. Returns whether anything changed,
   * so the caller only persists + emits on a real transition (an idle poll is a no-op).
   * Prior id/url/phase are preserved when a poll omits them (drain-on-read semantics).
   */
  /**
   * Fold a running poll's live delta (container status/phase, subtask counts, backend, streamed
   * follow-ups, env projection) onto `target`, returning whether anything changed. Idempotent for
   * the set-to-latest folds and correct under CAS retry for the drain-on-read follow-up append —
   * see the call site in {@link pollAgentJobInner}. A concurrent write that advanced the step (or
   * superseded the job) makes it a no-op.
   */
  private async applyRunningFold(
    target: ExecutionInstance,
    ctx: {
      jobId: string
      update: Extract<AgentJobUpdate, { state: 'running' }>
      workspaceId: string
    },
  ): Promise<boolean> {
    const { jobId, update, workspaceId } = ctx
    const s = target.steps[target.currentStep]
    // The step advanced (or the job was superseded) under a concurrent write — nothing to fold.
    if (!s || s.jobId !== jobId) return false
    let changed = false
    if (this.applyContainerRunning(s, update)) changed = true
    if (this.applySubtaskProgress(s, update.subtasks)) changed = true
    // Persist the harness liveness heartbeat (throttled) so a quiet-but-alive container keeps the
    // run's `updated_at` fresh — the signal a long, output-less phase (a reviewer reading files)
    // would otherwise never emit, leaving it indistinguishable from a wedged run to the sweeper + UI.
    if (this.applyLastActivity(s, update.lastActivityAt)) changed = true
    // The transport reports WHICH backend served the job on the first poll (native host
    // process vs. sandboxed container) — record it in the run diagnostics.
    if (this.recordBackendDiagnostics(target, update.backend)) changed = true
    // Append any forward-looking items the Coder streamed since the last poll so the
    // Follow-up companion lights up + accrues items LIVE while the container still runs.
    if (this.followUpGate.appendStreamedFollowUps(s, update.followUps)) changed = true
    // Refresh the env projection so its status transitions (provisioning→ready→
    // expired/torn_down) and any error stay live in the run details during the run.
    if (await this.deployer.attachEnvironmentProjection(workspaceId, target.blockId, s)) {
      changed = true
    }
    return changed
  }

  /**
   * A polling gate step's in-flight job is its helper agent (ci-fixer / conflict-resolver / the
   * human-review fixer), NOT the step's own work: when it finishes (or fails) we don't record a
   * result or advance — we run any deterministic post-helper bookkeeping hook, record the attempt,
   * drop the handle, return the gate to `checking`, and re-run the precheck (the helper's push
   * triggers a fresh CI run / updates mergeability). A helper that failed without pushing leaves the
   * precheck negative, so the next check re-dispatches (until the attempt budget is spent). Split
   * from {@link pollAgentJobInner} to keep it under the complexity ceiling.
   */
  private async reprobeGateAfterHelper(
    gate: GateDefinition,
    ctx: {
      workspaceId: string
      instance: ExecutionInstance
      step: PipelineStep
      update: Extract<AgentJobUpdate, { state: 'done' } | { state: 'failed' }>
    },
  ): Promise<AdvanceResult> {
    const { workspaceId, instance, step, update } = ctx
    // A gate may need deterministic GitHub-side bookkeeping to land BEFORE the re-probe
    // reads it (the human-review gate replies to + RESOLVES the threads it handed the
    // fixer, so the next probe counts them addressed). Run that side-effect hook first;
    // it does NOT replace the re-probe (unlike resolveHelperCompletion).
    if (gate.onHelperComplete && step.gate) {
      const block = await this.blockRepository.get(workspaceId, instance.blockId)
      if (block) {
        const jobResult: GateHelperJobResult =
          update.state === 'done'
            ? { state: 'done', result: update.result }
            : { state: 'failed', error: update.error ?? null }
        await this.runInitiatorScope(instance.initiatedBy, () =>
          gate.onHelperComplete!({
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
    await this.runStateMachine.casPersist(workspaceId, instance)
    await this.runStateMachine.emitInstance(workspaceId, instance)
    return { kind: 'awaiting_gate', stepIndex: instance.currentStep }
  }

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
   * executor's `update.subtasks`) and the {@link DeployerStepController} poll (the deploy job's
   * `view.progress`)
   * so the progress-fraction math lives in one place.
   */
  private applySubtaskProgress(step: PipelineStep, counts: PipelineStep['subtasks']): boolean {
    if (!counts || sameSubtasks(step.subtasks, counts)) return false
    step.subtasks = counts
    step.progress = counts.total > 0 ? counts.completed / counts.total : 0
    return true
  }

  /**
   * Fold a running poll's forwarded liveness heartbeat onto `step.lastActivityAt`, THROTTLED via
   * {@link shouldPersistActivity}: re-stamped only once the heartbeat has advanced by a bounded
   * window (not on every ~15s poll), and never when a wedged job's heartbeat is frozen — so its
   * `updated_at` correctly stops advancing. Returns whether it changed, so the caller persists +
   * emits (refreshing the run's `updated_at` and the UI's "active Ns ago") only on a real advance.
   */
  private applyLastActivity(step: PipelineStep, incoming: number | undefined): boolean {
    if (!shouldPersistActivity(step.lastActivityAt, incoming)) return false
    step.lastActivityAt = incoming
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
    failure: ContainerFailureView,
    onBeforeRedispatch?: () => Promise<void>,
  ): Promise<AdvanceResult | null> {
    const { error, evicted, detail } = failure
    // The eviction verdict rides the transport's STRUCTURED `evicted` field (every transport
    // mints it). Absent ⇒ not an eviction, so the caller proceeds with genuine-failure handling.
    const kind = evicted
    if (!kind) return null
    const transient = kind === 'transient'
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
      await this.runStateMachine.casPersist(workspaceId, instance)
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
      // The transport's post-mortem of the LAST container to die (exit state + log tail). The
      // container itself is reclaimed when the run settles, so this is the only place the cause
      // survives — carry it onto the failure rather than reporting a bare "still evicting".
      ...(detail ? { detail } : {}),
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
    await this.runStateMachine.casPersist(workspaceId, instance)
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
    return this.redriveOnContention(() => this.pollGateInner(workspaceId, executionId))
  }

  private async pollGateInner(workspaceId: string, executionId: string): Promise<AdvanceResult> {
    const instance = await this.executionRepository.get(workspaceId, executionId)
    if (!instance || (instance.status !== 'running' && instance.status !== 'paused')) {
      return { kind: 'noop' }
    }
    const step = instance.steps[instance.currentStep]
    // The human-testing gate no longer provisions its own env (the upstream `deployer` does), so it
    // never rides the `awaiting_gate` poll loop — it parks the human synchronously. A human-test
    // step here is not a registered gate, so it falls through to the gate-less `continue` below.
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
    return this.redriveOnContention(() =>
      this.resolveGatePollExhaustionInner(workspaceId, executionId),
    )
  }

  private async resolveGatePollExhaustionInner(
    workspaceId: string,
    executionId: string,
  ): Promise<AdvanceResult> {
    const instance = await this.executionRepository.get(workspaceId, executionId)
    if (!instance || (instance.status !== 'running' && instance.status !== 'paused')) {
      return { kind: 'noop' }
    }
    const step = instance.steps[instance.currentStep]
    // The human-testing gate no longer provisions (so it never sits in the gate-poll loop) — but be
    // defensive against a replay landing here for one: re-drive rather than failing the run, so it
    // re-evaluates and re-parks the human.
    if (step?.agentKind === HUMAN_TEST_AGENT_KIND) {
      return { kind: 'continue' }
    }
    const gate = step ? this.gateFor(step.agentKind) : undefined
    const timeoutError = 'Gate precheck did not settle within its polling budget'
    // An unbounded human-wait gate (human-review, `pollExhaustion: 'rearm'`) has no deadline:
    // running out of polls is never a verdict. Always re-arm another poll cycle — the waiting
    // is surfaced via the gate's notification (escalated by the severity sweep), not by killing
    // the run.
    if (step && gate && gate.pollExhaustion === 'rearm') {
      if (step.gate) step.gate.phase = 'checking'
      await this.runStateMachine.casPersist(workspaceId, instance)
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
        await this.runStateMachine.casPersist(workspaceId, instance)
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
      await this.runStateMachine.casPersist(workspaceId, instance)
      await this.runStateMachine.emitInstance(workspaceId, instance)
      await this.runStateMachine.stopRunContainer(workspaceId, instance)
      return { kind: 'done' }
    }
    instance.currentStep += 1
    const next = instance.steps[instance.currentStep]
    if (next) this.stepGraph.startStep(next)
    await this.runStateMachine.updateBlockProgress(workspaceId, instance, 'in_progress')
    await this.runStateMachine.casPersist(workspaceId, instance)
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
    // Meter the LLM call into the usage ledger. Recorded whether the step completed or
    // raised a decision — both consumed tokens. A subscription-harness result is tagged
    // `'subscription'` so it's counted for the usage report but EXCLUDED from the budget
    // rollups (a flat-rate quota plan costs nothing per token); an inline metered call
    // defaults to `'metered'` and is summed by the spend gate as before.
    if (result.usage) {
      await this.spend.record({
        workspaceId,
        executionId: instance.id,
        agentKind: step.agentKind,
        model: result.model ?? 'unknown',
        usage: result.usage,
        billing: result.usageBilling ?? 'metered',
        vendor: result.usageVendor ?? null,
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
      return this.parkStepAwaitingInput(workspaceId, instance, step, step.decision.id)
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
    // The container agent's effort self-assessment (how hard the work was, what reduced its
    // effectiveness, the obstacles) — surfaced in run details for every container step. Absent
    // for inline agents / older harness images.
    if (result.effortReport) step.effortReport = result.effortReport
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
    // regardless of whether this is the final step. A multi-repo run
    // (service-connections phase 3) additionally reports the PRs it opened in the
    // connected involved-service repos; record them beside the own-service PR (they may
    // even arrive when the own service was a no-op and only a peer changed).
    await this.recordOpenedPullRequests(workspaceId, instance, result)

    // Run any POST-COMPLETION resolver registered for this step kind (blueprint/spec
    // ingestion, task-estimate persistence). It reshapes the agent's structured result into
    // domain state and may replace `step.output` (the estimator's readable summary). Its
    // POSITION is load-bearing — it runs after the output is recorded but BEFORE the
    // reviewable-output rendering and the follow-up/approval gates read `step.output`, so it
    // sits exactly where the old inline ingestion branches did. See
    // {@link buildStepResolverRegistry} and {@link StepCompletionResolver.phase}.
    await this.applyPostCompletionResolver(workspaceId, instance, step, result, isFinalStep)

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
      const gated = await this.followUpGate.evaluateFollowUpGate(workspaceId, instance, step)
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
      return this.parkStepAwaitingInput(workspaceId, instance, step, step.approval.id)
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
    const resolverOwnsTerminalStatus = await this.applyTerminalStepResolver(
      workspaceId,
      instance,
      step,
      result,
      isFinalStep,
    )

    // A registered custom kind's POST-ops run deterministic backend repo work from the
    // agent's structured result (coerce its JSON, render artifact files, commit them via
    // the checkout-free RepoFiles port — the blueprint/spec rendering that used to live in
    // the harness). Position-independent like the resolver above; a no-op for built-ins
    // and when GitHub isn't wired. A throwing op propagates to fail the step/run.
    await this.repoOps.runRegisteredPostOps(workspaceId, instance, step, isFinalStep, result)

    if (isFinalStep) {
      instance.status = 'done'
      // Merge resolution (and confidence persistence) already happened above,
      // POSITION-INDEPENDENTLY: confidence at the top of recordStepResult and the merger's
      // real merge via the step-completion resolver registry (so a trailing
      // post-release-health gate doesn't disable auto-merge). Nothing merge-specific here.
      await this.runStateMachine.finalizeBlock(workspaceId, instance, result.confidence)
      await this.runStateMachine.casPersist(workspaceId, instance)
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
    await this.runStateMachine.casPersist(workspaceId, instance)
    await this.runStateMachine.emitInstance(workspaceId, instance)
    return { kind: 'continue' }
  }

  /**
   * Park a step on the durable decision-wait: pause it for input, flip the run + block to
   * `blocked`, persist under CAS, emit, and report `awaiting_decision` keyed by `decisionId`.
   * Shared by the raised-decision and human-approval branches of {@link recordStepResult}.
   */
  private async parkStepAwaitingInput(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    decisionId: string,
  ): Promise<AdvanceResult> {
    this.stepGraph.pauseStepForInput(step)
    instance.status = 'blocked'
    await this.runStateMachine.updateBlockProgress(workspaceId, instance, 'blocked')
    await this.runStateMachine.casPersist(workspaceId, instance)
    await this.runStateMachine.emitInstance(workspaceId, instance)
    return { kind: 'awaiting_decision', decisionId }
  }

  /**
   * Record any PR(s) the step opened onto the block (its own-service PR + any peer-service PRs),
   * and best-effort write back to the task's linked tracker issue(s) when the own-service PR is
   * NEWLY opened (a retry that re-reports the same PR must not re-comment). Split from
   * {@link recordStepResult} to keep it under the statement ceiling; a no-op when no PR was opened.
   */
  private async recordOpenedPullRequests(
    workspaceId: string,
    instance: ExecutionInstance,
    result: AgentRunResult,
  ): Promise<void> {
    if (!(result.pullRequest || result.peerPullRequests?.length)) return
    // Read the block before the update so we can tell whether this PR is newly
    // opened (vs. the same PR re-reported by a re-run/retry of the coder step).
    const priorBlock = this.issueWriteback
      ? await this.blockRepository.get(workspaceId, instance.blockId)
      : null
    await this.blockRepository.update(workspaceId, instance.blockId, {
      ...(result.pullRequest ? { pullRequest: result.pullRequest } : {}),
      ...(result.peerPullRequests?.length ? { peerPullRequests: result.peerPullRequests } : {}),
    })
    // Best-effort writeback: comment on the task's linked tracker issue(s) that a
    // PR opened. Only for the OWN-service PR, and only when it is newly recorded — a
    // retry that re-reports the same PR must not re-comment (the tracker comment is not
    // idempotent). Gated inside the provider by the workspace setting + per-task
    // override; fire-and-forget so a tracker outage never fails the run.
    if (
      this.issueWriteback &&
      priorBlock &&
      result.pullRequest &&
      priorBlock.pullRequest?.url !== result.pullRequest.url
    ) {
      await this.issueWriteback
        .onPullRequestOpened(workspaceId, priorBlock, result.pullRequest)
        .catch(() => {})
    }
  }

  /**
   * Run any POST-COMPLETION resolver registered for this step kind (blueprint/spec ingestion,
   * task-estimate persistence). It reshapes the agent's structured result into domain state and may
   * replace `step.output`. A no-op when no post-completion resolver applies. See
   * {@link buildStepResolverRegistry} and {@link StepCompletionResolver.phase}.
   */
  private async applyPostCompletionResolver(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    result: AgentRunResult,
    isFinalStep: boolean,
  ): Promise<void> {
    const postCompletionResolver = this.stepResolverFor(step.agentKind)
    if (
      postCompletionResolver?.phase !== 'post-completion' ||
      !(postCompletionResolver.applies?.(result) ?? true)
    ) {
      return
    }
    const resolution = await postCompletionResolver.resolve({
      workspaceId,
      instance,
      step,
      result,
      isFinalStep,
    })
    if (resolution?.output !== undefined) step.output = resolution.output
  }

  /**
   * Run any DETERMINISTIC terminal-phase resolver for this step kind (e.g. the merger performs the
   * real GitHub merge with backend-held credentials), mutating `step.output` when it reshapes it.
   * Position-independent: it fires whenever the step finishes, not only when it's last. Returns
   * whether the resolver OWNS the block's terminal status (the merger sets `done`/`pr_ready`), so
   * the advance/finalize path leaves that status alone rather than clobbering it to `in_progress`.
   */
  private async applyTerminalStepResolver(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    result: AgentRunResult,
    isFinalStep: boolean,
  ): Promise<boolean> {
    const resolver = this.stepResolverFor(step.agentKind)
    if (
      !resolver ||
      (resolver.phase ?? 'terminal') !== 'terminal' ||
      !(resolver.applies?.(result) ?? true)
    ) {
      return false
    }
    const resolution = await resolver.resolve({ workspaceId, instance, step, result, isFinalStep })
    if (resolution?.output !== undefined) step.output = resolution.output
    return resolution?.ownsTerminalStatus ?? false
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
   * Run a `bug-intake` step — the recurring bug-triage pipeline's inbound dual of `tracker`
   * (design §3). Pull ONE matching open issue from the schedule's configured tracker board,
   * claim it (import + replace-link onto the reused block, mark it in-progress + comment), and
   * seed the block's title/description from it so every downstream step works THAT bug. When
   * nothing matches — or no task source is wired — the run completes SUCCESSFULLY with every
   * remaining step skipped (there is nothing to investigate / reproduce / fix), no notification.
   * Best-effort throughout: the intake helper never throws (a tracker outage resolves to a
   * no-op), and the pickup writeback is fire-and-forget.
   */
  private async runBugIntake(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    block: Block,
    isFinalStep: boolean,
  ): Promise<AdvanceResult> {
    const outcome: BugIntakeOutcome = this.bugIntakeService
      ? await this.bugIntakeService.pickForBlock(workspaceId, block.id)
      : { picked: null, summary: 'Issue intake is not configured on this deployment.' }

    if (!outcome.picked) {
      return this.completeRunSkippingRemaining(workspaceId, instance, step, outcome.summary)
    }

    const pickup = outcome.picked
    // Seed the reused recurring block from the picked issue so each fire works a different bug
    // through the same block (the same block-seeding `createTaskFromIssue` does, applied in place).
    // Clear the previous fire's peer PRs too — this fire works a DIFFERENT bug, so a prior bug's
    // connected-repo PRs must not linger on the block. (The own-service `pullRequest` is overwritten
    // by this run's coder step before any step reads it; it is a non-nullable `BlockPatch` field, so
    // it cannot be cleared here anyway.)
    await this.blockRepository.update(workspaceId, block.id, {
      title: pickup.seedTitle,
      description: pickup.seedDescription,
      peerPullRequests: [],
    })
    // Best-effort: claim the issue where it was filed (in-progress mark + "taken by cat-factory"
    // comment). Fire-and-forget — a tracker hiccup must never fail the run, mirroring the PR
    // open/merge writeback hooks; and unlike them this is NOT gated on the writeback settings.
    if (this.issueWriteback) {
      await this.issueWriteback
        .onIssuePickedUp(
          workspaceId,
          block.id,
          pickup.inProgressLabel ? { inProgressLabel: pickup.inProgressLabel } : {},
        )
        .catch(() => {})
    }
    return this.recordStepResult(workspaceId, instance, step, isFinalStep, {
      output: pickup.summary,
    })
  }

  /**
   * Complete the run successfully after a `bug-intake` step found no issue to work: record the
   * intake step's own no-match output (it SUCCEEDED — it made the decision), then mark every
   * REMAINING step `skipped` and finalize the reused block `done`, with NO notification (the
   * outcome is visible in the schedule's run history).
   *
   * The block is finalized `done` DIRECTLY here rather than through `RunStateMachine.finalizeBlock`:
   * for a mergerless task block (every bug-triage pipeline) finalizeBlock's terminal branch treats
   * the run as "work complete but unmerged" — it flips the block `pr_ready` and raises a
   * `pipeline_complete` "confirm + merge the PR" notification. This fire did NO work and opened NO
   * PR, so that card would be spurious (and its payload would reference a STALE PR carried over from
   * a prior fire). Setting the terminal status inline keeps the no-op silent, as documented.
   */
  private async completeRunSkippingRemaining(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    summary: string,
  ): Promise<AdvanceResult> {
    step.output = summary
    step.progress = 1
    step.subtasks = undefined
    this.stepGraph.finishStep(step)
    for (let i = instance.currentStep + 1; i < instance.steps.length; i++) {
      const remaining = instance.steps[i]
      if (!remaining) continue
      remaining.skipped = true
      remaining.output = ''
      remaining.progress = 1
      remaining.subtasks = undefined
      this.stepGraph.finishStep(remaining)
    }
    instance.currentStep = instance.steps.length - 1
    instance.status = 'done'
    const block = await this.blockRepository.get(workspaceId, instance.blockId)
    if (block && block.status !== 'done') {
      await this.blockRepository.update(workspaceId, instance.blockId, {
        status: 'done',
        progress: 1,
      })
    }
    await this.runStateMachine.casPersist(workspaceId, instance)
    await this.runStateMachine.emitInstance(workspaceId, instance)
    await this.runStateMachine.stopRunContainer(workspaceId, instance)
    return { kind: 'done' }
  }

  /**
   * Persist an APPROVED initiative plan for an `initiative-committer` step: flip the
   * entity to `executing` and mirror the tracker into the repo's default branch
   * (`docs/initiatives/<slug>/`) via the checkout-free {@link RepoFiles}. Deterministic,
   * no LLM. REPLAY-SAFE: the tracker commit hash-short-circuits (an unchanged entity
   * commits nothing) and `markExecuting` is content-idempotent, so a durable-driver
   * replay re-enters harmlessly. The repo mirror is skipped gracefully when GitHub
   * isn't wired (the DB entity stays the source of truth); a missing entity or an
   * empty plan is a REAL failure — completing the run would strand the initiative in
   * `planning` behind a green run.
   */
  private async runInitiativeCommitter(
    workspaceId: string,
    block: Block,
  ): Promise<{ kind: 'ok'; result: AgentRunResult } | { kind: 'failed'; error: string }> {
    if (!this.initiativeService) {
      return { kind: 'failed', error: 'Initiative module is not wired on this deployment.' }
    }
    const initiative = await this.initiativeService.getByBlock(workspaceId, block.id)
    if (!initiative) {
      return { kind: 'failed', error: 'No initiative entity found for this block.' }
    }
    if ((initiative.items ?? []).length === 0) {
      return {
        kind: 'failed',
        error: 'No approved plan to commit — the planner produced no usable items.',
      }
    }

    // Resolve the run repo BEFORE flipping status. `resolveRunRepo` returns null only when
    // GitHub is entirely unwired (skip the mirror gracefully — the DB entity stays the source
    // of truth), but it THROWS for a GitHub-connected workspace whose frame isn't linked to a
    // repo (`resolveRepoTarget` fails loudly rather than guessing one). Doing it first means
    // such a misconfiguration aborts the committer with the entity still truthfully
    // `awaiting_approval` — instead of flipping to `executing` and THEN throwing, which would
    // fail the run while leaving a committed status whose plan never got mirrored (a lie).
    const runRepo = await this.repoOps.resolveRunRepo(workspaceId, block.id)

    // Now flip to `executing` and render the tracker from the flipped entity — the committed
    // mirror (and its content hash) must record the REAL `executing` status. Committing the
    // pre-flip entity would bake a stale `awaiting_approval` status into
    // `initiative.json`/`tracker.md` that nothing re-commits in this slice, AND would break
    // replay-safety: a durable-driver replay re-reads the now-`executing` entity, whose hash
    // no longer matches the committed `version.json`, so the no-change short-circuit would miss
    // and re-commit. `markExecuting` is a committed CAS write that still runs before the git
    // side effect, so a CAS conflict aborts before any commit lands (no orphaned tracker commit).
    const executing =
      (await this.initiativeService.markExecuting(workspaceId, block.id, null)) ?? initiative

    let doc: { version: number; hash: string } | null = null
    let mirror = 'Repo tracker mirror skipped (GitHub not connected).'
    if (runRepo) {
      doc = await commitInitiativeTracker(
        runRepo.repo,
        runRepo.baseBranch,
        executing,
        new Date(this.clock.now()),
      )
      mirror = doc
        ? `Committed docs/initiatives/${executing.slug}/ (v${doc.version}) to ${runRepo.baseBranch}.`
        : `Tracker already up to date in docs/initiatives/${executing.slug}/.`
      // Stamp the committed version/hash back onto the entity (content-unchanged tick ⇒
      // no commit ⇒ nothing to stamp, so a replay skips this second write too).
      if (doc) await this.initiativeService.markExecuting(workspaceId, block.id, doc)
    }

    const phases = (executing.phases ?? []).length
    const items = (executing.items ?? []).length
    return {
      kind: 'ok',
      result: {
        output:
          `Initiative plan approved: ${phases} phase${phases === 1 ? '' : 's'}, ` +
          `${items} item${items === 1 ? '' : 's'}. ${mirror}`,
      },
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
    return buildStepHandlerRegistryImpl(this.registryDeps)
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
    return buildStepCompletionInterceptorsImpl(this.registryDeps)
  }

  private stepResolverFor(agentKind: string): StepCompletionResolver | undefined {
    if (!this.stepResolverCache) this.stepResolverCache = this.buildStepResolverRegistry()
    return this.stepResolverCache.get(agentKind)
  }

  private buildStepResolverRegistry(): Map<string, StepCompletionResolver> {
    return buildStepResolverRegistryImpl(this.registryDeps)
  }

  private buildGateRegistry(): Map<string, GateDefinition> {
    // The built-in gate suite (ci / conflicts / post-release-health) is no longer inline:
    // it ships as `@cat-factory/gates`, installed into the app-owned `GateRegistry` the
    // facade threads through `CoreDependencies` (the dogfood — the platform's own gates
    // register through the SAME public seam as anyone's). The engine merely builds whatever
    // gates the facade registered. A facade that forgot to call `registerBuiltinGates(...)`
    // then has no gates and those steps fail — which the cross-runtime conformance suite catches.
    const map = new Map<string, GateDefinition>()
    const ctx = this.makeGateContext()
    for (const { kind, factory } of this.gateRegistry.factories()) map.set(kind, factory(ctx))
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
      // A gate reaches its deployment-wired provider through the app-owned provider registry the
      // facade injected — not a module global; the engine just forwards to that instance.
      getProvider: (token) => this.providerRegistry.get(token),
      requireProvider: (token) => this.providerRegistry.require(token),
      isProviderWired: (token) => this.providerRegistry.isWired(token),
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
      const preset = await this.resolveRiskPolicy(workspaceId, block)
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
      await this.runStateMachine.casPersist(workspaceId, instance)
      return this.dispatchGateHelper(workspaceId, instance, step, block, isFinalStep, {
        gate,
        failureSummary: fix.instructions,
      })
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
    // Multi-repo (service-connections phase 4): the CI / conflicts gates aggregate across every
    // PR the task opened; persist the per-repo head shas (and, for the conflicts gate, which repo
    // conflicted) so the run-detail UI can group checks by service and the conflict-resolver can
    // target the conflicted repo.
    step.gate.headShas = probe.headShas ?? null
    step.gate.conflictTarget = probe.conflictTarget ?? null
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
      await this.runStateMachine.casPersist(workspaceId, instance)
      await this.runStateMachine.emitInstance(workspaceId, instance)
      return { kind: 'awaiting_gate', stepIndex: instance.currentStep }
    }

    // probe.status === 'fail'.
    // A gate can decline escalation for a failure its helper can't fix (e.g. the conflicts
    // gate on a PEER-repo conflict it has no resolver for) — go straight to give-up instead
    // of burning the attempt budget on a helper that can't touch the problem.
    const canEscalate = isAsyncAgentExecutor(this.agentExecutor) && probe.escalatable !== false
    if (canEscalate && step.gate.attempts < step.gate.maxAttempts) {
      return this.dispatchGateHelper(workspaceId, instance, step, block, isFinalStep, {
        gate,
        failureSummary: probe.failureSummary,
      })
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
    helper: { gate: GateDefinition; failureSummary?: string },
  ): Promise<AdvanceResult> {
    const { gate, failureSummary } = helper
    const executor = this.agentExecutor
    if (!isAsyncAgentExecutor(executor)) {
      // Defensive: evaluateGate only calls this when async-capable.
      return { kind: 'job_failed', error: `No async executor available for the ${gate.kind} gate.` }
    }
    // Build the context AS the helper kind: the hosting step's kind is the gate
    // (`ci` / `post-release-health`), so trait-driven context — the `code-aware`
    // service-fragment fold for `ci-fixer` / `on-call` — must key off the helper.
    const base = await this.contextBuilder.buildContext(
      workspaceId,
      instance,
      step,
      isFinalStep,
      block,
      { agentKind: gate.helperKind },
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
    // When the conflicts gate detected the conflict on a PEER repo (multi-repo task), hand the
    // conflict-resolver the target repo so the executor points it at THAT repo (own-service or
    // a connected service) instead of always the own service. Own-repo conflicts leave it absent
    // (`conflictTarget` carries no `frameId`), so the resolver targets the own repo as before.
    const conflictTarget = step.gate?.conflictTarget
    const context: AgentRunContext = {
      ...base,
      agentKind: gate.helperKind,
      priorOutputs: [...base.priorOutputs, ...extras],
      ...(conflictTarget?.frameId
        ? { conflictTarget: { repo: conflictTarget.repo, frameId: conflictTarget.frameId } }
        : {}),
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
      maxAttempts: step.gate?.maxAttempts ?? DEFAULT_RISK_POLICY.ciMaxAttempts,
      headSha: step.gate?.headSha ?? null,
      // Stash the instructions this helper was handed (the failing-check summary / conflict
      // reason / human fix prompt) so the attempt recorded at its completion can show WHAT
      // this round set out to fix — the gate analogue of the Tester attempt's `concerns`.
      // Covers every dispatch path (the failed-precheck `probe.failureSummary` and the human
      // `pendingFix.instructions`), which both arrive here as `failureSummary`.
      lastDispatchedInstructions: failureSummary ?? step.gate?.lastDispatchedInstructions ?? null,
    }
    await this.runStateMachine.casPersist(workspaceId, instance)
    await this.runStateMachine.emitInstance(workspaceId, instance)
    return { kind: 'awaiting_job', jobId: step.jobId, stepIndex: instance.currentStep }
  }

  // ---- Implementation-fork decision phase (Phase A dispatch) --------------
  // The proposer explore job runs as a HELPER off the coder step; its completion is handled
  // by the `fork-proposal` interceptor + {@link ForkDecisionController.recordProposal}, and the
  // human's choice by {@link ForkDecisionController.choose}. This method only owns the FRESH
  // entry: resolve the tri-state + risk-policy gate, then either dispatch the proposer or fall
  // through by marking the phase skipped so the Coder dispatches on the next re-drive.

  /**
   * Run the fork-decision phase for a coder step. On fresh entry resolve whether to propose
   * (tri-state `off` → skip; `always` → propose; `auto` → the risk-policy fork gate against the
   * block's estimate). Not proposing → record `skipped` and `continue` so the driver re-enters
   * and dispatches the Coder. Proposing → dispatch the read-only `fork-proposer` explore job on
   * this step (Phase A) via {@link handleAgentStep} with a dispatch-kind override; its
   * completion is intercepted. A re-drive while `proposing` re-attaches to the running job.
   */
  private async handleForkDecisionPhase(ctx: StepHandlerContext): Promise<AdvanceResult> {
    const { workspaceId, instance, step, block } = ctx
    // Re-entry: the human sent a chat turn about the surfaced forks (`pendingForkChat` set by
    // {@link ForkDecisionController.chat}). Compute the grounded reply INLINE in the durable driver
    // (off the HTTP request), append it, and re-park — never re-dispatch the proposer. This is the
    // resume path the `reentrantForkDecision` guard in `stepInstance` falls through for.
    if (step.pendingForkChat) {
      return this.forkDecisionController.answerChat(workspaceId, instance, step, block)
    }
    if (!step.forkDecision) {
      const tri = resolveForkTriState(block.agentConfig)
      let propose = tri === 'always'
      if (tri === 'auto') {
        const policy = await this.resolveRiskPolicy(workspaceId, block)
        propose = shouldProposeForkAuto(policy.forkDecision, block.estimate)
      }
      if (!propose) {
        step.forkDecision = {
          status: 'skipped',
          forks: [],
          chat: [],
          maxChatTurns: DEFAULT_FORK_MAX_CHAT_TURNS,
        }
        await this.runStateMachine.casPersist(workspaceId, instance)
        await this.runStateMachine.emitInstance(workspaceId, instance)
        return { kind: 'continue' }
      }
      step.forkDecision = {
        status: 'proposing',
        forks: [],
        chat: [],
        maxChatTurns: DEFAULT_FORK_MAX_CHAT_TURNS,
      }
    }
    // Dispatch (or re-attach to) the proposer as a helper off this coder step.
    return this.handleAgentStep(ctx, FORK_PROPOSER_KIND)
  }

  /**
   * Drive a re-armed PR-review step's RESOLUTION. The human resolved a parked review with `fix` or
   * `post`; {@link PrReviewController.resolve} re-armed this step and woke the driver. Delegated to
   * {@link PrReviewResolutionController} (the cohesive driver-side seam); see it for the `fix` /
   * `post` mechanics.
   */
  private handlePrReviewResolution(ctx: StepHandlerContext): Promise<AdvanceResult> {
    return this.prReviewResolution.handle(ctx)
  }

  /** Read a run's active implementation-fork decision state, or null. */
  getForkDecision(workspaceId: string, executionId: string): Promise<ForkDecisionStepState | null> {
    return this.forkDecisionController.getActive(workspaceId, executionId)
  }

  /** Resolve the human's implementation-fork choice, re-running the Coder with it folded in. */
  chooseFork(
    workspaceId: string,
    executionId: string,
    input: ChooseForkInput,
  ): Promise<ForkDecisionStepState> {
    return this.forkDecisionController.choose(workspaceId, executionId, input)
  }

  /** Send a grounded chat message about the surfaced forks (the reply arrives via the stream). */
  forkChat(
    workspaceId: string,
    executionId: string,
    input: ForkChatRequestInput,
  ): Promise<ForkDecisionStepState> {
    return this.forkDecisionController.chat(workspaceId, executionId, input)
  }

  /** Read a run's active PR deep-review state, or null. */
  getPrReview(workspaceId: string, executionId: string): Promise<PrReviewStepState | null> {
    return this.prReviewController.getActive(workspaceId, executionId)
  }

  /** Resolve a parked PR review: record the human's finding selection and advance the run. */
  resolvePrReview(
    workspaceId: string,
    executionId: string,
    input: ResolvePrReviewInput,
  ): Promise<PrReviewStepState> {
    return this.prReviewController.resolve(workspaceId, executionId, input)
  }

  /** Dismiss a parked PR-review finding entirely (remove it + prune it from the selection). */
  dismissPrReviewFinding(
    workspaceId: string,
    executionId: string,
    findingId: string,
  ): Promise<PrReviewStepState> {
    return this.prReviewController.dismissFinding(workspaceId, executionId, findingId)
  }

  /** Challenge a parked PR-review finding — dispatch the Challenge Investigator to re-examine it. */
  challengePrReviewFinding(
    workspaceId: string,
    executionId: string,
    findingId: string,
    input: ChallengePrReviewFindingInput,
  ): Promise<PrReviewStepState> {
    return this.prReviewController.challengeFinding(workspaceId, executionId, findingId, input)
  }

  // ---- Follow-up companion pass-throughs ----------------------------------
  // The follow-up gate + its human-action API live on {@link FollowUpGateController}; these
  // thin delegations keep the dispatcher the single surface `ExecutionService` re-exports.

  /** @see FollowUpGateController.getFollowUps */
  getFollowUps(workspaceId: string, executionId: string): Promise<FollowUpsStepState | null> {
    return this.followUpGate.getFollowUps(workspaceId, executionId)
  }

  /** @see FollowUpGateController.fileFollowUp */
  fileFollowUp(
    workspaceId: string,
    executionId: string,
    itemId: string,
  ): Promise<FollowUpsStepState> {
    return this.followUpGate.fileFollowUp(workspaceId, executionId, itemId)
  }

  /** @see FollowUpGateController.queueFollowUp */
  queueFollowUp(
    workspaceId: string,
    executionId: string,
    itemId: string,
  ): Promise<FollowUpsStepState> {
    return this.followUpGate.queueFollowUp(workspaceId, executionId, itemId)
  }

  /** @see FollowUpGateController.answerFollowUp */
  answerFollowUp(
    workspaceId: string,
    executionId: string,
    itemId: string,
    answer: string,
  ): Promise<FollowUpsStepState> {
    return this.followUpGate.answerFollowUp(workspaceId, executionId, itemId, answer)
  }

  /** @see FollowUpGateController.dismissFollowUp */
  dismissFollowUp(
    workspaceId: string,
    executionId: string,
    itemId: string,
  ): Promise<FollowUpsStepState> {
    return this.followUpGate.dismissFollowUp(workspaceId, executionId, itemId)
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
