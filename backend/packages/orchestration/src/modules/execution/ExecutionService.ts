import type {
  JudgeDefinition,
  JudgeStepState,
  ResolveJudgeInput,
  AgentFailureKind,
  Block,
  ExecutionInstance,
  FollowUpsStepState,
  ForkDecisionStepState,
  ChooseForkInput,
  ForkChatRequestInput,
  PrReviewStepState,
  ResolvePrReviewInput,
  ChallengePrReviewFindingInput,
  PipelineStep,
  PullRequestMerger,
  StepReviewComment,
  IssueWritebackProvider,
  Logger,
} from '@cat-factory/kernel'
import { allPullRequests } from '@cat-factory/contracts'
import type { AgentKindRegistry } from '@cat-factory/agents'
import type { RunStartOptions } from './runStartOptions.js'
import { producerWasSkipped, shouldRunGatedStep } from './stepGating.logic.js'
import {
  resolveIndividualVendors,
  type HasPersonalSubscription,
} from './individualVendors.logic.js'
import {
  assertFound,
  RunContendedError,
  ReviewContendedError,
  type SubscriptionVendor,
} from '@cat-factory/kernel'
import { noopLogger, runBestEffort } from '@cat-factory/kernel'
import { AgentContextBuilder } from './AgentContextBuilder.js'
import { CompanionController } from './CompanionController.js'
import { StepGraph } from './StepGraph.js'
import { RunStateMachine } from './RunStateMachine.js'
import { RunDispatcher } from './RunDispatcher.js'
import { RunAdmission } from './RunAdmission.js'
import { StepDecisionController } from './StepDecisionController.js'
import { buildRunActionControllers, type RunActionControllers } from './run-action-controllers.js'
import { inferTechnicalLabel } from './technical.logic.js'
import { MergeResolver, type FinalizeMergeResult } from './MergeResolver.js'
import { PostMergeBoardController, type PostMergeBoardHost } from './PostMergeBoardController.js'
import { orderPrsForMerge } from './mergeOrder.logic.js'
import { type ReviewGateController, type ReviewKind } from './ReviewGateController.js'
import { buildGateWindowControllers, buildReviewSubjects } from './gate-window-controllers.js'
import { buildRunContextAndAdmission } from './run-context-admission.js'
import { ForkDecisionController } from './ForkDecisionController.js'
import { PrReviewController } from './PrReviewController.js'
import {
  BrainstormActions,
  ClarityReviewActions,
  type HumanTestActions,
  RequirementReviewActions,
  type VisualConfirmActions,
} from './gate-window-facades.js'
import { TesterController } from './TesterController.js'
import { RalphController } from './RalphController.js'
import { HumanTestController } from './HumanTestController.js'
import { VisualConfirmationController } from './VisualConfirmationController.js'
import type { NotificationService } from '../notifications/NotificationService.js'
import { InitiativeInterviewController } from './InitiativeInterviewController.js'
import { DocInterviewController } from './DocInterviewController.js'
import { isReentrantDecisionResume } from './reentrancy.logic.js'
import type { InitiativeRunHarvest } from '../initiative/initiative.logic.js'
import type {
  IterationCapChoice,
  RequirementReview,
  ClarityReview,
  BrainstormSession,
  BrainstormStage,
} from '@cat-factory/kernel'
import type {
  BlockRepository,
  ExecutionRepository,
  PipelineRepository,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import type { Clock, IdGenerator, PreloadedBlocks } from '@cat-factory/kernel'
import type { AgentExecutor } from '@cat-factory/kernel'
import type { ReviewEffort } from '@cat-factory/kernel'
import { RunMergePolicy } from './RunMergePolicy.js'
import type { ResolvedRunRiskPolicy } from './policy-types.js'
import type { WorkRunner } from '@cat-factory/kernel'
import type { ExecutionEventPublisher } from '@cat-factory/kernel'
import type { BoardService } from '../board/BoardService.js'
import type { SpendService } from '@cat-factory/spend'
import { requireWorkspace } from '@cat-factory/kernel'
import type { AdvanceOptions, AdvanceResult } from './advance.js'
import type { ExecutionServiceDependencies } from './ExecutionServiceDependencies.js'
import { PrVerificationReportController } from './PrVerificationReportController.js'

// The engine's injected-collaborator contract lives next door (a ~350-line declaration block
// that was crowding this file against its size budget); re-exported here so every existing
// importer — including the package index — keeps resolving it from `ExecutionService.js`.
export type {
  BlueprintReconciler,
  ExecutionServiceDependencies,
} from './ExecutionServiceDependencies.js'

export type { ResolvedRunRiskPolicy } from './policy-types.js'

/**
 * The execution engine. It orchestrates a pipeline of agent-performed steps and
 * is fully deterministic: `advanceInstance` moves one run forward by exactly one
 * step, delegating the actual work — and the choice of whether to pause for a
 * human decision — to the injected {@link AgentExecutor}. The durable workflow
 * driver calls it in a loop. All LLM behaviour lives behind that port, so the
 * engine here can be tested with a
 * deterministic fake and no timing/delays.
 */
/**
 * Assemble the PR verification-report controller from the engine's already-resolved deps. A
 * seam extracted out of the constructor purely so that (large) composition stays inside its
 * per-function line budget: the budget is a split trigger, never a number to raise.
 */
function buildPrReportController(
  deps: ExecutionServiceDependencies,
): PrVerificationReportController {
  return new PrVerificationReportController({
    blockRepository: deps.blockRepository,
    clock: deps.clock,
    publisher: deps.prVerificationReportPublisher,
    taskRepository: deps.taskRepository,
    workspaceSettingsRepository: deps.workspaceSettingsRepository,
    // Same seam the repo-ops controller uses, so the report reads the run's `spec/` through the
    // repo access the engine has already resolved. Unwired ⇒ the requirement section reports
    // `absent` with a note.
    resolveRunRepoContext: deps.resolveRunRepoContext,
    // Dates the environment lifecycle (up → torn down). Unwired ⇒ the section says so rather
    // than reporting an environment nobody reclaimed as one nobody recorded.
    provisioningLogRepository: deps.provisioningLogRepository,
    appBaseUrl: deps.appBaseUrl,
    // The BACKEND's own public URL, for direct links to captured artifacts' bytes. Distinct from
    // the SPA origin above, which the two links deliberately do not share.
    apiBaseUrl: deps.apiBaseUrl,
    logger: deps.logger,
  })
}

export class ExecutionService {
  private readonly workspaceRepository: WorkspaceRepository
  private readonly blockRepository: BlockRepository
  private readonly pipelineRepository: PipelineRepository
  private readonly executionRepository: ExecutionRepository
  private readonly idGenerator: IdGenerator
  private readonly clock: Clock
  /** The pure step/cursor mutators (start/finish/park/reset + the companion rework loop). */
  private readonly stepGraph: StepGraph
  /** The async instance/block state-machine spine (persist/emit/park/advance/finalize/fail). */
  private readonly runStateMachine: RunStateMachine
  private readonly agentExecutor: AgentExecutor
  /** App-owned agent-kind registry (custom-kind traits/inline-surface + pre/post-op hooks). */
  private readonly agentKindRegistry: AgentKindRegistry
  private readonly workRunner: WorkRunner
  private readonly events: ExecutionEventPublisher
  private readonly board: BoardService
  private readonly spend: SpendService
  /** Assembles the per-step agent context (requirements, docs, env, service frame, fragments). */
  private readonly contextBuilder: AgentContextBuilder
  /**
   * The run-admission preflights (the `assert*` family): every config/resource precondition
   * a START / RETRY / RESTART must satisfy, extracted to {@link RunAdmission} so the guard
   * family can grow without re-bloating the engine. Also owns the shared
   * {@link RunAdmission.modelIdIsMetered} predicate the spend gates use.
   */
  private readonly admission: RunAdmission
  /** Resolves a `merger` step's assessment into an auto-merge or a `merge_review` notification. */
  private readonly mergeResolver: MergeResolver
  /** Drives a companion (reviewer/spec/architect) step: grade → pass / loop producer / park. */
  private readonly companionController: CompanionController
  /** Drives the Tester gate's fix loop: report → greenlight / dispatch fixer / fail. */
  private readonly testerController: TesterController
  private readonly ralphController: RalphController
  /** Drives the human-testing gate: provision env → park → confirm / fix / pull-main / recreate. */
  private readonly humanTestController: HumanTestController
  /** Drives the visual-confirmation gate: gather screenshots → park → approve / fix / recapture. */
  private readonly visualConfirmationController: VisualConfirmationController
  /** Drives both iterative review gates (requirements + clarity); kind-parameterised. */
  private readonly reviewGate: ReviewGateController
  /** Drives the human-facing half of the implementation-fork decision phase on the Coder step. */
  private readonly forkDecisionController: ForkDecisionController
  private readonly prReviewController: PrReviewController
  /** The requirements subject for {@link reviewGate}. */
  private readonly requirementsKind: ReviewKind<RequirementReview>
  /** The clarity (bug-report triage) subject for {@link reviewGate}. */
  private readonly clarityKind: ReviewKind<ClarityReview>
  /** The two brainstorm (structured-dialogue) subjects for {@link reviewGate}, by stage. */
  private readonly requirementsBrainstormKind: ReviewKind<BrainstormSession>
  private readonly architectureBrainstormKind: ReviewKind<BrainstormSession>
  // The three review-window sub-facades are built LAZILY by their getters (below) rather than in
  // the constructor: they are thin wrappers over collaborators the constructor already assigned,
  // and building them on first read keeps that (budgeted) constructor from carrying assembly that
  // has no ordering constraint.
  /** Requirements-review window actions (exposed via {@link requirementsReview}). */
  private requirementsReviewActions?: RequirementReviewActions
  /** Clarity-review (bug triage) window actions (exposed via {@link clarityReview}). */
  private clarityReviewActions?: ClarityReviewActions
  /** Brainstorm window actions (exposed via {@link brainstorm}). */
  private brainstormActions?: BrainstormActions
  /** Drives the interactive-planning interviewer gate (exposed via {@link initiativeInterview}). */
  private readonly initiativeInterviewController?: InitiativeInterviewController
  /** Drives the interactive document-interview gate (exposed via {@link docInterview}). */
  private readonly docInterviewController?: DocInterviewController
  // `blueprintReconciler` / `notificationService` / `ticketTrackerProvider` /
  // `resolveRunRepoContext` / `runInitiatorScope` are NOT stored on the engine: their only
  // consumers (the ingest/follow-up/tracker/notification paths + the pre/post-op repo binding +
  // the initiator scope) moved to {@link RunDispatcher} (and the controllers / RunStateMachine),
  // so the constructor forwards the destructured params straight to those collaborators. The
  // admission-only seams (`workspaceSettingsService` / `resolveProviderCapabilities` /
  // `inlineHarnessRef` / `resolveBinaryArtifactStore` / `assertAgentBackendConfigured` /
  // `environmentProvisioning`) likewise live on {@link RunAdmission} (and the controllers).
  private readonly prMerger?: PullRequestMerger
  private readonly notifications?: NotificationService
  private readonly mergePolicy: RunMergePolicy
  /** The board-shaped follow-up a merged task triggers (module materialisation, dependents). */
  private readonly postMergeBoard: PostMergeBoardController
  private readonly issueWriteback?: IssueWritebackProvider
  /**
   * The engine's structured logger, resolved once so the best-effort paths below can report
   * their drops without a null-check. `noopLogger` when a facade wired none.
   */
  private readonly log: Logger
  // No `subscriptionActivations` field: its only reader is the run-lifecycle surface, which now
  // takes the repository straight off the deps object (see {@link RunLifecycleController}).
  private readonly pokeInitiativeLoop?: (
    workspaceId: string,
    initiativeBlockId: string,
    harvest?: InitiativeRunHarvest,
  ) => void
  private readonly resolveWorkspaceModelDefault?: (
    workspaceId: string,
    agentKind: string,
    modelPresetId?: string,
  ) => Promise<string | undefined>
  /**
   * The per-step dispatch + completion spine (the four registries, the completion hub, the
   * gate machinery, the deterministic deployer/tracker steps, the pre/post-op cluster, the
   * structured-artifact ingest, and the follow-up companion gate). `stepInstance` runs the
   * run-lifecycle preamble then delegates the per-kind work here; `pollAgentJob` / `pollGate`
   * / `resolveGatePollExhaustion` + the follow-up human-action API are thin pass-throughs.
   */
  private readonly runDispatcher: RunDispatcher
  /** The human decision surface on a parked run (approve / reject / merge / …). */
  private readonly stepDecisions: StepDecisionController
  /**
   * The surfaces a HUMAN drives on a whole run: its lifecycle (launch / re-launch / resume / end,
   * which share the claim-then-hand-off order) and the three-way iteration-cap resolution both
   * automatic-rework gates park for. Extracted so this service keeps the per-step machine; the
   * public methods that reach them are thin pass-throughs.
   */
  private readonly runActions: RunActionControllers
  /** Maintains the run's verification report on its PR (a hook on step settlement). */
  private readonly prVerificationReport: PrVerificationReportController

  constructor(dependencies: ExecutionServiceDependencies) {
    // Bind the whole deps object, then destructure what this constructor itself reads. The
    // object is what the sibling factories below are handed, so a field they consume can never
    // be dropped by a hand-maintained forwarding list.
    //
    // That is not hypothetical: this list previously omitted `agentPromptRepository`, which is
    // declared on the deps type and consumed by `buildRunContextAndAdmission`, so every
    // workspace's agent prompt OVERRIDES silently never reached a dispatch. The two libraries
    // the context builder reads — the prompt-override log and the consensus-group library —
    // both fail that way when unforwarded: nothing errors, the feature is just off. Nothing
    // below may go back to naming them one by one.
    const {
      workspaceRepository,
      blockRepository,
      pipelineRepository,
      executionRepository,
      idGenerator,
      clock,
      agentExecutor,
      workRunner,
      executionEventPublisher,
      boardService,
      spendService,
      environmentProvisioning,
      requirementReviewService,
      docInterviewService,
      forkChatService,
      testerQualityReviewer,
      kaizenScheduler,
      clarityReviewService,
      brainstormServices,
      environmentTeardown,
      branchUpdater,
      initiativeService,
      initiativeInterviewService,
      notificationService,
      runLifecycleSink,
      resolveBinaryArtifactStore,
      llmObservability,
      pullRequestMerger,
      riskPolicyRepository,
      mergeTrackRecord,
      riskPolicyCache,
      issueWriteback,
      subscriptionActivationRepository,
      resolveWorkspaceModelDefault,
      runInitiatorScope,
      pokeInitiativeLoop,
      agentKindRegistry,
      logger,
    } = dependencies
    // Forward-only: the run-initiator scope is consumed solely by RunDispatcher (below), so it
    // is hoisted to a local with its default applied rather than stored as a `this.` field.
    const runInitiatorScopeFn = runInitiatorScope ?? ((_initiatedBy, fn) => fn())
    this.workspaceRepository = workspaceRepository
    this.blockRepository = blockRepository
    this.pipelineRepository = pipelineRepository
    this.executionRepository = executionRepository
    this.idGenerator = idGenerator
    this.clock = clock
    this.stepGraph = new StepGraph(clock)
    // The task's merge POLICY (which preset governs a run) + the EVIDENCE behind it (settling the
    // run's merge track record when a human merges or declines), extracted as one collaborator so
    // neither concern re-accretes onto the engine.
    this.mergePolicy = new RunMergePolicy({
      riskPolicyRepository,
      riskPolicyCache,
      mergeTrackRecord,
    })
    this.runStateMachine = new RunStateMachine({
      executionRepository,
      blockRepository,
      events: executionEventPublisher,
      workRunner,
      agentExecutor,
      idGenerator,
      clock,
      stepGraph: this.stepGraph,
      notificationService,
      runLifecycleSink,
      logger,
      mergeTrackRecord,
      kaizenScheduler,
      subscriptionActivations: subscriptionActivationRepository,
      llmObservability,
      pokeInitiativeLoop,
    })
    this.agentExecutor = agentExecutor
    this.agentKindRegistry = agentKindRegistry
    this.workRunner = workRunner
    this.events = executionEventPublisher
    this.board = boardService
    this.spend = spendService
    // The prompt-composition builder + the run-admission preflight family it backs, built as one
    // pair by the sibling factory (see run-context-admission.ts) — admission is constructed ON the
    // context builder, so they are one seam.
    const runContext = buildRunContextAndAdmission(dependencies)
    this.contextBuilder = runContext.contextBuilder
    this.admission = runContext.admission
    this.postMergeBoard = this.buildPostMergeBoard()
    this.mergeResolver = new MergeResolver({
      blockRepository,
      notificationService,
      mergeTrackRecord,
      resolveRiskPolicy: (ws, block) => this.resolveRiskPolicy(ws, block),
      finalizeMerge: (ws, blockId) => this.finalizeMerge(ws, blockId),
    })
    this.companionController = new CompanionController({
      contextBuilder: this.contextBuilder,
      spend: spendService,
      idGenerator,
      previewStepModel: (ctx) => this.runDispatcher.previewStepModel(ctx),
      runAgent: (ctx, opts) => this.runDispatcher.runAgent(ctx, opts),
      stateMachine: this.runStateMachine,
      stepGraph: this.stepGraph,
      inferTechnicalLabel: (ws, block, producer, companionStep) =>
        this.inferBlockTechnical(ws, block, producer, companionStep),
    })
    // The human-gate window controllers (Tester / Ralph / human-test / visual-confirmation /
    // review / fork-decision / PR-review), built by the sibling factory over one deps bundle.
    // The engine methods they reach back into are passed BOUND, so every closure still resolves
    // against this instance exactly as when they were constructed inline.
    const gateWindows = buildGateWindowControllers({
      blockRepository,
      executionRepository,
      workRunner,
      agentExecutor,
      notificationService,
      contextBuilder: this.contextBuilder,
      stateMachine: this.runStateMachine,
      stepGraph: this.stepGraph,
      idGenerator,
      clock,
      clockNow: () => this.clock.now(),
      resolveRiskPolicy: (ws, block) => this.resolveRiskPolicy(ws, block),
      dispatchIterationCap: (ws, blockId, choice, handlers) =>
        this.runActions.iterationCap.dispatchIterationCap(ws, blockId, choice, handlers),
      testerQualityReviewer,
      environmentProvisioning,
      environmentTeardown,
      branchUpdater,
      resolveBinaryArtifactStore,
      forkChatService,
      issueWriteback,
      logger,
    })
    this.testerController = gateWindows.testerController
    this.ralphController = gateWindows.ralphController
    this.humanTestController = gateWindows.humanTestController
    this.visualConfirmationController = gateWindows.visualConfirmationController
    this.reviewGate = gateWindows.reviewGate
    this.forkDecisionController = gateWindows.forkDecisionController
    this.prReviewController = gateWindows.prReviewController
    // The review-gate subjects + the two interactive interview gates, built by the sibling
    // factory over the same collaborators (see gate-window-controllers.ts).
    const reviewSubjects = buildReviewSubjects({
      blockRepository,
      executionRepository,
      workRunner,
      stateMachine: this.runStateMachine,
      stepGraph: this.stepGraph,
      executionEventPublisher,
      requirementReviewService,
      clarityReviewService,
      brainstormServices,
      issueWriteback,
      initiativeService,
      initiativeInterviewService,
      docInterviewService,
      logger,
    })
    this.requirementsKind = reviewSubjects.requirementsKind
    this.clarityKind = reviewSubjects.clarityKind
    this.requirementsBrainstormKind = reviewSubjects.requirementsBrainstormKind
    this.architectureBrainstormKind = reviewSubjects.architectureBrainstormKind
    this.initiativeInterviewController = reviewSubjects.initiativeInterviewController
    this.docInterviewController = reviewSubjects.docInterviewController
    // The per-step dispatch + completion spine. Composes the collaborators built above; the
    // merge subgraph stays on the engine, reached only through the injected `resolveRiskPolicy`
    // callback + the MergeResolver (which closes over the engine's `finalizeMerge`). The
    // controllers' `runAgent`/`previewStepModel`/`deployInputs`/`deployContext` closures resolve
    // through `this.runDispatcher` lazily, so this assignment trailing their construction is safe.
    // Keeps the run's verification report on its PR as each step settles (a hook, not a pipeline
    // step; see docs/initiatives/pr-verification-report.md). A no-op when no publisher is wired,
    // so no-VCS deployments and the engine tests are untouched. Assigned as a FIELD rather than
    // inline in the dispatcher literal because the environment lifecycle it reports finishes
    // AFTER the run does: {@link refreshVerificationReport} re-publishes from the teardown path.
    this.prVerificationReport = buildPrReportController(dependencies)
    this.runDispatcher = this.buildRunDispatcher(dependencies, runInitiatorScopeFn)
    this.prMerger = pullRequestMerger
    this.notifications = notificationService
    this.issueWriteback = issueWriteback
    this.log = logger ?? noopLogger
    this.pokeInitiativeLoop = pokeInitiativeLoop
    this.resolveWorkspaceModelDefault = resolveWorkspaceModelDefault
    this.stepDecisions = new StepDecisionController({
      agentExecutor: this.agentExecutor,
      agentKindRegistry: this.agentKindRegistry,
      blockRepository: this.blockRepository,
      clock: this.clock,
      executionRepository: this.executionRepository,
      mergePolicy: this.mergePolicy,
      runDispatcher: this.runDispatcher,
      runStateMachine: this.runStateMachine,
      stepGraph: this.stepGraph,
      workRunner: this.workRunner,
      requireWorkspace: (ws) => this.requireWorkspace(ws),
      requireBlock: (ws, id) => this.requireBlock(ws, id),
      failRun: (ws, id, message, kind, detail, reason) =>
        this.failRun(ws, id, message, kind, detail, reason),
      finalizeMerge: (ws, blockId) => this.finalizeMerge(ws, blockId),
    })
    // The two surfaces a HUMAN drives on a whole run (its lifecycle + the iteration-cap
    // resolution), built as one pair by the sibling factory: the cap gate's `stop-reset` branch is
    // a run cancel, so it is bound to the lifecycle controller there rather than back through this
    // instance. The engine methods they reach into are passed BOUND, as with the gate windows.
    this.runActions = buildRunActionControllers({
      admission: this.admission,
      blockRepository: this.blockRepository,
      clock: this.clock,
      contextBuilder: this.contextBuilder,
      events: this.events,
      executionRepository: this.executionRepository,
      idGenerator: this.idGenerator,
      pipelineRepository: this.pipelineRepository,
      runStateMachine: this.runStateMachine,
      stepGraph: this.stepGraph,
      workRunner: this.workRunner,
      subscriptionActivations: subscriptionActivationRepository,
      logger: this.log,
      // The one merge-policy fact the start path needs, as a bound callback: the lifecycle
      // controller launches runs and has no other business with the preset layer.
      resolveDryRunRoles: async (ws, block) =>
        (await this.mergePolicy.resolve(ws, block)).dryRunRoles,
      requireWorkspace: (ws) => this.requireWorkspace(ws),
      requireBlock: (ws, id) => this.requireBlock(ws, id),
      failRun: (ws, id, message, kind, detail, reason) =>
        this.failRun(ws, id, message, kind, detail, reason),
      inferBlockTechnical: (ws, block, producer, companionStep) =>
        this.inferBlockTechnical(ws, block, producer, companionStep),
    })
  }

  /**
   * Re-compose and re-publish a run's verification report OUT OF BAND, after the run itself has
   * settled.
   *
   * The step-settlement hook cannot close the environment-lifecycle proof on its own: the
   * teardown that completes it is performed by the TTL sweep (or a human destroying the env from
   * the human-test gate), routinely minutes or hours after the last step settled. Without this
   * entry point the report would say "still live" forever about an environment the platform
   * reclaimed on schedule, which inverts the leg's whole point into a standing false alarm.
   *
   * Wired to `EnvironmentTeardownService`'s torn-down hook in the composition root. Best-effort
   * throughout: an unknown run is a silent no-op, and the publish swallows its own failures.
   */
  async refreshVerificationReport(workspaceId: string, executionId: string): Promise<void> {
    const instance = await this.executionRepository.get(workspaceId, executionId)
    if (!instance) return
    await this.prVerificationReport.publishForRun(workspaceId, instance)
  }

  /**
   * Assemble the post-merge board controller. A method rather than a literal in the constructor
   * because everything it reads is already a field by the time it runs, so it needs no destructured
   * parameter threaded through — and the constructor is a god-function against its size budget.
   */
  /**
   * The per-step dispatch + completion spine. Built from the deps OBJECT rather than a
   * hand-maintained forwarding list, for the reason the constructor states: a field dropped from
   * such a list turns a feature off silently. Split out of the constructor purely for size.
   */
  private buildRunDispatcher(
    deps: ExecutionServiceDependencies,
    runInitiatorScopeFn: NonNullable<ExecutionServiceDependencies['runInitiatorScope']>,
  ): RunDispatcher {
    return new RunDispatcher({
      ...deps,
      events: deps.executionEventPublisher,
      spend: deps.spendService,
      stepGraph: this.stepGraph,
      runStateMachine: this.runStateMachine,
      contextBuilder: this.contextBuilder,
      mergeResolver: this.mergeResolver,
      companionController: this.companionController,
      testerController: this.testerController,
      ralphController: this.ralphController,
      humanTestController: this.humanTestController,
      visualConfirmationController: this.visualConfirmationController,
      reviewGate: this.reviewGate,
      forkDecisionController: this.forkDecisionController,
      prReviewController: this.prReviewController,
      requirementsKind: this.requirementsKind,
      clarityKind: this.clarityKind,
      requirementsBrainstormKind: this.requirementsBrainstormKind,
      architectureBrainstormKind: this.architectureBrainstormKind,
      // The interview-gate controllers, dispatched by the `interview-gate` trait keyed on each
      // controller's `agentKind` (a new interviewer wires its controller here — no engine branch).
      interviewControllers: [
        this.initiativeInterviewController,
        this.docInterviewController,
      ].filter((c): c is InitiativeInterviewController | DocInterviewController => !!c),
      prVerificationReport: this.prVerificationReport,
      runInitiatorScope: runInitiatorScopeFn,
      resolveRiskPolicy: (ws, block) => this.resolveRiskPolicy(ws, block),
      modelIdIsMetered: (id, caps) => this.admission.modelIdIsMetered(id, caps),
    })
  }

  private buildPostMergeBoard(): PostMergeBoardController {
    // An explicit host literal, not `this`: the fields below are `private`, which makes the class
    // structurally incompatible with the interface even from inside it.
    const host: PostMergeBoardHost = {
      blockRepository: this.blockRepository,
      pipelineRepository: this.pipelineRepository,
      admission: this.admission,
      board: this.board,
      events: this.events,
    }
    return new PostMergeBoardController(host, {
      // A system-initiated auto-start has no human present to unlock a personal credential, so it
      // reports NO activation and any individual-usage dependent is skipped rather than started.
      resolveIndividualVendors: (ws, modelId, presetId, kinds) =>
        this.resolveIndividualVendors(ws, modelId, presetId, kinds, () => false),
      start: (ws, blockId, pipelineId, opts) => this.start(ws, blockId, pipelineId, opts),
    })
  }

  // ---- gate-window action sub-facades -------------------------------------
  // Per-feature groupings of the dedicated review/test window actions, consumed by the
  // matching server controllers. See {@link gate-window-facades}. The `executionService` is
  // still the single injected object, so the runtimes stay symmetric (no composition-root edit).

  /** Requirements-review window actions (run / incorporate / re-review / proceed / …). */
  get requirementsReview(): RequirementReviewActions {
    this.requirementsReviewActions ??= new RequirementReviewActions(
      this.reviewGate,
      this.requirementsKind,
    )
    return this.requirementsReviewActions
  }

  /** Clarity-review (bug-report triage) window actions. */
  get clarityReview(): ClarityReviewActions {
    this.clarityReviewActions ??= new ClarityReviewActions(this.reviewGate, this.clarityKind)
    return this.clarityReviewActions
  }

  /** Brainstorm (structured-dialogue) window actions, keyed by stage. */
  get brainstorm(): BrainstormActions {
    this.brainstormActions ??= new BrainstormActions(this.reviewGate, (stage) =>
      this.brainstormKindFor(stage),
    )
    return this.brainstormActions
  }

  /** Human-testing gate window actions (confirm / request-fix / pull-main / recreate / destroy). */
  get humanTest(): HumanTestActions {
    return this.humanTestController
  }

  /** Visual-confirmation gate window actions (approve / request-fix / recapture). */
  get visualConfirm(): VisualConfirmActions {
    return this.visualConfirmationController
  }

  /**
   * Interactive-planning interviewer window actions (answer / continue / proceed). Undefined
   * when the interviewer isn't wired (no model / no initiative store) — the server controller
   * then 503s, exactly like the other optional gate windows.
   */
  get initiativeInterview(): InitiativeInterviewController | undefined {
    return this.initiativeInterviewController
  }

  /**
   * Interactive document-interview window actions (answer / continue / proceed). Undefined when
   * the interviewer isn't wired (no model / no session store) — the server controller then 503s,
   * exactly like the other optional gate windows.
   */
  get docInterview(): DocInterviewController | undefined {
    return this.docInterviewController
  }

  private requireWorkspace(workspaceId: string) {
    return requireWorkspace(this.workspaceRepository, workspaceId)
  }

  private async requireBlock(workspaceId: string, id: string): Promise<Block> {
    return assertFound(await this.blockRepository.get(workspaceId, id), 'Block', id)
  }

  /**
   * The individual-usage subscription vendors a run STARTED against `blockId` with
   * `pipelineId` will lease a personal credential for — so the controller can gate the
   * run on the initiator's personal subscription(s) up-front. Mirrors the dispatch-time
   * model precedence (block pin → workspace per-kind default) across every step, AND the
   * per-user dispatch decision: `hasPersonalSubscription(vendor)` reports whether the
   * initiator has their own subscription for a vendor, so a dual-mode model (GLM) only
   * gates a subscriber (a non-subscriber runs it on the Cloudflare base, ungated).
   * Defaults to "no personal subscription" for system/unauthenticated callers.
   */
  async individualVendorsForBlock(
    workspaceId: string,
    blockId: string,
    pipelineId: string,
    hasPersonalSubscription: HasPersonalSubscription = () => false,
  ): Promise<SubscriptionVendor[]> {
    const block = await this.requireBlock(workspaceId, blockId)
    const pipeline = await this.pipelineRepository.get(workspaceId, pipelineId)
    return this.resolveIndividualVendors(
      workspaceId,
      block.modelId,
      block.modelPresetId,
      pipeline?.agentKinds ?? [],
      hasPersonalSubscription,
    )
  }

  /** The individual-usage vendors a failed run's resumed steps use (for the retry gate). */
  async individualVendorsForRun(
    workspaceId: string,
    executionId: string,
    hasPersonalSubscription: HasPersonalSubscription = () => false,
  ): Promise<SubscriptionVendor[]> {
    const run = await this.executionRepository.get(workspaceId, executionId)
    if (!run) return []
    const block = await this.blockRepository.get(workspaceId, run.blockId)
    if (!block) return []
    return this.resolveIndividualVendors(
      workspaceId,
      block.modelId,
      block.modelPresetId,
      run.steps.map((s) => s.agentKind),
      hasPersonalSubscription,
    )
  }

  /**
   * The set of individual-usage vendors the given steps resolve to, used to gate a run
   * on the initiator's personal subscription(s) up-front. Delegates to the pure
   * {@link resolveIndividualVendors}, which mirrors the dispatch-time precedence: a
   * resolvable block pin decides the set alone (NONE for a non-subscription model), and
   * only an unpinned run falls to the workspace per-kind defaults.
   */
  private resolveIndividualVendors(
    workspaceId: string,
    blockModelId: string | undefined,
    modelPresetId: string | undefined,
    agentKinds: string[],
    hasPersonalSubscription: HasPersonalSubscription,
  ): Promise<SubscriptionVendor[]> {
    const resolveDefault = this.resolveWorkspaceModelDefault
    return resolveIndividualVendors(
      blockModelId,
      agentKinds,
      resolveDefault ? (kind) => resolveDefault(workspaceId, kind, modelPresetId) : undefined,
      hasPersonalSubscription,
    )
  }

  /**
   * Advance a single run by exactly one step and report what happened. This is
   * the durable driver's entry point: it reloads the run from storage (so it is
   * safe under replay/retry), no-ops unless the run is actively running, and
   * otherwise performs one agent step via the shared {@link stepInstance} logic.
   */
  async advanceInstance(
    workspaceId: string,
    executionId: string,
    options: AdvanceOptions = {},
  ): Promise<AdvanceResult> {
    try {
      const instance = await this.executionRepository.get(workspaceId, executionId)
      // A paused run is still drivable: the spend gate in stepInstance resumes it
      // once the budget frees up (or re-pauses it otherwise).
      if (!instance || (instance.status !== 'running' && instance.status !== 'paused')) {
        return { kind: 'noop' }
      }
      const result = await this.stepInstance(workspaceId, instance, options)
      // Whenever a run parks waiting for a human, make sure there is an open notification
      // for it — runs no longer time out, so the (escalating) notification is the only
      // signal a human is needed. Best-effort and non-clobbering (see the helper).
      // Conversely, once the run advances past the decision (the human responded, or it
      // auto-passed, or the run reached a terminal state) clear that waiting card so the
      // escalation sweep can't later flip a settled decision red ("Overdue").
      if (result.kind === 'awaiting_decision') {
        await this.runStateMachine.ensureWaitingNotification(workspaceId, instance)
      } else {
        await this.runStateMachine.clearWaitingNotification(workspaceId, instance)
      }
      return result
    } catch (error) {
      // A driver-owned write lost an optimistic-concurrency race (a concurrent human action
      // moved the row, or a cancel/stop removed/terminated it). RE-DRIVE on fresh state rather
      // than clobbering the winner: `continue` re-enters advanceInstance, which reloads and
      // either re-applies the mechanical step on the winning snapshot or no-ops on a
      // gone/terminal run (race-audit 2.2 driver-half / 2.3). Every other error still funnels
      // to the driver's failRun path.
      //
      // `ReviewContendedError` is the same signal from the REVIEW row rather than the run row
      // (race-audit 2.5): the incorporation cycle's mutation carries the output of an LLM call
      // the run has already paid for, so a contended give-up must re-derive it on fresh state
      // rather than fail the run and discard it. The pending decision is still in storage (the
      // instance is only persisted after the cycle settles), so the re-drive re-enters it.
      if (error instanceof RunContendedError || error instanceof ReviewContendedError) {
        return { kind: 'continue' }
      }
      throw error
    }
  }

  /** Advance a single running instance by one step, persisting the result. */
  private async stepInstance(
    workspaceId: string,
    instance: ExecutionInstance,
    options: AdvanceOptions = {},
  ): Promise<AdvanceResult> {
    const step = instance.steps[instance.currentStep]
    if (!step) return { kind: 'noop' }

    // Spend gate: don't incur monetary LLM cost once the budget is exhausted. Pause
    // the run (so the frontend can flag it) and stop here. A previously-paused run
    // that finds the budget has freed up resumes and proceeds. EXEMPTION: a step that
    // incurs no metered monetary cost — a flat-rate subscription (Claude Code / Codex)
    // OR a local-runner model (keyless, on the user's own endpoint) — never contributes
    // to the budget, so it must not be held hostage by a budget other (metered) models
    // exhausted. This is what lets a deliberately local-only / subscription-only workspace
    // keep running at a `0` budget (see the spend-budget docs).
    const budgetAccountId = await this.workspaceRepository.accountOf(workspaceId)
    if (
      await this.spend.isOverBudget(workspaceId, {
        accountId: budgetAccountId,
        userId: instance.initiatedBy,
      })
    ) {
      if (!(await this.runDispatcher.currentStepIsNonMetered(workspaceId, instance, step))) {
        if (instance.status !== 'paused') {
          instance.status = 'paused'
          await this.runStateMachine.casPersist(workspaceId, instance)
          await this.runStateMachine.emitInstance(workspaceId, instance)
          // Surface the pause in the inbox (F3): a `paused` run is invisible to the sweeper and
          // has no auto-resume, so without this card the paused board badge is its only signal.
          await this.runStateMachine.raiseBudgetPaused(workspaceId)
        }
        return { kind: 'paused' }
      }
    }
    if (instance.status === 'paused') instance.status = 'running'

    if (step.state === 'waiting_decision') {
      // Several gates are re-entrant: a human action sets a `pending*` marker on the parked step and
      // wakes the driver, and the step handler must run the (slow) resume work in the durable driver
      // instead of immediately re-parking on its stale decision id. See {@link
      // isReentrantDecisionResume} for the per-gate cases.
      if (!isReentrantDecisionResume(step, this.agentKindRegistry)) {
        // Parked on either an agent-raised decision or a human approval gate; both
        // are addressed by the same durable event id.
        const pendingId = step.decision?.id ?? step.approval?.id
        if (pendingId) {
          instance.status = 'blocked'
          await this.runStateMachine.casPersist(workspaceId, instance)
          await this.runStateMachine.emitInstance(workspaceId, instance)
          return { kind: 'awaiting_decision', decisionId: pendingId }
        }
      }
    }
    this.stepGraph.startStep(step)

    const block = await this.blockRepository.get(workspaceId, instance.blockId)
    if (!block) return { kind: 'noop' }
    const isFinalStep = instance.currentStep === instance.steps.length - 1

    // Estimate gating: a step gated on the task estimate is transparently SKIPPED when the
    // estimate — written by an earlier task-estimator step in this same run — falls below the
    // threshold. No agent is spun up; the step finishes as `skipped` and the run advances.
    // Evaluated here (not at build time) because the estimate only exists once the estimator
    // step has run.
    //
    // A COMPANION whose producer was skipped is skipped for the second reason: with producers
    // now gatable, it would otherwise grade whatever step happens to precede it. Checked
    // alongside its own gate because either reason is sufficient and they need not agree — a
    // companion with no gate of its own still cascades.
    const gatedOut = step.gating?.enabled && !shouldRunGatedStep(block.estimate, step.gating)
    if (gatedOut || producerWasSkipped(instance.steps, instance.currentStep)) {
      return this.runDispatcher.skipGatedStep(workspaceId, instance, step, isFinalStep)
    }

    // The fixed run-lifecycle preamble is done; hand the per-kind work to the
    // engine-internal StepHandler registry (the first handler whose `canHandle` claims
    // this step). See {@link dispatchStepHandler} / {@link handleAgentStep}.
    return this.runDispatcher.dispatchStepHandler({
      workspaceId,
      instance,
      step,
      block,
      isFinalStep,
      options,
    })
  }

  // ---- durable-driver + follow-up pass-throughs ---------------------------
  // The durable drivers (Cloudflare ExecutionWorkflow / Node driveExecution) and the
  // FollowUpController call these on `executionService`; the per-step dispatch + completion
  // spine + the follow-up companion gate live on {@link RunDispatcher}, so these are thin
  // delegations (the public API is unchanged by the extraction).

  /** @see RunDispatcher.pollAgentJob */
  pollAgentJob(workspaceId: string, executionId: string): Promise<AdvanceResult> {
    return this.runDispatcher.pollAgentJob(workspaceId, executionId)
  }

  /** @see RunDispatcher.pollGate */
  pollGate(workspaceId: string, executionId: string): Promise<AdvanceResult> {
    return this.runDispatcher.pollGate(workspaceId, executionId)
  }

  /** @see JudgeStepController.getActive */
  getJudgeState(workspaceId: string, executionId: string): Promise<JudgeStepState | null> {
    return this.runDispatcher.getJudgeState(workspaceId, executionId)
  }

  /**
   * Resolve a parked JUDGE step (proceed / bounce / stop) — the SINGLE service method behind
   * both the SPA controller and the public API's decisions surface, so the park's CAS +
   * approval-id arbitration applies identically whichever surface answers first.
   * @see JudgeStepController.resolveDecision
   */
  resolveJudgeDecision(
    workspaceId: string,
    executionId: string,
    input: ResolveJudgeInput,
  ): Promise<JudgeStepState> {
    return this.runDispatcher.resolveJudgeDecision(workspaceId, executionId, input)
  }

  /**
   * Every registered judge (kind + rubric + presentation), for the workspace-snapshot palette
   * projection — the judge counterpart of `agentKindRegistry.all()`.
   */
  registeredJudges(): JudgeDefinition[] {
    return this.runDispatcher.registeredJudges()
  }

  /** @see RunDispatcher.resolveGatePollExhaustion */
  resolveGatePollExhaustion(workspaceId: string, executionId: string): Promise<AdvanceResult> {
    return this.runDispatcher.resolveGatePollExhaustion(workspaceId, executionId)
  }

  /** @see RunDispatcher.getFollowUps */
  getFollowUps(workspaceId: string, executionId: string): Promise<FollowUpsStepState | null> {
    return this.runDispatcher.getFollowUps(workspaceId, executionId)
  }

  /** @see RunDispatcher.getForkDecision */
  getForkDecision(workspaceId: string, executionId: string): Promise<ForkDecisionStepState | null> {
    return this.runDispatcher.getForkDecision(workspaceId, executionId)
  }

  /** @see RunDispatcher.chooseFork */
  chooseFork(
    workspaceId: string,
    executionId: string,
    input: ChooseForkInput,
  ): Promise<ForkDecisionStepState> {
    return this.runDispatcher.chooseFork(workspaceId, executionId, input)
  }

  /** @see RunDispatcher.forkChat */
  forkChat(
    workspaceId: string,
    executionId: string,
    input: ForkChatRequestInput,
  ): Promise<ForkDecisionStepState> {
    return this.runDispatcher.forkChat(workspaceId, executionId, input)
  }

  /** @see RunDispatcher.getPrReview */
  getPrReview(workspaceId: string, executionId: string): Promise<PrReviewStepState | null> {
    return this.runDispatcher.getPrReview(workspaceId, executionId)
  }

  /** @see RunDispatcher.resolvePrReview */
  resolvePrReview(
    workspaceId: string,
    executionId: string,
    input: ResolvePrReviewInput,
  ): Promise<PrReviewStepState> {
    return this.runDispatcher.resolvePrReview(workspaceId, executionId, input)
  }

  /** @see RunDispatcher.resumePrReview */
  resumePrReview(workspaceId: string, executionId: string): Promise<PrReviewStepState> {
    return this.runDispatcher.resumePrReview(workspaceId, executionId)
  }

  /** @see RunDispatcher.dismissPrReviewFinding */
  dismissPrReviewFinding(
    workspaceId: string,
    executionId: string,
    findingId: string,
  ): Promise<PrReviewStepState> {
    return this.runDispatcher.dismissPrReviewFinding(workspaceId, executionId, findingId)
  }

  /** @see RunDispatcher.challengePrReviewFinding */
  challengePrReviewFinding(
    workspaceId: string,
    executionId: string,
    findingId: string,
    input: ChallengePrReviewFindingInput,
  ): Promise<PrReviewStepState> {
    return this.runDispatcher.challengePrReviewFinding(workspaceId, executionId, findingId, input)
  }

  /** @see RunDispatcher.fileFollowUp */
  fileFollowUp(
    workspaceId: string,
    executionId: string,
    itemId: string,
  ): Promise<FollowUpsStepState> {
    return this.runDispatcher.fileFollowUp(workspaceId, executionId, itemId)
  }

  /** @see RunDispatcher.queueFollowUp */
  queueFollowUp(
    workspaceId: string,
    executionId: string,
    itemId: string,
  ): Promise<FollowUpsStepState> {
    return this.runDispatcher.queueFollowUp(workspaceId, executionId, itemId)
  }

  /** @see RunDispatcher.answerFollowUp */
  answerFollowUp(
    workspaceId: string,
    executionId: string,
    itemId: string,
    answer: string,
  ): Promise<FollowUpsStepState> {
    return this.runDispatcher.answerFollowUp(workspaceId, executionId, itemId, answer)
  }

  /** @see RunDispatcher.dismissFollowUp */
  dismissFollowUp(
    workspaceId: string,
    executionId: string,
    itemId: string,
  ): Promise<FollowUpsStepState> {
    return this.runDispatcher.dismissFollowUp(workspaceId, executionId, itemId)
  }

  /**
   * Infer + persist the block's `technical` label from the settled spec phase (item 5):
   * combine the spec-writer's `noBusinessSpecs` determination (recorded on the producer
   * step) with the spec-companion's `technicalCorroborated` verdict (recorded on the
   * companion step). Driven both on the companion's automatic convergence and on a human
   * "proceed" past the iteration cap, since both signals live on the persisted steps. An
   * already-determined value is authoritative and is NEVER re-inferred (the pure
   * {@link inferTechnicalLabel} returns `undefined` then). Best-effort: the label is a
   * convenience (re-inferable, and human-overridable), so a persistence hiccup must NOT
   * wedge the run — a failed write is swallowed.
   */
  private async inferBlockTechnical(
    workspaceId: string,
    block: Block,
    producerStep: PipelineStep,
    companionStep: PipelineStep,
  ): Promise<void> {
    const technical = inferTechnicalLabel(
      block.technical,
      producerStep.noBusinessSpecs === true,
      companionStep.technicalCorroborated,
    )
    if (technical === undefined) return
    await runBestEffort(
      this.log,
      'block.updateTechnicalSummary',
      () => this.blockRepository.update(workspaceId, block.id, { technical }),
      { workspaceId, blockId: block.id },
    )
  }

  // ---- iterative review gates (requirements + clarity) --------------------
  // The two gate flows live in {@link ReviewGateController}, parameterised by a
  // {@link ReviewKind}. The public methods below are thin delegators (the HTTP controllers
  // call them) and the kind builders supply each subject's differentiators. Three shared
  // state-machine primitives stay here — they are reused by the generic approval path and
  // the companion iteration-cap gate, so they have a single home: {@link parkStepOnDecision},
  // the `advanceRunPastGate`/`settleAdvancedGate` split (run under `mutateInstance`), and
  // {@link dispatchIterationCap}.

  /** Pick the brainstorm kind for a stage (the dedicated window drives both via the same loop). */
  private brainstormKindFor(stage: BrainstormStage): ReviewKind<BrainstormSession> {
    return stage === 'architecture'
      ? this.architectureBrainstormKind
      : this.requirementsBrainstormKind
  }

  /** @see IterationCapController.resolveCompanionExceeded */
  resolveCompanionExceeded(
    workspaceId: string,
    executionId: string,
    approvalId: string,
    choice: IterationCapChoice,
  ): Promise<ExecutionInstance> {
    return this.runActions.iterationCap.resolveCompanionExceeded(
      workspaceId,
      executionId,
      approvalId,
      choice,
    )
  }

  // The clarity / human-testing / visual-confirmation gate-window actions now live on the
  // per-feature sub-facades (`clarityReview` / `humanTest` / `visualConfirm`); see the getters
  // above and {@link gate-window-facades}.

  /**
   * Merge a block's PR(s) for real, then mark it `done`. The remote merge happens FIRST (via
   * the {@link PullRequestMerger} port) and only on its success does the block flip to `done`
   * — so `done` provably means "merged", not a board-only status. When no merger is wired
   * (tests) this degrades to the old board-only flip.
   *
   * Multi-repo (service-connections phase 4): a cross-service task opens one PR per changed
   * repo. All of them are merged in provider-before-consumer order (see {@link orderPrsForMerge}),
   * stopping at the first failure. A COMPLETE failure (nothing merged) THROWS so the caller
   * falls back to a review notification, exactly as the single-repo path did. A PARTIAL failure
   * (some merged, then one failed — cross-repo merges are non-atomic) leaves the block `blocked`
   * and raises an enumerated `merge_review` notification, and is reported to the caller as
   * `partial` so it labels the decision without raising a second card.
   */
  private async finalizeMerge(workspaceId: string, blockId: string): Promise<FinalizeMergeResult> {
    const block = await this.blockRepository.get(workspaceId, blockId)
    if (!block) return { kind: 'merged' }
    // Idempotent under durable-driver replays: a crash between the real merge and the
    // instance persist re-runs the merger resolver, and re-merging an already-merged PR
    // throws — which the resolver's fall-through would then misread as a failed merge
    // and downgrade the block to `pr_ready`. `done` already means "merged"; keep it.
    if (block.status === 'done') return { kind: 'merged' }
    // Same idempotency guard for a PARTIALLY-merged multi-repo task: the first pass merged some
    // PRs, then one failed, so it left the block `blocked` and raised the enumerated card. A
    // durable-driver replay must NOT re-run the merge — re-merging the already-merged PRs throws
    // (GitHub 405) and would be misread as a TOTAL failure (`merged.length === 0` → throw → the
    // resolver downgrades the block to `pr_ready` + raises a SECOND card). The merger step only
    // ever enters `finalizeMerge` on an already-`blocked` block on such a replay (the manual
    // `mergePr` path gates on `pr_ready`), so return the already-recorded partial outcome.
    if (block.status === 'blocked') return { kind: 'partial', merged: [], unmerged: [] }
    // Merge every PR the task opened (own-service + peers) — not just `block.pullRequest`, since a
    // multi-repo task can have changed ONLY peer repos (own service untouched, no own PR).
    const ordered = orderPrsForMerge(
      allPullRequests(block).map((p) => ({
        ...(p.repo ? { repo: p.repo } : {}),
        ...(p.frameId ? { frameId: p.frameId } : {}),
        ref: p.ref,
      })),
    )
    if (this.prMerger && ordered.length > 0) {
      const outcome = await this.prMerger.mergePullRequests(workspaceId, blockId, ordered)
      if (outcome.failed) {
        // Nothing merged → behave like the old single-PR throw so the caller raises a review.
        if (outcome.merged.length === 0) throw new Error(outcome.failed.error)
        // Partial: leave the block blocked and enumerate the split for a human to finish/revert.
        const label = (e: { repo?: string }): string => e.repo ?? 'own service'
        const merged = outcome.merged.map(label)
        const unmerged = [outcome.failed.entry, ...outcome.skipped].map(label)
        await this.blockRepository.update(workspaceId, blockId, { status: 'blocked' })
        await this.raisePartialMergeNotification(workspaceId, block, merged, unmerged)
        return { kind: 'partial', merged, unmerged }
      }
    }
    await this.blockRepository.update(workspaceId, blockId, { status: 'done', progress: 1 })
    // Best-effort writeback: comment + close the task's linked tracker issue(s) as
    // resolved now the PR is merged. Gated inside the provider by the workspace
    // setting + per-task override; fire-and-forget so a tracker outage never fails
    // the run (the merge already happened).
    if (this.issueWriteback && block.pullRequest) {
      await runBestEffort(
        this.log,
        'issueWriteback.onPullRequestMerged',
        () => this.issueWriteback!.onPullRequestMerged(workspaceId, block, block.pullRequest!),
        { workspaceId, blockId },
      )
    }
    if ((block.level ?? 'frame') === 'task') {
      await this.applyModuleAssignment(workspaceId, blockId)
      // Propagate to dependents: if this task opted into auto-start, launch every task
      // that depends on it whose other dependencies are now also done. Best-effort — the
      // merge already happened, so a dependent that fails to start must never roll it back.
      if (block.autoStartDependents) {
        // The consequential one: a swallow here means dependent tasks silently never start,
        // and "the board just stopped moving" is the only symptom a user ever sees.
        await runBestEffort(
          this.log,
          'execution.autoStartDependents',
          () => this.autoStartDependents(workspaceId, blockId),
          { workspaceId, blockId },
        )
      }
      // A spawned initiative task's PR merging pokes its owning initiative's loop so it
      // reconciles the item + spawns the next wave immediately (the manual-merge path, which
      // doesn't emit a terminal run event). Fire-and-forget; the sweep is the backstop.
      if (block.initiativeId) this.pokeInitiativeLoop?.(workspaceId, block.initiativeId)
    }
    return { kind: 'merged' }
  }

  /**
   * Raise the `merge_review` card for a PARTIALLY-merged multi-repo task: some PRs merged, then
   * an intermediate one failed. Cross-repo merges can't be atomic, so the human finishes or
   * reverts the split by hand; the card enumerates which repos merged vs are still open.
   */
  private async raisePartialMergeNotification(
    workspaceId: string,
    block: Block,
    merged: string[],
    unmerged: string[],
  ): Promise<void> {
    if (!this.notifications) return
    await this.notifications.raise(workspaceId, {
      type: 'merge_review',
      blockId: block.id,
      executionId: block.executionId ?? null,
      title: `Finish the multi-repo merge for "${block.title}"`,
      body:
        `Merged ${merged.length} PR(s) (${merged.join(', ')}) but could not merge ` +
        `${unmerged.length} more (${unmerged.join(', ')}). Cross-repo merges aren't atomic — ` +
        `merge the rest or revert the merged PR(s) by hand.`,
      payload: {
        mergedRepos: merged,
        unmergedRepos: unmerged,
        ...(block.pullRequest?.url ? { prUrl: block.pullRequest.url } : {}),
      },
    })
  }

  /**
   * Start the dependents a merged task was blocking. Delegates to
   * {@link PostMergeBoardController}; the skip rules live there.
   */
  private autoStartDependents(workspaceId: string, mergedBlockId: string): Promise<void> {
    return this.postMergeBoard.autoStartDependents(workspaceId, mergedBlockId)
  }

  /**
   * Resolve the merge threshold preset that governs a task — delegated to {@link RunMergePolicy}
   * (preset resolution + its cache read-through live there, alongside the track-record settle).
   */
  private resolveRiskPolicy(workspaceId: string, block: Block): Promise<ResolvedRunRiskPolicy> {
    return this.mergePolicy.resolve(workspaceId, block)
  }

  /**
   * Materialise the module a merged task was assigned to. Delegates to
   * {@link PostMergeBoardController}.
   */
  private applyModuleAssignment(workspaceId: string, taskId: string): Promise<void> {
    return this.postMergeBoard.applyModuleAssignment(workspaceId, taskId)
  }

  // ---- human decision surface (delegated) ---------------------------------
  // Resolve / approve / request-changes / reject / merge and the human-review fix request all
  // live on {@link StepDecisionController} — the decisions PEOPLE make about a parked run, as
  // opposed to the engine's own advance path. These stay here as thin delegates because the HTTP
  // + public-API controllers reach them through the engine facade.

  /** Resolve a pending decision; the run's next step lets the agent finish it. */
  resolveDecision(
    workspaceId: string,
    executionId: string,
    decisionId: string,
    choice: string,
  ): Promise<ExecutionInstance> {
    return this.stepDecisions.resolveDecision(workspaceId, executionId, decisionId, choice)
  }

  /** Approve a step's gated proposal (optionally replacing it with the human's edit). */
  approveStep(
    workspaceId: string,
    executionId: string,
    approvalId: string,
    opts: { proposal?: string } = {},
  ): Promise<ExecutionInstance> {
    return this.stepDecisions.approveStep(workspaceId, executionId, approvalId, opts)
  }

  /** Request changes on a step's gated proposal; the step re-runs with the feedback folded in. */
  requestStepChanges(
    workspaceId: string,
    executionId: string,
    approvalId: string,
    review: { feedback?: string; comments?: StepReviewComment[] },
  ): Promise<ExecutionInstance> {
    return this.stepDecisions.requestStepChanges(workspaceId, executionId, approvalId, review)
  }

  /** Reject a step's gated proposal; the run stops with a `rejected` failure. */
  rejectStep(
    workspaceId: string,
    executionId: string,
    approvalId: string,
    reason?: string,
  ): Promise<ExecutionInstance> {
    return this.stepDecisions.rejectStep(workspaceId, executionId, approvalId, reason)
  }

  /** Dispatch the human-review gate's fixer from a human's freeform instructions. */
  requestHumanReviewFix(
    workspaceId: string,
    blockId: string,
    instructions: string,
  ): Promise<ExecutionInstance> {
    return this.stepDecisions.requestHumanReviewFix(workspaceId, blockId, instructions)
  }

  /** Merge an open PR for real, moving the block from `pr_ready` to `done`. */
  mergePr(
    workspaceId: string,
    blockId: string,
    reviewEffort?: ReviewEffort | null,
  ): Promise<Block> {
    return this.stepDecisions.mergePr(workspaceId, blockId, reviewEffort)
  }

  /** Record that a human DECLINED to merge (the review card was dismissed, not acted on). */
  recordMergeRejection(workspaceId: string, executionId: string): Promise<void> {
    return this.stepDecisions.recordMergeRejection(workspaceId, executionId)
  }

  /**
   * Record a terminal agent failure: persist a structured {@link AgentFailure},
   * flip the run to `failed`, and mark the block `blocked` (needs attention) — NOT
   * `pr_ready`, which looked like success and hid the failure. The board then
   * renders the same failure banner + retry as a failed bootstrap. Called by the
   * durable driver once a step has exhausted its retries (or a job/decision
   * faulted); `kind` classifies the cause so the right hint is shown.
   */
  failRun(
    workspaceId: string,
    executionId: string,
    message: string,
    kind: AgentFailureKind = 'agent',
    detail: string | null = null,
    reason: string | null = null,
  ): Promise<void> {
    return this.runStateMachine.failRun(workspaceId, executionId, message, kind, detail, reason)
  }

  // ---- run-lifecycle pass-throughs ----------------------------------------
  // Launching, re-launching, resuming and ending a run all live on
  // {@link RunLifecycleController} (they share the claim-then-hand-off order documented there);
  // these thin delegations keep this service the single surface the HTTP layer talks to.

  /** @see RunLifecycleController.start */
  start(
    workspaceId: string,
    blockId: string,
    pipelineId: string,
    options: RunStartOptions = {},
  ): Promise<ExecutionInstance> {
    return this.runActions.lifecycle.start(workspaceId, blockId, pipelineId, options)
  }

  /** @see RunLifecycleController.retry */
  retry(
    workspaceId: string,
    executionId: string,
    initiatedBy?: string | null,
    activate?: (executionId: string) => Promise<void>,
  ): Promise<ExecutionInstance> {
    return this.runActions.lifecycle.retry(workspaceId, executionId, initiatedBy, activate)
  }

  /** @see RunLifecycleController.restartFromStep */
  restartFromStep(
    workspaceId: string,
    executionId: string,
    fromStepIndex: number,
    initiatedBy?: string | null,
    activate?: (executionId: string) => Promise<void>,
  ): Promise<ExecutionInstance> {
    return this.runActions.lifecycle.restartFromStep(
      workspaceId,
      executionId,
      fromStepIndex,
      initiatedBy,
      activate,
    )
  }

  /** @see RunLifecycleController.resumePaused */
  resumePaused(workspaceId: string): Promise<ExecutionInstance[]> {
    return this.runActions.lifecycle.resumePaused(workspaceId)
  }

  /** @see RunLifecycleController.cancel */
  cancel(workspaceId: string, blockId: string): Promise<Block> {
    return this.runActions.lifecycle.cancel(workspaceId, blockId)
  }

  /** @see RunLifecycleController.stopRun */
  stopRun(
    workspaceId: string,
    executionId: string,
    opts: { reason?: string; kind?: AgentFailureKind } = {},
  ): Promise<ExecutionInstance> {
    return this.runActions.lifecycle.stopRun(workspaceId, executionId, opts)
  }

  /** @see RunLifecycleController.teardownForBlockTree */
  teardownForBlockTree(workspaceId: string, rootId: string): Promise<PreloadedBlocks> {
    return this.runActions.lifecycle.teardownForBlockTree(workspaceId, rootId)
  }
}
