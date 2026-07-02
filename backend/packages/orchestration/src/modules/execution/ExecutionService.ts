import type {
  AgentFailureKind,
  ResolveBinaryArtifactStore,
  Block,
  BlueprintService,
  ExecutionInstance,
  FollowUpsStepState,
  MergePresetRepository,
  PipelineStep,
  PullRequestMerger,
  StepReviewComment,
  SubscriptionActivationRepository,
  TicketTrackerProvider,
  IssueWritebackProvider,
} from '@cat-factory/kernel'
import {
  DEFAULT_COMPANION_MAX_ATTEMPTS,
  frameAllowsVisualPipeline,
  isLocalRunner,
  pipelineHasVisualStep,
} from '@cat-factory/contracts'
import {
  BINARY_STORAGE_TRAIT,
  companionFor,
  companionTargets,
  hasTrait,
  isCompanionKind,
  isInlineModelStep,
} from '@cat-factory/agents'
import type { RunInitiatorScope } from '@cat-factory/kernel'
import { validatePipelineShape, type PipelineShape } from '../pipelines/pipelineShape.js'
import { shouldRunGatedStep } from './stepGating.logic.js'
import {
  resolveIndividualVendors,
  type HasPersonalSubscription,
} from './individualVendors.logic.js'
import {
  assertFound,
  ConflictError,
  isModelUsable,
  isModelUsableInline,
  type ModelRef,
  NotFoundError,
  type ProviderCapabilities,
  resolveModelRef,
  subscriptionOptionFor,
  ValidationError,
  type SubscriptionVendor,
} from '@cat-factory/kernel'
import { DEFAULT_MERGE_PRESET } from '@cat-factory/kernel'
import {
  REQUIREMENTS_REVIEW_AGENT_KIND,
  CLARITY_REVIEW_AGENT_KIND,
  REQUIREMENTS_BRAINSTORM_AGENT_KIND,
  ARCHITECTURE_BRAINSTORM_AGENT_KIND,
  BUG_INVESTIGATOR_AGENT_KIND,
  isTesterKind,
  HUMAN_TEST_AGENT_KIND,
  VISUAL_CONFIRM_AGENT_KIND,
  HUMAN_REVIEW_AGENT_KIND,
} from './ci.logic.js'
import { DEFAULT_FOLLOW_UP_MAX_LOOPS, FOLLOW_UP_PRODUCER_KIND } from './followUp.logic.js'
import {
  AgentContextBuilder,
  type DocumentUrlResolver,
  type FragmentBodyResolver,
} from './AgentContextBuilder.js'
import { CompanionController } from './CompanionController.js'
import { StepGraph } from './StepGraph.js'
import { RunStateMachine, type KaizenScheduler } from './RunStateMachine.js'
import { RunDispatcher } from './RunDispatcher.js'
import { inferTechnicalLabel } from './technical.logic.js'
import { MergeResolver } from './MergeResolver.js'
import { ReviewGateController, type ReviewKind } from './ReviewGateController.js'
import {
  BrainstormActions,
  ClarityReviewActions,
  type HumanTestActions,
  RequirementReviewActions,
  type VisualConfirmActions,
} from './gate-window-facades.js'
import { TesterController } from './TesterController.js'
import type { TesterQualityReviewer } from './TesterQualityReviewService.js'
import { HumanTestController } from './HumanTestController.js'
import { VisualConfirmationController } from './VisualConfirmationController.js'
import type { NotificationService } from '../notifications/NotificationService.js'
import type { WorkspaceSettingsService } from '../settings/WorkspaceSettingsService.js'
import type { RequirementReviewService } from '../requirements/RequirementReviewService.js'
import type { ClarityReviewService } from '../clarity/ClarityReviewService.js'
import type { BrainstormService } from '../brainstorm/BrainstormService.js'
import type {
  IterationCapChoice,
  RequirementConcernLevel,
  RequirementReview,
  ClarityReview,
  BrainstormSession,
  BrainstormStage,
} from '@cat-factory/kernel'
import type { LlmObservabilityService } from '../observability/LlmObservabilityService.js'
import type {
  AccountRepository,
  BlockRepository,
  ExecutionRepository,
  PipelineRepository,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import type { Clock, IdGenerator } from '@cat-factory/kernel'
import type { AgentExecutor, ResolveRunRepoContext } from '@cat-factory/kernel'
import { isAsyncAgentExecutor } from '@cat-factory/kernel'
import type { WorkRunner } from '@cat-factory/kernel'
import type { ExecutionEventPublisher } from '@cat-factory/kernel'
import type { DocumentRepository } from '@cat-factory/kernel'
import type { TaskRepository } from '@cat-factory/kernel'
import type { RequirementReviewRepository } from '@cat-factory/kernel'
import type { ClarityReviewRepository } from '@cat-factory/kernel'
import type { BrainstormSessionRepository } from '@cat-factory/kernel'
import type {
  EnvironmentProvisioningService,
  EnvironmentTeardownService,
} from '@cat-factory/integrations'
import type { BranchUpdater } from '@cat-factory/kernel'
import {
  dependenciesMet,
  descendantIds,
  serviceOf,
  unmetDependencies,
} from '../board/board.logic.js'
import type { BoardService } from '../board/BoardService.js'
import type { SpendService } from '@cat-factory/spend'
import { requireWorkspace } from '@cat-factory/kernel'
import type { AdvanceOptions, AdvanceResult } from './advance.js'
import { carryForwardFailures, planResumedSteps, planRestartFromStep } from './retry.logic.js'
import { decideTesterInfra, TESTER_INFRA_MESSAGES } from './tester-infra.logic.js'
import { hasLiveServiceBinding, hasServiceBinding } from './frontend-infra.logic.js'

export interface ExecutionServiceDependencies {
  workspaceRepository: WorkspaceRepository
  blockRepository: BlockRepository
  pipelineRepository: PipelineRepository
  executionRepository: ExecutionRepository
  /**
   * Resolves the owning account of a workspace so a service that pins no cloud
   * provider falls back to the account's `defaultCloudProvider` at dispatch.
   */
  accountRepository: AccountRepository
  idGenerator: IdGenerator
  clock: Clock
  agentExecutor: AgentExecutor
  workRunner: WorkRunner
  executionEventPublisher: ExecutionEventPublisher
  boardService: BoardService
  spendService: SpendService
  /**
   * Optional: when the document-source integration is configured, documents
   * linked to a block are resolved here and fed to the agent as extra context.
   */
  documentRepository?: DocumentRepository
  /**
   * Optional: canonicalises a URL named in a block's description to the document's stable
   * `(source, externalId)` (via the document providers' `parseRef`) so a pasted design/doc
   * link auto-matches its imported page even when the URL carries title/tracking noise.
   * Forwarded to {@link AgentContextBuilder}; absent → url-string matching only.
   */
  documentUrlResolver?: DocumentUrlResolver
  /**
   * Optional: when the task-source integration is configured, tracker issues
   * linked to a block are resolved here and fed to the agent as extra context.
   */
  taskRepository?: TaskRepository
  /**
   * Optional: when the requirements-review feature is configured, a block's
   * reworked ("incorporated") requirements are read here. When present they REPLACE
   * the block's description + linked docs/tasks as the agent context (for every
   * step) and become the per-task input the spec-writer aggregates. Absent
   * → the engine uses the original description + docs/tasks unchanged.
   */
  requirementReviewRepository?: RequirementReviewRepository
  /**
   * Optional: the requirements-review feature's service, present when the reviewer is
   * wired. Drives the special `requirements-review` gate step (run reviewer inline, the
   * iterative answer → incorporate → re-review loop). Absent → the gate step passes
   * through so pipelines run unchanged without the feature.
   */
  requirementReviewService?: RequirementReviewService
  /**
   * Optional: the inline reviewer for the test quality-control companion. When wired (and a
   * Tester step has the companion enabled), each Tester report is audited for coverage before
   * the greenlight/fixer decision and an inadequate report loops the Tester. Passed straight
   * to the {@link TesterController}. Absent → QC is a pass-through.
   */
  testerQualityReviewer?: TesterQualityReviewer
  /**
   * Optional: the Kaizen agent's scheduler. When wired, a run reaching a terminal state
   * schedules a post-run grading for each completed agent step (skipping verified combos).
   * Structural so the engine doesn't depend on the concrete service. Absent → no grading.
   */
  kaizenScheduler?: KaizenScheduler
  /**
   * Optional: persistence for the clarity-review (bug-report triage) feature. Read here
   * to substitute a converged clarified report as the downstream agent context (the
   * mirror of `requirementReviewRepository`). Absent → no substitution.
   */
  clarityReviewRepository?: ClarityReviewRepository
  /**
   * Optional: the clarity-review feature's service, present when the reviewer is wired.
   * Drives the special `clarity-review` gate step (inline reviewer + the iterative
   * answer → incorporate → re-review loop). Absent → the gate step passes through.
   */
  clarityReviewService?: ClarityReviewService
  /**
   * Optional: the brainstorm (structured-dialogue) feature's services, one per stage, present
   * when the brainstorm module is wired. Drive the special `requirements-brainstorm` /
   * `architecture-brainstorm` gate steps (inline option-generator + the iterative propose →
   * pick → incorporate → re-run loop). Absent → the gate steps pass through.
   */
  brainstormServices?: Record<BrainstormStage, BrainstormService>
  /**
   * Optional: persistence for the brainstorm feature. Read by the agent-context builder to
   * surface a converged `architecture-brainstorm` direction to the architect (the mirror of
   * `requirementReviewRepository`). Absent → no substitution.
   */
  brainstormSessionRepository?: BrainstormSessionRepository
  /**
   * Optional: resolves fragment ids against the merged tenant catalog (managed +
   * document-backed fragments), live-resolving linked Confluence/Notion/GitHub
   * documents at run time. Wired only when the prompt-fragment library is
   * configured; absent → the engine resolves against the static built-in pool.
   */
  fragmentResolver?: FragmentBodyResolver
  /**
   * Optional: when the individual-usage subscription store is configured, a finished
   * run's per-run credential activation is deleted here the moment it reaches a terminal
   * state, bounding standing exposure to the run's own lifetime (the TTL sweep is the
   * backstop). Absent → activations are reclaimed by the TTL sweep alone.
   */
  subscriptionActivationRepository?: SubscriptionActivationRepository
  /**
   * Optional: resolve a workspace's per-agent-kind default model id (the same resolver
   * the container executor uses for dispatch). The personal-credential gate consults it
   * so a run whose block has NO pinned model but whose workspace default resolves to an
   * individual-usage vendor is still gated up-front — matching what dispatch will resolve,
   * instead of starting and then failing on a missing activation. Absent → the gate sees
   * only the block's pinned model (env-routing defaults are operator-level and not gated).
   */
  resolveWorkspaceModelDefault?: (
    workspaceId: string,
    agentKind: string,
    modelPresetId?: string,
  ) => Promise<string | undefined>
  /**
   * Optional: resolve the provider capabilities (configured direct keys +
   * subscription vendors + whether Cloudflare AI is enabled) for a workspace and the
   * run initiator. The start guard uses it to block a pipeline whose steps' canonical
   * models have no usable provider. Absent → the guard is skipped (tests / unconfigured
   * facades), exactly like the existing optional engine deps.
   */
  resolveProviderCapabilities?: (
    workspaceId: string,
    initiatedBy?: string | null,
  ) => Promise<ProviderCapabilities>
  /**
   * Optional: whether a container-only subscription harness ref (`claude-code` / `codex`)
   * can run as an INLINE LLM call in this deployment (local mode's ambient CLI). The preset
   * satisfiability guard uses it so an inline step pinned to a subscription model is
   * satisfiable where the harness runs inline, and refused where it doesn't (Node/Worker).
   * From `config.agents.inlineHarnessRef`; absent → no inline harness support.
   */
  inlineHarnessRef?: (ref: ModelRef) => boolean
  /**
   * Optional: when the environment integration is configured, a `deployer` step
   * provisions an ephemeral environment deterministically through this service
   * (no LLM), and downstream steps discover the resulting env via it.
   */
  environmentProvisioning?: EnvironmentProvisioningService
  /**
   * Optional: resolves the binary-artifact store (UI screenshots + reference design images)
   * for a workspace's account; the `visual-confirmation` gate reads it. Absent (or resolving
   * to null — storage not configured) → the gate passes through (auto-advances), since there
   * is nowhere to read screenshots from.
   */
  resolveBinaryArtifactStore?: ResolveBinaryArtifactStore
  /**
   * Optional: tears down ephemeral environments. Wired alongside
   * {@link environmentProvisioning}; the `human-test` gate uses it to destroy an env on
   * confirm / recreate / on-demand. Absent → the gate's destroy/recreate is a no-op.
   */
  environmentTeardown?: EnvironmentTeardownService
  /**
   * Optional: merges the repo default branch into a block's PR branch server-side. Wired
   * when GitHub is configured; the `human-test` gate's "pull latest main" action uses it
   * (a clean merge rebuilds the env; a conflict escalates to the conflict-resolver). Absent
   * → pulling main is unavailable on the gate.
   */
  branchUpdater?: BranchUpdater
  /**
   * Optional: when the board-scan module is configured, a `blueprints` step's
   * decomposition tree is reconciled onto the board through this (BoardScanService).
   * Absent → a blueprint step still runs and commits its in-repo files, but the
   * board isn't auto-updated from it.
   */
  blueprintReconciler?: BlueprintReconciler
  /**
   * Optional: raises human-actionable notifications (a PR needs a merge decision,
   * a no-merger pipeline finished, CI fixing gave up). Absent → those events still
   * transition the block but no notification surfaces (tests).
   */
  notificationService?: NotificationService
  /**
   * Optional: resolves a workspace's runtime settings so {@link ExecutionService.start}
   * can enforce the per-service running-task limit. Absent → the limit is never enforced
   * (tests / unconfigured facades start runs unbounded).
   */
  workspaceSettingsService?: WorkspaceSettingsService
  // The CI / mergeability / release-health / incident-enrichment providers the built-in
  // gates used to read are no longer engine dependencies: the gate suite ships as
  // `@cat-factory/gates` and a facade wires those providers into it via its `wireX` handles
  // (see "Keep the runtimes symmetric"). The engine only holds the merge collaborators below
  // (the `merger` resolver stays a privileged built-in — see buildStepResolverRegistry).
  /**
   * Optional: performs the real GitHub merge when a task should become `done`.
   * Absent → `done` is a board-only flip (tests); when wired, `done` provably
   * means the PR was merged on the remote.
   */
  pullRequestMerger?: PullRequestMerger
  /**
   * Optional: resolves a task's merge threshold preset (auto-merge ceilings + the
   * CI-fixer attempt budget). Absent → the built-in {@link DEFAULT_MERGE_PRESET}.
   */
  mergePresetRepository?: MergePresetRepository
  /**
   * Optional: runs the gate-probe / merge GitHub reads under the run initiator's
   * ambient context, so a per-user PAT (when set) is preferred over the deployment's
   * App/env token (see `PatPreferringAppRegistry`). Absent → a pass-through
   * (`(_, fn) => fn()`), so tests/conformance run unchanged.
   */
  runInitiatorScope?: RunInitiatorScope
  /**
   * Optional: files a GitHub issue / Jira ticket for the `tracker` step (the
   * tech-debt recurring pipeline). Absent → the `tracker` step passes through
   * without filing anything, so the engine works unchanged when no tracker is wired.
   */
  ticketTrackerProvider?: TicketTrackerProvider
  /**
   * Optional: writes back to a task's linked tracker issue(s) as its PR progresses
   * (comment on PR open; comment + close as resolved on merge). Gated by the
   * workspace's writeback settings + the per-task override. Absent → no writeback,
   * so the engine works unchanged when no tracker writeback is wired.
   */
  issueWriteback?: IssueWritebackProvider
  /**
   * Optional: the LLM observability sink. When wired, each emit rolls the per-run
   * model-call aggregates onto the matching pipeline steps (`step.metrics`) so the
   * board shows tokens / output-limit headroom / transport-vs-execution latency
   * live. Absent (tests / unconfigured) → steps carry no `metrics`.
   */
  llmObservability?: LlmObservabilityService
  /**
   * Optional: whether the runtime can run a `docker-compose` service's infra in-container
   * via Docker-in-Docker. Defaults to `true` (Cloudflare, Node, tests). The local facade
   * sets it `false` for runtimes without nesting (Apple `container`), which makes
   * {@link ExecutionService.assertTesterInfraConfigured} refuse a `docker-compose` Tester
   * run ("limited mode" — steer to an `infraless` service or a runtime that nests
   * containers) instead of dispatching a job that can't stand its dependencies up.
   */
  localTestInfraSupported?: boolean
  /**
   * Optional: resolve a block's run repo (installation + repo + default branch) bound to
   * a checkout-free {@link RepoFiles} so a registered custom kind's pre/post-op hooks
   * read/commit a targeted subset of the repo WITHOUT a checkout. A facade composes it
   * from its wired `GitHubClient` + `resolveRepoTarget` (`makeResolveRunRepoContext`).
   * Absent (tests / GitHub not connected) → pre/post-ops are skipped.
   */
  resolveRunRepoContext?: ResolveRunRepoContext
  /**
   * Optional: assert the workspace has a usable container-agent backend before a run
   * starts (local mode delegating agents to a runner pool that isn't registered throws a
   * clean {@link ConflictError} here). Absent → no start-time check (Cloudflare/Node have
   * a fixed backend; a missing local pool still fails loudly at dispatch).
   */
  assertAgentBackendConfigured?: (workspaceId: string) => Promise<void>
}

/** Reconciles a Blueprinter step's tree onto the board in place (BoardScanService). */
export interface BlueprintReconciler {
  reconcileBlueprint(
    workspaceId: string,
    frameId: string | null,
    service: BlueprintService,
  ): Promise<unknown>
}

/**
 * The execution engine. It orchestrates a pipeline of agent-performed steps and
 * is fully deterministic: `advanceInstance` moves one run forward by exactly one
 * step, delegating the actual work — and the choice of whether to pause for a
 * human decision — to the injected {@link AgentExecutor}. The durable workflow
 * driver calls it in a loop. All LLM behaviour lives behind that port, so the
 * engine here can be tested with a
 * deterministic fake and no timing/delays.
 */
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
  private readonly workRunner: WorkRunner
  private readonly events: ExecutionEventPublisher
  private readonly board: BoardService
  private readonly spend: SpendService
  private readonly requirementReviewService?: RequirementReviewService
  private readonly clarityReviewService?: ClarityReviewService
  private readonly brainstormServices?: Record<BrainstormStage, BrainstormService>
  private readonly environmentProvisioning?: EnvironmentProvisioningService
  /** Assembles the per-step agent context (requirements, docs, env, service frame, fragments). */
  private readonly contextBuilder: AgentContextBuilder
  /** Resolves a `merger` step's assessment into an auto-merge or a `merge_review` notification. */
  private readonly mergeResolver: MergeResolver
  /** Drives a companion (reviewer/spec/architect) step: grade → pass / loop producer / park. */
  private readonly companionController: CompanionController
  /** Drives the Tester gate's fix loop: report → greenlight / dispatch fixer / fail. */
  private readonly testerController: TesterController
  /** Drives the human-testing gate: provision env → park → confirm / fix / pull-main / recreate. */
  private readonly humanTestController: HumanTestController
  /** Drives the visual-confirmation gate: gather screenshots → park → approve / fix / recapture. */
  private readonly visualConfirmationController: VisualConfirmationController
  /** Drives both iterative review gates (requirements + clarity); kind-parameterised. */
  private readonly reviewGate: ReviewGateController
  /** The requirements subject for {@link reviewGate}. */
  private readonly requirementsKind: ReviewKind<RequirementReview>
  /** The clarity (bug-report triage) subject for {@link reviewGate}. */
  private readonly clarityKind: ReviewKind<ClarityReview>
  /** The two brainstorm (structured-dialogue) subjects for {@link reviewGate}, by stage. */
  private readonly requirementsBrainstormKind: ReviewKind<BrainstormSession>
  private readonly architectureBrainstormKind: ReviewKind<BrainstormSession>
  /** Requirements-review window actions (exposed via {@link requirementsReview}). */
  private readonly requirementsReviewActions: RequirementReviewActions
  /** Clarity-review (bug triage) window actions (exposed via {@link clarityReview}). */
  private readonly clarityReviewActions: ClarityReviewActions
  /** Brainstorm window actions (exposed via {@link brainstorm}). */
  private readonly brainstormActions: BrainstormActions
  // `blueprintReconciler` / `notificationService` / `ticketTrackerProvider` /
  // `resolveRunRepoContext` / `runInitiatorScope` are NOT stored on the engine: their only
  // consumers (the ingest/follow-up/tracker/notification paths + the pre/post-op repo binding +
  // the initiator scope) moved to {@link RunDispatcher} (and the controllers / RunStateMachine),
  // so the constructor forwards the destructured params straight to those collaborators.
  private readonly workspaceSettingsService?: WorkspaceSettingsService
  private readonly prMerger?: PullRequestMerger
  private readonly mergePresetRepository?: MergePresetRepository
  private readonly issueWriteback?: IssueWritebackProvider
  private readonly subscriptionActivations?: SubscriptionActivationRepository
  private readonly resolveProviderCapabilities?: (
    workspaceId: string,
    initiatedBy?: string | null,
  ) => Promise<ProviderCapabilities>
  private readonly inlineHarnessRef?: (ref: ModelRef) => boolean
  private readonly resolveWorkspaceModelDefault?: (
    workspaceId: string,
    agentKind: string,
    modelPresetId?: string,
  ) => Promise<string | undefined>
  /** Whether the runtime can run the Tester's local DinD infra (false = limited mode). */
  private readonly localTestInfraSupported: boolean
  /** Start-time assertion that a container-agent backend is configured (local-mode pool). */
  private readonly assertAgentBackendConfigured?: (workspaceId: string) => Promise<void>
  /**
   * Resolves the per-account binary-artifact store, used by the start gate to refuse a
   * pipeline carrying a {@link BINARY_STORAGE_TRAIT} kind (e.g. the UI Tester) when the
   * account has no storage configured. Absent (tests/conformance with no store wired) ⇒
   * the gate passes through, like the other optional start guards.
   */
  private readonly resolveBinaryArtifactStore?: ResolveBinaryArtifactStore
  /**
   * The per-step dispatch + completion spine (the four registries, the completion hub, the
   * gate machinery, the deterministic deployer/tracker steps, the pre/post-op cluster, the
   * structured-artifact ingest, and the follow-up companion gate). `stepInstance` runs the
   * run-lifecycle preamble then delegates the per-kind work here; `pollAgentJob` / `pollGate`
   * / `resolveGatePollExhaustion` + the follow-up human-action API are thin pass-throughs.
   */
  private readonly runDispatcher: RunDispatcher

  constructor({
    workspaceRepository,
    blockRepository,
    pipelineRepository,
    executionRepository,
    accountRepository,
    idGenerator,
    clock,
    agentExecutor,
    workRunner,
    executionEventPublisher,
    boardService,
    spendService,
    documentRepository,
    documentUrlResolver,
    taskRepository,
    requirementReviewRepository,
    requirementReviewService,
    testerQualityReviewer,
    kaizenScheduler,
    clarityReviewRepository,
    clarityReviewService,
    brainstormServices,
    brainstormSessionRepository,
    fragmentResolver,
    environmentProvisioning,
    environmentTeardown,
    branchUpdater,
    blueprintReconciler,
    notificationService,
    resolveBinaryArtifactStore,
    workspaceSettingsService,
    llmObservability,
    pullRequestMerger,
    mergePresetRepository,
    ticketTrackerProvider,
    issueWriteback,
    subscriptionActivationRepository,
    resolveWorkspaceModelDefault,
    resolveProviderCapabilities,
    inlineHarnessRef,
    localTestInfraSupported,
    resolveRunRepoContext,
    assertAgentBackendConfigured,
    runInitiatorScope,
  }: ExecutionServiceDependencies) {
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
      kaizenScheduler,
      subscriptionActivations: subscriptionActivationRepository,
      llmObservability,
    })
    this.agentExecutor = agentExecutor
    this.workRunner = workRunner
    this.events = executionEventPublisher
    this.board = boardService
    this.spend = spendService
    this.requirementReviewService = requirementReviewService
    this.clarityReviewService = clarityReviewService
    this.brainstormServices = brainstormServices
    this.environmentProvisioning = environmentProvisioning
    this.contextBuilder = new AgentContextBuilder({
      workspaceRepository,
      blockRepository,
      accountRepository,
      documents: documentRepository,
      documentUrlResolver,
      tasks: taskRepository,
      requirementReviews: requirementReviewRepository,
      clarityReviews: clarityReviewRepository,
      brainstormSessions: brainstormSessionRepository,
      environmentProvisioning,
      fragmentResolver,
    })
    this.mergeResolver = new MergeResolver({
      blockRepository,
      notificationService,
      resolveMergePreset: (ws, block) => this.resolveMergePreset(ws, block),
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
    this.testerController = new TesterController({
      blockRepository,
      notificationService,
      agentExecutor,
      contextBuilder: this.contextBuilder,
      resolveMergePreset: (ws, block) => this.resolveMergePreset(ws, block),
      stateMachine: this.runStateMachine,
      // The test quality-control companion's inline reviewer (when wired); absent → QC
      // pass-through. Stamps its verdicts with the engine clock.
      ...(testerQualityReviewer ? { qualityReviewer: testerQualityReviewer } : {}),
      clockNow: () => this.clock.now(),
    })
    this.humanTestController = new HumanTestController({
      blockRepository,
      executionRepository,
      workRunner,
      agentExecutor,
      contextBuilder: this.contextBuilder,
      notificationService,
      // Wrap the env services with the deployer's input/context derivation so the gate's
      // provisioning matches a `deployer` step's. Left undefined when no provider is wired
      // (the gate degrades to manual mode).
      ...(environmentProvisioning
        ? {
            provisionEnvironment: (ws, block, executionId) =>
              environmentProvisioning.provision({
                workspaceId: ws,
                blockId: block.id,
                executionId,
                inputs: this.runDispatcher.deployInputs(block),
                context: this.runDispatcher.deployContext(block),
              }),
            refreshEnvironment: (ws, id) => environmentProvisioning.refreshStatus(ws, id),
          }
        : {}),
      ...(environmentTeardown
        ? {
            teardownEnvironment: async (ws, id) => {
              await environmentTeardown.teardown(ws, id)
            },
          }
        : {}),
      ...(branchUpdater ? { branchUpdater } : {}),
      resolveMergePreset: (ws, block) => this.resolveMergePreset(ws, block),
      stateMachine: this.runStateMachine,
      stepGraph: this.stepGraph,
      clockNow: () => this.clock.now(),
    })
    this.visualConfirmationController = new VisualConfirmationController({
      blockRepository,
      executionRepository,
      workRunner,
      agentExecutor,
      contextBuilder: this.contextBuilder,
      notificationService,
      ...(resolveBinaryArtifactStore ? { resolveBinaryArtifactStore } : {}),
      resolveMergePreset: (ws, block) => this.resolveMergePreset(ws, block),
      stateMachine: this.runStateMachine,
      stepGraph: this.stepGraph,
      clockNow: () => this.clock.now(),
    })
    this.reviewGate = new ReviewGateController({
      blockRepository,
      executionRepository,
      workRunner,
      stateMachine: this.runStateMachine,
      stepGraph: this.stepGraph,
      resolveMergePreset: (ws, block) => this.resolveMergePreset(ws, block),
      dispatchIterationCap: (ws, blockId, choice, handlers) =>
        this.dispatchIterationCap(ws, blockId, choice, handlers),
    })
    this.requirementsKind = this.buildRequirementsKind()
    this.clarityKind = this.buildClarityKind()
    this.requirementsBrainstormKind = this.buildBrainstormKind(
      'requirements',
      REQUIREMENTS_BRAINSTORM_AGENT_KIND,
    )
    this.architectureBrainstormKind = this.buildBrainstormKind(
      'architecture',
      ARCHITECTURE_BRAINSTORM_AGENT_KIND,
    )
    // The per-step dispatch + completion spine. Composes the collaborators built above; the
    // merge subgraph stays on the engine, reached only through the injected `resolveMergePreset`
    // callback + the MergeResolver (which closes over the engine's `finalizeMerge`). The
    // controllers' `runAgent`/`previewStepModel`/`deployInputs`/`deployContext` closures resolve
    // through `this.runDispatcher` lazily, so this assignment trailing their construction is safe.
    this.runDispatcher = new RunDispatcher({
      blockRepository,
      executionRepository,
      agentExecutor,
      workRunner,
      events: executionEventPublisher,
      idGenerator,
      clock,
      spend: spendService,
      stepGraph: this.stepGraph,
      runStateMachine: this.runStateMachine,
      contextBuilder: this.contextBuilder,
      mergeResolver: this.mergeResolver,
      companionController: this.companionController,
      testerController: this.testerController,
      humanTestController: this.humanTestController,
      visualConfirmationController: this.visualConfirmationController,
      reviewGate: this.reviewGate,
      requirementsKind: this.requirementsKind,
      clarityKind: this.clarityKind,
      requirementsBrainstormKind: this.requirementsBrainstormKind,
      architectureBrainstormKind: this.architectureBrainstormKind,
      runInitiatorScope: runInitiatorScopeFn,
      environmentProvisioning,
      ticketTrackerProvider,
      issueWriteback,
      notificationService,
      blueprintReconciler,
      resolveRunRepoContext,
      resolveProviderCapabilities,
      resolveMergePreset: (ws, block) => this.resolveMergePreset(ws, block),
      modelIdIsMetered: (id, caps) => this.modelIdIsMetered(id, caps),
    })
    // Group the per-feature gate-window actions into cohesive sub-facades (exposed as
    // getters below) so they stop bloating the engine's public surface as ~30 near-identical
    // 3-line delegations. They close over the same shared collaborators the handlers use.
    this.requirementsReviewActions = new RequirementReviewActions(
      this.reviewGate,
      this.requirementsKind,
    )
    this.clarityReviewActions = new ClarityReviewActions(this.reviewGate, this.clarityKind)
    this.brainstormActions = new BrainstormActions(this.reviewGate, (stage) =>
      this.brainstormKindFor(stage),
    )
    this.workspaceSettingsService = workspaceSettingsService
    this.prMerger = pullRequestMerger
    this.mergePresetRepository = mergePresetRepository
    this.issueWriteback = issueWriteback
    this.subscriptionActivations = subscriptionActivationRepository
    this.resolveWorkspaceModelDefault = resolveWorkspaceModelDefault
    this.resolveProviderCapabilities = resolveProviderCapabilities
    this.inlineHarnessRef = inlineHarnessRef
    this.localTestInfraSupported = localTestInfraSupported ?? true
    this.assertAgentBackendConfigured = assertAgentBackendConfigured
    this.resolveBinaryArtifactStore = resolveBinaryArtifactStore
  }

  // ---- gate-window action sub-facades -------------------------------------
  // Per-feature groupings of the dedicated review/test window actions, consumed by the
  // matching server controllers. See {@link gate-window-facades}. The `executionService` is
  // still the single injected object, so the runtimes stay symmetric (no composition-root edit).

  /** Requirements-review window actions (run / incorporate / re-review / proceed / …). */
  get requirementsReview(): RequirementReviewActions {
    return this.requirementsReviewActions
  }

  /** Clarity-review (bug-report triage) window actions. */
  get clarityReview(): ClarityReviewActions {
    return this.clarityReviewActions
  }

  /** Brainstorm (structured-dialogue) window actions, keyed by stage. */
  get brainstorm(): BrainstormActions {
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
   * Guard a Tester pipeline's start on the service frame's declared provisioning being
   * runnable. The Tester needs SOME way to stand its system up: `infraless` (or no
   * provisioning declared) runs with no infra; a `docker-compose` service stands its stack
   * up in-container (so a runtime without Docker-in-Docker is refused — "limited mode"); a
   * `kubernetes`/`custom` service is provisioned by a workspace handler, so one must resolve
   * for its type. Throws a {@link ConflictError} (`tester_infra_unsupported` when the local
   * docker-compose infra can't run — no DinD or no compose path declared,
   * `provision_type_unhandled` for a missing handler) — surfaced as an actionable message —
   * otherwise. Passes through when the provisioning seam is unwired (tests / no environment
   * integration), like the other optional start guards.
   */
  /**
   * Guard a run start when the pipeline carries a VISUAL step (`tester-ui` /
   * `visual-confirmation`): such a step exercises a rendered UI, so it only makes sense where
   * there is a UI to drive — a `type: 'frontend'` frame (it owns the app under test) or a frame
   * a `frontend` frame links to (the linked frontend is the UI a change to that service is
   * validated through). On any other frame (a service with no linked frontend, a `library` /
   * `document` repo) a `tester-ui` step would have nothing to drive, so refuse the start with an
   * actionable {@link ConflictError} (`visual_pipeline_no_frontend`). The frontend surfaces the
   * SAME rule (via the shared `frameAllowsVisualPipeline`) so it only offers these pipelines
   * where they can run; this is the server-side guarantee. A non-visual pipeline passes through.
   * The workspace block list is read ONCE (for the frontend→service links), never per-frame.
   */
  private async assertPipelineFrameTypeAllowed(
    workspaceId: string,
    block: Block,
    agentKinds: readonly string[],
  ): Promise<void> {
    if (!pipelineHasVisualStep({ agentKinds: [...agentKinds] })) return
    const frame = await this.contextBuilder.resolveServiceFrame(workspaceId, block.id)
    // A `frontend` frame is always allowed without listing the workspace; only a non-frontend
    // frame needs the link scan, so defer the (single) block-list read until then.
    if (frame?.type === 'frontend') return
    const blocks = await this.blockRepository.listByWorkspace(workspaceId)
    if (frameAllowsVisualPipeline(frame, blocks)) return
    throw new ConflictError(
      'This pipeline includes a UI-testing step, so it can only run on a frontend service (or a ' +
        'backend service that has a frontend linked to it). Move the task under a frontend, link ' +
        'a frontend to this service, or pick a pipeline without UI-testing steps.',
      'visual_pipeline_no_frontend',
      { frameType: frame?.type ?? null },
    )
  }

  private async assertTesterInfraConfigured(workspaceId: string, block: Block): Promise<void> {
    // A `frontend` frame (the self-contained UI-test flow) is gated on having a live service
    // under test, NOT on a provision type — resolved first and short-circuiting the backend
    // branch. Only enforce it when the environment seam is wired (else, like the other optional
    // start guards, pass through so tests / no-env deployments run unchanged).
    const frontend = await this.contextBuilder.resolveFrontendConfig(workspaceId, block)
    if (frontend) {
      if (!this.environmentProvisioning) return
      const decision = decideTesterInfra({
        frontend: {
          hasServiceBindings: hasServiceBinding(frontend.config),
          hasLiveService: hasLiveServiceBinding(frontend.bindings),
        },
        provisionType: undefined,
        localTestInfraSupported: this.localTestInfraSupported,
        hasComposePath: false,
        handlerResolves: true,
      })
      if (decision.ok) return
      throw new ConflictError(TESTER_INFRA_MESSAGES[decision.reason], 'tester_infra_unsupported', {
        infraReason: decision.reason,
      })
    }
    const service = await this.contextBuilder.resolveServiceConfig(workspaceId, block)
    const provisioning = service?.provisioning
    // Only `kubernetes`/`custom` need a workspace handler resolved; resolve it lazily and
    // only when the provisioning seam is wired (else pass through, treating it as resolvable).
    const needsHandler = provisioning?.type === 'kubernetes' || provisioning?.type === 'custom'
    const handlerResolves =
      needsHandler && this.environmentProvisioning
        ? (await this.environmentProvisioning.canProvision(workspaceId, provisioning)).ok
        : true
    const decision = decideTesterInfra({
      provisionType: provisioning?.type,
      localTestInfraSupported: this.localTestInfraSupported,
      hasComposePath: !!provisioning?.composePath,
      handlerResolves,
    })
    if (decision.ok) return
    // A docker-compose service that can't stand its infra up (no DinD, or no compose path)
    // surfaces as the "test infra not configured" conflict; a missing handler is distinct.
    if (decision.reason === 'limited-local' || decision.reason === 'compose-unconfigured') {
      throw new ConflictError(TESTER_INFRA_MESSAGES[decision.reason], 'tester_infra_unsupported', {
        infraReason: decision.reason,
      })
    }
    throw new ConflictError(TESTER_INFRA_MESSAGES[decision.reason], 'provision_type_unhandled', {
      provisionType: provisioning!.type,
    })
  }

  /**
   * Guard a pipeline's start when it carries an agent kind that RELIES on binary-artifact
   * storage (the {@link BINARY_STORAGE_TRAIT}, e.g. the UI Tester, which uploads its
   * screenshots there). Such a run would otherwise dispatch and then fail/degrade with no
   * place to store its artifacts, so refuse it up-front with a clear, actionable
   * `binary_storage_unconfigured` conflict the SPA turns into a "configure storage" prompt.
   * The check is trait-driven so it stays universal: a future artifact-producing kind just
   * carries the trait. Pass-through when no store resolver is wired (tests/conformance with
   * no storage) — matching the other optional start guards.
   */
  private async assertBinaryStorageConfigured(
    workspaceId: string,
    agentKinds: readonly string[],
  ): Promise<void> {
    if (!agentKinds.some((kind) => hasTrait(kind, BINARY_STORAGE_TRAIT))) return
    const resolve = this.resolveBinaryArtifactStore
    if (!resolve) return
    const store = await resolve(workspaceId)
    if (store) return
    throw new ConflictError(
      'This pipeline includes an agent that needs binary storage (e.g. the UI Tester, which uploads its screenshots), but this account has no content storage configured. Configure content storage to run it.',
      'binary_storage_unconfigured',
    )
  }

  /**
   * Guard a pipeline's start on having a usable provider for every step's canonical
   * model. The model a step runs is resolved by the same precedence the dispatch path
   * uses (block pin → workspace per-kind default); each canonical id must have a usable
   * provider given what's configured — a direct API key for its provider, a connected
   * subscription vendor, or the opt-in Cloudflare lib enabled. Env-routing defaults (the
   * last fallback, with no catalog id) are operator-level and not gated, matching the
   * personal-credential gate. A throw aborts the start cleanly before any side effects.
   * Skipped when no capability resolver is wired (tests / unconfigured facades).
   */
  private async assertProvidersConfiguredForPipeline(
    workspaceId: string,
    block: Block,
    agentKinds: readonly string[],
    initiatedBy: string | null | undefined,
  ): Promise<void> {
    if (!this.resolveProviderCapabilities) return
    const caps = await this.resolveProviderCapabilities(workspaceId, initiatedBy)
    const runsInline = this.inlineHarnessRef
    // Two failure buckets, so the error can steer the fix precisely:
    //  - `unconfigured`: no usable provider AT ALL (container or inline) — add a key/sub/CF.
    //  - `inlineUnsatisfiable`: usable for a container step but NOT for an INLINE step — a
    //    subscription-only model an inline `generateText` call can't drive (and this
    //    deployment can't run the harness inline). The remedy is different (pin an
    //    inline-capable model, or a preset whose inline steps resolve to one), so a subscription
    //    model that satisfies the container steps but strands the reviewer/brainstorm/estimator
    //    is refused up front instead of failing mid-run against an ungated env default.
    const unconfigured = new Set<string>()
    const inlineUnsatisfiable = new Set<string>()
    const check = (id: string | undefined, inline: boolean): void => {
      if (!id) return
      if (!isModelUsable(id, caps)) unconfigured.add(id)
      else if (inline && !isModelUsableInline(id, caps, runsInline)) inlineUnsatisfiable.add(id)
    }
    if (block.modelId) {
      // A block-level pin applies to every step; it must satisfy an inline step too when the
      // pipeline has one.
      check(block.modelId, agentKinds.some(isInlineModelStep))
    } else if (this.resolveWorkspaceModelDefault) {
      // Independent per-kind resolutions on the start path — run them concurrently.
      const ids = await Promise.all(
        agentKinds.map((kind) =>
          this.resolveWorkspaceModelDefault!(workspaceId, kind, block.modelPresetId),
        ),
      )
      agentKinds.forEach((kind, i) => check(ids[i], isInlineModelStep(kind)))
    }
    if (unconfigured.size > 0) {
      throw new ConflictError(
        `This pipeline uses models with no configured provider: ${[...unconfigured].join(', ')}. ` +
          'Add an API key for the provider, connect a subscription, or enable Cloudflare AI ' +
          'before starting.',
        'providers_unconfigured',
        { models: [...unconfigured] },
      )
    }
    if (inlineUnsatisfiable.size > 0) {
      throw new ConflictError(
        `This pipeline has inline steps (e.g. the requirements reviewer) whose model ` +
          `cannot run inline: ${[...inlineUnsatisfiable].join(', ')}. A subscription-only model ` +
          '(Claude / GPT / GLM) runs only in the container agents, not the inline reviewers — ' +
          'and this deployment has no inline harness. Pick a model preset whose inline steps ' +
          'resolve to a provider-backed model (a direct API key, OpenRouter, or Cloudflare AI), ' +
          'or run local mode with the ambient Claude Code / Codex CLI enabled.',
        'preset_unsatisfiable',
        { models: [...inlineUnsatisfiable] },
      )
    }
  }

  /**
   * Refuse to START / RETRY a run when the workspace has reached its spend budget AND the
   * pipeline has at least one budget-METERED step. A `0` (or exhausted) budget is a
   * deliberate "no paid spend" setting, but it must surface as a clear, up-front error here
   * rather than a silent mid-run pause. Steps that incur no metered cost — a connected
   * subscription model, or a keyless local-runner model — are exempt, so a workspace that
   * runs ONLY local/subscription models starts normally even at a `0` budget. Best-effort:
   * with no capability resolver wired (tests/unconfigured) it is skipped and the mid-run
   * gate still guards. Before any side effects, matching the other start guards.
   */
  private async assertBudgetAllowsPipeline(
    workspaceId: string,
    block: Block,
    agentKinds: readonly string[],
    initiatedBy: string | null | undefined,
  ): Promise<void> {
    if (!(await this.spend.isOverBudget(workspaceId))) return
    if (!this.resolveProviderCapabilities) return
    const caps = await this.resolveProviderCapabilities(workspaceId, initiatedBy)
    const ids: (string | undefined)[] = []
    if (block.modelId) {
      ids.push(block.modelId)
    } else if (this.resolveWorkspaceModelDefault) {
      ids.push(
        ...(await Promise.all(
          agentKinds.map((kind) =>
            this.resolveWorkspaceModelDefault!(workspaceId, kind, block.modelPresetId),
          ),
        )),
      )
    } else {
      ids.push(undefined)
    }
    if (!ids.some((id) => this.modelIdIsMetered(id, caps))) return
    const status = await this.spend.status(workspaceId)
    throw new ConflictError(
      `This workspace has reached its spend budget (${status.costSpent.toFixed(2)}/` +
        `${status.costLimit.toFixed(2)} ${status.currency}). New runs on metered models are ` +
        'paused until the budget is raised (Workspace settings → Budget) or the billing period ' +
        'resets. A task pinned to a local model or a connected subscription still runs.',
    )
  }

  /**
   * Whether a model id will incur metered monetary cost for THIS workspace. Non-metered:
   * a subscription model whose vendor is connected ("subscriptions always win"), or a
   * local-runner model (keyless, on the user's own endpoint). Everything else — including
   * env-default routing (an absent id) and Cloudflare Workers AI — is treated as metered.
   */
  private modelIdIsMetered(id: string | undefined, caps: ProviderCapabilities): boolean {
    const sub = subscriptionOptionFor(id)
    if (sub && caps.subscriptionVendors.has(sub.vendor)) return false
    const ref = resolveModelRef(id, caps)
    if (!ref) return true
    if (ref.harness === 'claude-code' || ref.harness === 'codex') return false
    return !isLocalRunner(ref.provider)
  }

  /**
   * The config/resource preconditions a run must satisfy to START, RETRY **or** RESTART:
   * everything that depends on the workspace environment + the steps being run, and NOT on
   * whether this is a fresh run or a replacement. All three entry points call this so they
   * can't drift — a guard added to one but silently missing from the other is exactly how a
   * subscription-only preset slipped past retry and failed mid-run against the routing default.
   * All checks are read-only and run BEFORE any side effects, each throwing an actionable
   * {@link ConflictError}.
   *
   * The `shape` is the effective chain that will run, NOT the current pipeline definition: a
   * fresh start passes the pipeline, while a retry/restart passes the STORED steps (via
   * {@link runnableShapeOf}) so the guard validates exactly what re-executes — a pipeline
   * edited out of band since the run started can't falsely refuse (or silently skip a check
   * for) a step that isn't actually being re-driven.
   *
   * The concurrency (task-limit) and dependency gates are deliberately NOT here — they are
   * start-only (a retry replaces the failed run rather than adding a new concurrent one, and a
   * re-drive of an already-started task isn't re-gated on its dependencies).
   */
  private async assertRunnable(
    workspaceId: string,
    block: Block,
    shape: PipelineShape,
    initiatedBy: string | null | undefined,
  ): Promise<void> {
    // Reject a structurally-invalid chain (a misplaced companion or estimate-gating without a
    // preceding task-estimator). The builder also rejects these at save, but a pipeline can
    // become invalid out of band.
    validatePipelineShape(shape)

    // A chain with visual steps (`tester-ui` / `visual-confirmation`) needs a UI to exercise:
    // it can only run on a `frontend` frame or a frame a frontend links to — else a `tester-ui`
    // step has no app to drive.
    await this.assertPipelineFrameTypeAllowed(workspaceId, block, shape.agentKinds)

    // A chain with a Tester needs the service's declared provisioning to be runnable
    // (`infraless`/none = no infra, `docker-compose` = DinD, `kubernetes`/`custom` = a handler).
    if (shape.agentKinds.some(isTesterKind)) {
      await this.assertTesterInfraConfigured(workspaceId, block)
    }

    // A chain carrying an agent that relies on binary-artifact storage (the UI Tester uploads
    // screenshots) needs the account to have storage configured.
    await this.assertBinaryStorageConfigured(workspaceId, shape.agentKinds)

    // A workspace that delegates container agents to a runner pool needs that pool registered
    // (local mode opt-in). No-op on Cloudflare/Node (fixed backend) and when delegation is off.
    await this.assertAgentBackendConfigured?.(workspaceId)

    // Every step's canonical model must have a usable provider — a container step needs any
    // usable flavour, an INLINE step needs an inline-usable one (a subscription-only model can't
    // run inline without an inline harness). This is the gate a retry used to skip.
    await this.assertProvidersConfiguredForPipeline(
      workspaceId,
      block,
      shape.agentKinds,
      initiatedBy,
    )

    // Refuse a metered run once the spend budget is reached (a clear error rather than a silent
    // mid-run pause). A local/subscription-only pipeline is exempt.
    await this.assertBudgetAllowsPipeline(workspaceId, block, shape.agentKinds, initiatedBy)
  }

  /**
   * The {@link PipelineShape} a retry/restart re-drives: the stored run's steps ARE the enabled,
   * ordered chain that will run again, so {@link assertRunnable} validates exactly what
   * re-executes rather than the current pipeline definition (which may have been edited out of
   * band since the run started). Disabled steps were already filtered out at start, so every
   * stored step is enabled.
   */
  private runnableShapeOf(steps: readonly PipelineStep[]): PipelineShape {
    return {
      agentKinds: steps.map((s) => s.agentKind),
      gating: steps.map((s) => s.gating ?? null),
      // The QC companion's live step-state carries the same `gating` config the pipeline set, so
      // the tester-QC gating validation re-runs on a retry against exactly what re-executes.
      testerQuality: steps.map((s) => s.testerQuality ?? null),
    }
  }

  /** Start a pipeline against a block, replacing any prior run on it. */
  async start(
    workspaceId: string,
    blockId: string,
    pipelineId: string,
    /**
     * Internal user id of the initiator. Recorded on the run so an individual-usage
     * model (Claude) uses this user's OWN personal subscription. Absent for
     * system-initiated runs (recurring schedules) and auth-disabled dev.
     */
    initiatedBy?: string | null,
    /**
     * Mint the per-run personal-credential activation for an individual-usage model.
     * Invoked with the new run's id BEFORE it is persisted/dispatched, so the async
     * steps can lease it; a throw (wrong/missing password) aborts the start cleanly
     * with nothing persisted. The server layer supplies this (the personal store lives
     * outside the domain Core); absent for non-individual runs.
     */
    activate?: (executionId: string) => Promise<void>,
  ): Promise<ExecutionInstance> {
    await this.requireWorkspace(workspaceId)
    const block = await this.requireBlock(workspaceId, blockId)
    const pipeline = assertFound(
      await this.pipelineRepository.get(workspaceId, pipelineId),
      'Pipeline',
      pipelineId,
    )

    // Shared config/resource preconditions (pipeline shape, frame type, tester infra, binary
    // storage, agent backend, provider/preset satisfiability, budget) — the SAME gate a retry
    // runs, so the two can't drift. See assertRunnable.
    await this.assertRunnable(workspaceId, block, pipeline, initiatedBy)

    // START-ONLY gates below: a retry REPLACES the failed run rather than adding a new one, so
    // the concurrency limit doesn't apply to it, and a re-drive of an already-started task isn't
    // re-gated on its dependencies.

    // Enforce the workspace's per-service running-task limit (off by default) — a clear,
    // actionable error before any side effects, so the human knows why the start was refused.
    await this.assertWithinTaskLimit(workspaceId, block)

    // Hard dependency gate: a task cannot start while any block it `dependsOn` is unfinished
    // (not yet `done`/merged). Enforced server-side so it holds for manual starts, recurring
    // fires, auto-start propagation and direct API calls alike — the frontend's runnable
    // check is only a hint. Before any side effects so nothing is torn down on a refusal.
    await this.assertDependenciesMet(workspaceId, block)

    // Mint the activation next: if the credential can't be unlocked, fail before
    // tearing down the block's prior run or creating a new one.
    const executionId = this.idGenerator.next('exec')
    await activate?.(executionId)

    // Replacing the block's prior run: clear its per-run activation now (it never reaches
    // the terminal cleanup in emitInstance when it's still running), so a replaced run's
    // system-encrypted token copy doesn't linger to its TTL. Keyed by the OLD run id, so
    // the activation just minted for the new run is untouched.
    if (this.subscriptionActivations) {
      const prior = await this.executionRepository.getByBlock(workspaceId, blockId)
      if (prior && prior.id !== executionId) {
        // Best-effort + idempotent, mirroring the terminal cleanup in RunStateMachine.emit: a
        // failure here must never derail the start. In mothership mode this repo is remote and
        // `deleteByExecution` is not yet allow-listed (it throws `unknown_method`), so an
        // unguarded call would otherwise break re-running any block; the TTL sweep reclaims the
        // stale activation row as the backstop.
        try {
          await this.subscriptionActivations.deleteByExecution(prior.id)
        } catch {
          // Swallow — see above.
        }
      }
    }

    await this.executionRepository.deleteByBlock(workspaceId, blockId)

    // Build the run only from the ENABLED steps. A step the pipeline marked
    // `enabled[i] === false` is kept in the saved pipeline (so it can be toggled back
    // on later) but skipped here entirely. Gates/thresholds are read by the kind's
    // ORIGINAL index `i`, so they stay aligned to the kind even when earlier steps are
    // skipped; the first SURVIVING step is the one that starts working.
    const steps: PipelineStep[] = pipeline.agentKinds
      .map((kind, i) => ({ kind, i }))
      .filter(({ i }) => pipeline.enabled?.[i] !== false)
      .map(({ kind, i }, position) => {
        const companionDef = companionFor(kind)
        return {
          agentKind: kind,
          state: position === 0 ? 'working' : 'pending',
          progress: 0,
          decision: null,
          // A gated step pauses for human approval once its proposal is ready (see
          // recordStepResult). Copied from the pipeline definition at run start.
          requiresApproval: pipeline.gates?.[i] ?? false,
          approval: null,
          // A consensus-enabled step runs through the multi-model mechanism (the consensus
          // executor reads this off the context). Copied from the pipeline at run start.
          ...(pipeline.consensus?.[i] ? { consensus: pipeline.consensus[i] } : {}),
          // Estimate gating: when set+enabled the step is skipped at runtime unless the
          // block estimate (written by an earlier task-estimator step) meets the threshold.
          ...(pipeline.gating?.[i] ? { gating: pipeline.gating[i] } : {}),
          // A companion step carries its quality bar + rework budget, seeded from the
          // pipeline's per-step threshold (else the companion's default).
          ...(companionDef
            ? {
                companion: {
                  threshold: pipeline.thresholds?.[i] ?? companionDef.defaultThreshold,
                  maxAttempts: DEFAULT_COMPANION_MAX_ATTEMPTS,
                  attempts: 0,
                  verdicts: [],
                },
              }
            : {}),
          // The Follow-up companion is on by default for a `coder` step; the pipeline's
          // per-step `followUps[i] === false` toggle disables it. Seeded empty here; the
          // harness streams items in as the Coder surfaces them (see pollAgentJob).
          ...(kind === FOLLOW_UP_PRODUCER_KIND && pipeline.followUps?.[i] !== false
            ? {
                followUps: {
                  enabled: true,
                  items: [],
                  loops: 0,
                  maxLoops: DEFAULT_FOLLOW_UP_MAX_LOOPS,
                },
              }
            : {}),
          // The test quality-control companion is on by default for a Tester step; the
          // pipeline's per-step `testerQuality[i].enabled === false` disables it. `maxAttempts`
          // is seeded with the default ceiling here and refreshed from the task's resolved
          // merge preset on the first report (TesterController). Optional estimate gating is
          // carried through so it can be evaluated against the block estimate at gate time.
          ...(isTesterKind(kind) && pipeline.testerQuality?.[i]?.enabled !== false
            ? {
                testerQuality: {
                  enabled: true,
                  attempts: 0,
                  maxAttempts: DEFAULT_MERGE_PRESET.maxTesterQualityIterations,
                  verdicts: [],
                  ...(pipeline.testerQuality?.[i]?.gating
                    ? { gating: pipeline.testerQuality[i]!.gating }
                    : {}),
                },
              }
            : {}),
        }
      })
    if (steps.length === 0) {
      throw new ValidationError('Pipeline has no enabled steps to run.')
    }
    const instance: ExecutionInstance = {
      id: executionId,
      blockId,
      pipelineId: pipeline.id,
      pipelineName: pipeline.name,
      steps,
      currentStep: 0,
      status: 'running',
      initiatedBy: initiatedBy ?? null,
    }
    await this.executionRepository.upsert(workspaceId, instance)
    await this.blockRepository.update(workspaceId, blockId, {
      status: 'in_progress',
      progress: 0,
      executionId: instance.id,
    })
    // Hand the run off to the durable runner so it progresses server-side without
    // a browser open. With the no-op runner (tests) this does nothing and the run
    // is advanced directly via advanceInstance.
    await this.workRunner.startRun(workspaceId, instance.id)
    await this.runStateMachine.emitInstance(workspaceId, instance)
    return instance
  }

  /**
   * Enforce the workspace's per-service running-task limit before a task run starts.
   * No-ops unless the settings module is wired, the block is a task, and a limit mode
   * is active. Counts the tasks under the same service frame that already have a live
   * run (running / blocked / paused) — bucketed by task type when the mode is
   * `per_type`, else shared across all types — and throws a {@link ConflictError} (→ 409,
   * shown as a toast) when the cap is reached. The starting block is excluded from the
   * count (its prior run is about to be replaced).
   */
  /**
   * Refuse a task start while any of its dependencies is unfinished. A task may only run
   * once every block it `dependsOn` has reached `done` (its PR merged). No-ops for
   * non-task blocks and for tasks with no dependencies. Throws a {@link ConflictError}
   * (→ 409, shown as a toast) naming the unfinished blockers so the human knows why.
   */
  private async assertDependenciesMet(workspaceId: string, block: Block): Promise<void> {
    if (block.level !== 'task' || block.dependsOn.length === 0) return
    const blocks = await this.augmentWithCrossWorkspaceDeps(
      await this.blockRepository.listByWorkspace(workspaceId),
      block.dependsOn,
    )
    if (dependenciesMet(blocks, block.id)) return
    const blockers = unmetDependencies(blocks, block.id)
    const names = blockers.map((b) => `"${b.title}"`).join(', ')
    throw new ConflictError(
      `This task is blocked by ${blockers.length} unfinished dependenc${
        blockers.length === 1 ? 'y' : 'ies'
      }${names ? ` (${names})` : ''}. Finish them before starting this task.`,
      'dependencies_unmet',
      { count: blockers.length, blockers: blockers.map((b) => b.title) },
    )
  }

  /**
   * Augment a workspace's block list (in place) with any dependency blocks referenced by
   * `depIds` that aren't already present — a `dependsOn` edge can point at a task homed in a
   * DIFFERENT workspace (a shared/mounted service). Resolved via the cross-workspace
   * {@link BlockRepository.findByIds} (one batched query, not a point-read per id), so a
   * shared-service blocker is evaluated by its real status instead of being silently treated
   * as satisfied (missing ⇒ done). Returns the same (now-augmented) array for chaining.
   */
  private async augmentWithCrossWorkspaceDeps(blocks: Block[], depIds: string[]): Promise<Block[]> {
    const have = new Set(blocks.map((b) => b.id))
    const missing = [...new Set(depIds)].filter((id) => !have.has(id))
    if (missing.length === 0) return blocks
    for (const found of await this.blockRepository.findByIds(missing)) {
      blocks.push(found.block)
    }
    return blocks
  }

  private async assertWithinTaskLimit(workspaceId: string, block: Block): Promise<void> {
    const settingsService = this.workspaceSettingsService
    if (!settingsService || block.level !== 'task') return
    const settings = await settingsService.get(workspaceId)
    if (settings.taskLimitMode === 'off') return

    const all = await this.blockRepository.listByWorkspace(workspaceId)
    const byId = new Map(all.map((b) => [b.id, b]))
    // Walk up to the owning service frame.
    let frame: Block | undefined = block
    let guard = 0
    while (frame && frame.level !== 'frame' && guard++ < 1000) {
      frame = frame.parentId ? byId.get(frame.parentId) : undefined
    }
    if (!frame || frame.level !== 'frame') return // orphan task — nothing to scope a service limit to
    const frameId = frame.id

    const underFrame = (b: Block): boolean => {
      let cur: Block | undefined = b
      let hops = 0
      while (cur && hops++ < 1000) {
        if (cur.id === frameId) return true
        cur = cur.parentId ? byId.get(cur.parentId) : undefined
      }
      return false
    }

    const executions = await this.executionRepository.listByWorkspace(workspaceId)
    const liveBlockIds = new Set(
      executions
        .filter((e) => e.status === 'running' || e.status === 'blocked' || e.status === 'paused')
        .map((e) => e.blockId),
    )
    const siblingTasks = all.filter((b) => b.level === 'task' && b.id !== block.id && underFrame(b))

    if (settings.taskLimitMode === 'shared') {
      const limit = settings.taskLimitShared ?? 0
      const running = siblingTasks.filter((b) => liveBlockIds.has(b.id)).length
      if (running >= limit) {
        throw new ConflictError(
          `"${frame.title}" is already running ${running} of ${limit} allowed task(s). ` +
            `Wait for one to finish before starting another.`,
          'task_limit_reached',
          { frame: frame.title, limit, running },
        )
      }
      return
    }

    // per_type: only the configured types are capped; an unconfigured type is unbounded.
    const type = block.taskType ?? 'feature'
    const perType = (settings.taskLimitPerType ?? {}) as Record<string, number>
    const limit = perType[type]
    if (limit == null) return
    const running = siblingTasks.filter(
      (b) => liveBlockIds.has(b.id) && (b.taskType ?? 'feature') === type,
    ).length
    if (running >= limit) {
      throw new ConflictError(
        `"${frame.title}" is already running ${running} of ${limit} allowed ${type} task(s). ` +
          `Wait for one to finish before starting another ${type} task.`,
        'task_limit_reached',
        { frame: frame.title, limit, running, taskType: type },
      )
    }
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
    if (await this.spend.isOverBudget(workspaceId)) {
      if (!(await this.runDispatcher.currentStepIsNonMetered(workspaceId, instance, step))) {
        if (instance.status !== 'paused') {
          instance.status = 'paused'
          await this.executionRepository.upsert(workspaceId, instance)
          await this.runStateMachine.emitInstance(workspaceId, instance)
        }
        return { kind: 'paused' }
      }
    }
    if (instance.status === 'paused') instance.status = 'running'

    if (step.state === 'waiting_decision') {
      // The requirements gate is re-entrant: when the human answers the findings and asks to
      // incorporate (`pendingIncorporation`), or asks the Requirement Writer to recommend answers
      // (`pendingRecommendation`), a marker is set on the parked step and the run is signalled to
      // wake. Fall through so the gate re-evaluates — folding + re-reviewing, or running the
      // Writer per finding, in the durable driver (the LLM work that used to block the HTTP
      // request) — instead of immediately re-parking. Every other parked step (and a requirements
      // gate with nothing pending) re-parks on its durable decision id.
      const reentrantRequirements =
        (step.agentKind === REQUIREMENTS_REVIEW_AGENT_KIND ||
          step.agentKind === CLARITY_REVIEW_AGENT_KIND ||
          step.agentKind === REQUIREMENTS_BRAINSTORM_AGENT_KIND ||
          step.agentKind === ARCHITECTURE_BRAINSTORM_AGENT_KIND) &&
        (!!step.pendingIncorporation || !!step.pendingRecommendation)
      // The human-testing gate is likewise re-entrant: a human action (confirm / request a
      // fix / pull main / recreate) records a `pendingAction` on the parked step and wakes
      // the driver. Fall through so the gate re-evaluates and acts on it (dispatch a helper,
      // rebuild the env, or advance) instead of immediately re-parking.
      const reentrantHumanTest =
        step.agentKind === HUMAN_TEST_AGENT_KIND && !!step.humanTest?.pendingAction
      // The visual-confirmation gate is likewise re-entrant on a human action.
      const reentrantVisualConfirm =
        step.agentKind === VISUAL_CONFIRM_AGENT_KIND && !!step.visualConfirm?.pendingAction
      if (!reentrantRequirements && !reentrantHumanTest && !reentrantVisualConfirm) {
        // Parked on either an agent-raised decision or a human approval gate; both
        // are addressed by the same durable event id.
        const pendingId = step.decision?.id ?? step.approval?.id
        if (pendingId) {
          instance.status = 'blocked'
          await this.executionRepository.upsert(workspaceId, instance)
          await this.runStateMachine.emitInstance(workspaceId, instance)
          return { kind: 'awaiting_decision', decisionId: pendingId }
        }
      }
    }
    this.stepGraph.startStep(step)

    const block = await this.blockRepository.get(workspaceId, instance.blockId)
    if (!block) return { kind: 'noop' }
    const isFinalStep = instance.currentStep === instance.steps.length - 1

    // Estimate gating: a step gated on the task estimate (today a conditional companion)
    // is transparently SKIPPED when the estimate — written by an earlier task-estimator
    // step in this same run — falls below the threshold. No agent is spun up; the step
    // finishes as `skipped` and the run advances. Evaluated here (not at build time)
    // because the estimate only exists once the estimator step has run.
    if (step.gating?.enabled && !shouldRunGatedStep(block.estimate, step.gating)) {
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

  /** @see RunDispatcher.resolveGatePollExhaustion */
  resolveGatePollExhaustion(workspaceId: string, executionId: string): Promise<AdvanceResult> {
    return this.runDispatcher.resolveGatePollExhaustion(workspaceId, executionId)
  }

  /** @see RunDispatcher.getFollowUps */
  getFollowUps(workspaceId: string, executionId: string): Promise<FollowUpsStepState | null> {
    return this.runDispatcher.getFollowUps(workspaceId, executionId)
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
    await this.blockRepository.update(workspaceId, block.id, { technical }).catch(() => {})
  }

  // ---- iterative review gates (requirements + clarity) --------------------
  // The two gate flows live in {@link ReviewGateController}, parameterised by a
  // {@link ReviewKind}. The public methods below are thin delegators (the HTTP controllers
  // call them) and the kind builders supply each subject's differentiators. Three shared
  // state-machine primitives stay here — they are reused by the generic approval path and
  // the companion iteration-cap gate, so they have a single home: {@link parkStepOnDecision},
  // {@link advancePastResolvedGate} and {@link dispatchIterationCap}.

  /**
   * Two gates park on a `step.approval` but are NOT generic prose approvals — they are
   * iterative gates driven by their own dedicated surface, never the generic
   * approve/request-changes/reject resolvers (which would advance the run bypassing the
   * loop). Guard those resolvers so a stray approve can't short-circuit either gate:
   * - the requirements-review gate (driven by re-review / proceed / resolve-exceeded);
   * - a companion gate that hit its rework cap (`companion.exceeded`), driven by
   *   {@link resolveCompanionExceeded}'s one-more-round / proceed / stop-reset choices.
   */
  private assertNotIterativeGate(step: PipelineStep): void {
    if (step.agentKind === REQUIREMENTS_REVIEW_AGENT_KIND) {
      throw new ConflictError(
        'Resolve the requirements review through its review window, not the approval gate',
      )
    }
    if (step.agentKind === CLARITY_REVIEW_AGENT_KIND) {
      throw new ConflictError(
        'Resolve the clarity review through its review window, not the approval gate',
      )
    }
    if (
      step.agentKind === REQUIREMENTS_BRAINSTORM_AGENT_KIND ||
      step.agentKind === ARCHITECTURE_BRAINSTORM_AGENT_KIND
    ) {
      throw new ConflictError(
        'Resolve the brainstorm through its brainstorm window, not the approval gate',
      )
    }
    if (step.agentKind === HUMAN_TEST_AGENT_KIND) {
      throw new ConflictError(
        'Resolve the human-testing gate through its window (confirm / request a fix), not the approval gate',
      )
    }
    if (step.agentKind === VISUAL_CONFIRM_AGENT_KIND) {
      throw new ConflictError(
        'Resolve the visual-confirmation gate through its window (approve / request a fix), not the approval gate',
      )
    }
    if (step.companion?.exceeded) {
      throw new ConflictError(
        'Resolve this companion review through its iteration-cap prompt, not the approval gate',
      )
    }
    if (step.followUps?.enabled && step.followUps.items.some((i) => i.status === 'pending')) {
      throw new ConflictError(
        'Resolve the follow-up companion through its window (file / send back / answer / dismiss), not the approval gate',
      )
    }
  }

  /**
   * The requirements subject for {@link reviewGate}: closures over the requirements reviewer
   * service. The service-not-configured guard preserves the exact 409 the inline reviewer
   * raised before this extraction.
   */
  private buildRequirementsKind(): ReviewKind<RequirementReview> {
    const require = (): RequirementReviewService => {
      if (!this.requirementReviewService?.enabled) {
        throw new ConflictError('The requirements reviewer is not configured')
      }
      return this.requirementReviewService
    }
    return {
      agentKind: REQUIREMENTS_REVIEW_AGENT_KIND,
      entityName: 'Requirement review',
      enabled: () => !!this.requirementReviewService?.enabled,
      getForBlock: (ws, blockId) => require().getForBlock(ws, blockId),
      review: (ws, block, preset) =>
        require().review(ws, block.id, {
          maxIterations: preset.maxRequirementIterations,
          concernThreshold: preset.maxRequirementConcernAllowed,
        }),
      reReview: (ws, reviewId, preset) =>
        require().reReview(ws, reviewId, { concernThreshold: preset.maxRequirementConcernAllowed }),
      incorporate: async (ws, _blockId, reviewId, feedback) => {
        await require().incorporate(ws, reviewId, { feedback })
      },
      markIncorporated: (ws, reviewId) => require().markIncorporated(ws, reviewId),
      markReReviewing: (ws, reviewId) => require().markReReviewing(ws, reviewId),
      markIncorporating: (ws, reviewId) => require().markIncorporating(ws, reviewId),
      grantExtraRound: (ws, reviewId) => require().grantExtraRound(ws, reviewId),
      prepareRecommendations: (ws, reviewId, itemIds, note) =>
        require().prepareRecommendations(ws, reviewId, itemIds, note),
      markRecommendationPending: (ws, reviewId, recId, note) =>
        require().markRecommendationPending(ws, reviewId, recId, note),
      fillRecommendations: async (ws, blockId) => {
        const svc = require()
        const review = assertFound(
          await svc.getForBlock(ws, blockId),
          'Requirement review',
          blockId,
        )
        await svc.fillPendingRecommendations(ws, review.id, {
          onProgress: (r) => this.events.requirementReviewChanged?.(ws, r) ?? Promise.resolve(),
        })
        return assertFound(await svc.getForBlock(ws, blockId), 'Requirement review', blockId)
      },
      emit: (ws, review) => this.events.requirementReviewChanged?.(ws, review) ?? Promise.resolve(),
    }
  }

  /**
   * The clarity (bug-report triage) subject for {@link reviewGate}: threads any upstream
   * `bug-investigator` output into the reviewer/incorporation context, otherwise identical to
   * the requirements kind.
   */
  private buildClarityKind(): ReviewKind<ClarityReview> {
    const require = (): ClarityReviewService => {
      if (!this.clarityReviewService?.enabled) {
        throw new ConflictError('The clarity reviewer is not configured')
      }
      return this.clarityReviewService
    }
    return {
      agentKind: CLARITY_REVIEW_AGENT_KIND,
      entityName: 'Clarity review',
      enabled: () => !!this.clarityReviewService?.enabled,
      getForBlock: (ws, blockId) => require().getForBlock(ws, blockId),
      review: async (ws, block, preset) =>
        require().review(ws, block.id, {
          maxIterations: preset.maxRequirementIterations,
          concernThreshold: preset.maxRequirementConcernAllowed,
          investigation: await this.investigationForBlock(ws, block.id),
        }),
      reReview: (ws, reviewId, preset) =>
        require().reReview(ws, reviewId, { concernThreshold: preset.maxRequirementConcernAllowed }),
      incorporate: async (ws, blockId, reviewId, feedback) => {
        const investigation = await this.investigationForBlock(ws, blockId)
        await require().incorporate(ws, reviewId, { feedback, investigation })
      },
      markIncorporated: (ws, reviewId) => require().markIncorporated(ws, reviewId),
      markReReviewing: (ws, reviewId) => require().markReReviewing(ws, reviewId),
      markIncorporating: (ws, reviewId) => require().markIncorporating(ws, reviewId),
      grantExtraRound: (ws, reviewId) => require().grantExtraRound(ws, reviewId),
      emit: (ws, review) => this.events.clarityReviewChanged?.(ws, review) ?? Promise.resolve(),
    }
  }

  /**
   * A brainstorm (structured-dialogue) subject for {@link reviewGate}, parameterised by stage.
   * Otherwise identical to the requirements kind — the service handles its own upstream context
   * (the architecture stage seeds from the refined requirements). The brainstorm services
   * resolve their model exactly like the requirements reviewer, so the cap knobs are reused.
   */
  private buildBrainstormKind(
    stage: BrainstormStage,
    agentKind: string,
  ): ReviewKind<BrainstormSession> {
    const require = (): BrainstormService => {
      const svc = this.brainstormServices?.[stage]
      if (!svc?.enabled) throw new ConflictError('The brainstorm agent is not configured')
      return svc
    }
    return {
      agentKind,
      entityName: 'Brainstorm session',
      enabled: () => !!this.brainstormServices?.[stage]?.enabled,
      getForBlock: (ws, blockId) => require().getForBlock(ws, blockId),
      review: (ws, block, preset) =>
        require().review(ws, block.id, {
          maxIterations: preset.maxRequirementIterations,
          concernThreshold: preset.maxRequirementConcernAllowed,
        }),
      reReview: (ws, reviewId, preset) =>
        require().reReview(ws, reviewId, { concernThreshold: preset.maxRequirementConcernAllowed }),
      incorporate: async (ws, _blockId, reviewId, feedback) => {
        await require().incorporate(ws, reviewId, { feedback })
      },
      markIncorporated: (ws, reviewId) => require().markIncorporated(ws, reviewId),
      markReReviewing: (ws, reviewId) => require().markReReviewing(ws, reviewId),
      markIncorporating: (ws, reviewId) => require().markIncorporating(ws, reviewId),
      grantExtraRound: (ws, reviewId) => require().grantExtraRound(ws, reviewId),
      emit: (ws, session) =>
        this.events.brainstormSessionChanged?.(ws, session) ?? Promise.resolve(),
    }
  }

  /** Pick the brainstorm kind for a stage (the dedicated window drives both via the same loop). */
  private brainstormKindFor(stage: BrainstormStage): ReviewKind<BrainstormSession> {
    return stage === 'architecture'
      ? this.architectureBrainstormKind
      : this.requirementsBrainstormKind
  }

  /**
   * Route an iteration-cap resolution to its gate-specific handlers. `stop-reset` is
   * uniform across gates: cancel the run and return the block to phase zero (editable),
   * keeping whatever reference artifact each gate persists (the requirements doc on its
   * own table; a companion's producer output on its branch). Shared by the requirements
   * gate (`requirementsReview.resolveExceeded`, via {@link ReviewGateController}) and the
   * companion gate ({@link resolveCompanionExceeded}) so the three-way choice lives in one place.
   */
  private async dispatchIterationCap(
    workspaceId: string,
    blockId: string,
    choice: IterationCapChoice,
    handlers: { extraRound: () => Promise<unknown>; proceed: () => Promise<unknown> },
  ): Promise<void> {
    if (choice === 'extra-round') {
      await handlers.extraRound()
    } else if (choice === 'proceed') {
      await handlers.proceed()
    } else {
      // stop-reset: tear down the run + reset the block to phase zero (editable).
      await this.cancel(workspaceId, blockId)
    }
  }

  /**
   * Resolve a companion step parked at its automatic-rework cap (`companion.exceeded`):
   * grant one more round, proceed accepting the producer's current output, or stop the
   * task and reset it to phase zero. The companion mirror of the requirements
   * iteration-cap resolution (`requirementsReview.resolveExceeded`), sharing the iteration-cap dispatch + the
   * gate-resume plumbing. Idempotent — an already-resolved gate returns the instance
   * unchanged. Scoped by execution + approval id (the execution controller surface),
   * since a companion gate is not block-addressed like the requirements window.
   */
  async resolveCompanionExceeded(
    workspaceId: string,
    executionId: string,
    approvalId: string,
    choice: IterationCapChoice,
  ): Promise<ExecutionInstance> {
    await this.requireWorkspace(workspaceId)
    // NOTE (optimistic concurrency): unlike the other human-action handlers (resolveDecision /
    // requestChanges / rejectStep / requestHumanReviewFix), this one is NOT yet routed through
    // `mutateInstance`. Its two branches persist through the shared gate-resume plumbing
    // (`dispatchIterationCap` → `advancePastResolvedGate`), which owns its own upsert + signal +
    // emit, so CAS-guarding it cleanly requires splitting that shared helper into a pure-mutation
    // part and a side-effect part. Tracked as the remaining slice of the lost-update fix; the
    // window is small (a human resolving a companion iteration-cap racing the driver).
    const instance = assertFound(
      await this.executionRepository.get(workspaceId, executionId),
      'Execution',
      executionId,
    )
    const stepIndex = instance.steps.findIndex((s) => s.approval?.id === approvalId)
    const step = instance.steps[stepIndex]
    if (!step || !step.approval) throw new NotFoundError('Approval', approvalId)
    if (!step.companion?.exceeded) {
      throw new ConflictError(`Approval '${approvalId}' is not a companion iteration-cap gate`)
    }
    if (step.approval.status === 'approved') return instance

    await this.dispatchIterationCap(workspaceId, instance.blockId, choice, {
      // Grant one more automatic rework: raise the budget by one, clear the cap flag, then
      // loop the producer back through the companion to re-grade (`rerunProducerThrough`
      // un-parks the gate by resetting the companion step). The last verdict's feedback
      // drives the rework, the same way the automatic loop folds the live assessment in.
      extraRound: async () => {
        step.companion!.maxAttempts += 1
        step.companion!.exceeded = undefined
        const producer = instance.steps[this.stepGraph.companionProducerIndex(instance, stepIndex)]
        this.stepGraph.loopCompanionProducer(instance, stepIndex, {
          previousProposal: producer?.output ?? '',
          feedback: step.companion!.verdicts.at(-1)?.feedback ?? '',
        })
        await this.runStateMachine.updateBlockProgress(workspaceId, instance, 'in_progress')
        await this.executionRepository.upsert(workspaceId, instance)
        await this.workRunner.signalDecision(workspaceId, instance.id, approvalId, 'extra-round')
        await this.runStateMachine.emitInstance(workspaceId, instance)
      },
      // Proceed: accept the producer's current output and advance past the gate.
      proceed: async () => {
        step.companion!.exceeded = undefined
        step.approval!.status = 'approved'
        // The spec-companion never reached its automatic PASS branch, but both signals are
        // persisted (the producer's `noBusinessSpecs` + this step's `technicalCorroborated`),
        // so infer the block's `technical` label here too — best-effort, human-authority
        // preserved — before advancing.
        if (step.agentKind === 'spec-companion') {
          const producer =
            instance.steps[this.stepGraph.companionProducerIndex(instance, stepIndex)]
          const block = await this.blockRepository.get(workspaceId, instance.blockId)
          if (producer && block) await this.inferBlockTechnical(workspaceId, block, producer, step)
        }
        await this.runStateMachine.advancePastResolvedGate(workspaceId, instance, stepIndex)
      },
    })
    return instance
  }

  // ---- clarity-review context helpers (bug-report triage) ------------------
  // The clarity gate triages a block's bug report — optionally enriched by an upstream
  // `bug-investigator` step's prose output — through the SAME {@link ReviewGateController}
  // flow as requirements; these two helpers resolve that investigator output as the triage
  // subject, threaded into the clarity {@link ReviewKind}.

  /** The latest `bug-investigator` step output on a run (the triage subject), or undefined. */
  private investigationFor(instance: ExecutionInstance): string | undefined {
    for (let i = instance.steps.length - 1; i >= 0; i--) {
      const s = instance.steps[i]!
      if (s.agentKind === BUG_INVESTIGATOR_AGENT_KIND && s.output) return s.output
    }
    return undefined
  }

  /** Resolve a block's investigator output via its current execution (off the gate path). */
  private async investigationForBlock(
    workspaceId: string,
    blockId: string,
  ): Promise<string | undefined> {
    const block = await this.blockRepository.get(workspaceId, blockId)
    if (!block?.executionId) return undefined
    const instance = await this.executionRepository.get(workspaceId, block.executionId)
    return instance ? this.investigationFor(instance) : undefined
  }

  // The clarity / human-testing / visual-confirmation gate-window actions now live on the
  // per-feature sub-facades (`clarityReview` / `humanTest` / `visualConfirm`); see the getters
  // above and {@link gate-window-facades}.

  /**
   * Dispatch the `fixer` against the human-review gate's PR branch from a human's freeform
   * instructions — bypassing the precheck + grace window. Parks a `pendingFix` on the gate step,
   * consumed on the gate's next poll (see {@link evaluateGate}) which dispatches the fixer with
   * the instructions folded in. A second request before the first is consumed simply replaces the
   * pending instructions. Throws when no human-review gate is currently parked.
   *
   * The run is re-driven via `workRunner.startRun` so the pending fix is picked up promptly even
   * when the driver had died (e.g. its durable advance job expired/was evicted before the stale-
   * run sweeper re-drove it) — `startRun` is idempotent for a live run (the exclusive advance
   * queue no-ops a duplicate send), so this only has an effect when no driver is currently
   * polling. A spend-paused run is left paused (it resumes through its own path).
   */
  async requestHumanReviewFix(
    workspaceId: string,
    blockId: string,
    instructions: string,
  ): Promise<ExecutionInstance> {
    const block = await this.blockRepository.get(workspaceId, blockId)
    if (!block?.executionId) {
      throw new ConflictError('No human-review gate is currently awaiting input')
    }
    // Optimistic-concurrency write: parking the `pendingFix` can race the gate's own poll
    // (the durable driver advancing the run), so re-read + re-apply on fresh state instead
    // of clobbering — the lost-update fix, same path as resolveDecision. The validation runs
    // inside the mutation so it sees the run as it stands at write time.
    const instance = await this.runStateMachine.mutateInstance(
      workspaceId,
      block.executionId,
      (inst) => {
        const step = inst.steps[inst.currentStep]
        if (!step || step.agentKind !== HUMAN_REVIEW_AGENT_KIND || !step.gate) {
          throw new ConflictError('No human-review gate is currently awaiting input')
        }
        // The fix is consumed by evaluateGate's pendingFix branch, which dispatches the fixer
        // ONLY when the gate's provider is wired AND there is an async executor to escalate to.
        // Reject up front when neither holds, instead of silently parking a pendingFix the gate
        // would discard on its pass-through (an unwired gate advances) — the caller must see the
        // failure, not a 200.
        const gate = this.runDispatcher.gateFor(step.agentKind)
        if (!gate?.wired() || !isAsyncAgentExecutor(this.agentExecutor)) {
          throw new ConflictError(
            'The human-review gate cannot dispatch a fix on this deployment (no review provider or async executor configured)',
          )
        }
        step.gate.pendingFix = { instructions, at: this.clock.now() }
        // Re-arm a decision-parked run so the re-driven loop polls instead of no-oping; a spend-
        // paused run stays paused.
        if (inst.status === 'blocked') inst.status = 'running'
      },
    )
    await this.runStateMachine.emitInstance(workspaceId, instance)
    // Ensure a driver is active to consume the pending fix (idempotent for a live run).
    if (instance.status === 'running') {
      await this.workRunner.startRun(workspaceId, instance.id)
    }
    return instance
  }

  /**
   * Merge a block's PR for real, then mark it `done`. The remote merge happens
   * FIRST (via the {@link PullRequestMerger} port) and only on its success does the
   * block flip to `done` — so `done` provably means "merged", not a board-only
   * status. When no merger is wired (tests) this degrades to the old board-only
   * flip. Throws if the remote merge fails so callers can fall back to a manual
   * merge / review notification.
   */
  private async finalizeMerge(workspaceId: string, blockId: string): Promise<void> {
    const block = await this.blockRepository.get(workspaceId, blockId)
    if (!block) return
    // Idempotent under durable-driver replays: a crash between the real merge and the
    // instance persist re-runs the merger resolver, and re-merging an already-merged PR
    // throws — which the resolver's fall-through would then misread as a failed merge
    // and downgrade the block to `pr_ready`. `done` already means "merged"; keep it.
    if (block.status === 'done') return
    if (this.prMerger && block.pullRequest) {
      // Throws on a blocked/failed merge — the caller decides what to do next.
      await this.prMerger.mergeForBlock(workspaceId, blockId)
    }
    await this.blockRepository.update(workspaceId, blockId, { status: 'done', progress: 1 })
    // Best-effort writeback: comment + close the task's linked tracker issue(s) as
    // resolved now the PR is merged. Gated inside the provider by the workspace
    // setting + per-task override; fire-and-forget so a tracker outage never fails
    // the run (the merge already happened).
    if (this.issueWriteback && block.pullRequest) {
      await this.issueWriteback
        .onPullRequestMerged(workspaceId, block, block.pullRequest)
        .catch(() => {})
    }
    if ((block.level ?? 'frame') === 'task') {
      await this.applyModuleAssignment(workspaceId, blockId)
      // Propagate to dependents: if this task opted into auto-start, launch every task
      // that depends on it whose other dependencies are now also done. Best-effort — the
      // merge already happened, so a dependent that fails to start must never roll it back.
      if (block.autoStartDependents) {
        await this.autoStartDependents(workspaceId, blockId).catch(() => {})
      }
    }
  }

  /**
   * After a task with `autoStartDependents` merges, start every task that `dependsOn` it
   * and whose remaining dependencies are all now `done`. System-initiated (no human
   * present), so a dependent on an individual-usage model — which needs its owner to
   * unlock a personal credential per run — is SKIPPED rather than started (it would fault
   * at dispatch); the human starts it manually. Each dependent is started independently so
   * one failure (already running, no provider, …) never blocks the rest.
   */
  private async autoStartDependents(workspaceId: string, mergedBlockId: string): Promise<void> {
    const blocks = await this.blockRepository.listByWorkspace(workspaceId)
    const dependents = blocks.filter(
      (b) => b.level === 'task' && b.dependsOn.includes(mergedBlockId),
    )
    // A dependent's OTHER blockers may live in another workspace (a shared service); resolve
    // them so `dependenciesMet` doesn't treat a cross-workspace blocker as missing-⇒-satisfied.
    await this.augmentWithCrossWorkspaceDeps(
      blocks,
      dependents.flatMap((d) => d.dependsOn),
    )
    // The workspace's first pipeline (the board's "Run" default for a dependent with no
    // pinned pipeline) is invariant across the loop — read it once, not per dependent.
    const firstPipeline = dependents.some((d) => !d.pipelineId)
      ? ((await this.pipelineRepository.listByWorkspace(workspaceId))[0] ?? null)
      : null
    for (const dependent of dependents) {
      // All of the dependent's blockers must now be satisfied (not just the one that merged).
      if (!dependenciesMet(blocks, dependent.id)) continue
      // Only auto-start a fresh task — never replace a run already in flight or a finished one.
      if (dependent.status !== 'planned' && dependent.status !== 'ready') continue
      const pipeline = dependent.pipelineId
        ? await this.pipelineRepository.get(workspaceId, dependent.pipelineId)
        : firstPipeline
      if (!pipeline) continue
      // Skip dependents that would lease an individual-usage credential (can't unlock
      // unattended) — resolved from the block + pipeline already in hand, no re-reads.
      const individual = await this.resolveIndividualVendors(
        workspaceId,
        dependent.modelId,
        dependent.modelPresetId,
        pipeline.agentKinds,
        () => false,
      )
      if (individual.length > 0) continue
      try {
        await this.start(workspaceId, dependent.id, pipeline.id, null)
      } catch {
        // Already running, no usable provider, still-unmet dep racing, etc. — leave this
        // dependent for a manual start; the others still get their chance.
      }
    }
  }

  /**
   * Resolve the merge threshold preset that governs a task: its explicitly-picked
   * preset, else the workspace default, else the built-in {@link DEFAULT_MERGE_PRESET}.
   * Returns just the thresholds the engine compares against (+ the CI attempt budget).
   */
  private async resolveMergePreset(
    workspaceId: string,
    block: Block,
  ): Promise<{
    name: string
    maxComplexity: number
    maxRisk: number
    maxImpact: number
    ciMaxAttempts: number
    maxRequirementIterations: number
    maxRequirementConcernAllowed: RequirementConcernLevel
    maxTesterQualityIterations: number
    releaseWatchWindowMinutes: number
    releaseMaxAttempts: number
    humanReviewGraceMinutes: number
    autoMergeEnabled: boolean
  }> {
    if (this.mergePresetRepository) {
      if (block.mergePresetId) {
        const picked = await this.mergePresetRepository.get(workspaceId, block.mergePresetId)
        if (picked) return picked
      }
      const fallback = await this.mergePresetRepository.getDefault(workspaceId)
      if (fallback) return fallback
    }
    return DEFAULT_MERGE_PRESET
  }

  /**
   * Implementing a task assigned to a module materialises that module: create it
   * in the service if missing, then move the task inside it.
   */
  private async applyModuleAssignment(workspaceId: string, taskId: string): Promise<void> {
    const task = await this.blockRepository.get(workspaceId, taskId)
    if (!task || !task.moduleName) return
    const blocks = await this.blockRepository.listByWorkspace(workspaceId)
    const service = serviceOf(blocks, task)
    if (!service) return

    let module = blocks.find(
      (b) => b.parentId === service.id && b.level === 'module' && b.title === task.moduleName,
    )
    if (!module) {
      module = await this.board.addModule(workspaceId, service.id, {
        name: task.moduleName,
      })
    }
    if (module.id !== task.parentId) {
      const n = blocks.filter((b) => b.parentId === module!.id && b.level === 'task').length
      await this.board.reparent(workspaceId, taskId, {
        parentId: module.id,
        position: { x: 16 + (n % 2) * 190, y: 40 + Math.floor(n / 2) * 130 },
      })
    }
    // A module node appeared and/or a task changed parent — the per-block event
    // can't express that hierarchy change, so signal a coarse board refresh. Name the moved
    // task so the refresh fans out to every board mounting its shared service.
    await this.events.boardChanged(workspaceId, 'module', taskId)
  }

  /** Resolve a pending decision; the run's next step lets the agent finish it. */
  async resolveDecision(
    workspaceId: string,
    executionId: string,
    decisionId: string,
    choice: string,
  ): Promise<ExecutionInstance> {
    await this.requireWorkspace(workspaceId)
    // Optimistic-concurrency write: a second resolve (double-click) or a racing driver
    // poll can't clobber the chosen decision — the loser re-reads and re-applies.
    const instance = await this.runStateMachine.mutateInstance(
      workspaceId,
      executionId,
      async (inst) => {
        const step = inst.steps.find((s) => s.decision?.id === decisionId)
        if (!step || !step.decision) throw new NotFoundError('Decision', decisionId)
        step.decision.chosen = choice
        this.stepGraph.startStep(step)
        if (inst.status === 'blocked') inst.status = 'running'
        await this.runStateMachine.updateBlockProgress(workspaceId, inst, 'in_progress')
      },
    )
    // Wake the parked durable run, if any. The DB write above remains the source
    // of truth (so the backstop sweeper can still re-drive it); the signal is an
    // optimisation that lets the workflow continue immediately.
    await this.workRunner.signalDecision(workspaceId, instance.id, decisionId, choice)
    await this.runStateMachine.emitInstance(workspaceId, instance)
    return instance
  }

  /**
   * Approve a step's gated proposal: the run advances to the next step, carrying
   * the (optionally human-edited) proposal forward as context. Mirrors
   * {@link resolveDecision}'s durable-wake but *advances* the pipeline instead of
   * re-running the step (the step is already done). Idempotent — re-approving an
   * already-approved gate is a no-op.
   */
  async approveStep(
    workspaceId: string,
    executionId: string,
    approvalId: string,
    opts: { proposal?: string } = {},
  ): Promise<ExecutionInstance> {
    await this.requireWorkspace(workspaceId)
    // Optimistic-concurrency write like resolveDecision/requestStepChanges: an approve
    // holding a stale snapshot (a racing reject, a driver poll, a terminal transition)
    // must re-read and re-validate rather than blind-write — otherwise it can resurrect
    // a run another writer already failed. The advance's in-memory half runs inside the
    // CAS; the non-idempotent side effects (block writes, driver signal, emit) run once
    // after, on the winning state.
    let stepIndex = -1
    let alreadyApproved = false
    const instance = await this.runStateMachine.mutateInstance(workspaceId, executionId, (inst) => {
      alreadyApproved = false
      stepIndex = inst.steps.findIndex((s) => s.approval?.id === approvalId)
      const step = inst.steps[stepIndex]
      if (!step || !step.approval) throw new NotFoundError('Approval', approvalId)
      this.assertNotIterativeGate(step)
      if (step.approval.status === 'approved') {
        alreadyApproved = true
        return
      }
      if (step.approval.status === 'rejected') {
        throw new ConflictError(`Approval '${approvalId}' was rejected`)
      }
      if (inst.status === 'failed' || inst.status === 'done') {
        throw new ConflictError(`Execution '${executionId}' is already ${inst.status}`)
      }

      // A human edit to the proposal replaces the agent's text, so the revised
      // proposal is what downstream steps read (via priorOutputs).
      if (opts.proposal !== undefined) {
        step.output = opts.proposal
        step.approval.proposal = opts.proposal
      }
      step.approval.status = 'approved'
      // A gate is never raised on the final step, but the shared advance stays defensive.
      this.runStateMachine.advanceRunPastGate(inst, stepIndex)
    })
    if (alreadyApproved) return instance
    await this.runStateMachine.settleAdvancedGate(workspaceId, instance, stepIndex)
    return instance
  }

  /**
   * Request changes on a step's gated proposal: the same step re-runs with the
   * human's freeform feedback and/or per-block comments (and its prior proposal)
   * folded into the agent's context (see {@link AgentContextBuilder}). The run is left
   * `running` on the same step; on the re-run's completion the gate is raised
   * afresh. At least one of `feedback`/`comments` is expected (the controller
   * validates this), but an empty review is harmless — the agent simply re-runs.
   */
  async requestStepChanges(
    workspaceId: string,
    executionId: string,
    approvalId: string,
    review: { feedback?: string; comments?: StepReviewComment[] },
  ): Promise<ExecutionInstance> {
    await this.requireWorkspace(workspaceId)
    // Optimistic-concurrency write: two concurrent change-requests on the same gate
    // (the documented double-submit) can't both dispatch a re-run — the loser re-reads,
    // sees `changes_requested`, and is rejected below instead of clobbering.
    const instance = await this.runStateMachine.mutateInstance(workspaceId, executionId, (inst) => {
      const step = inst.steps.find((s) => s.approval?.id === approvalId)
      if (!step || !step.approval) throw new NotFoundError('Approval', approvalId)
      this.assertNotIterativeGate(step)
      if (step.approval.status === 'approved') {
        throw new ConflictError(`Approval '${approvalId}' is already approved`)
      }
      if (step.approval.status === 'rejected') {
        throw new ConflictError(`Approval '${approvalId}' was rejected`)
      }
      // A re-run is already in flight (and will raise a fresh gate on completion);
      // acting on this now-stale gate id would dispatch duplicate work.
      if (step.approval.status === 'changes_requested') {
        throw new ConflictError(`Approval '${approvalId}' is already being re-run`)
      }

      const stepIndex = inst.steps.findIndex((s) => s.approval?.id === approvalId)

      step.approval.status = 'changes_requested'
      step.approval.feedback = review.feedback
      step.approval.comments = review.comments?.length ? review.comments : undefined

      // A companion's gate reviews the PRODUCER's output, not the companion's own work:
      // requesting changes here must re-run the producer (with the human's feedback
      // folded in) and re-grade, NOT re-run the companion. Redirect the rework to the
      // nearest preceding step of one of the companion's target kinds.
      if (isCompanionKind(step.agentKind)) {
        const targets = companionTargets(step.agentKind)
        let producerIndex = -1
        for (let i = stepIndex - 1; i >= 0; i--) {
          if (targets.includes(inst.steps[i]!.agentKind)) {
            producerIndex = i
            break
          }
        }
        const producer = producerIndex >= 0 ? inst.steps[producerIndex]! : undefined
        if (producer) {
          // Re-run the producer (with the human's feedback) and every step up to and
          // including the companion, then the companion re-grades. Does NOT touch the
          // companion's automatic-rework budget — a human-driven iteration is unbounded.
          const previousProposal = producer.output ?? step.approval.proposal
          this.stepGraph.rerunProducerThrough(inst, producerIndex, stepIndex, {
            previousProposal,
            feedback: review.feedback ?? '',
            ...(review.comments?.length ? { comments: review.comments } : {}),
          })
          if (inst.status === 'blocked') inst.status = 'running'
          return
        }
      }

      // Drop the live job handle so the re-run dispatches fresh work rather than
      // re-attaching to the finished job (async steps); inline steps ignore this.
      step.jobId = undefined
      // A requested re-run is a fresh execution: clear the prior timing so the next
      // start/finish times this attempt rather than spanning the human gate wait.
      step.startedAt = null
      step.finishedAt = null
      this.stepGraph.startStep(step)
      if (inst.status === 'blocked') inst.status = 'running'
    })
    await this.workRunner.signalDecision(workspaceId, instance.id, approvalId, 'changes_requested')
    await this.runStateMachine.emitInstance(workspaceId, instance)
    return instance
  }

  /**
   * Reject a step's gated proposal: the run stops entirely. The gate is marked
   * `rejected` and the run is failed with a dedicated `rejected` failure kind, so
   * the board surfaces it via the shared failure banner (block → `blocked`) with a
   * Retry affordance. The parked durable run is woken so it observes the now-terminal
   * status and stops (the workflow's advance loop no-ops on a non-running run).
   * Idempotent — rejecting an already-terminal gate is a no-op.
   */
  async rejectStep(
    workspaceId: string,
    executionId: string,
    approvalId: string,
    reason?: string,
  ): Promise<ExecutionInstance> {
    await this.requireWorkspace(workspaceId)
    // Optimistic-concurrency write: a reject racing the durable driver (or a concurrent
    // resolve/request-changes on the same gate) re-reads and re-applies instead of
    // clobbering the other writer — the lost-update fix, same as resolveDecision.
    let alreadyRejected = false
    const instance = await this.runStateMachine.mutateInstance(workspaceId, executionId, (inst) => {
      const step = inst.steps.find((s) => s.approval?.id === approvalId)
      if (!step || !step.approval) throw new NotFoundError('Approval', approvalId)
      this.assertNotIterativeGate(step)
      if (step.approval.status === 'approved') {
        throw new ConflictError(`Approval '${approvalId}' is already approved`)
      }
      // A re-run is in flight; this gate id is stale (a fresh one is raised on its
      // completion). Reject the current gate via that fresh id, not this one.
      if (step.approval.status === 'changes_requested') {
        throw new ConflictError(`Approval '${approvalId}' is being re-run`)
      }
      // Already rejected (and the run already failed): leave it as-is and skip failRun below.
      if (step.approval.status === 'rejected') {
        alreadyRejected = true
        return
      }
      step.approval.status = 'rejected'
      if (reason) step.approval.feedback = reason
    })
    if (alreadyRejected) return instance
    const message = reason
      ? `A reviewer rejected the proposal: ${reason}`
      : 'A reviewer rejected the proposal, stopping the run.'
    // failRun persists the terminal failure + flips the block to `blocked` and emits.
    await this.failRun(workspaceId, executionId, message, 'rejected')
    // Wake the parked durable run; it re-reads the now-terminal status and stops.
    await this.workRunner.signalDecision(workspaceId, instance.id, approvalId, 'rejected')
    return assertFound(
      await this.executionRepository.get(workspaceId, executionId),
      'Execution',
      executionId,
    )
  }

  /** Merge an open PR: a block moves from `pr_ready` to `done`. */
  async mergePr(workspaceId: string, blockId: string): Promise<Block> {
    await this.requireWorkspace(workspaceId)
    const block = await this.requireBlock(workspaceId, blockId)
    if (block.status !== 'pr_ready') {
      throw new ConflictError(`Block '${blockId}' has no PR awaiting merge`, 'no_pr_to_merge')
    }
    await this.finalizeMerge(workspaceId, blockId)
    return this.requireBlock(workspaceId, blockId)
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
  ): Promise<void> {
    return this.runStateMachine.failRun(workspaceId, executionId, message, kind, detail)
  }

  /**
   * Retry a failed run: re-drive the same pipeline on the same block, **resuming
   * from the step that actually failed** rather than restarting from step 0. The
   * steps that already completed are preserved (so a `coder` failure in `pl_full`
   * doesn't re-run the human-gated `requirements`/`architect` steps before it);
   * the failed step and everything after it are reset to a clean, re-runnable
   * state. Only a `failed` run can be retried.
   *
   * A fresh instance id is minted because the durable runner addresses one
   * Workflows instance per execution id and the failed one is terminal — the new
   * instance simply starts with `currentStep` pointed at the failed step, so the
   * driver advances forward from there and never re-issues the completed steps'
   * work. Mirrors {@link BootstrapService.retry}; both are reached via the unified
   * `POST /agent-runs/:id/retry` endpoint.
   */
  async retry(
    workspaceId: string,
    executionId: string,
    /** The retrying user (their personal subscription is used for individual-usage
     *  models). Falls back to the original initiator when omitted. */
    initiatedBy?: string | null,
    /** Mint the per-run personal-credential activation (see {@link start}). */
    activate?: (executionId: string) => Promise<void>,
  ): Promise<ExecutionInstance> {
    await this.requireWorkspace(workspaceId)
    const previous = assertFound(
      await this.executionRepository.get(workspaceId, executionId),
      'Execution',
      executionId,
    )
    if (previous.status !== 'failed') {
      throw new ConflictError(
        `Only a failed run can be retried (run is '${previous.status}').`,
        'run_not_retryable',
        { status: previous.status },
      )
    }
    const block = await this.requireBlock(workspaceId, previous.blockId)

    // Run the SAME config/resource preconditions start() does (shape, frame type, tester infra,
    // binary storage, agent backend, provider/preset satisfiability, budget), so a retry can't
    // silently proceed on a config a fresh start would refuse — the drift that let a
    // subscription-only preset fail mid-run against the routing default. Validated over the
    // STORED steps (what the retry actually re-drives), not the current pipeline definition, so
    // an out-of-band pipeline edit can't skew the gate and a deleted pipeline needs no special
    // case. Before any side effects.
    await this.assertRunnable(
      workspaceId,
      block,
      this.runnableShapeOf(previous.steps),
      initiatedBy ?? previous.initiatedBy,
    )

    const { steps, currentStep } = planResumedSteps(previous)
    // Mint the activation before replacing the failed run, so a bad password aborts
    // the retry without losing the retryable terminal run.
    const newId = this.idGenerator.next('exec')
    await activate?.(newId)
    // Replace the terminal failed run for this block with the resumed one (single
    // run per block, matching the board's by-block projection). This mints a FRESH run id
    // (delete + insert), so there is no prior row for a concurrent writer to lose an update
    // against — the CAS/`mutateInstance` lost-update fix is structurally N/A here; the
    // one-run-per-block projection is what serialises a double-retry.
    await this.executionRepository.deleteByBlock(workspaceId, previous.blockId)
    const instance: ExecutionInstance = {
      id: newId,
      blockId: previous.blockId,
      pipelineId: previous.pipelineId,
      pipelineName: previous.pipelineName,
      steps,
      currentStep,
      status: 'running',
      initiatedBy: initiatedBy ?? previous.initiatedBy ?? null,
      // Preserve the error trail: the failure this retry is clearing is appended to the
      // history so it stays viewable after the top banner disappears on restart.
      failureHistory: carryForwardFailures(previous),
    }
    await this.executionRepository.upsert(workspaceId, instance)
    const done = steps.filter((s) => s.state === 'done').length
    await this.blockRepository.update(workspaceId, previous.blockId, {
      status: 'in_progress',
      progress: steps.length > 0 ? done / steps.length : 0,
      executionId: instance.id,
    })
    await this.workRunner.startRun(workspaceId, instance.id)
    await this.runStateMachine.emitInstance(workspaceId, instance)
    return instance
  }

  /**
   * Restart a run from a human-chosen step: re-run from `fromStepIndex` onward,
   * regardless of how far the run had progressed (a `done`, `failed`, `blocked`,
   * `paused` or still-`running` run are all valid sources). Unlike {@link retry}
   * (which resumes at the first FAILURE) this rewinds to an arbitrary step the user
   * picked — so it can re-run steps that already completed.
   *
   * What is preserved vs reset:
   * - Steps BEFORE `fromStepIndex` keep their `output`/approval/timing untouched, so
   *   the engine still hands the restarted step its predecessors' work as
   *   `priorOutputs` (and their resolved `decisions`) — a useful handoff.
   * - The chosen step and every later one are reset to a clean, re-runnable state,
   *   dropping each step's iteration counters (companion attempts, gate/test attempts,
   *   eviction recoveries) so the restart starts those loops from zero.
   * - A block's incorporated requirements are NOT touched: they live on the
   *   requirement-review record, so a restarted spec-writer/coder still receives the
   *   incorporated document (or the base description when none was generated). When the
   *   chosen step is the `requirements-review` gate ITSELF, re-running it mints a fresh
   *   iteration-1 review (the reviewer's `review()` replaces the prior one), which is
   *   exactly the "reset the iterations counter from this step" semantics.
   *
   * Like {@link retry} a fresh instance id is minted (the durable runner addresses one
   * driver per execution id). Any still-live driver/container for the run being
   * replaced is torn down first, so restarting a RUNNING run never orphans a container
   * or a parked Workflows instance.
   */
  async restartFromStep(
    workspaceId: string,
    executionId: string,
    fromStepIndex: number,
    /** The restarting user (their personal subscription is used for individual-usage
     *  models). Falls back to the original initiator when omitted. */
    initiatedBy?: string | null,
    /** Mint the per-run personal-credential activation (see {@link start}). */
    activate?: (executionId: string) => Promise<void>,
  ): Promise<ExecutionInstance> {
    await this.requireWorkspace(workspaceId)
    const previous = assertFound(
      await this.executionRepository.get(workspaceId, executionId),
      'Execution',
      executionId,
    )
    const block = await this.requireBlock(workspaceId, previous.blockId)
    if (
      !Number.isInteger(fromStepIndex) ||
      fromStepIndex < 0 ||
      fromStepIndex >= previous.steps.length
    ) {
      throw new ValidationError(
        `Step ${fromStepIndex} is out of range for this run (it has ${previous.steps.length} step(s)).`,
      )
    }

    // Run the SAME config/resource preconditions start()/retry() do, over the STORED steps this
    // restart re-drives (frame type, tester infra, binary storage, agent backend, provider/preset
    // satisfiability, budget). A restart re-dispatches provider-bearing steps just like a retry,
    // so it must be gated identically — otherwise a run whose preset can't run every step (e.g. a
    // subscription-only model an inline reviewer can't drive) strands mid-run instead of being
    // refused up front. Before any teardown/side effects.
    await this.assertRunnable(
      workspaceId,
      block,
      this.runnableShapeOf(previous.steps),
      initiatedBy ?? previous.initiatedBy,
    )

    // Tear down whatever was driving the run we're about to replace — its per-run
    // container AND its durable driver — before minting the restart. A `done`/`failed`
    // run is already terminal (a no-op teardown), but a still-`running` run would
    // otherwise leak a container and a live Workflows/pg-boss driver.
    await this.runStateMachine.stopRunContainer(workspaceId, previous)
    await this.workRunner.cancelRun(workspaceId, executionId)

    const { steps, currentStep } = planRestartFromStep(previous, fromStepIndex)
    // Mint the activation before replacing the prior run, so a bad password aborts the
    // restart without losing the source run.
    const newId = this.idGenerator.next('exec')
    await activate?.(newId)
    // Like retry(), this mints a FRESH run id (delete + insert), so there is no prior row for
    // a concurrent writer to lose an update against — the CAS lost-update fix is N/A here.
    await this.executionRepository.deleteByBlock(workspaceId, previous.blockId)
    const instance: ExecutionInstance = {
      id: newId,
      blockId: previous.blockId,
      pipelineId: previous.pipelineId,
      pipelineName: previous.pipelineName,
      steps,
      currentStep,
      status: 'running',
      initiatedBy: initiatedBy ?? previous.initiatedBy ?? null,
      // Preserve the error trail across a restart too (a failed run is a valid restart
      // source), so the prior failure stays viewable once the run is running again.
      failureHistory: carryForwardFailures(previous),
    }
    await this.executionRepository.upsert(workspaceId, instance)
    const done = steps.filter((s) => s.state === 'done').length
    await this.blockRepository.update(workspaceId, previous.blockId, {
      status: 'in_progress',
      progress: steps.length > 0 ? done / steps.length : 0,
      executionId: instance.id,
    })
    await this.workRunner.startRun(workspaceId, instance.id)
    await this.runStateMachine.emitInstance(workspaceId, instance)
    return instance
  }

  /**
   * Resume every run paused by the spend safeguard in this workspace. Flips them
   * back to `running` and re-drives the durable runner. If the budget is still
   * exhausted the spend gate will simply pause them again on their next step.
   */
  async resumePaused(workspaceId: string): Promise<ExecutionInstance[]> {
    await this.requireWorkspace(workspaceId)
    const instances = await this.executionRepository.listByWorkspace(workspaceId)
    const paused = instances.filter((e) => e.status === 'paused')
    for (const p of paused) {
      // Optimistic-concurrency write: only flip + re-drive a run that is STILL paused at
      // write time, so a resume racing the driver (or a concurrent resume) can't clobber a
      // run another writer already advanced. A vanished/contended run is skipped (the next
      // sweep retries) rather than failing the whole batch.
      let flipped = false
      const resumed = await this.runStateMachine
        .mutateInstance(workspaceId, p.id, (inst) => {
          flipped = inst.status === 'paused'
          if (flipped) inst.status = 'running'
        })
        .catch(() => null)
      if (resumed && flipped) {
        await this.workRunner.startRun(workspaceId, resumed.id)
        await this.runStateMachine.emitInstance(workspaceId, resumed)
      }
    }
    return this.executionRepository.listByWorkspace(workspaceId)
  }

  /** Cancel the run on a block, returning it to `planned`. */
  async cancel(workspaceId: string, blockId: string): Promise<Block> {
    await this.requireWorkspace(workspaceId)
    await this.requireBlock(workspaceId, blockId)
    // Tear down the durable run (if any) AND its per-run container before removing
    // the record, so a cancel never leaves a container running until its watchdog.
    const existing = await this.executionRepository.getByBlock(workspaceId, blockId)
    if (existing) {
      await this.runStateMachine.stopRunContainer(workspaceId, existing)
      await this.workRunner.cancelRun(workspaceId, existing.id)
    }
    await this.executionRepository.deleteByBlock(workspaceId, blockId)
    await this.blockRepository.update(workspaceId, blockId, {
      status: 'planned',
      progress: 0,
      executionId: null,
    })
    // The run record is gone and the block is back to planned; the client can't
    // reconstruct that from a per-instance event, so signal a coarse refresh. Name the block
    // so the refresh fans out to every board mounting its shared service.
    await this.events.boardChanged(workspaceId, 'cancel', blockId)
    return this.requireBlock(workspaceId, blockId)
  }

  /**
   * Explicitly stop a *running* run by id (the unified `POST /agent-runs/:id/stop`
   * surface): kill its per-run container, tear down the durable driver, then record
   * a terminal `cancelled` failure so the board shows the run stopped (with retry)
   * rather than spinning forever. Idempotent — a run already terminal is returned
   * as-is. `opts.reason`/`opts.kind` let the orphan sweep reuse this with its own
   * wording instead of the user-facing default.
   */
  async stopRun(
    workspaceId: string,
    executionId: string,
    opts: { reason?: string; kind?: AgentFailureKind } = {},
  ): Promise<ExecutionInstance> {
    await this.requireWorkspace(workspaceId)
    const instance = assertFound(
      await this.executionRepository.get(workspaceId, executionId),
      'Execution',
      executionId,
    )
    if (instance.status === 'failed' || instance.status === 'done') return instance
    await this.runStateMachine.stopRunContainer(workspaceId, instance)
    await this.workRunner.cancelRun(workspaceId, executionId)
    await this.failRun(
      workspaceId,
      executionId,
      opts.reason ?? 'Stopped by the user.',
      opts.kind ?? 'cancelled',
    )
    return assertFound(
      await this.executionRepository.get(workspaceId, executionId),
      'Execution',
      executionId,
    )
  }

  /**
   * Tear down every run under a block subtree — kill each container, terminate each
   * durable driver, and delete the run record — so deleting a service/module never
   * orphans a container or a Workflows instance. Best-effort and silent: the board
   * delete that follows emits the coarse refresh, so no per-run event is needed.
   */
  async teardownForBlockTree(workspaceId: string, rootId: string): Promise<void> {
    const blocks = await this.blockRepository.listByWorkspace(workspaceId)
    // Resolve every run in one query and index by block id, rather than a per-block
    // getByBlock (N+1) over the whole subtree.
    const runsByBlock = new Map(
      (await this.executionRepository.listByWorkspace(workspaceId)).map((run) => [
        run.blockId,
        run,
      ]),
    )
    for (const blockId of descendantIds(blocks, rootId)) {
      const run = runsByBlock.get(blockId)
      if (!run) continue
      await this.runStateMachine.stopRunContainer(workspaceId, run)
      await this.workRunner.cancelRun(workspaceId, run.id)
      await this.executionRepository.deleteByBlock(workspaceId, blockId)
    }
  }
}
