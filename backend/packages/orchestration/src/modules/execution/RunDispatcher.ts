import type {
  AgentExecutor,
  BinaryCandidateStepState,
  KeepBinaryCandidatesInput,
  AgentRunContext,
  AgentRunResult,
  Block,
  BlockRepository,
  BlueprintService,
  ChallengePrReviewFindingInput,
  ChooseForkInput,
  Clock,
  ExecutionEventPublisher,
  ExecutionInstance,
  ExecutionRepository,
  FollowUpsStepState,
  ForkChatRequestInput,
  ForkDecisionStepState,
  GateDefinition,
  GateRegistry,
  IdGenerator,
  IssueWritebackProvider,
  JudgeDefinition,
  JudgeStepState,
  Logger,
  PipelineStep,
  PrReviewStepState,
  ProviderRegistry,
  ResolveJudgeInput,
  ResolvePrReviewInput,
  RunInitiatorScope,
  StepCompletionResolver,
  StepResolverRegistry,
} from '@cat-factory/kernel'
import {
  isAsyncAgentExecutor,
  noopLogger,
  runBestEffort,
  RunContendedError,
} from '@cat-factory/kernel'
import { buildStepApproval } from './stepApproval.js'
import { parseBlueprintService, parseSpecDoc } from '@cat-factory/contracts'
import { applyContainerRunning, applySubtaskProgress, pollHandleFor } from './step-fold.logic.js'
import { applyObservedToolServers } from './toolServers.logic.js'
import { FORK_PROPOSER_KIND } from '@cat-factory/agents'
import type { AgentKindRegistry } from '@cat-factory/agents'
import { isDeployStep } from '@cat-factory/integrations'
import type { EnvironmentProvisioningService } from '@cat-factory/integrations'
import { reviewableArtifactOutput } from './artifact-review.logic.js'
import { HUMAN_TEST_AGENT_KIND } from './ci.logic.js'
import { AgentContextBuilder } from './AgentContextBuilder.js'
import { DeployerStepController } from './DeployerStepController.js'
import { DisposerStepController } from './DisposerStepController.js'
import { FollowUpGateController } from './FollowUpGateController.js'
import { RunRepoOpsController } from './RunRepoOpsController.js'
import { CompanionController } from './CompanionController.js'
import { HumanTestController } from './HumanTestController.js'
import { MergeResolver } from './MergeResolver.js'
import { ReviewGateController } from './ReviewGateController.js'
import type { BinaryCandidateController } from './BinaryCandidateController.js'
import { ForkDecisionController } from './ForkDecisionController.js'
import { JudgeStepController } from './JudgeStepController.js'
import { GateHelperDispatcher } from './GateHelperDispatcher.js'
import { GateStepController } from './GateStepController.js'
import {
  buildGateMap,
  type ExtensionContextDeps,
  makeGateContext,
  makeJudgeContext,
} from './extension-contexts.js'
import { PrReviewController } from './PrReviewController.js'
import type { PrVerificationReportController } from './PrVerificationReportController.js'
import { PrReviewResolutionController } from './PrReviewResolutionController.js'
import { PollCompletionController } from './PollCompletionController.js'
import { PollRunningController } from './PollRunningController.js'
import { OneShotStepController } from './OneShotStepController.js'
import {
  DEFAULT_FORK_MAX_CHAT_TURNS,
  resolveForkTriState,
  shouldProposeForkAuto,
} from './forkDecision.logic.js'
import type { InterviewGateController } from './InterviewGateController.js'
import { recordJobFacts } from './job-facts.js'
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
import { AgentDispatchController } from './AgentDispatchController.js'
import type { NotificationService } from '../notifications/NotificationService.js'
import type { InitiativeService } from '../initiative/InitiativeService.js'
import type { SpendService } from '@cat-factory/spend'
import type { BlueprintReconciler } from './ExecutionService.js'
import {
  gateOutcomeRecording,
  type ResolvedRiskPolicy,
  type RunDispatcherDeps,
} from './RunDispatcherDependencies.js'

