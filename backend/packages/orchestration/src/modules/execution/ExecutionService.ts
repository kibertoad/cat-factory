import type {
  JudgeDefinition,
  JudgeStepState,
  ResolveJudgeInput,
  AgentFailureKind,
  Block,
  ExecutionInstance,
  PipelineStep,
  PullRequestMerger,
  GateActor,
  StepReviewComment,
  IssueWritebackProvider,
  Logger,
  InputGateInput,
  ResolveInputGateChoice,
  RunInputGate,
} from '@cat-factory/kernel'
import { allPullRequests } from '@cat-factory/contracts'
import type { PrVerificationReport, RunOutcome, ServiceSpecView } from '@cat-factory/contracts'
import type { AgentKindRegistry } from '@cat-factory/agents'
import type { RunStartOptions } from './runStartOptions.js'
import type { HasPersonalSubscription } from './runVendorGate.js'
import { createRunVendorGate, type RunVendorGate } from './runVendorGate.js'
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
import { type ReviewKind } from './ReviewGateController.js'
import { runStepPreamble, type StepPreambleDeps } from './stepPreamble.js'
import { resolveScopeForRun } from './runServiceScope.js'
import type { InputGateController } from './InputGateController.js'
import {
  type GateWindowControllerDeps,
  buildGateWindowControllers,
  buildInputGateController,
  buildReviewSubjects,
} from './gate-window-controllers.js'
import { buildRunContextAndAdmission } from './run-context-admission.js'
import { runDecisionSurfaces, type RunDecisionSurfaces } from './run-decision-surfaces.js'
import {
  BrainstormActions,
  ClarityReviewActions,
  type HumanTestActions,
  RequirementReviewActions,
  type VisualConfirmActions,
} from './gate-window-facades.js'
import type { NotificationService } from '../notifications/NotificationService.js'
import { InitiativeInterviewController } from './InitiativeInterviewController.js'
import { DocInterviewController } from './DocInterviewController.js'
import type { InterviewGate } from './InterviewGateController.js'
import type { InitiativeRunHarvest } from '../initiative/initiative.logic.js'
import type {
  IterationCapChoice,
  RequirementReview,
  ClarityReview,
  BrainstormSession,
  BrainstormStage,
} from '@cat-factory/kernel'
import type { BlockRepository, ExecutionRepository, WorkspaceRepository } from '@cat-factory/kernel'
import type { Clock, IdGenerator, PreloadedBlocks } from '@cat-factory/kernel'
import type { AgentExecutor } from '@cat-factory/kernel'
import type { ReviewEffort } from '@cat-factory/kernel'
import { RunMergePolicy } from './RunMergePolicy.js'
import type { ResolvedRunRiskPolicy, RunPolicyScope } from './policy-types.js'
import type { WorkRunner } from '@cat-factory/kernel'
import type { ExecutionEventPublisher } from '@cat-factory/kernel'
import type { BoardService } from '../board/BoardService.js'
import type { SpendService } from '@cat-factory/spend'
import { requireWorkspace } from '@cat-factory/kernel'
import type { AdvanceOptions, AdvanceResult } from './advance.js'
import type { ExecutionServiceDependencies } from './ExecutionServiceDependencies.js'
import { createPipelineAdoption, type PipelineAdoption } from '../pipelines/pipelineAdoption.js'
import type { RunSpecRead } from './RunEvidenceLoader.js'
import { RunEvidenceReads } from './RunEvidenceReads.js'
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

/**
 * The engine's logger, normalised. A helper rather than a `this.log` read, because a collaborator
 * built mid-constructor captures the logger by VALUE into its own dependency literal, and `this.log`
 * is assigned partway down: reading the field from a factory that runs before that line hands the
 * collaborator `undefined` and turns its first best-effort warn into a `TypeError`. One normalisation
 * site, reachable from anywhere in the construction sequence.
 */
function engineLogger(deps: ExecutionServiceDependencies): Logger {
  return deps.logger ?? noopLogger
}