// The dependency DECLARATIONS live in `RunDispatcherDependencies.ts` (the same move
// `ExecutionServiceDependencies.ts` is) and are re-exported here, so every existing import site
// still reaches them through this module.
export type { ResolvedRiskPolicy, RunDispatcherDeps } from './RunDispatcherDependencies.js'

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
  private readonly events: ExecutionEventPublisher
  private readonly idGenerator: IdGenerator
  private readonly clock: Clock
  /** Bound once with the subsystem tag; the per-run ids ride each call's fields. */
  private readonly log: Logger
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
  private readonly binaryCandidateController: BinaryCandidateController
  private readonly prReviewController: PrReviewController
  // The four review-gate SUBJECTS are pure pass-throughs into `registryDeps` — the dispatcher
  // never reads one itself — so they are forwarded from `deps` there rather than mirrored onto
  // four fields that only ever feed one literal.
  /** Interview-gate controllers keyed by their `agentKind` — the trait-driven dispatch table. */
  private readonly interviewControllers: Map<string, InterviewGateController<unknown>>
  private readonly prVerificationReport: PrVerificationReportController
  private readonly runInitiatorScope: RunInitiatorScope
  private readonly environmentProvisioning?: EnvironmentProvisioningService
  private readonly issueWriteback?: IssueWritebackProvider
  private readonly notificationService?: NotificationService
  private readonly blueprintReconciler?: BlueprintReconciler
  private readonly initiativeService?: InitiativeService
  private readonly resolveRiskPolicy: (
    workspaceId: string,
    block: Block,
  ) => Promise<ResolvedRiskPolicy>
  // `resolveRunRepoContext` / `resolveProviderCapabilities` / `modelIdIsMetered` are NOT held
  // here: their only readers moved to {@link AgentDispatchController}, which takes them straight
  // off the deps object. A field kept "for symmetry" would be write-only state that no
  // typecheck flags (TypeScript does not report an assigned-but-unread private member).

  /**
   * The deterministic `deployer` step family (the multi-frame provision fan-out, the async
   * deploy-job poll, and the environment projection env-aware steps surface), extracted to
   * {@link DeployerStepController}. The completion hub + the shared poll folds are injected
   * back as callbacks so the agent and deployer paths share one implementation of each.
   */
  private readonly deployer: DeployerStepController
  /**
   * The deterministic `disposer` step — the deployer's counterpart, reclaiming the environments
   * the run stood up at the point in the pipeline its author chose. Extracted to
   * {@link DisposerStepController} for the same reason the deployer is.
   */
  private readonly disposer: DisposerStepController
  private readonly repoOps: RunRepoOpsController
  /** Driver-side PR deep-review resolution (`fix` / `post`), extracted as a cohesive collaborator. */
  private readonly prReviewResolution: PrReviewResolutionController
  /** Settled-agent-poll completion (helper-phase branches + `failed` handling), extracted collaborator. */
  private readonly pollCompletion: PollCompletionController
  /** The RUNNING half of the poll branch tree — the sibling of {@link pollCompletion}. */
  private readonly pollRunning: PollRunningController
  /**
   * The DISPATCH side of a step — the other side of the park from the two poll controllers above:
   * context build, registered pre-ops, the async start-and-park / inline call, and the facts only a
   * dispatch can record (resolved model, job attribution, investigation diagnostics). The public
   * methods below are thin pass-throughs the execution service and the step registries re-export.
   */
  private readonly agentDispatch: AgentDispatchController
  /** The one-shot engine steps (`tracker` / `bug-intake` / `initiative-committer`). */
  private readonly oneShot: OneShotStepController
  /**
   * The Follow-up companion gate (the future-looking Coder's streamed items, the
   * park-until-decided gate, and the human-action API), extracted to
   * {@link FollowUpGateController}. The dispatcher folds streamed items on each poll and
   * evaluates the gate at Coder completion through this; the public follow-up methods below
   * are thin pass-throughs the execution service re-exports.
   */
  private readonly followUpGate: FollowUpGateController

  /**
   * The JUDGE driver (the fourth step-taxonomy bucket): rubric assessment → per-task threshold
   * → advance / park / bounce / fail. Owns its own lazily-built registry, mirroring
   * {@link gateFor}. See {@link JudgeStepController}.
   */
  private readonly judgeController: JudgeStepController

  /** The polling-gate state machine (precheck → advance / poll / escalate / give up). */
  private readonly gateStepController: GateStepController

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
    this.events = deps.events
    this.idGenerator = deps.idGenerator
    this.clock = deps.clock
    this.log = (deps.logger ?? noopLogger).child({ scope: 'runDispatcher' })
    // Shared by BOTH controllers that can settle a gate (see `gateOutcomeRecording`).
    const gateOutcomeRecorder = gateOutcomeRecording(deps, this.log)
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
    this.binaryCandidateController = deps.binaryCandidateController
    this.prReviewController = deps.prReviewController
    this.interviewControllers = new Map(
      (deps.interviewControllers ?? []).map((c) => [c.agentKind, c]),
    )
    this.prVerificationReport = deps.prVerificationReport
    this.runInitiatorScope = deps.runInitiatorScope
    this.environmentProvisioning = deps.environmentProvisioning
    this.issueWriteback = deps.issueWriteback
    this.notificationService = deps.notificationService
    this.blueprintReconciler = deps.blueprintReconciler
    this.initiativeService = deps.initiativeService
    this.resolveRiskPolicy = deps.resolveRiskPolicy
    this.deployer = new DeployerStepController({
      blockRepository: deps.blockRepository,
      contextBuilder: deps.contextBuilder,
      runStateMachine: deps.runStateMachine,
      environmentProvisioning: deps.environmentProvisioning,
      recordStepResult: (ws, instance, step, isFinalStep, result) =>
        this.recordStepResult(ws, instance, step, isFinalStep, result),
      applyContainerRunning: (step, update) => applyContainerRunning(step, update),
      applySubtaskProgress: (step, counts) => applySubtaskProgress(step, counts),
      recoverContainerEviction: (ws, instance, step, failure, onBeforeRedispatch) =>
        this.pollRunning.recoverContainerEviction(ws, instance, step, failure, onBeforeRedispatch),
      logger: deps.logger,
    })
    this.disposer = new DisposerStepController({
      runStateMachine: deps.runStateMachine,
      environmentTeardown: deps.environmentTeardown,
      recordStepResult: (ws, instance, step, isFinalStep, result) =>
        this.recordStepResult(ws, instance, step, isFinalStep, result),
      logger: deps.logger,
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
      logger: deps.logger,
    })
    this.agentDispatch = new AgentDispatchController({
      agentExecutor: deps.agentExecutor,
      blockRepository: deps.blockRepository,
      clock: deps.clock,
      contextBuilder: deps.contextBuilder,
      deployer: this.deployer,
      repoOps: this.repoOps,
      runStateMachine: deps.runStateMachine,
      runInitiatorScope: this.runInitiatorScope,
      resolveRunRepoContext: deps.resolveRunRepoContext,
      resolveProviderCapabilities: deps.resolveProviderCapabilities,
      modelIdIsMetered: deps.modelIdIsMetered,
      recordStepResult: (ws, instance, step, isFinalStep, result) =>
        this.recordStepResult(ws, instance, step, isFinalStep, result),
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
    this.pollRunning = new PollRunningController({
      blockRepository: deps.blockRepository,
      clock: deps.clock,
      runStateMachine: deps.runStateMachine,
      deployer: this.deployer,
      followUpGate: this.followUpGate,
      runInitiatorScope: this.runInitiatorScope,
      gateFor: (agentKind) => this.gateFor(agentKind),
      ...gateOutcomeRecorder,
      recordStepResult: (ws, instance, step, isFinalStep, result) =>
        this.recordStepResult(ws, instance, step, isFinalStep, result),
      recordBackendDiagnostics: (instance, backend) =>
        this.recordBackendDiagnostics(instance, backend),
    })
    this.oneShot = new OneShotStepController({
      blockRepository: deps.blockRepository,
      clock: deps.clock,
      contextBuilder: deps.contextBuilder,
      log: this.log,
      repoOps: this.repoOps,
      runStateMachine: deps.runStateMachine,
      stepGraph: deps.stepGraph,
      ...(deps.bugIntakeService ? { bugIntakeService: deps.bugIntakeService } : {}),
      ...(deps.initiativeService ? { initiativeService: deps.initiativeService } : {}),
      ...(deps.issueWriteback ? { issueWriteback: deps.issueWriteback } : {}),
      ...(deps.ticketTrackerProvider ? { ticketTrackerProvider: deps.ticketTrackerProvider } : {}),
      recordStepResult: (ws, instance, step, isFinalStep, result) =>
        this.recordStepResult(ws, instance, step, isFinalStep, result),
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
        this.pollRunning.recoverContainerEviction(ws, instance, step, failure),
      markContainerErrored: (ws, instance, step) =>
        this.pollRunning.markContainerErrored(ws, instance, step),
    })
    this.gateStepController = new GateStepController(
      {
        agentExecutor: deps.agentExecutor,
        clock: deps.clock,
        runStateMachine: deps.runStateMachine,
        runInitiatorScope: this.runInitiatorScope,
        resolveRiskPolicy: (ws, block) => this.resolveRiskPolicy(ws, block),
        declaredGateFields: (kind) => this.gateRegistry.configFields(kind),
        ...gateOutcomeRecorder,
        recordStepResult: (ws, instance, step, isFinalStep, result) =>
          this.recordStepResult(ws, instance, step, isFinalStep, result),
      },
      new GateHelperDispatcher({
        agentExecutor: deps.agentExecutor,
        contextBuilder: deps.contextBuilder,
        runStateMachine: deps.runStateMachine,
      }),
    )
    this.judgeController = new JudgeStepController({
      judgeRegistry: deps.judgeRegistry,
      judgeAssessor: deps.judgeAssessor,
      executionRepository: deps.executionRepository,
      stateMachine: deps.runStateMachine,
      stepGraph: deps.stepGraph,
      workRunner: deps.workRunner,
      clock: deps.clock,
      runInitiatorScope: this.runInitiatorScope,
      raiseNotification: async (ws, input) => {
        await this.notificationService?.raise(ws, input)
      },
      resolveRiskPolicy: (ws, block) => this.resolveRiskPolicy(ws, block),
      fragmentResolver: deps.fragmentResolver,
      recordStepResult: (ws, instance, step, isFinalStep, result) =>
        this.recordStepResult(ws, instance, step, isFinalStep, result),
      makeJudgeContext: () => makeJudgeContext(this.extensionContextDeps()),
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
      disposer: this.disposer,
      companionController: this.companionController,
      testerController: this.testerController,
      ralphController: this.ralphController,
      humanTestController: this.humanTestController,
      visualConfirmationController: this.visualConfirmationController,
      reviewGate: this.reviewGate,
      forkDecisionController: this.forkDecisionController,
      binaryCandidateController: this.binaryCandidateController,
      prReviewController: this.prReviewController,
      mergeResolver: this.mergeResolver,
      requirementsKind: deps.requirementsKind,
      clarityKind: deps.clarityKind,
      requirementsBrainstormKind: deps.requirementsBrainstormKind,
      architectureBrainstormKind: deps.architectureBrainstormKind,
      interviewControllers: this.interviewControllers,
      recordStepResult: (ws, instance, step, isFinalStep, result) =>
        this.recordStepResult(ws, instance, step, isFinalStep, result),
      runTracker: (ws, instance, block) => this.oneShot.runTracker(ws, instance, block),
      runBugIntake: (ws, instance, step, block, isFinalStep) =>
        this.oneShot.runBugIntake(ws, instance, step, block, isFinalStep),
      runInitiativeCommitter: (ws, block) => this.oneShot.runInitiativeCommitter(ws, block),
      evaluateGate: (ws, instance, step, block, isFinalStep, gate) =>
        this.evaluateGate(ws, instance, step, block, isFinalStep, gate),
      gateFor: (kind) => this.gateFor(kind),
      evaluateJudge: (ws, instance, step, block, isFinalStep, judge) =>
        this.judgeController.evaluate(ws, instance, step, block, isFinalStep, judge),
      judgeFor: (kind) => this.judgeController.judgeFor(kind),
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

  // ---- Dispatch-side pass-throughs ----------------------------------------
  // The dispatch half of a step lives on {@link AgentDispatchController}; these thin delegations
  // keep the dispatcher the single surface `ExecutionService` and the step registries re-export.

  /** @see AgentDispatchController.handleAgentStep */
  private handleAgentStep(
    ctx: StepHandlerContext,
    dispatchKind?: string,
    augmentContext?: (context: AgentRunContext) => void,
  ): Promise<AdvanceResult> {
    return this.agentDispatch.handleAgentStep(ctx, dispatchKind, augmentContext)
  }

  /** @see AgentDispatchController.recordBackendDiagnostics */
  private recordBackendDiagnostics(
    instance: ExecutionInstance,
    backend: string | undefined,
  ): boolean {
    return this.agentDispatch.recordBackendDiagnostics(instance, backend)
  }

  /** @see AgentDispatchController.previewStepModel */
  previewStepModel(context: AgentRunContext): Promise<string | undefined> {
    return this.agentDispatch.previewStepModel(context)
  }

  /** @see AgentDispatchController.currentStepIsNonMetered */
  currentStepIsNonMetered(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
  ): Promise<boolean> {
    return this.agentDispatch.currentStepIsNonMetered(workspaceId, instance, step)
  }

  /** @see AgentDispatchController.runAgent */
  runAgent(context: AgentRunContext, options: AdvanceOptions = {}): Promise<AgentRunResult> {
    return this.agentDispatch.runAgent(context, options)
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

    // The handle is rebuilt from the STEP — the poll site has no dispatch in scope — so every
    // field the executor reads off it has to have been persisted at dispatch. What each one is
    // for, and what silently breaks without it, lives with its counterpart in `step-fold.logic`.
    const update = await executor.pollJob(pollHandleFor(step, workspaceId, executionId))
    if (update.state === 'running') {
      return this.pollRunning.handleRunningPoll(
        workspaceId,
        executionId,
        instance,
        update,
        step.jobId,
      )
    }

    // The CLI's own tool-server startup report, for every SETTLED disposition — folded once ahead
    // of the branch tree below rather than inside each of its five persisting arms (see
    // `toolServers.logic.ts`). Mutation only; whichever arm runs owns the persist.
    applyObservedToolServers(step, update.toolServers)

    // A gate whose helper INVESTIGATES instead of fixing (post-release-health → on-call)
    // declares a `resolveHelperCompletion` hook on its definition. When such a helper's job
    // settles — done OR failed — we call the hook INSTEAD of re-probing the precheck
    // (re-probing an investigate-don't-fix helper would just regress again and burn the
    // budget) and finish the gate step with the output it returns. The gate raises its own
    // `release_regression` notification + enriches any open incident inside the hook (from the
    // signals stashed at escalation); the run then completes for a human to act out-of-band.
    const investigated = await this.pollRunning.resolveInvestigateHelperCompletion(
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
      return this.pollRunning.reprobeGateAfterHelper(reprobeGate, {
        workspaceId,
        instance,
        step,
        update,
      })
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
    // Read off the REGISTRATION, not off the definition the factory builds: it is one
    // declaration, and public-API admission has to read the same one at HTTP request time where
    // there is no engine context to build a definition with. `undefined` here means the kind is
    // not registered as a gate at all (a step whose gate was retired between the run starting and
    // this poll landing), which falls through to the timeout below exactly as an unknown kind did.
    const pollExhaustion = step ? this.gateRegistry.pollExhaustion(step.agentKind) : undefined
    const timeoutError = 'Gate precheck did not settle within its polling budget'
    // An unbounded human-wait gate (human-review, `pollExhaustion: 'rearm'`) has no deadline:
    // running out of polls is never a verdict. Always re-arm another poll cycle — the waiting
    // is surfaced via the gate's notification (escalated by the severity sweep), not by killing
    // the run.
    if (step && pollExhaustion === 'rearm') {
      if (step.gate) step.gate.phase = 'checking'
      await this.runStateMachine.casPersist(workspaceId, instance)
      return { kind: 'awaiting_gate', stepIndex: instance.currentStep }
    }
    if (!step || pollExhaustion !== 'pass') {
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
      output: `${step.agentKind} gate passed: watch window elapsed with no regression observed.`,
    })
  }

  /**
   * Finish a gated step that was skipped (its estimate gate or its run condition was not
   * satisfied) and either complete the run or advance to the next step — the deterministic
   * finish/advance tail of {@link recordStepResult}, minus all the agent-result handling (no LLM
   * ran, so there is no usage / decision / PR / artifact / approval / resolver to process). The
   * step is marked `skipped` so the UI renders "skipped (gated)".
   *
   * `note` states WHY, for a skip whose reason a reader cannot recover from the pipeline: an
   * estimate gate is visible on the step itself (the thresholds are right there beside it), while
   * a run condition is a fact about the TASK, so an unexplained skip reads as a tester that
   * silently did nothing. Empty output otherwise, exactly as before.
   */
  async skipGatedStep(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    isFinalStep: boolean,
    note?: string,
  ): Promise<AdvanceResult> {
    step.skipped = true
    step.output = note ?? ''
    step.progress = 1
    step.subtasks = undefined
    this.stepGraph.finishStep(step)

    return this.runStateMachine.settleStepAndAdvance(workspaceId, instance, isFinalStep)
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
    await recordJobFacts(
      { clock: this.clock, spend: this.spend, contextBuilder: this.contextBuilder },
      workspaceId,
      instance,
      step,
      result,
    )

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
    const resolverRendered = await this.applyPostCompletionResolver(
      workspaceId,
      instance,
      step,
      result,
      isFinalStep,
    )

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
    // Record WHICH of the two the step's output now is, because the approval gate below reads
    // `step.output` as an editable proposal and a rendering is not editable — the artifact it
    // renders was already ingested, so a correction typed over the render reaches nothing.
    // Either producer counts: the generic seam above, or a post-completion resolver that
    // rendered the artifact IT committed (`StepResolution.outputIsRendered` — the initiative
    // planner, whose committed plan the engine derives rather than takes verbatim).
    // Assigned on BOTH branches (not only when a render happened): a re-run that produced no
    // artifact this time must clear a flag the previous attempt set. The negative branch is
    // `undefined` rather than `false` so `JSON.stringify` omits the key — every ordinary step
    // takes it, and the run detail blob carries one per step.
    step.outputIsRendered = reviewable !== undefined || resolverRendered ? true : undefined

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
      // Through the shared builder, which snapshots the gate's configured policy. See
      // `stepApproval.ts` for why a second raise site may not hand-roll this literal.
      step.approval = buildStepApproval(step, this.idGenerator.next('appr'), step.output)
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

    // Refresh the engine-maintained VERIFICATION REPORT on the run's PR from the evidence the
    // instance now carries (CI verdict, tester report, environment lifecycle, merge assessment).
    // Its POSITION is load-bearing: AFTER the terminal resolver, so a `merger` step publishes
    // with its resolved `MergeDecision` recorded; BEFORE `finalizeBlock`, so the
    // `pipeline_complete` card a merger-less pipeline raises points at a PR that already carries
    // the finished report. A passing polling gate settles through here too, so the CI verdict
    // needs no hook of its own. Best-effort inside the controller: no publisher wired, no PR
    // yet, or a settlement whose evidence is unchanged ⇒ nothing happens. A settlement that DOES
    // change the evidence writes, so the report tracks the run rather than landing once at the
    // end — which is the point, since a run that fails or parks part-way never reaches an end.
    await this.prVerificationReport.publishForRun(workspaceId, instance)

    // Merge resolution (and confidence persistence) already happened above,
    // POSITION-INDEPENDENTLY: confidence at the top of recordStepResult and the merger's real
    // merge via the step-completion resolver registry (so a trailing post-release-health gate
    // doesn't disable auto-merge). Nothing merge-specific is left for the settle.
    return this.runStateMachine.settleStepAndAdvance(workspaceId, instance, isFinalStep, {
      ...(result.confidence !== undefined ? { confidence: result.confidence } : {}),
      resolverOwnsTerminalStatus,
    })
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
    await this.runStateMachine.persistAndEmit(workspaceId, instance, { blockStatus: 'blocked' })
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
    // Bound to locals before the closure: TypeScript drops property narrowing across a callback
    // boundary, so reading them off `this`/`result` inside would need `!` — an assertion that is
    // true today only because of a guard three lines up, and that nothing rechecks if this
    // condition later gains a branch.
    const writeback = this.issueWriteback
    const pullRequest = result.pullRequest
    if (writeback && priorBlock && pullRequest && priorBlock.pullRequest?.url !== pullRequest.url) {
      await runBestEffort(
        this.log,
        'writeback.onPullRequestOpened',
        () => writeback.onPullRequestOpened(workspaceId, priorBlock, pullRequest),
        { workspaceId, executionId: instance.id, blockId: priorBlock.id },
      )
    }
  }

  /**
   * Run any POST-COMPLETION resolver registered for this step kind (blueprint/spec ingestion,
   * task-estimate persistence). It reshapes the agent's structured result into domain state and may
   * replace `step.output`. A no-op when no post-completion resolver applies. See
   * {@link buildStepResolverRegistry} and {@link StepCompletionResolver.phase}.
   *
   * Returns whether the replacement output is a RENDERING of an artifact the resolver committed
   * (`StepResolution.outputIsRendered`), which the caller folds into `step.outputIsRendered`.
   */
  private async applyPostCompletionResolver(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    result: AgentRunResult,
    isFinalStep: boolean,
  ): Promise<boolean> {
    const postCompletionResolver = this.stepResolverFor(step.agentKind)
    if (
      postCompletionResolver?.phase !== 'post-completion' ||
      !(postCompletionResolver.applies?.(result) ?? true)
    ) {
      return false
    }
    const resolution = await postCompletionResolver.resolve({
      workspaceId,
      instance,
      step,
      result,
      isFinalStep,
    })
    if (resolution?.output === undefined) return false
    step.output = resolution.output
    // Reported to the caller rather than written here, so `step.outputIsRendered` keeps a
    // SINGLE assignment point — the flag has to be cleared on a re-run that rendered nothing,
    // and two writers would make "who clears it" ambiguous.
    return resolution.outputIsRendered === true
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
    if (!this.gateRegistryCache) {
      this.gateRegistryCache = buildGateMap(
        this.gateRegistry,
        makeGateContext(this.extensionContextDeps()),
      )
    }
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

  /**
   * The collaborators the extension contexts (gate + judge) close over. Assembled here and
   * handed to the shared factories in `extension-contexts.ts`, so both extension families see
   * exactly the same seams and neither can drift.
   */
  private extensionContextDeps(): ExtensionContextDeps {
    return {
      clock: this.clock,
      getBlock: (workspaceId, blockId) => this.blockRepository.get(workspaceId, blockId),
      runInitiatorScope: this.runInitiatorScope,
      raiseNotification: async (workspaceId, input) => {
        await this.notificationService?.raise(workspaceId, input)
      },
      providerRegistry: this.providerRegistry,
    }
  }

  /** @see JudgeStepController.getActive */
  getJudgeState(workspaceId: string, executionId: string): Promise<JudgeStepState | null> {
    return this.judgeController.getActive(workspaceId, executionId)
  }

  /** @see JudgeStepController.resolveDecision */
  resolveJudgeDecision(
    workspaceId: string,
    executionId: string,
    input: ResolveJudgeInput,
  ): Promise<JudgeStepState> {
    return this.judgeController.resolveDecision(workspaceId, executionId, input)
  }

  /** Every registered judge, for the workspace-snapshot palette projection. */
  registeredJudges(): JudgeDefinition[] {
    return this.judgeController.all()
  }

  /**
   * Evaluate a polling gate step once and decide (shared by the initial advance and the durable
   * `awaiting_gate` re-poll). Thin delegate — the state machine lives in
   * {@link GateStepController}.
   */
  private evaluateGate(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    block: Block,
    isFinalStep: boolean,
    gate: GateDefinition,
  ): Promise<AdvanceResult> {
    return this.gateStepController.evaluate(workspaceId, instance, step, block, isFinalStep, gate)
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
        await this.runStateMachine.persistAndEmit(workspaceId, instance)
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

  /** Read a run's active generated-candidate comparison state, or null. */
  getBinaryCandidates(
    workspaceId: string,
    executionId: string,
  ): Promise<BinaryCandidateStepState | null> {
    return this.binaryCandidateController.getActive(workspaceId, executionId)
  }

  /** Keep the chosen candidates, re-running the step to deliver exactly those. */
  keepBinaryCandidates(
    workspaceId: string,
    executionId: string,
    input: KeepBinaryCandidatesInput,
  ): Promise<BinaryCandidateStepState> {
    return this.binaryCandidateController.keep(workspaceId, executionId, input)
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

  /** Resume a review stuck mid-`reviewing`: re-review only the slices that never reported. */
  resumePrReview(workspaceId: string, executionId: string): Promise<PrReviewStepState> {
    return this.prReviewController.resume(workspaceId, executionId)
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
    // A whole subtree changed, not one block, so this stays a refresh. Name the service frame so
    // it fans out to every board mounting this shared service.
    await this.events.boardChanged(workspaceId, {
      reason: 'blueprint-reconciled',
      blockId: frameId,
    })
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
    // Refresh so clients re-read the spec files. What changed is in the repo, not on a block.
    await this.events.boardChanged(workspaceId, { reason: 'requirements-updated' })
  }
}