/**
 * How a run resolves its pipeline: the workspace's stored row, else the catalog entry the board was
 * never seeded with, ADOPTED so every other surface can see what ran
 * (`pipelines/pipelineAdoption.ts`). A reusable operation pins its pipeline by id, so a board older
 * than the registration would otherwise refuse to start a task it happily created.
 *
 * A sibling factory rather than an inline call for the reason {@link buildPrReportController} is
 * one: the constructor is at its per-function line budget, and a budget is a split trigger.
 */
function buildPipelineAdoption(deps: ExecutionServiceDependencies): PipelineAdoption {
  return createPipelineAdoption({
    pipelineRepository: deps.pipelineRepository,
    pipelineRegistry: deps.pipelineRegistry,
    operationalMetrics: deps.operationalMetrics,
    logger: deps.logger,
  })
}

export class ExecutionService {
  private readonly workspaceRepository: WorkspaceRepository
  private readonly blockRepository: BlockRepository
  private readonly pipelineAdoption: PipelineAdoption
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
  /**
   * The controllers behind the run's gates and dedicated park windows, as ONE bundle rather than
   * one field each: the Tester fix loop, the Ralph loop, the human-testing and
   * visual-confirmation gates, both iterative review gates, the implementation-fork decision, the
   * PR deep-review and the generated-candidate comparison. The family grows with every park
   * surface, and a field plus an assignment per member spends two lines of this class's budget on
   * a value that is only ever forwarded. See {@link buildGateWindowControllers}.
   */
  private readonly gateWindows: ReturnType<typeof buildGateWindowControllers>
  /** The pre-dispatch input gate; see {@link InputGateController}. */
  private readonly inputGate: InputGateController
  /** Bound collaborators for the shared pre-dispatch preamble ({@link runStepPreamble}). */
  private stepPreambleDepsCache?: StepPreambleDeps
  /** The three doors onto "what personal subscriptions would a run started here lease". */
  private vendorGateCache?: RunVendorGate
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
      documentRepository,
      llmObservability,
      pullRequestMerger,
      riskPolicyReader,
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
    this.pipelineAdoption = buildPipelineAdoption(dependencies)
    this.executionRepository = executionRepository
    this.idGenerator = idGenerator
    this.clock = clock
    this.stepGraph = new StepGraph(clock, agentKindRegistry)
    // The task's merge POLICY (which preset governs a run) + the EVIDENCE behind it (settling the
    // run's merge track record when a human merges or declines), extracted as one collaborator so
    // neither concern re-accretes onto the engine.
    this.mergePolicy = new RunMergePolicy({
      riskPolicyReader,
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
    this.postMergeBoard = this.buildPostMergeBoard(dependencies)
    this.mergeResolver = new MergeResolver({
      blockRepository,
      notificationService,
      mergeTrackRecord,
      resolveRiskPolicy: (ws, block, run) => this.resolveRiskPolicy(ws, block, run),
      finalizeMerge: (ws, blockId) => this.finalizeMerge(ws, blockId),
    })
    this.companionController = new CompanionController({
      contextBuilder: this.contextBuilder,
      agentKindRegistry,
      spend: spendService,
      idGenerator,
      previewStepModel: (ctx) => this.runDispatcher.previewStepModel(ctx),
      previewStepToolServers: (ctx) => this.runDispatcher.previewStepToolServers(ctx),
      runAgent: (ctx, opts) => this.runDispatcher.runAgent(ctx, opts),
      stateMachine: this.runStateMachine,
      stepGraph: this.stepGraph,
      resolveRiskPolicy: (ws, block, run) => this.resolveRiskPolicy(ws, block, run),
      ...(dependencies.logger ? { logger: dependencies.logger } : {}),
      inferTechnicalLabel: (ws, block, producer, companionStep) =>
        this.inferBlockTechnical(ws, block, producer, companionStep),
    })
    // The human-gate window controllers (Tester / Ralph / human-test / visual-confirmation /
    // review / fork-decision / PR-review / bug-fishing), built by the sibling factory over one
    // deps bundle. Assembled in its own method for the reason {@link buildRunDispatcher} is: the
    // constructor is against its per-function line budget, and a budget is a split trigger.
    const gateWindows = this.buildGateWindows(dependencies, {
      blockRepository,
      executionRepository,
      workRunner,
      agentExecutor,
      notificationService,
      idGenerator,
      clock,
      testerQualityReviewer,
      environmentProvisioning,
      environmentTeardown,
      branchUpdater,
      resolveBinaryArtifactStore,
      documentRepository,
      forkChatService,
      issueWriteback,
      logger,
      executionEventPublisher,
    })
    this.gateWindows = gateWindows
    // The pre-dispatch input gate: not a gate WINDOW (it guards the run's first dispatch and has no
    // pipeline step of its own), so it has its own factory over the same dependency bag.
    this.inputGate = buildInputGateController(dependencies, {
      stateMachine: this.runStateMachine,
      stepGraph: this.stepGraph,
    })
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
      initiativeService,
      initiativeInterviewService,
      docInterviewService,
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
    this.log = engineLogger(dependencies)
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
      agentKindRegistry: this.agentKindRegistry,
      blockRepository: this.blockRepository,
      clock: this.clock,
      contextBuilder: this.contextBuilder,
      events: this.events,
      executionRepository: this.executionRepository,
      idGenerator: this.idGenerator,
      pipelineAdoption: this.pipelineAdoption,
      runStateMachine: this.runStateMachine,
      stepGraph: this.stepGraph,
      workRunner: this.workRunner,
      subscriptionActivations: subscriptionActivationRepository,
      logger: this.log,
      // The two policy facts the start path needs, each as a bound callback: the lifecycle
      // controller launches runs and has no other business with the preset layer. Both read
      // through the same cached resolution the engine uses everywhere else.
      resolveDryRunRoles: async (ws, block, run) =>
        (await this.mergePolicy.resolve(ws, block, run)).dryRunRoles,
      resolveCompanionReworkBudget: async (ws, block, run) =>
        (await this.mergePolicy.resolve(ws, block, run)).companionMaxReworks,
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
   * The run-EVIDENCE reads, resolved by run id: the verification report, the outcome summary, and
   * the `spec/` they join against, that last one both folded (for the SPA's card) and with the
   * outcome of the read kept (for `GET /api/v1/runs/:runId/spec`). Thin delegates onto
   * {@link RunEvidenceReads}, which owns the one thing they must never disagree about (what "this
   * run" resolves to).
   */
  private readonly evidenceReads = new RunEvidenceReads({
    getInstance: (workspaceId, executionId) =>
      this.executionRepository.get(workspaceId, executionId),
    composeReport: (workspaceId, instance) =>
      this.prVerificationReport.composeForRun(workspaceId, instance),
    composeOutcome: (workspaceId, instance) =>
      this.prVerificationReport.composeOutcomeForRun(workspaceId, instance),
    readSpec: (workspaceId, instance) =>
      this.prVerificationReport.readRunSpec(workspaceId, instance),
    readSpecOutcome: (workspaceId, instance) =>
      this.prVerificationReport.readRunSpecOutcome(workspaceId, instance),
  })

  /** The read behind `GET /api/v1/runs/:runId/report`. */
  async composeVerificationReport(
    workspaceId: string,
    executionId: string,
  ): Promise<PrVerificationReport | null> {
    return this.evidenceReads.report(workspaceId, executionId)
  }

  /** The read behind `GET /api/v1/runs/:runId/outcome`. */
  async composeRunOutcome(workspaceId: string, executionId: string): Promise<RunOutcome | null> {
    return this.evidenceReads.outcome(workspaceId, executionId)
  }

  /** The read behind `GET /workspaces/:ws/executions/:executionId/spec` (the outcome card). */
  async readRunSpec(workspaceId: string, executionId: string): Promise<ServiceSpecView | null> {
    return this.evidenceReads.spec(workspaceId, executionId)
  }

  /**
   * The read behind `GET /api/v1/runs/:runId/spec`: the same tree as {@link readRunSpec}, with the
   * outcome of the read kept rather than folded onto an empty view.
   */
  async readRunSpecOutcome(workspaceId: string, executionId: string): Promise<RunSpecRead | null> {
    return this.evidenceReads.specRead(workspaceId, executionId)
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
  /**
   * Assemble the human-gate window controllers. A method rather than a literal in the constructor
   * for the reason {@link ExecutionService.buildRunDispatcher} is one: the constructor is against
   * its per-function line budget, and that budget is a split trigger rather than a number to
   * raise. `leaves` carries the values the constructor destructured out of `deps` (they are not
   * yet fields when this runs); the engine methods the controllers reach back into are passed
   * BOUND, so every closure still resolves against this instance exactly as it did inline.
   */
  private buildGateWindows(
    deps: ExecutionServiceDependencies,
    leaves: Pick<
      GateWindowControllerDeps,
      | 'blockRepository'
      | 'executionRepository'
      | 'workRunner'
      | 'agentExecutor'
      | 'notificationService'
      | 'idGenerator'
      | 'clock'
      | 'testerQualityReviewer'
      | 'environmentProvisioning'
      | 'environmentTeardown'
      | 'branchUpdater'
      | 'resolveBinaryArtifactStore'
      | 'documentRepository'
      | 'forkChatService'
      | 'issueWriteback'
      | 'logger'
    > & { executionEventPublisher: ExecutionServiceDependencies['executionEventPublisher'] },
  ): ReturnType<typeof buildGateWindowControllers> {
    return buildGateWindowControllers({
      ...leaves,
      contextBuilder: this.contextBuilder,
      stateMachine: this.runStateMachine,
      stepGraph: this.stepGraph,
      clockNow: () => this.clock.now(),
      resolveRiskPolicy: (ws, block, run) => this.resolveRiskPolicy(ws, block, run),
      dispatchIterationCap: (ws, blockId, choice, handlers) =>
        this.runActions.iterationCap.dispatchIterationCap(ws, blockId, choice, handlers),
      pipelineRepository: deps.pipelineRepository,
      workspaceSettingsRepository: deps.workspaceSettingsRepository,
      serviceRepository: deps.serviceRepository,
      taskTypeRegistry: deps.taskTypeRegistry,
      promptFragmentSource: deps.promptFragmentSource,
      events: leaves.executionEventPublisher,
      // Bound, so a bug-fishing spawn starts its fix task through the real entry point rather
      // than a copy of it — the same shape `PostMergeBoardController` takes for auto-started
      // dependents, and for the same reason: the start funnel owns admission, the spend gate and
      // the durable hand-off, none of which a second implementation would keep in step.
      start: (ws, blockId, pipelineId, opts) => this.start(ws, blockId, pipelineId, opts),
    })
  }

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
      testerController: this.gateWindows.testerController,
      ralphController: this.gateWindows.ralphController,
      humanTestController: this.gateWindows.humanTestController,
      visualConfirmationController: this.gateWindows.visualConfirmationController,
      reviewGate: this.gateWindows.reviewGate,
      forkDecisionController: this.gateWindows.forkDecisionController,
      binaryCandidateController: this.gateWindows.binaryCandidateController,
      prReviewController: this.gateWindows.prReviewController,
      bugFishingController: this.gateWindows.bugFishingController,
      requirementsKind: this.requirementsKind,
      clarityKind: this.clarityKind,
      requirementsBrainstormKind: this.requirementsBrainstormKind,
      architectureBrainstormKind: this.architectureBrainstormKind,
      // The interview-gate controllers, dispatched by the `interview-gate` trait keyed on each
      // controller's `agentKind` (a new interviewer wires its controller here — no engine branch).
      interviewControllers: this.wiredInterviewGates,
      prVerificationReport: this.prVerificationReport,
      runInitiatorScope: runInitiatorScopeFn,
      resolveRiskPolicy: (ws, block, run) => this.resolveRiskPolicy(ws, block, run),
      modelIdIsMetered: (id, caps) => this.admission.modelIdIsMetered(id, caps),
    })
  }

  private buildPostMergeBoard(deps: ExecutionServiceDependencies): PostMergeBoardController {
    // An explicit host literal, not `this`: the fields below are `private`, which makes the class
    // structurally incompatible with the interface even from inside it. The repository and the
    // logger come off `deps` rather than off `this`, because this runs partway through the
    // constructor: neither is an engine field by then (see {@link engineLogger}).
    const host: PostMergeBoardHost = {
      blockRepository: this.blockRepository,
      pipelineRepository: deps.pipelineRepository,
      pipelineAdoption: this.pipelineAdoption,
      admission: this.admission,
      board: this.board,
      events: this.events,
      logger: engineLogger(deps),
    }
    return new PostMergeBoardController(host, {
      // A system-initiated auto-start has no human present to unlock a personal credential, so it
      // reports NO activation and any individual-usage dependent is skipped rather than started.
      resolveIndividualVendors: (ws, modelId, presetId, kinds) =>
        this.vendorGate.forSteps(ws, modelId, presetId, kinds, () => false),
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
      this.gateWindows.reviewGate,
      this.requirementsKind,
    )
    return this.requirementsReviewActions
  }

  /** Clarity-review (bug-report triage) window actions. */
  get clarityReview(): ClarityReviewActions {
    this.clarityReviewActions ??= new ClarityReviewActions(
      this.gateWindows.reviewGate,
      this.clarityKind,
    )
    return this.clarityReviewActions
  }

  /** Brainstorm (structured-dialogue) window actions, keyed by stage. */
  get brainstorm(): BrainstormActions {
    this.brainstormActions ??= new BrainstormActions(this.gateWindows.reviewGate, (stage) =>
      this.brainstormKindFor(stage),
    )
    return this.brainstormActions
  }

  /** Human-testing gate window actions (confirm / request-fix / pull-main / recreate / destroy). */
  get humanTest(): HumanTestActions {
    return this.gateWindows.humanTestController
  }

  /** Visual-confirmation gate window actions (approve / request-fix / recapture). */
  get visualConfirm(): VisualConfirmActions {
    return this.gateWindows.visualConfirmationController
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

  /**
   * Every interview gate this deployment actually wired. ONE list, because the engine's own step
   * dispatch and {@link interviewGateFor} both have to enumerate the gates and a second copy is
   * how they would come to disagree: the dispatcher would park a run on a gate the public decision
   * surface then reports as unwired, which reads to an operator as a run stopped on nothing.
   *
   * Wiring a THIRD interviewer is still an edit here (a field on this class, fed from
   * `reviewSubjects`); what this getter buys is that it is one edit rather than two.
   */
  private get wiredInterviewGates(): (InitiativeInterviewController | DocInterviewController)[] {
    return [this.initiativeInterviewController, this.docInterviewController].filter(
      (c): c is InitiativeInterviewController | DocInterviewController => !!c,
    )
  }

  /**
   * The interview gate wired for a step's `agentKind`, or undefined when this deployment wired
   * none. The lookup a caller reaches for when it holds a PARKED STEP rather than a feature: the
   * public decision surface answers "the interview this run is stopped on" and must not have to
   * name which gate that is (the getters above are the per-feature reads, for a controller that
   * already knows, and they keep the entity-typed return this one cannot have).
   *
   * Keyed exactly as the engine's own dispatch is, off the same {@link wiredInterviewGates} list.
   * Note where that stops: admission reads the `interview-gate` TRAIT off the kind registry, so a
   * deployment's own interviewer is counted as a park the moment it is REGISTERED, while being
   * answerable here needs its controller WIRED as well. Registered but unwired is the honest 503
   * the public surface reports, not a state this lookup can paper over.
   */
  interviewGateFor(agentKind: string): InterviewGate | undefined {
    return this.wiredInterviewGates.find((c) => c.agentKind === agentKind)
  }

  /**
   * The three doors onto "what personal subscriptions would a run started here lease". Built
   * lazily and memoised for the reason {@link stepPreambleDeps} is: it closes over collaborators
   * this class assigns during construction, so binding it in the constructor would depend on the
   * field order rather than on the object being finished.
   */
  private get vendorGate(): RunVendorGate {
    const cached = this.vendorGateCache
    if (cached) return cached
    const gate = createRunVendorGate({
      requireBlock: (ws, id) => this.requireBlock(ws, id),
      blockOf: (ws, id) => this.blockRepository.get(ws, id),
      executionRepository: this.executionRepository,
      resolveDefinition: (ws, id) => this.pipelineAdoption.resolveDefinition(ws, id),
      ...(this.resolveWorkspaceModelDefault
        ? { resolveWorkspaceModelDefault: this.resolveWorkspaceModelDefault }
        : {}),
    })
    this.vendorGateCache = gate
    return gate
  }

  private requireWorkspace(workspaceId: string) {
    return requireWorkspace(this.workspaceRepository, workspaceId)
  }

  private async requireBlock(workspaceId: string, id: string): Promise<Block> {
    return assertFound(await this.blockRepository.get(workspaceId, id), 'Block', id)
  }

  /**
   * The individual-usage subscription vendors a run STARTED against `blockId` with `pipelineId`
   * will lease a personal credential for — so the controller can gate the run on the initiator's
   * personal subscription(s) up-front. The three doors (a pipeline, one agent kind, a failed run's
   * stored steps) live on {@link RunVendorGate}; these delegate so no start path can answer the
   * question its own way.
   */
  individualVendorsForBlock(
    workspaceId: string,
    blockId: string,
    pipelineId: string,
    hasPersonalSubscription?: HasPersonalSubscription,
  ): Promise<SubscriptionVendor[]> {
    return this.vendorGate.forBlock(workspaceId, blockId, pipelineId, hasPersonalSubscription)
  }

  /** The individual-usage vendors a SINGLE-KIND run would use (for its start gate). */
  individualVendorsForAgentKind(
    workspaceId: string,
    blockId: string,
    agentKind: string,
    hasPersonalSubscription?: HasPersonalSubscription,
  ): Promise<SubscriptionVendor[]> {
    return this.vendorGate.forAgentKind(workspaceId, blockId, agentKind, hasPersonalSubscription)
  }

  /** The individual-usage vendors a failed run's resumed steps use (for the retry gate). */
  individualVendorsForRun(
    workspaceId: string,
    executionId: string,
    hasPersonalSubscription?: HasPersonalSubscription,
  ): Promise<SubscriptionVendor[]> {
    return this.vendorGate.forRun(workspaceId, executionId, hasPersonalSubscription)
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
    // The run-row load sits OUTSIDE the step's try/catch, and reads through `loadOrDispose`: a
    // row that cannot be decoded is poison (no driver will ever get past this line), so it is
    // settled terminally there rather than re-driven on every sweep until the end of time, and
    // arrives here as a plain `null`. Keeping it out of the block below is what keeps the
    // disposition honest: a `DataIntegrityError` raised deeper in the step (about some OTHER row)
    // must never be read as this run being unreadable.
    const instance = await this.runStateMachine.loadOrDispose(workspaceId, executionId)
    try {
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

  /**
   * The preamble's bound collaborators. Built lazily and memoised because two of them
   * (`RunDispatcher`'s methods) resolve through a field assigned after this one in the
   * constructor, exactly like the dispatcher's own lazily-resolved closures.
   */
  private get stepPreambleDeps(): StepPreambleDeps {
    const cached = this.stepPreambleDepsCache
    if (cached) return cached
    const deps: StepPreambleDeps = {
      spend: this.spend,
      accountOf: (ws) => this.workspaceRepository.accountOf(ws),
      currentStepIsNonMetered: (ws, inst, step) =>
        this.runDispatcher.currentStepIsNonMetered(ws, inst, step),
      skipGatedStep: (ws, inst, step, isFinal, note) =>
        this.runDispatcher.skipGatedStep(ws, inst, step, isFinal, note),
      serviceScopeOf: (ws, block) =>
        resolveScopeForRun((id) => this.blockRepository.listByWorkspace(id), ws, block),
      blockOf: (ws, blockId) => this.blockRepository.get(ws, blockId),
      stateMachine: this.runStateMachine,
      stepGraph: this.stepGraph,
      inputGate: this.inputGate,
      agentKindRegistry: this.agentKindRegistry,
    }
    this.stepPreambleDepsCache = deps
    return deps
  }

  /** Advance a single running instance by one step, persisting the result. */
  private async stepInstance(
    workspaceId: string,
    instance: ExecutionInstance,
    options: AdvanceOptions = {},
  ): Promise<AdvanceResult> {
    const step = instance.steps[instance.currentStep]
    if (!step) return { kind: 'noop' }

    // The four pre-dispatch checks (spend gate, decision park, input gate, estimate gating),
    // in the order money is at stake. See {@link runStepPreamble}.
    const preamble = await runStepPreamble(this.stepPreambleDeps, workspaceId, instance, step)
    if (preamble.kind === 'stop') return preamble.result
    const { block, isFinalStep } = preamble

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

  /**
   * Whether the PRE-DISPATCH INPUT GATE would park a run started against this input, evaluated
   * without writing anything. The public API's admission asks before starting a run, so a key
   * that cannot answer a park is refused up front rather than left holding one.
   * @see InputGateController.wouldBlock
   */
  inputGateWouldBlock(workspaceId: string, input: InputGateInput): Promise<boolean> {
    return this.inputGate.wouldBlock(workspaceId, input)
  }

  /**
   * Resolve a run parked on the PRE-DISPATCH INPUT GATE: `recheck` (re-evaluate the task as it
   * now stands, which is what actually clears the park) or `proceed` (waive the findings).
   * @see InputGateController.resolve
   */
  resolveInputGate(
    workspaceId: string,
    executionId: string,
    choice: ResolveInputGateChoice,
    userId?: string | null,
  ): Promise<RunInputGate> {
    return this.inputGate.resolve(workspaceId, executionId, choice, userId)
  }

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

  /**
   * The verbs a run's DEDICATED PARK WINDOWS are answered with: the Follow-up companion, the
   * implementation-fork decision, the PR deep-review and the generated-candidate comparison.
   *
   * One property rather than sixteen delegates, because they are one concern and the family grows
   * by two every time a park surface is added. See `run-decision-surfaces.ts`.
   */
  readonly decisions: RunDecisionSurfaces = runDecisionSurfaces(
    () => this.runDispatcher,
    () => this.gateWindows.bugFishingController,
  )

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
        ...(p.frameIds?.length ? { frameIds: p.frameIds } : {}),
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
  private resolveRiskPolicy(
    workspaceId: string,
    block: Block,
    run: RunPolicyScope,
  ): Promise<ResolvedRunRiskPolicy> {
    return this.mergePolicy.resolve(workspaceId, block, run)
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

  /**
   * Approve a step's gated proposal (optionally replacing it with the human's edit).
   *
   * `actor` is REQUIRED on all three gate resolutions rather than optional, so an entry point that
   * forgets to supply the acting identity fails to typecheck instead of silently resolving a gate
   * that names its approvers as though nobody were named. See `GateActor` / `refuseGateResolution`.
   */
  approveStep(
    workspaceId: string,
    executionId: string,
    approvalId: string,
    opts: { proposal?: string } = {},
    actor: GateActor,
  ): Promise<ExecutionInstance> {
    return this.stepDecisions.approveStep(workspaceId, executionId, approvalId, opts, actor)
  }

  /** Request changes on a step's gated proposal; the step re-runs with the feedback folded in. */
  requestStepChanges(
    workspaceId: string,
    executionId: string,
    approvalId: string,
    review: { feedback?: string; comments?: StepReviewComment[] },
    actor: GateActor,
  ): Promise<ExecutionInstance> {
    return this.stepDecisions.requestStepChanges(
      workspaceId,
      executionId,
      approvalId,
      review,
      actor,
    )
  }

  /** Reject a step's gated proposal; the run stops with a `rejected` failure. */
  rejectStep(
    workspaceId: string,
    executionId: string,
    approvalId: string,
    reason: string | undefined,
    actor: GateActor,
  ): Promise<ExecutionInstance> {
    return this.stepDecisions.rejectStep(workspaceId, executionId, approvalId, reason, actor)
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

  /** @see RunLifecycleController.startAgentKind */
  startAgentKind(
    workspaceId: string,
    blockId: string,
    agentKind: string,
    options: RunStartOptions = {},
  ): Promise<ExecutionInstance> {
    return this.runActions.lifecycle.startAgentKind(workspaceId, blockId, agentKind, options)
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
  teardownForBlockTree(
    workspaceId: string,
    rootId: string,
    opts: { preloaded?: PreloadedBlocks } = {},
  ): Promise<PreloadedBlocks> {
    return this.runActions.lifecycle.teardownForBlockTree(workspaceId, rootId, opts)
  }
}
