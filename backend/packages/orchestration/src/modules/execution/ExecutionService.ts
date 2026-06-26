import type {
  AgentFailure,
  AgentFailureKind,
  Block,
  BlueprintService,
  ExecutionInstance,
  MergePresetRepository,
  Pipeline,
  PipelineStep,
  PullRequestMerger,
  StepReviewComment,
  SubscriptionActivationRepository,
  TicketTrackerProvider,
  IssueWritebackProvider,
} from '@cat-factory/kernel'
import {
  parseBlueprintService,
  parseSpecDoc,
  DEFAULT_COMPANION_MAX_ATTEMPTS,
  isLocalRunner,
} from '@cat-factory/contracts'
import {
  blueprintPostOp,
  companionFor,
  companionTargets,
  isCompanionKind,
  registeredAgentStep,
  registeredPreOps,
  registeredPostOps,
  runRepoOps,
  specPostOp,
  TASK_ESTIMATOR_AGENT_KIND,
} from '@cat-factory/agents'
import type { RepoOp, RunInitiatorScope } from '@cat-factory/kernel'
import { coerceTaskEstimate, summarizeEstimate } from '../estimation/estimate.logic.js'
import { validatePipelineShape } from '../pipelines/pipelineShape.js'
import { shouldRunGatedStep } from './stepGating.logic.js'
import { reviewableArtifactOutput } from './artifact-review.logic.js'
import {
  resolveIndividualVendors,
  type HasPersonalSubscription,
} from './individualVendors.logic.js'
import {
  assertFound,
  ConflictError,
  getErrorMessage,
  isModelUsable,
  NotFoundError,
  parseLocalModelId,
  type ProviderCapabilities,
  resolveModelRef,
  sameSubtasks,
  subscriptionOptionFor,
  ValidationError,
  type SubscriptionVendor,
} from '@cat-factory/kernel'
import { DEFAULT_MERGE_PRESET } from '@cat-factory/kernel'
import {
  CONFLICTS_AGENT_KIND,
  MERGER_AGENT_KIND,
  REQUIREMENTS_REVIEW_AGENT_KIND,
  CLARITY_REVIEW_AGENT_KIND,
  BUG_INVESTIGATOR_AGENT_KIND,
  TRACKER_AGENT_KIND,
  ANALYSIS_AGENT_KIND,
  TESTER_AGENT_KIND,
  HUMAN_TEST_AGENT_KIND,
  HUMAN_REVIEW_AGENT_KIND,
  BLUEPRINTS_AGENT_KIND,
  SPEC_WRITER_AGENT_KIND,
} from './ci.logic.js'
import { AgentContextBuilder, type FragmentBodyResolver } from './AgentContextBuilder.js'
import { CompanionController } from './CompanionController.js'
import { inferTechnicalLabel } from './technical.logic.js'
import { MergeResolver } from './MergeResolver.js'
import { ReviewGateController, type ReviewKind } from './ReviewGateController.js'
import { TesterController } from './TesterController.js'
import { HumanTestController } from './HumanTestController.js'
import type {
  GateContext,
  GateDefinition,
  GateHelperJobResult,
  ResolverContext,
  StepCompletionResolver,
} from '@cat-factory/kernel'
import {
  getProvider,
  recordGateAttempt,
  registeredGateFactories,
  registeredStepResolverFactories,
  requireProvider,
} from '@cat-factory/kernel'
import type { NotificationService } from '../notifications/NotificationService.js'
import type { WorkspaceSettingsService } from '../settings/WorkspaceSettingsService.js'
import type { RequirementReviewService } from '../requirements/RequirementReviewService.js'
import type { ClarityReviewService } from '../clarity/ClarityReviewService.js'
import type {
  IterationCapChoice,
  RequirementConcernLevel,
  RequirementReview,
  ClarityReview,
  ResolveRequirementsExceededChoice,
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
import type { ProvisionContext } from '@cat-factory/kernel'
import type {
  AgentExecutor,
  AgentJobHandle,
  AgentRunContext,
  AgentRunResult,
  AgentStepSpec,
  RepoFiles,
  ResolveRunRepoContext,
  RunRepoContext,
} from '@cat-factory/kernel'
import { isAsyncAgentExecutor } from '@cat-factory/kernel'
import type { WorkRunner } from '@cat-factory/kernel'
import type { ExecutionEventPublisher } from '@cat-factory/kernel'
import type { DocumentRepository } from '@cat-factory/kernel'
import type { TaskRepository } from '@cat-factory/kernel'
import type { RequirementReviewRepository } from '@cat-factory/kernel'
import type { ClarityReviewRepository } from '@cat-factory/kernel'
import type {
  EnvironmentProvisioningService,
  EnvironmentTeardownService,
} from '@cat-factory/integrations'
import { isDeployStep } from '@cat-factory/integrations'
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
import { planResumedSteps, planRestartFromStep } from './retry.logic.js'
import {
  isContainerEvictionError,
  isTransientEviction,
  MAX_EVICTION_RECOVERIES,
  MAX_TRANSIENT_EVICTION_RECOVERIES,
} from './job.logic.js'
import {
  decideTesterInfra,
  resolveTesterEnvironment,
  TESTER_INFRA_MESSAGES,
} from './tester-infra.logic.js'

/**
 * "What to do next" guidance per failure kind a pipeline run can produce, shown
 * under the failure banner on the board (mirrors bootstrap's FAILURE_HINTS). Only
 * the execution-relevant subset of {@link AgentFailureKind} is keyed.
 */
const EXECUTION_FAILURE_HINTS: Partial<Record<AgentFailureKind, string>> = {
  agent:
    'An agent step failed after its automatic retries. Review the run, then retry to re-run the pipeline.',
  job_failed:
    'The implementation container reported a failure. Inspect its logs (Cloudflare Workers Observability, filtered by the run id), then retry to spin a fresh container.',
  evicted:
    'The implementation container kept vanishing mid-run even after automatic fresh-container restarts. Most often this is transient: a deploy / new-version rollout draining the container, in which case simply retrying once the rollout has finished succeeds. If it persists, it points at a memory or crash issue on the run — inspect its logs (Cloudflare Workers Observability, filtered by the run id) and consider a heavier container instance type. Retry to try again.',
  timeout:
    'The run exceeded its time budget — a step or the implementation job did not finish in time. Retry to start it again.',
  rejected:
    'You rejected this step’s proposal, stopping the run. Retry to re-run the pipeline from the rejected step.',
  companion_rejected:
    'A companion agent could not return a usable quality assessment (its reply was truncated or malformed) even after a repair retry. Review the companion’s raw output on the run, then retry.',
  cancelled: 'You stopped this run; its container was killed. Retry to start it again.',
  dispatch:
    'The agent’s container could not be started — the run never began executing. The provider/runtime’s verbatim response is shown below. Most often this is transient (a capacity blip or a new-version rollout); retrying spins a fresh container. If it persists it points at a misconfigured container binding/image or runner pool. Retry to try again.',
  unknown: 'The run failed for an unclassified reason. Review the run, then retry.',
}

/**
 * Step kinds whose run details surface the ephemeral-environment lifecycle: the
 * `deployer` provisions it and the `tester`/`playwright` exercise it. Used to gate
 * the per-poll env projection so the `getByBlock` read never hits the hot path for
 * the many container steps that have no env to show (see attachEnvironmentProjection).
 */
const ENV_PROJECTION_KINDS = new Set<string>(['deployer', 'tester', 'playwright'])

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
   * Optional: when the environment integration is configured, a `deployer` step
   * provisions an ephemeral environment deterministically through this service
   * (no LLM), and downstream steps discover the resulting env via it.
   */
  environmentProvisioning?: EnvironmentProvisioningService
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
   * Optional: whether the runtime can run the Tester's LOCAL docker-compose infra via
   * Docker-in-Docker. Defaults to `true` (Cloudflare, Node, tests). The local facade
   * sets it `false` for runtimes without nesting (Apple `container`), which makes
   * {@link ExecutionService.assertTesterInfraConfigured} refuse a local-infra Tester run
   * (steering it to the ephemeral environment or a no-infra service) instead of
   * dispatching a job that can't stand its dependencies up.
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
  private readonly runInitiatorScope: RunInitiatorScope
  private readonly workspaceRepository: WorkspaceRepository
  private readonly blockRepository: BlockRepository
  private readonly pipelineRepository: PipelineRepository
  private readonly executionRepository: ExecutionRepository
  private readonly accountRepository: AccountRepository
  private readonly idGenerator: IdGenerator
  private readonly clock: Clock
  private readonly agentExecutor: AgentExecutor
  private readonly workRunner: WorkRunner
  private readonly events: ExecutionEventPublisher
  private readonly board: BoardService
  private readonly spend: SpendService
  private readonly requirementReviewService?: RequirementReviewService
  private readonly clarityReviewService?: ClarityReviewService
  private readonly environmentProvisioning?: EnvironmentProvisioningService
  private readonly environmentTeardown?: EnvironmentTeardownService
  private readonly branchUpdater?: BranchUpdater
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
  /** Drives both iterative review gates (requirements + clarity); kind-parameterised. */
  private readonly reviewGate: ReviewGateController
  /** The requirements subject for {@link reviewGate}. */
  private readonly requirementsKind: ReviewKind<RequirementReview>
  /** The clarity (bug-report triage) subject for {@link reviewGate}. */
  private readonly clarityKind: ReviewKind<ClarityReview>
  private readonly blueprintReconciler?: BlueprintReconciler
  private readonly notificationService?: NotificationService
  private readonly workspaceSettingsService?: WorkspaceSettingsService
  private readonly llmObservability?: LlmObservabilityService
  private readonly prMerger?: PullRequestMerger
  private readonly mergePresetRepository?: MergePresetRepository
  private readonly ticketTrackerProvider?: TicketTrackerProvider
  private readonly issueWriteback?: IssueWritebackProvider
  private readonly subscriptionActivations?: SubscriptionActivationRepository
  private readonly resolveProviderCapabilities?: (
    workspaceId: string,
    initiatedBy?: string | null,
  ) => Promise<ProviderCapabilities>
  private readonly resolveWorkspaceModelDefault?: (
    workspaceId: string,
    agentKind: string,
    modelPresetId?: string,
  ) => Promise<string | undefined>
  /** Whether the runtime can run the Tester's local DinD infra (false = limited mode). */
  private readonly localTestInfraSupported: boolean
  /**
   * Optional: resolve a block's run repo bound to a checkout-free {@link RepoFiles} so a
   * registered custom kind's pre/post-op hooks read/commit a targeted subset of the repo
   * without a checkout. Absent (tests / GitHub not connected) → pre/post-ops are skipped.
   */
  private readonly resolveRunRepoContext?: ResolveRunRepoContext
  /** Lazily-built polling-gate registry, keyed by `agentKind`. See {@link gateFor}. */
  private gateRegistryCache?: Map<string, GateDefinition>
  /**
   * Lazily-built post-completion resolver registry, keyed by `agentKind`. See
   * {@link stepResolverFor} and {@link StepCompletionResolver}.
   */
  private stepResolverCache?: Map<string, StepCompletionResolver>

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
    taskRepository,
    requirementReviewRepository,
    requirementReviewService,
    clarityReviewRepository,
    clarityReviewService,
    fragmentResolver,
    environmentProvisioning,
    environmentTeardown,
    branchUpdater,
    blueprintReconciler,
    notificationService,
    workspaceSettingsService,
    llmObservability,
    pullRequestMerger,
    mergePresetRepository,
    ticketTrackerProvider,
    issueWriteback,
    subscriptionActivationRepository,
    resolveWorkspaceModelDefault,
    resolveProviderCapabilities,
    localTestInfraSupported,
    resolveRunRepoContext,
    runInitiatorScope,
  }: ExecutionServiceDependencies) {
    this.runInitiatorScope = runInitiatorScope ?? ((_initiatedBy, fn) => fn())
    this.workspaceRepository = workspaceRepository
    this.blockRepository = blockRepository
    this.pipelineRepository = pipelineRepository
    this.executionRepository = executionRepository
    this.accountRepository = accountRepository
    this.idGenerator = idGenerator
    this.clock = clock
    this.agentExecutor = agentExecutor
    this.workRunner = workRunner
    this.events = executionEventPublisher
    this.board = boardService
    this.spend = spendService
    this.requirementReviewService = requirementReviewService
    this.clarityReviewService = clarityReviewService
    this.environmentProvisioning = environmentProvisioning
    this.environmentTeardown = environmentTeardown
    this.branchUpdater = branchUpdater
    this.contextBuilder = new AgentContextBuilder({
      workspaceRepository,
      blockRepository,
      accountRepository,
      documents: documentRepository,
      tasks: taskRepository,
      requirementReviews: requirementReviewRepository,
      clarityReviews: clarityReviewRepository,
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
      previewStepModel: (ctx) => this.previewStepModel(ctx),
      runAgent: (ctx, opts) => this.runAgent(ctx, opts),
      finishStep: (s) => this.finishStep(s),
      startStep: (s) => this.startStep(s),
      pauseStepForInput: (s) => this.pauseStepForInput(s),
      updateBlockProgress: (ws, i, st) => this.updateBlockProgress(ws, i, st),
      persistInstance: (ws, i) => this.executionRepository.upsert(ws, i),
      emitInstance: (ws, i) => this.emitInstance(ws, i),
      stopRunContainer: (ws, i) => this.stopRunContainer(ws, i),
      finalizeBlock: (ws, i, c) => this.finalizeBlock(ws, i, c),
      parkStepOnDecision: (ws, i, s, p) => this.parkStepOnDecision(ws, i, s, p),
      raiseDecisionRequired: (ws, i) => this.raiseDecisionRequired(ws, i),
      loopCompanionProducer: (i, ci, rw) => this.loopCompanionProducer(i, ci, rw),
      inferTechnicalLabel: (ws, block, producer, companionStep) =>
        this.inferBlockTechnical(ws, block, producer, companionStep),
    })
    this.testerController = new TesterController({
      blockRepository,
      notificationService,
      agentExecutor,
      contextBuilder: this.contextBuilder,
      resolveMergePreset: (ws, block) => this.resolveMergePreset(ws, block),
      stopRunContainer: (ws, i) => this.stopRunContainer(ws, i),
      persistInstance: (ws, i) => this.executionRepository.upsert(ws, i),
      emitInstance: (ws, i) => this.emitInstance(ws, i),
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
                inputs: this.deployInputs(block),
                context: this.deployContext(block),
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
      parkStepOnDecision: (ws, i, s, p) => this.parkStepOnDecision(ws, i, s, p),
      finishStep: (s) => this.finishStep(s),
      startStep: (s) => this.startStep(s),
      updateBlockProgress: (ws, i, st) => this.updateBlockProgress(ws, i, st),
      finalizeBlock: (ws, i, c) => this.finalizeBlock(ws, i, c),
      stopRunContainer: (ws, i) => this.stopRunContainer(ws, i),
      persistInstance: (ws, i) => this.executionRepository.upsert(ws, i),
      emitInstance: (ws, i) => this.emitInstance(ws, i),
      clockNow: () => this.clock.now(),
    })
    this.reviewGate = new ReviewGateController({
      blockRepository,
      executionRepository,
      workRunner,
      resolveMergePreset: (ws, block) => this.resolveMergePreset(ws, block),
      parkStepOnDecision: (ws, i, s, p) => this.parkStepOnDecision(ws, i, s, p),
      advancePastResolvedGate: (ws, i, idx) => this.advancePastResolvedGate(ws, i, idx),
      dispatchIterationCap: (ws, blockId, choice, handlers) =>
        this.dispatchIterationCap(ws, blockId, choice, handlers),
      raiseDecisionRequired: (ws, i) => this.raiseDecisionRequired(ws, i),
      finishStep: (s) => this.finishStep(s),
      startStep: (s) => this.startStep(s),
      updateBlockProgress: (ws, i, st) => this.updateBlockProgress(ws, i, st),
      finalizeBlock: (ws, i, c) => this.finalizeBlock(ws, i, c),
      stopRunContainer: (ws, i) => this.stopRunContainer(ws, i),
      persistInstance: (ws, i) => this.executionRepository.upsert(ws, i),
      emitInstance: (ws, i) => this.emitInstance(ws, i),
    })
    this.requirementsKind = this.buildRequirementsKind()
    this.clarityKind = this.buildClarityKind()
    this.blueprintReconciler = blueprintReconciler
    this.notificationService = notificationService
    this.workspaceSettingsService = workspaceSettingsService
    this.llmObservability = llmObservability
    this.prMerger = pullRequestMerger
    this.mergePresetRepository = mergePresetRepository
    this.ticketTrackerProvider = ticketTrackerProvider
    this.issueWriteback = issueWriteback
    this.subscriptionActivations = subscriptionActivationRepository
    this.resolveWorkspaceModelDefault = resolveWorkspaceModelDefault
    this.resolveProviderCapabilities = resolveProviderCapabilities
    this.localTestInfraSupported = localTestInfraSupported ?? true
    this.resolveRunRepoContext = resolveRunRepoContext
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
   * Guard a Tester pipeline's start: local-mode testing must have its infra
   * configured on the service frame — either a docker-compose path to stand the
   * dependencies up, or the explicit "no infra dependencies" flag. Ephemeral-mode
   * testing uses the provisioned environment, so it needs neither. Throws a
   * {@link ConflictError} (surfaced as an actionable message) when neither is set.
   */
  private async assertTesterInfraConfigured(workspaceId: string, block: Block): Promise<void> {
    // Resolve the service config first: it carries the frame's default test environment,
    // which the task inherits unless it pins its own `tester.environment` (the same
    // resolution the agent-context materialisation applies, so the gate and the run agree).
    const service = await this.contextBuilder.resolveServiceConfig(workspaceId, block)
    const environment = resolveTesterEnvironment(
      block.agentConfig?.['tester.environment'],
      service?.defaultTestEnvironment,
    )
    const decision = decideTesterInfra({
      localTestInfraSupported: this.localTestInfraSupported,
      environment,
      noInfraDependencies: service?.noInfraDependencies === true,
      hasComposePath: !!service?.testComposePath,
      hasEnvironmentProvider: this.environmentProvisioning !== undefined,
    })
    if (decision.ok) return
    throw new ConflictError(TESTER_INFRA_MESSAGES[decision.reason], 'tester_infra_unsupported', {
      infraReason: decision.reason,
    })
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
    pipeline: Pipeline,
    initiatedBy: string | null | undefined,
  ): Promise<void> {
    if (!this.resolveProviderCapabilities) return
    const caps = await this.resolveProviderCapabilities(workspaceId, initiatedBy)
    const unconfigured = new Set<string>()
    const check = (id: string | undefined): void => {
      if (id && !isModelUsable(id, caps)) unconfigured.add(id)
    }
    if (block.modelId) {
      // A block-level pin applies to every step.
      check(block.modelId)
    } else if (this.resolveWorkspaceModelDefault) {
      for (const kind of pipeline.agentKinds) {
        check(await this.resolveWorkspaceModelDefault(workspaceId, kind, block.modelPresetId))
      }
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
    pipeline: Pipeline,
    initiatedBy: string | null | undefined,
  ): Promise<void> {
    if (!(await this.spend.isOverBudget(workspaceId))) return
    if (!this.resolveProviderCapabilities) return
    const caps = await this.resolveProviderCapabilities(workspaceId, initiatedBy)
    const ids: (string | undefined)[] = []
    if (block.modelId) {
      ids.push(block.modelId)
    } else if (this.resolveWorkspaceModelDefault) {
      for (const kind of pipeline.agentKinds) {
        ids.push(await this.resolveWorkspaceModelDefault(workspaceId, kind, block.modelPresetId))
      }
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

    // Reject a structurally-invalid pipeline before any side effects — a misplaced
    // companion or estimate-gating without a preceding task-estimator. The builder also
    // rejects these at save, but a pipeline can become invalid out of band, so a run
    // refuses to START as well (the same shared check).
    validatePipelineShape(pipeline)

    // A pipeline with a Tester that runs locally needs the service's test infra
    // configured (a docker-compose path, or an explicit "no infra dependencies"
    // flag). Block the start with a clear, actionable error otherwise — before any
    // side effects (activation mint / prior-run teardown).
    if (pipeline.agentKinds.includes(TESTER_AGENT_KIND)) {
      await this.assertTesterInfraConfigured(workspaceId, block)
    }

    // Block the start when a step's canonical model has no usable provider (no direct
    // key, no subscription, no Cloudflare) — before any side effects.
    await this.assertProvidersConfiguredForPipeline(workspaceId, block, pipeline, initiatedBy)

    // Enforce the workspace's per-service running-task limit (off by default) — a clear,
    // actionable error before any side effects, so the human knows why the start was refused.
    await this.assertWithinTaskLimit(workspaceId, block)

    // Refuse a metered run once the spend budget is reached (a clear error rather than a
    // silent mid-run pause). A local/subscription-only pipeline is exempt and starts.
    await this.assertBudgetAllowsPipeline(workspaceId, block, pipeline, initiatedBy)

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
        await this.subscriptionActivations.deleteByExecution(prior.id)
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
    await this.emitInstance(workspaceId, instance)
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
   * {@link BlockRepository.findById}, so a shared-service blocker is evaluated by its real
   * status instead of being silently treated as satisfied (missing ⇒ done). Returns the same
   * (now-augmented) array for chaining.
   */
  private async augmentWithCrossWorkspaceDeps(blocks: Block[], depIds: string[]): Promise<Block[]> {
    const have = new Set(blocks.map((b) => b.id))
    for (const id of depIds) {
      if (have.has(id)) continue
      have.add(id)
      const found = await this.blockRepository.findById(id)
      if (found) blocks.push(found.block)
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
      await this.ensureWaitingNotification(workspaceId, instance)
    } else {
      await this.clearWaitingNotification(workspaceId, instance)
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
      if (!(await this.currentStepIsNonMetered(workspaceId, instance, step))) {
        if (instance.status !== 'paused') {
          instance.status = 'paused'
          await this.executionRepository.upsert(workspaceId, instance)
          await this.emitInstance(workspaceId, instance)
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
          step.agentKind === CLARITY_REVIEW_AGENT_KIND) &&
        (!!step.pendingIncorporation || !!step.pendingRecommendation)
      // The human-testing gate is likewise re-entrant: a human action (confirm / request a
      // fix / pull main / recreate) records a `pendingAction` on the parked step and wakes
      // the driver. Fall through so the gate re-evaluates and acts on it (dispatch a helper,
      // rebuild the env, or advance) instead of immediately re-parking.
      const reentrantHumanTest =
        step.agentKind === HUMAN_TEST_AGENT_KIND && !!step.humanTest?.pendingAction
      if (!reentrantRequirements && !reentrantHumanTest) {
        // Parked on either an agent-raised decision or a human approval gate; both
        // are addressed by the same durable event id.
        const pendingId = step.decision?.id ?? step.approval?.id
        if (pendingId) {
          instance.status = 'blocked'
          await this.executionRepository.upsert(workspaceId, instance)
          await this.emitInstance(workspaceId, instance)
          return { kind: 'awaiting_decision', decisionId: pendingId }
        }
      }
    }
    this.startStep(step)

    const block = await this.blockRepository.get(workspaceId, instance.blockId)
    if (!block) return { kind: 'noop' }
    const isFinalStep = instance.currentStep === instance.steps.length - 1

    // Estimate gating: a step gated on the task estimate (today a conditional companion)
    // is transparently SKIPPED when the estimate — written by an earlier task-estimator
    // step in this same run — falls below the threshold. No agent is spun up; the step
    // finishes as `skipped` and the run advances. Evaluated here (not at build time)
    // because the estimate only exists once the estimator step has run.
    if (step.gating?.enabled && !shouldRunGatedStep(block.estimate, step.gating)) {
      return this.skipGatedStep(workspaceId, instance, step, isFinalStep)
    }

    // A `deployer` step provisions an ephemeral environment deterministically via
    // the provider — no LLM, no token usage — when the integration is wired.
    // Otherwise it falls through to the normal agent path.
    if (this.environmentProvisioning && isDeployStep(step.agentKind)) {
      const result = await this.runDeployer(workspaceId, instance, block, options)
      return this.recordStepResult(workspaceId, instance, step, isFinalStep, result)
    }

    // A `tracker` step files a GitHub issue / Jira ticket from the preceding
    // `analysis` output (the tech-debt pipeline) — no LLM of its own. It is a
    // pass-through when no tracker provider is wired or none is configured for the
    // workspace. See {@link runTracker}.
    if (step.agentKind === TRACKER_AGENT_KIND) {
      const result = await this.runTracker(workspaceId, instance, block)
      return this.recordStepResult(workspaceId, instance, step, isFinalStep, result)
    }

    // A `requirements-review` step runs the inline reviewer and parks for the dedicated
    // review window, driving the iterative answer → incorporate → re-review loop. NOT a
    // container/prose agent. Pass-through when the reviewer isn't wired. The clarity gate
    // shares the SAME flow (only the subject + persisted doc differ); both run through the
    // {@link ReviewGateController}, parameterised by their {@link ReviewKind}.
    if (step.agentKind === REQUIREMENTS_REVIEW_AGENT_KIND) {
      return this.reviewGate.evaluate(
        this.requirementsKind,
        workspaceId,
        instance,
        step,
        block,
        isFinalStep,
      )
    }

    // A `clarity-review` step triages the block's bug report (optionally enriched by an
    // upstream `bug-investigator` step) and parks for the dedicated review window, driving
    // the same iterative loop as the requirements gate. NOT a container/prose agent.
    // Pass-through when the reviewer isn't wired.
    if (step.agentKind === CLARITY_REVIEW_AGENT_KIND) {
      return this.reviewGate.evaluate(
        this.clarityKind,
        workspaceId,
        instance,
        step,
        block,
        isFinalStep,
      )
    }

    // A `human-test` gate spins up an ephemeral environment and PARKS for a human to
    // validate the change in a live URL before the run continues — NOT a container/prose
    // agent and NOT a programmatic polling gate (the human is the verdict). It also drives
    // the same helpers the other gates use on demand: the Tester's `fixer` (from findings)
    // and the `conflict-resolver` (after a conflicting pull-main). Degrades to a manual
    // (no-env) mode when no ephemeral-environment provider is wired. See {@link HumanTestController}.
    if (step.agentKind === HUMAN_TEST_AGENT_KIND) {
      return this.humanTestController.evaluate(workspaceId, instance, step, block, isFinalStep)
    }

    // A polling gate step (`ci` / `conflicts`) runs a programmatic precheck and only
    // escalates to a helper container agent (`ci-fixer` / `conflict-resolver`) on a
    // negative verdict — no LLM of its own. Pass-through when the gate's provider is
    // not wired. One generic machine drives every gate; see {@link evaluateGate}.
    const gate = this.gateFor(step.agentKind)
    if (gate) {
      return this.evaluateGate(workspaceId, instance, step, block, isFinalStep, gate)
    }

    // A companion step grades the nearest preceding producer of one of its target
    // kinds, looping it back for automatic rework below the threshold (and failing
    // the run once the budget is spent) before any human gate. See evaluateCompanion.
    if (isCompanionKind(step.agentKind)) {
      return this.companionController.evaluate(
        workspaceId,
        instance,
        step,
        block,
        isFinalStep,
        options,
      )
    }

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
        // Surface an explicit "spinning up container" phase for the cold-boot
        // window: dispatch blocks until the per-run container is up and has
        // accepted the job, so emitting before it lets the board show the boot
        // instead of a blank "working" state.
        step.startingContainer = true
        // Surface the block's ephemeral environment (if any) alongside the cold-boot
        // phase, so a run's details show the env spinning up next to the container.
        await this.attachEnvironmentProjection(workspaceId, instance.blockId, step)
        await this.executionRepository.upsert(workspaceId, instance)
        await this.emitInstance(workspaceId, instance)

        let handle: AgentJobHandle
        try {
          handle = await executor.startJob(context)
        } catch (error) {
          // The container/runner never accepted the job (a dispatch HTTP error, a
          // missing backend, a capacity blip). Surface the EXACT provider/runtime
          // response and classify it as a `dispatch` failure ("container failed to
          // start") so the run details say the container never started — not a generic
          // "run failed". A dispatch-time eviction still routes to the evicted framing.
          step.startingContainer = false
          await this.executionRepository.upsert(workspaceId, instance)
          await this.emitInstance(workspaceId, instance)
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
        // The dispatch returned, so the container is up and execution has begun.
        step.startingContainer = false
        await this.executionRepository.upsert(workspaceId, instance)
        await this.emitInstance(workspaceId, instance)
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
      await this.emitInstance(workspaceId, instance)
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
  private async previewStepModel(context: AgentRunContext): Promise<string | undefined> {
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
  private async currentStepIsNonMetered(
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
      if (step.startingContainer) {
        step.startingContainer = false
        changed = true
      }
      if (update.subtasks && !sameSubtasks(step.subtasks, update.subtasks)) {
        step.subtasks = update.subtasks
        step.progress =
          update.subtasks.total > 0 ? update.subtasks.completed / update.subtasks.total : 0
        changed = true
      }
      // Refresh the env projection so its status transitions (provisioning→ready→
      // expired/torn_down) and any error stay live in the run details during the run.
      if (await this.attachEnvironmentProjection(workspaceId, instance.blockId, step)) {
        changed = true
      }
      if (changed) {
        await this.executionRepository.upsert(workspaceId, instance)
        await this.emitInstance(workspaceId, instance)
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
      await this.emitInstance(workspaceId, instance)
      return { kind: 'awaiting_gate', stepIndex: instance.currentStep }
    }

    // A `tester` step in its `fixing` phase has a Fixer job in flight, NOT the
    // step's own work: when it finishes (or fails) we drop the handle, return to
    // `testing`, and re-dispatch the Tester against the (now-fixed) branch — its
    // fresh report then drives greenlight-or-loop again. Mirrors the CI gate.
    if (step.agentKind === TESTER_AGENT_KIND && step.test?.phase === 'fixing') {
      step.jobId = undefined
      step.subtasks = undefined
      step.test.phase = 'testing'
      const block = await this.blockRepository.get(workspaceId, instance.blockId)
      if (!block) return { kind: 'noop' }
      // Reclaim the finished Fixer container before re-dispatching the Tester so it
      // boots fresh against the just-pushed fixes (rather than re-attaching to the
      // completed job by run id).
      await this.stopRunContainer(workspaceId, instance)
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

    if (update.state === 'failed') {
      // A container eviction (the per-run container vanished, its in-memory job is
      // gone) is usually transient. Recover it by dropping the dead handle and
      // returning `continue`: the driver loops back into `advanceInstance`, which
      // re-dispatches the SAME step to a fresh container (a new instance boots under
      // the same id). Two flavours, with separate budgets:
      //   - one the runtime facade flagged as transient infra churn (e.g. a deploy
      //     draining the sandbox) is not a sick run, and can recur several times in a
      //     short window, so it gets the larger MAX_TRANSIENT_EVICTION_RECOVERIES
      //     budget (recoveries are naturally spaced by the job poll interval, riding
      //     out the window);
      //   - any other eviction (crash/OOM) gets the tight MAX_EVICTION_RECOVERIES.
      // Once a budget is spent the eviction is treated as deterministic and fails the
      // run as `evicted`. A genuine agent/job failure is never recovered.
      if (isContainerEvictionError(update.error)) {
        const transient = isTransientEviction(update.error)
        const limit = transient ? MAX_TRANSIENT_EVICTION_RECOVERIES : MAX_EVICTION_RECOVERIES
        const recoveries = transient
          ? (step.transientEvictionRecoveries ?? 0)
          : (step.evictionRecoveries ?? 0)
        if (recoveries < limit) {
          if (transient) step.transientEvictionRecoveries = recoveries + 1
          else step.evictionRecoveries = recoveries + 1
          step.jobId = undefined
          step.subtasks = undefined
          step.progress = 0
          await this.executionRepository.upsert(workspaceId, instance)
          await this.emitInstance(workspaceId, instance)
          return { kind: 'continue' }
        }
        return {
          kind: 'job_evicted',
          error: transient
            ? `${update.error} (still evicting after ${recoveries} automatic restarts through the infrastructure churn — treating as deterministic)`
            : `${update.error ?? 'Container evicted'} (still evicting after ${recoveries} automatic container restart${recoveries === 1 ? '' : 's'} — treating as deterministic)`,
        }
      }
      return { kind: 'job_failed', error: update.error }
    }

    const block = await this.blockRepository.get(workspaceId, instance.blockId)
    if (!block) return { kind: 'noop' }
    const isFinalStep = instance.currentStep === instance.steps.length - 1
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
   * Transition a step into `working`, stamping its start time the first time it
   * actually begins. Set-once so a Workflows replay (which re-runs `advance`)
   * preserves the original start rather than resetting it on every replay. An
   * explicit re-run clears `startedAt` first (see {@link requestStepChanges}) so
   * the fresh attempt is timed from scratch.
   */
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

  private startStep(step: PipelineStep): void {
    step.state = 'working'
    if (step.startedAt == null) step.startedAt = this.clock.now()
    // (Re)entering `working` means the step is no longer parked on a human: resume
    // its duration clock (see {@link pauseStepForInput}).
    step.pausedAt = null
  }

  /**
   * Transition a step into `done`, stamping its finish time once. Set-once so the
   * approval-gate flow (which re-asserts `done` after a human approves, long after
   * the agent actually finished) keeps the agent's true completion time, and so a
   * replay doesn't move it. With {@link startStep}'s `startedAt` this yields the
   * step's execution duration. A step finished directly out of a parked approval
   * stopped *working* when it parked, so its duration is billed to the pause instant
   * ({@link pauseStepForInput}), not the (later) moment the human decided.
   */
  private finishStep(step: PipelineStep): void {
    step.state = 'done'
    if (step.finishedAt == null) step.finishedAt = step.pausedAt ?? this.clock.now()
    step.pausedAt = null
  }

  /**
   * Finish a gated step that was skipped (its estimate gate was not satisfied) and either
   * complete the run or advance to the next step — the deterministic finish/advance tail
   * of {@link recordStepResult}, minus all the agent-result handling (no LLM ran, so there
   * is no usage / decision / PR / artifact / approval / resolver to process). The step is
   * marked `skipped` with empty output so the UI renders "skipped (gated)".
   */
  private async skipGatedStep(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    isFinalStep: boolean,
  ): Promise<AdvanceResult> {
    step.skipped = true
    step.output = ''
    step.progress = 1
    step.subtasks = undefined
    this.finishStep(step)

    if (isFinalStep) {
      instance.status = 'done'
      await this.finalizeBlock(workspaceId, instance, undefined)
      await this.executionRepository.upsert(workspaceId, instance)
      await this.emitInstance(workspaceId, instance)
      await this.stopRunContainer(workspaceId, instance)
      return { kind: 'done' }
    }
    instance.currentStep += 1
    const next = instance.steps[instance.currentStep]
    if (next) this.startStep(next)
    await this.updateBlockProgress(workspaceId, instance, 'in_progress')
    await this.executionRepository.upsert(workspaceId, instance)
    await this.emitInstance(workspaceId, instance)
    return { kind: 'continue' }
  }

  /**
   * Park a step on a human decision and freeze its duration clock. Records when the
   * step stopped working (`pausedAt`) so elapsed time no longer accrues while it waits
   * for input — the symmetric counterpart of the terminal freeze on `finishedAt`.
   * Set-once (a Workflows replay re-parking keeps the original instant); cleared when
   * the step resumes ({@link startStep}) or finishes ({@link finishStep}).
   */
  private pauseStepForInput(step: PipelineStep): void {
    step.state = 'waiting_decision'
    if (step.pausedAt == null) step.pausedAt = this.clock.now()
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
      this.pauseStepForInput(step)
      instance.status = 'blocked'
      await this.updateBlockProgress(workspaceId, instance, 'blocked')
      await this.executionRepository.upsert(workspaceId, instance)
      await this.emitInstance(workspaceId, instance)
      return { kind: 'awaiting_decision', decisionId: step.decision.id }
    }

    // A `tester` step returned a structured report. On a withheld greenlight we do
    // NOT finish the step: we loop the `fixer` (within the attempt budget) and
    // re-test, mirroring the CI gate. A greenlight (or no provider) falls through to
    // the normal finish/advance below. Records the report on the step either way.
    if (step.agentKind === TESTER_AGENT_KIND && result.testReport !== undefined) {
      const looped = await this.testerController.resolveTesterResult(
        workspaceId,
        instance,
        step,
        result,
      )
      if (looped) return looped
    }

    // The step completed.
    step.output = result.output ?? ''
    // Surface a registered custom kind's structured JSON on the step so the SPA's
    // `generic-structured` result view can render it (a post-op consumes the same value
    // server-side). Built-in / prose kinds leave it undefined.
    if (result.custom !== undefined) step.custom = result.custom
    if (result.model) step.model = result.model
    step.progress = 1
    this.finishStep(step)
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

    // A Blueprinter step produced a fresh service decomposition. Validate it with
    // the authoritative schema (a bad payload must never touch the board), then
    // reconcile it in place onto the run's service frame.
    if (result.blueprintService !== undefined) {
      await this.ingestBlueprint(workspaceId, instance.blockId, result.blueprintService)
    }

    // A spec-writer step produced the service's unified specification (`spec.json`)
    // and committed it to the implementation branch. Strict-validate it (a bad payload
    // must never be trusted), then nudge clients to refresh.
    if (result.spec !== undefined) {
      await this.ingestSpec(workspaceId, result.spec)
    }

    // Record the spec-writer's BUSINESS-vs-TECHNICAL determination on the step. "No
    // business specs" (a purely technical task) is a valid outcome; the spec-companion's
    // convergence — the one point both signals coexist — combines this with the
    // companion's `technicalCorroborated` verdict to infer the block's `technical` label
    // (see CompanionController). Recorded even when false so a re-run reflects the latest.
    if (step.agentKind === SPEC_WRITER_AGENT_KIND) {
      step.noBusinessSpecs = result.noBusinessSpecs === true
    }

    // A `task-estimator` step emits a JSON triage (complexity/risk/impact). Parse it
    // tolerantly, persist it on the block (used to gate consensus steps + surfaced in
    // the UI), and replace the raw JSON output with a readable summary. An unparseable
    // estimate leaves the block untouched and keeps the raw output (no run failure).
    // The estimate works the same whether the single-actor estimator or the consensus
    // ranked-scoring variant produced the JSON — both land here.
    if (step.agentKind === TASK_ESTIMATOR_AGENT_KIND) {
      const estimate = coerceTaskEstimate(
        step.output,
        result.model ?? step.model ?? null,
        this.clock.now(),
      )
      if (estimate) {
        await this.blockRepository.update(workspaceId, instance.blockId, { estimate })
        step.output = summarizeEstimate(estimate)
      }
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
      this.pauseStepForInput(step)
      instance.status = 'blocked'
      await this.updateBlockProgress(workspaceId, instance, 'blocked')
      await this.executionRepository.upsert(workspaceId, instance)
      await this.emitInstance(workspaceId, instance)
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
    if (resolver && (resolver.applies?.(result) ?? true)) {
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
      await this.finalizeBlock(workspaceId, instance, result.confidence)
      await this.executionRepository.upsert(workspaceId, instance)
      await this.emitInstance(workspaceId, instance)
      // The run is finished: reclaim its per-run container now instead of letting it
      // idle out its sleepAfter window (~10 min of billed-but-useless compute). All
      // pipeline steps share the one container keyed by the execution id, so this is
      // only safe on the FINAL step — never between steps. Best-effort/idempotent.
      await this.stopRunContainer(workspaceId, instance)
      return { kind: 'done' }
    }
    instance.currentStep += 1
    const next = instance.steps[instance.currentStep]
    if (next) this.startStep(next)
    // A resolver that already set the block's TERMINAL status (the merger flips it to
    // `done`/`pr_ready` mid-pipeline) must not be clobbered back to `in_progress` as we
    // advance to a trailing step — refresh progress only, preserving that status. (The
    // final step's `finalizeBlock` then leaves a `done` block alone.)
    if (resolverOwnsTerminalStatus) {
      await this.refreshBlockProgress(workspaceId, instance)
    } else {
      await this.updateBlockProgress(workspaceId, instance, 'in_progress')
    }
    await this.executionRepository.upsert(workspaceId, instance)
    await this.emitInstance(workspaceId, instance)
    return { kind: 'continue' }
  }

  /**
   * Reset a step so the durable driver re-runs it from scratch: clear its live
   * container job handle (so it dispatches FRESH work rather than re-attaching to a
   * finished or evicted job), its timings, approval gate, live subtasks and last
   * output, and drop it back to `pending`. Preserves the step's identity
   * (`agentKind` / `requiresApproval`) and any companion budget/verdict history.
   */
  private resetStepForRerun(step: PipelineStep): void {
    step.state = 'pending'
    step.startedAt = null
    step.finishedAt = null
    step.pausedAt = null
    step.jobId = undefined
    step.approval = null
    step.subtasks = undefined
    step.progress = 0
    step.output = undefined
    // Drop the prior run's structured output too, so a re-run that produces no `custom`
    // doesn't leave stale JSON for the `generic-structured` result view to render.
    step.custom = undefined
    step.rework = undefined
  }

  /**
   * Loop a producer step back for rework and re-run every step from it up to and
   * including the companion at `companionIndex`: each one is reset (crucially clearing
   * stale container job handles so an intermediate container step re-dispatches fresh
   * work instead of re-attaching to its evicted job), the producer is handed the
   * `rework` feedback + started, and the instance cursor is moved back to the producer.
   * Shared by the automatic companion loop and the human "request changes" path.
   */
  private rerunProducerThrough(
    instance: ExecutionInstance,
    producerIndex: number,
    companionIndex: number,
    rework: NonNullable<PipelineStep['rework']>,
  ): void {
    for (let i = producerIndex; i <= companionIndex; i++) {
      this.resetStepForRerun(instance.steps[i]!)
    }
    const producer = instance.steps[producerIndex]!
    producer.rework = rework
    this.startStep(producer)
    instance.currentStep = producerIndex
  }

  /**
   * The index of the nearest preceding step a companion grades (one of its target
   * producer kinds), or -1 when none precedes it. The single producer-search used by the
   * automatic companion loop, the human "request changes" redirect, and the iteration-cap
   * extra-round resolution.
   */
  private companionProducerIndex(instance: ExecutionInstance, companionIndex: number): number {
    const targets = companionTargets(instance.steps[companionIndex]!.agentKind)
    for (let i = companionIndex - 1; i >= 0; i--) {
      if (targets.includes(instance.steps[i]!.agentKind)) return i
    }
    return -1
  }

  /**
   * Loop a companion's producer back for one more automatic rework cycle: charge one
   * attempt against the budget, then re-run the producer (and any intermediate steps) up
   * to and including the companion so it re-grades. Shared by the automatic
   * below-threshold loop ({@link evaluateCompanion}) and the human-granted extra round
   * ({@link resolveCompanionExceeded}), so both consume the budget identically.
   */
  private loopCompanionProducer(
    instance: ExecutionInstance,
    companionIndex: number,
    rework: NonNullable<PipelineStep['rework']>,
  ): void {
    const companionStep = instance.steps[companionIndex]!
    const producerIndex = this.companionProducerIndex(instance, companionIndex)
    companionStep.companion!.attempts += 1
    this.rerunProducerThrough(instance, producerIndex, companionIndex, rework)
    if (instance.status === 'blocked') instance.status = 'running'
  }

  /**
   * Deterministically provision an ephemeral environment for a deployer step.
   * Produces a human-readable summary as the step output and reports no token
   * usage (it incurs no LLM cost). Errors are swallowed into the output unless
   * the durable driver wants them surfaced for its per-step retry.
   */
  private async runDeployer(
    workspaceId: string,
    instance: ExecutionInstance,
    block: Block,
    options: AdvanceOptions = {},
  ): Promise<AgentRunResult> {
    try {
      const handle = await this.environmentProvisioning!.provision({
        workspaceId,
        blockId: block.id,
        executionId: instance.id,
        inputs: this.deployInputs(block),
        context: this.deployContext(block),
      })
      const lines = [
        `Provisioned ephemeral environment via '${handle.providerId}'.`,
        `Status: ${handle.status}`,
        `URL: ${handle.url ?? '(pending)'}`,
      ]
      if (handle.expiresAt) lines.push(`Expires: ${new Date(handle.expiresAt).toISOString()}`)
      return { output: lines.join('\n'), model: `environment:${handle.providerId}` }
    } catch (error) {
      if (options.rethrowAgentErrors) throw error
      return {
        output: `Deployer error: ${getErrorMessage(error)}`,
      }
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
  private gateFor(agentKind: string): GateDefinition | undefined {
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
    return ExecutionService.BUILT_IN_POST_OPS[agentKind] ?? []
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
      await this.emitInstance(workspaceId, instance)
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
    await this.emitInstance(workspaceId, instance)
    return { kind: 'awaiting_job', jobId: step.jobId, stepIndex: instance.currentStep }
  }

  /**
   * Raise a `decision_required` notification when a run parks on an iteration-cap gate
   * after spending its automatic budget — a quality companion at its rework cap or an
   * iterative reviewer (requirements / clarity) at its iteration cap. Without it the
   * three-choice decision is reachable only by drilling into the parked step, so the run
   * looks silently stuck. Best-effort: a missing notification service (tests) or block is
   * a no-op.
   */
  private async raiseDecisionRequired(
    workspaceId: string,
    instance: ExecutionInstance,
  ): Promise<void> {
    if (!this.notificationService) return
    const block = await this.blockRepository.get(workspaceId, instance.blockId)
    if (!block) return
    await this.notificationService.raise(workspaceId, {
      type: 'decision_required',
      blockId: block.id,
      executionId: instance.id,
      title: `"${block.title}" ran out of automatic iterations and needs your decision`,
      body:
        'An automatic review loop reached its iteration cap without converging. Open the ' +
        'task to choose: one more round, proceed with the current result, or stop and reset.',
      payload: { pipelineName: instance.pipelineName },
    })
  }

  /**
   * Ensure an open notification exists for a run that has just parked waiting for a human
   * (an agent-raised decision, an approval gate, or an iterative review gate). Without
   * the old decision timeout the run waits indefinitely, so the inbox card — which the
   * periodic sweep escalates yellow → red — is the only signal a human is needed.
   *
   * Non-clobbering: if ANY open notification is already on the block (a more specific
   * `merge_review`, iteration-cap `decision_required`, etc.), it is left untouched and we
   * raise nothing — so the richer message wins. Best-effort: no notification service
   * (tests) or a missing block is a no-op.
   */
  private async ensureWaitingNotification(
    workspaceId: string,
    instance: ExecutionInstance,
  ): Promise<void> {
    const svc = this.notificationService
    if (!svc) return
    const open = await svc.listOpen(workspaceId)
    if (open.some((n) => n.blockId === instance.blockId)) return
    const block = await this.blockRepository.get(workspaceId, instance.blockId)
    if (!block) return
    await svc.raise(workspaceId, {
      type: 'decision_required',
      blockId: block.id,
      executionId: instance.id,
      title: `"${block.title}" is waiting for your input`,
      body: 'A pipeline step is parked awaiting a human decision. Open the task to respond.',
      payload: { pipelineName: instance.pipelineName },
    })
  }

  /**
   * Clear the auto-raised "waiting for a human decision" card once a run advances past
   * the decision it was parked on (so the escalation sweep can't flip a settled decision
   * red). Scoped to the `decision_required` type, so the human-actionable cards a stopped
   * run leaves behind are untouched. Best-effort: no notification service (tests) is a no-op.
   */
  private async clearWaitingNotification(
    workspaceId: string,
    instance: ExecutionInstance,
  ): Promise<void> {
    const svc = this.notificationService
    if (!svc) return
    await svc.clearWaitingDecision(workspaceId, instance.blockId)
  }

  /** Provision inputs (`{{input.*}}`) derived from the block under deployment. */
  private deployInputs(block: Block): Record<string, string> {
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
  private deployContext(block: Block): ProvisionContext {
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
  private async runAgent(
    context: AgentRunContext,
    options: AdvanceOptions = {},
  ): Promise<AgentRunResult> {
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

  // ---- iterative review gates (requirements + clarity) --------------------
  // The two gate flows live in {@link ReviewGateController}, parameterised by a
  // {@link ReviewKind}. The public methods below are thin delegators (the HTTP controllers
  // call them) and the kind builders supply each subject's differentiators. Three shared
  // state-machine primitives stay here — they are reused by the generic approval path and
  // the companion iteration-cap gate, so they have a single home: {@link parkStepOnDecision},
  // {@link advancePastResolvedGate} and {@link dispatchIterationCap}.

  /**
   * Park a step on the durable decision-wait the approval gate uses, so a human (or the
   * dedicated review window) can drive an iterative loop and resume the run. Shared by the
   * requirements gate and the companion iteration-cap gate: both reuse the SAME parking
   * mechanism rather than each rolling its own. `proposal` seeds the gate's stored text
   * (the companion's latest feedback; empty for the requirements window, which renders its
   * own structured surface via the universal result-view registry).
   */
  private async parkStepOnDecision(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    proposal = '',
  ): Promise<AdvanceResult> {
    step.approval = { id: this.idGenerator.next('appr'), status: 'pending', proposal }
    this.pauseStepForInput(step)
    instance.status = 'blocked'
    await this.updateBlockProgress(workspaceId, instance, 'blocked')
    await this.executionRepository.upsert(workspaceId, instance)
    await this.emitInstance(workspaceId, instance)
    return { kind: 'awaiting_decision', decisionId: step.approval.id }
  }

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
    if (step.agentKind === HUMAN_TEST_AGENT_KIND) {
      throw new ConflictError(
        'Resolve the human-testing gate through its window (confirm / request a fix), not the approval gate',
      )
    }
    if (step.companion?.exceeded) {
      throw new ConflictError(
        'Resolve this companion review through its iteration-cap prompt, not the approval gate',
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
   * Run a fresh reviewer pass over a block's collected requirements, snapshotting the
   * task's merge-preset knobs (iteration budget + tolerated severity) onto the review.
   * Shared by the pipeline gate and the off-path inspector "Run review" surface, so both
   * honour the task's preset identically.
   */
  reviewRequirements(workspaceId: string, blockId: string): Promise<RequirementReview> {
    return this.reviewGate.review(this.requirementsKind, workspaceId, blockId)
  }

  /**
   * Incorporate the human's settled answers ASYNCHRONOUSLY. Validates that every finding is
   * answered/dismissed, flags the review `incorporating`, records the intent on the parked
   * gate step, and signals the durable driver to wake — which folds the answers and
   * re-reviews in the background. Off-path (no parked run) the fold + re-review run inline.
   */
  incorporateRequirements(
    workspaceId: string,
    blockId: string,
    feedback?: string,
  ): Promise<RequirementReview> {
    return this.reviewGate.incorporate(this.requirementsKind, workspaceId, blockId, feedback)
  }

  /**
   * Re-review the incorporated document (one more reviewer pass). On convergence
   * (`incorporated`) the parked run advances; otherwise the window shows the next cycle
   * (`ready`) or the iteration-cap choices (`exceeded`).
   */
  reReviewRequirements(workspaceId: string, blockId: string): Promise<RequirementReview> {
    return this.reviewGate.reReview(this.requirementsKind, workspaceId, blockId)
  }

  /**
   * Proceed: settle the requirements (the last incorporated doc, if any, becomes what
   * downstream agents consume) and advance the parked run.
   */
  proceedRequirements(workspaceId: string, blockId: string): Promise<RequirementReview> {
    return this.reviewGate.proceed(this.requirementsKind, workspaceId, blockId)
  }

  /**
   * Ask the Requirement Writer to recommend answers for a batch of findings ASYNCHRONOUSLY:
   * append `pending` placeholder recommendations at once and signal the durable driver to run
   * the Writer per finding in the background (filling them in + notifying when done). Returns the
   * review with the placeholders so the SPA shows "generating…" and hands the user back.
   */
  requestRecommendations(
    workspaceId: string,
    blockId: string,
    itemIds: string[],
    note?: string,
  ): Promise<RequirementReview> {
    return this.reviewGate.requestRecommendations(
      this.requirementsKind,
      workspaceId,
      blockId,
      itemIds,
      note,
    )
  }

  /**
   * Re-request a single recommendation with a "do it differently" note — resets it to `pending`
   * and drives the Writer through the same async path. Review-scoped (the re-request endpoint
   * addresses the recommendation by review id).
   */
  reRequestRecommendation(
    workspaceId: string,
    reviewId: string,
    recId: string,
    note: string,
  ): Promise<RequirementReview> {
    return this.reviewGate.reRequestRecommendation(
      this.requirementsKind,
      workspaceId,
      reviewId,
      recId,
      note,
    )
  }

  /**
   * Route an iteration-cap resolution to its gate-specific handlers. `stop-reset` is
   * uniform across gates: cancel the run and return the block to phase zero (editable),
   * keeping whatever reference artifact each gate persists (the requirements doc on its
   * own table; a companion's producer output on its branch). Shared by the requirements
   * gate ({@link resolveRequirementsExceeded}) and the companion gate
   * ({@link resolveCompanionExceeded}) so the three-way choice lives in one place.
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
   * Resolve a requirements review that hit its iteration cap: grant one more round,
   * proceed with the last incorporated doc, or stop the task and reset it to phase zero.
   */
  resolveRequirementsExceeded(
    workspaceId: string,
    blockId: string,
    choice: ResolveRequirementsExceededChoice,
  ): Promise<RequirementReview> {
    return this.reviewGate.resolveExceeded(this.requirementsKind, workspaceId, blockId, choice)
  }

  /**
   * Resolve a companion step parked at its automatic-rework cap (`companion.exceeded`):
   * grant one more round, proceed accepting the producer's current output, or stop the
   * task and reset it to phase zero. The companion mirror of
   * {@link resolveRequirementsExceeded}, sharing the iteration-cap dispatch + the
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
        const producer = instance.steps[this.companionProducerIndex(instance, stepIndex)]
        this.loopCompanionProducer(instance, stepIndex, {
          previousProposal: producer?.output ?? '',
          feedback: step.companion!.verdicts.at(-1)?.feedback ?? '',
        })
        await this.updateBlockProgress(workspaceId, instance, 'in_progress')
        await this.executionRepository.upsert(workspaceId, instance)
        await this.workRunner.signalDecision(workspaceId, instance.id, approvalId, 'extra-round')
        await this.emitInstance(workspaceId, instance)
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
          const producer = instance.steps[this.companionProducerIndex(instance, stepIndex)]
          const block = await this.blockRepository.get(workspaceId, instance.blockId)
          if (producer && block) await this.inferBlockTechnical(workspaceId, block, producer, step)
        }
        await this.advancePastResolvedGate(workspaceId, instance, stepIndex)
      },
    })
    return instance
  }

  /**
   * Finish a gate step the human just resolved (its `approval` already marked `approved`),
   * then either finish the run (final step) or advance to the next step, persist, and wake
   * the parked durable driver. The single advance/finalize/signal path shared by every
   * gate-resume site — the generic approval ({@link approveStep}), the review gates (via
   * {@link ReviewGateController}) and the companion iteration-cap proceed
   * ({@link resolveCompanionExceeded}) — so the logic lives in exactly one place.
   */
  private async advancePastResolvedGate(
    workspaceId: string,
    instance: ExecutionInstance,
    stepIndex: number,
  ): Promise<void> {
    const step = instance.steps[stepIndex]!
    const decisionId = step.approval!.id
    this.finishStep(step)
    step.progress = 1
    const isFinalStep = stepIndex === instance.steps.length - 1
    if (isFinalStep) {
      instance.status = 'done'
      await this.finalizeBlock(workspaceId, instance, undefined)
      await this.stopRunContainer(workspaceId, instance)
    } else {
      instance.currentStep = stepIndex + 1
      const next = instance.steps[instance.currentStep]
      if (next) this.startStep(next)
      if (instance.status === 'blocked') instance.status = 'running'
      await this.updateBlockProgress(workspaceId, instance, 'in_progress')
    }
    await this.executionRepository.upsert(workspaceId, instance)
    await this.workRunner.signalDecision(workspaceId, instance.id, decisionId, 'approved')
    await this.emitInstance(workspaceId, instance)
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

  /**
   * Run a fresh clarity reviewer pass over a block's bug report, snapshotting the task's
   * merge-preset knobs (iteration budget + tolerated severity) and threading in any
   * `bug-investigator` output as the triage subject. Shared by the gate + the off-path
   * inspector "Run review" surface.
   */
  reviewClarity(workspaceId: string, blockId: string): Promise<ClarityReview> {
    return this.reviewGate.review(this.clarityKind, workspaceId, blockId)
  }

  /** Incorporate the human's settled answers ASYNCHRONOUSLY (the clarity mirror of {@link incorporateRequirements}). */
  incorporateClarity(
    workspaceId: string,
    blockId: string,
    feedback?: string,
  ): Promise<ClarityReview> {
    return this.reviewGate.incorporate(this.clarityKind, workspaceId, blockId, feedback)
  }

  /** Re-review the clarified report (one more pass). On convergence the parked run advances. */
  reReviewClarity(workspaceId: string, blockId: string): Promise<ClarityReview> {
    return this.reviewGate.reReview(this.clarityKind, workspaceId, blockId)
  }

  /** Proceed: settle the clarity review and advance the parked run. */
  proceedClarity(workspaceId: string, blockId: string): Promise<ClarityReview> {
    return this.reviewGate.proceed(this.clarityKind, workspaceId, blockId)
  }

  /** Resolve a clarity review that hit its iteration cap (extra-round / proceed / stop-reset). */
  resolveClarityExceeded(
    workspaceId: string,
    blockId: string,
    choice: ResolveRequirementsExceededChoice,
  ): Promise<ClarityReview> {
    return this.reviewGate.resolveExceeded(this.clarityKind, workspaceId, blockId, choice)
  }

  // ---- human-testing gate actions (driven from the dedicated window) -------
  // Each mutates the parked gate step and wakes the durable driver, which re-enters the gate
  // and performs the (env / helper) work; see {@link HumanTestController}.

  /** Confirm the change works: tear the ephemeral env down and advance the run. */
  confirmHumanTest(workspaceId: string, blockId: string): Promise<ExecutionInstance> {
    return this.humanTestController.confirm(workspaceId, blockId)
  }

  /** Submit findings and request a fix: dispatch the Tester's `fixer`, then rebuild the env. */
  requestHumanTestFix(
    workspaceId: string,
    blockId: string,
    findings: string,
  ): Promise<ExecutionInstance> {
    return this.humanTestController.requestFix(workspaceId, blockId, findings)
  }

  /** Pull the repo default branch into the PR branch + redeploy (conflict → conflict-resolver). */
  pullMainHumanTest(workspaceId: string, blockId: string): Promise<ExecutionInstance> {
    return this.humanTestController.pullMain(workspaceId, blockId)
  }

  /** Rebuild the ephemeral environment on demand. */
  recreateHumanTestEnv(workspaceId: string, blockId: string): Promise<ExecutionInstance> {
    return this.humanTestController.recreateEnvironment(workspaceId, blockId)
  }

  /** Destroy the ephemeral environment on demand (the run stays parked). */
  destroyHumanTestEnv(workspaceId: string, blockId: string): Promise<ExecutionInstance> {
    return this.humanTestController.destroyEnvironment(workspaceId, blockId)
  }

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
    const instance = await this.executionRepository.get(workspaceId, block.executionId)
    const step = instance?.steps[instance.currentStep]
    if (!instance || !step || step.agentKind !== HUMAN_REVIEW_AGENT_KIND || !step.gate) {
      throw new ConflictError('No human-review gate is currently awaiting input')
    }
    step.gate.pendingFix = { instructions, at: this.clock.now() }
    // Re-arm a decision-parked run so the re-driven loop polls instead of no-oping; a spend-
    // paused run stays paused.
    if (instance.status === 'blocked') instance.status = 'running'
    await this.executionRepository.upsert(workspaceId, instance)
    await this.emitInstance(workspaceId, instance)
    // Ensure a driver is active to consume the pending fix (idempotent for a live run).
    if (instance.status === 'running') {
      await this.workRunner.startRun(workspaceId, instance.id)
    }
    return instance
  }

  /**
   * Push the run's latest state to subscribed clients, alongside its rolled-up
   * block so the board updates without a refetch. Best-effort: the publisher
   * swallows its own errors, and the persisted run remains the source of truth.
   */
  private async emitInstance(workspaceId: string, instance: ExecutionInstance): Promise<void> {
    // Stamp each step with the run id so a lone step (in a pushed event, a log line, a
    // detail view) is self-describing for debugging; the value always equals the run id.
    for (const step of instance.steps) step.runId = instance.id
    // The metrics rollup and the block fetch are independent, so run them concurrently
    // — the rollup adds no serial latency to the (frequent) emit path.
    const [, block] = await Promise.all([
      this.attachStepMetrics(workspaceId, instance),
      this.blockRepository.get(workspaceId, instance.blockId),
    ])
    await this.events.executionChanged(workspaceId, instance, block)
    // When a run reaches a terminal state, delete its per-run personal-credential
    // activation immediately (individual-usage subscriptions) so the system-encrypted
    // token copy doesn't linger to its TTL. Best-effort + idempotent — a missing repo or
    // a re-emit of an already-cleared run is a no-op, and a failure here must never
    // derail the emit.
    if (
      this.subscriptionActivations &&
      (instance.status === 'done' || instance.status === 'failed')
    ) {
      try {
        await this.subscriptionActivations.deleteByExecution(instance.id)
      } catch {
        // Swallow — a failure here must never derail the emit. This is not a silent
        // data-loss path: the TTL sweep reclaims the row as a backstop, and the sweep
        // (Worker cron / Node retention timer) logs its own errors, so a *systemic*
        // cleanup failure surfaces there rather than being lost here.
      }
    }
  }

  /**
   * Roll the run's recorded LLM calls into per-step `metrics` for the board, in
   * place on the emitted instance. The proxy keys calls by execution + agentKind
   * (not step index), so the aggregate is per-agent-kind within the run; steps
   * sharing a kind get the same rollup. Best-effort and a no-op when the sink is
   * not wired, so it never blocks an emit.
   */
  private async attachStepMetrics(workspaceId: string, instance: ExecutionInstance): Promise<void> {
    if (!this.llmObservability) return
    try {
      const summaries = await this.llmObservability.summarizeByExecution(workspaceId, instance.id)
      if (summaries.length === 0) return
      const byKind = new Map(summaries.map((s) => [s.agentKind, s]))
      for (const step of instance.steps) {
        const s = byKind.get(step.agentKind)
        if (!s) continue
        step.metrics = {
          calls: s.calls,
          promptTokens: s.promptTokens,
          completionTokens: s.completionTokens,
          peakCompletionTokens: s.peakCompletionTokens,
          maxOutputTokens: s.maxOutputTokens,
          truncatedCalls: s.truncatedCalls,
          upstreamMs: s.upstreamMs,
          overheadMs: s.overheadMs,
          errors: s.errors,
          warnings: s.warnings,
        }
      }
    } catch (error) {
      // Observability is best-effort; never block an emit on a metrics read.
      void error
    }
  }

  /** Set the block's in-progress/blocked status and step-completion progress. */
  private async updateBlockProgress(
    workspaceId: string,
    instance: ExecutionInstance,
    status: 'in_progress' | 'blocked',
  ): Promise<void> {
    const total = instance.steps.length || 1
    const done = instance.steps.filter((s) => s.state === 'done').length
    await this.blockRepository.update(workspaceId, instance.blockId, {
      status,
      progress: Math.min(1, done / total),
    })
  }

  /**
   * Advance the block's step PROGRESS without touching its status — used when a step
   * resolver already owns the block's terminal status (the merger set `done`/`pr_ready`)
   * and a trailing step still follows, so the bar moves on without downgrading that status.
   */
  private async refreshBlockProgress(
    workspaceId: string,
    instance: ExecutionInstance,
  ): Promise<void> {
    const total = instance.steps.length || 1
    const done = instance.steps.filter((s) => s.state === 'done').length
    await this.blockRepository.update(workspaceId, instance.blockId, {
      progress: Math.min(1, done / total),
    })
  }

  /**
   * A pipeline finished. A frame becomes `done` (a mapping-only run leaves it
   * `ready`). A *task* never auto-`done`s from a confidence score any more — that
   * looked merged when the PR was still open with red CI. Instead:
   *   - if the pipeline has a `merger` step, it already owned the merge/notify
   *     decision (see {@link resolveMergerStep}); we only backstop a missing one;
   *   - otherwise the work is complete but unmerged: leave the PR open (`pr_ready`)
   *     and raise a `pipeline_complete` notification for a human to confirm + merge.
   * `done` now strictly means the PR was merged (see {@link finalizeMerge}).
   */
  private async finalizeBlock(
    workspaceId: string,
    instance: ExecutionInstance,
    confidence: number | undefined,
  ): Promise<void> {
    const block = await this.blockRepository.get(workspaceId, instance.blockId)
    if (!block || block.status === 'done') return

    if ((block.level ?? 'frame') !== 'task') {
      // A mapping-only run (just the `blueprints` step, e.g. kicked off after a
      // bootstrap) leaves the service frame `ready` and droppable rather than
      // marking the whole service "done".
      const mappingOnly = instance.steps.every((s) => s.agentKind === 'blueprints')
      await this.blockRepository.update(workspaceId, block.id, {
        status: mappingOnly ? 'ready' : 'done',
        progress: 1,
      })
      return
    }

    // Confidence is recorded by the caller (recordStepResult) before any merge, so
    // it persists on both the merge and review paths; `confidence` is unused here.
    void confidence

    const hasMerger = instance.steps.some((s) => s.agentKind === MERGER_AGENT_KIND)
    if (hasMerger) {
      // The `merger` step already merged (→ `done`) or raised a review (→ `pr_ready`).
      // Only backstop the case where it produced no decision at all.
      const fresh = await this.blockRepository.get(workspaceId, block.id)
      if (fresh && fresh.status !== 'done' && fresh.status !== 'pr_ready') {
        await this.blockRepository.update(workspaceId, block.id, {
          status: 'pr_ready',
          progress: 1,
        })
      }
      return
    }

    // No merger in this pipeline: complete but unmerged — ask a human to confirm.
    await this.blockRepository.update(workspaceId, block.id, { status: 'pr_ready', progress: 1 })
    await this.raisePipelineComplete(workspaceId, instance, block)
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
    for (const dependent of dependents) {
      // All of the dependent's blockers must now be satisfied (not just the one that merged).
      if (!dependenciesMet(blocks, dependent.id)) continue
      // Only auto-start a fresh task — never replace a run already in flight or a finished one.
      if (dependent.status !== 'planned' && dependent.status !== 'ready') continue
      const pipelineId = await this.resolveDefaultPipelineId(workspaceId, dependent)
      if (!pipelineId) continue
      // Skip dependents that would lease an individual-usage credential (can't unlock unattended).
      const individual = await this.individualVendorsForBlock(workspaceId, dependent.id, pipelineId)
      if (individual.length > 0) continue
      try {
        await this.start(workspaceId, dependent.id, pipelineId, null)
      } catch {
        // Already running, no usable provider, still-unmet dep racing, etc. — leave this
        // dependent for a manual start; the others still get their chance.
      }
    }
  }

  /**
   * The pipeline id a dependent task should auto-start with: its pinned `pipelineId` when
   * set, else the workspace's first pipeline (mirrors the board's "Run" default). Null
   * when no pipeline exists at all.
   */
  private async resolveDefaultPipelineId(
    workspaceId: string,
    block: Block,
  ): Promise<string | null> {
    if (block.pipelineId) return block.pipelineId
    const pipelines = await this.pipelineRepository.listByWorkspace(workspaceId)
    return pipelines[0]?.id ?? null
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
    maxComplexity: number
    maxRisk: number
    maxImpact: number
    ciMaxAttempts: number
    maxRequirementIterations: number
    maxRequirementConcernAllowed: RequirementConcernLevel
    releaseWatchWindowMinutes: number
    releaseMaxAttempts: number
    humanReviewGraceMinutes: number
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

  /** Raise a `pipeline_complete` notification for a no-merger run awaiting confirmation. */
  private async raisePipelineComplete(
    workspaceId: string,
    instance: ExecutionInstance,
    block: Block,
  ): Promise<void> {
    if (!this.notificationService) return
    await this.notificationService.raise(workspaceId, {
      type: 'pipeline_complete',
      blockId: block.id,
      executionId: instance.id,
      title: `Confirm "${block.title}" is complete`,
      body:
        `The "${instance.pipelineName}" pipeline finished and opened a PR, but it has no ` +
        `merger step. Review the work and confirm it as complete (this merges the PR).`,
      payload: {
        ...(block.pullRequest?.url ? { prUrl: block.pullRequest.url } : {}),
        pipelineName: instance.pipelineName,
      },
    })
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
    const instance = assertFound(
      await this.executionRepository.get(workspaceId, executionId),
      'Execution',
      executionId,
    )
    const step = instance.steps.find((s) => s.decision?.id === decisionId)
    if (!step || !step.decision) throw new NotFoundError('Decision', decisionId)

    step.decision.chosen = choice
    this.startStep(step)
    if (instance.status === 'blocked') instance.status = 'running'
    await this.updateBlockProgress(workspaceId, instance, 'in_progress')
    await this.executionRepository.upsert(workspaceId, instance)
    // Wake the parked durable run, if any. The DB write above remains the source
    // of truth (so the backstop sweeper can still re-drive it); the signal is an
    // optimisation that lets the workflow continue immediately.
    await this.workRunner.signalDecision(workspaceId, instance.id, decisionId, choice)
    await this.emitInstance(workspaceId, instance)
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
    const instance = assertFound(
      await this.executionRepository.get(workspaceId, executionId),
      'Execution',
      executionId,
    )
    const stepIndex = instance.steps.findIndex((s) => s.approval?.id === approvalId)
    const step = instance.steps[stepIndex]
    if (!step || !step.approval) throw new NotFoundError('Approval', approvalId)
    this.assertNotIterativeGate(step)
    if (step.approval.status === 'approved') return instance

    // A human edit to the proposal replaces the agent's text, so the revised
    // proposal is what downstream steps read (via priorOutputs).
    if (opts.proposal !== undefined) {
      step.output = opts.proposal
      step.approval.proposal = opts.proposal
    }
    step.approval.status = 'approved'
    // A gate is never raised on the final step, but the shared advance stays defensive.
    await this.advancePastResolvedGate(workspaceId, instance, stepIndex)
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
    const instance = assertFound(
      await this.executionRepository.get(workspaceId, executionId),
      'Execution',
      executionId,
    )
    const step = instance.steps.find((s) => s.approval?.id === approvalId)
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

    const stepIndex = instance.steps.findIndex((s) => s.approval?.id === approvalId)

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
        if (targets.includes(instance.steps[i]!.agentKind)) {
          producerIndex = i
          break
        }
      }
      const producer = producerIndex >= 0 ? instance.steps[producerIndex]! : undefined
      if (producer) {
        // Re-run the producer (with the human's feedback) and every step up to and
        // including the companion, then the companion re-grades. Does NOT touch the
        // companion's automatic-rework budget — a human-driven iteration is unbounded.
        const previousProposal = producer.output ?? step.approval.proposal
        this.rerunProducerThrough(instance, producerIndex, stepIndex, {
          previousProposal,
          feedback: review.feedback ?? '',
          ...(review.comments?.length ? { comments: review.comments } : {}),
        })
        if (instance.status === 'blocked') instance.status = 'running'
        await this.executionRepository.upsert(workspaceId, instance)
        await this.workRunner.signalDecision(
          workspaceId,
          instance.id,
          approvalId,
          'changes_requested',
        )
        await this.emitInstance(workspaceId, instance)
        return instance
      }
    }

    // Drop the live job handle so the re-run dispatches fresh work rather than
    // re-attaching to the finished job (async steps); inline steps ignore this.
    step.jobId = undefined
    // A requested re-run is a fresh execution: clear the prior timing so the next
    // start/finish times this attempt rather than spanning the human gate wait.
    step.startedAt = null
    step.finishedAt = null
    this.startStep(step)
    if (instance.status === 'blocked') instance.status = 'running'
    await this.executionRepository.upsert(workspaceId, instance)
    await this.workRunner.signalDecision(workspaceId, instance.id, approvalId, 'changes_requested')
    await this.emitInstance(workspaceId, instance)
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
    const instance = assertFound(
      await this.executionRepository.get(workspaceId, executionId),
      'Execution',
      executionId,
    )
    const step = instance.steps.find((s) => s.approval?.id === approvalId)
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
    // Already rejected (and the run already failed): return as-is.
    if (step.approval.status === 'rejected') {
      return (await this.executionRepository.get(workspaceId, executionId)) ?? instance
    }

    step.approval.status = 'rejected'
    if (reason) step.approval.feedback = reason
    await this.executionRepository.upsert(workspaceId, instance)
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
  async failRun(
    workspaceId: string,
    executionId: string,
    message: string,
    kind: AgentFailureKind = 'agent',
    detail: string | null = null,
  ): Promise<void> {
    const instance = await this.executionRepository.get(workspaceId, executionId)
    if (!instance) return
    // Reclaim the per-run container on the failure path too: a failed run otherwise
    // leaves its container to idle out sleepAfter. This is the single funnel for
    // every failure kind (job_failed from the driver, the spend/decision timeouts,
    // and the user-facing stopRun, which already reclaimed — the call is idempotent).
    await this.stopRunContainer(workspaceId, instance)
    // The FIRST recorded failure wins: a run already in a terminal `failed` state keeps
    // its existing (richest) failure rather than being overwritten. An inline gate that
    // knows the precise kind/detail returns a `job_failed` result the driver funnels here,
    // so there should only ever be one write — but this guards against a future path that
    // both records a failure and returns `job_failed`, which would otherwise clobber the
    // good record with a generic one (the companion-rejected regression).
    if (instance.status === 'failed') return
    const failure: AgentFailure = {
      kind,
      message,
      detail,
      hint: EXECUTION_FAILURE_HINTS[kind] ?? null,
      occurredAt: this.clock.now(),
      lastSubtasks: instance.steps[instance.currentStep]?.subtasks ?? null,
    }
    await this.executionRepository.markFailed(workspaceId, executionId, failure)
    // Progress reflects how far the pipeline got before failing.
    const done = instance.steps.filter((s) => s.state === 'done').length
    const progress = instance.steps.length > 0 ? done / instance.steps.length : 0
    await this.blockRepository.update(workspaceId, instance.blockId, {
      status: 'blocked',
      progress,
    })
    const failed = await this.executionRepository.get(workspaceId, executionId)
    if (failed) await this.emitInstance(workspaceId, failed)
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

    // Same up-front budget gate as start(): refuse a metered retry once the budget is
    // reached (local/subscription-only pipelines still retry). Before any side effects.
    const pipeline = await this.pipelineRepository.get(workspaceId, previous.pipelineId)
    if (pipeline) {
      await this.assertBudgetAllowsPipeline(
        workspaceId,
        block,
        pipeline,
        initiatedBy ?? previous.initiatedBy,
      )
    }

    const { steps, currentStep } = planResumedSteps(previous)
    // Mint the activation before replacing the failed run, so a bad password aborts
    // the retry without losing the retryable terminal run.
    const newId = this.idGenerator.next('exec')
    await activate?.(newId)
    // Replace the terminal failed run for this block with the resumed one (single
    // run per block, matching the board's by-block projection).
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
    }
    await this.executionRepository.upsert(workspaceId, instance)
    const done = steps.filter((s) => s.state === 'done').length
    await this.blockRepository.update(workspaceId, previous.blockId, {
      status: 'in_progress',
      progress: steps.length > 0 ? done / steps.length : 0,
      executionId: instance.id,
    })
    await this.workRunner.startRun(workspaceId, instance.id)
    await this.emitInstance(workspaceId, instance)
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
    await this.requireBlock(workspaceId, previous.blockId)
    if (
      !Number.isInteger(fromStepIndex) ||
      fromStepIndex < 0 ||
      fromStepIndex >= previous.steps.length
    ) {
      throw new ValidationError(
        `Step ${fromStepIndex} is out of range for this run (it has ${previous.steps.length} step(s)).`,
      )
    }

    // Tear down whatever was driving the run we're about to replace — its per-run
    // container AND its durable driver — before minting the restart. A `done`/`failed`
    // run is already terminal (a no-op teardown), but a still-`running` run would
    // otherwise leak a container and a live Workflows/pg-boss driver.
    await this.stopRunContainer(workspaceId, previous)
    await this.workRunner.cancelRun(workspaceId, executionId)

    const { steps, currentStep } = planRestartFromStep(previous, fromStepIndex)
    // Mint the activation before replacing the prior run, so a bad password aborts the
    // restart without losing the source run.
    const newId = this.idGenerator.next('exec')
    await activate?.(newId)
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
    }
    await this.executionRepository.upsert(workspaceId, instance)
    const done = steps.filter((s) => s.state === 'done').length
    await this.blockRepository.update(workspaceId, previous.blockId, {
      status: 'in_progress',
      progress: steps.length > 0 ? done / steps.length : 0,
      executionId: instance.id,
    })
    await this.workRunner.startRun(workspaceId, instance.id)
    await this.emitInstance(workspaceId, instance)
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
    for (const instance of paused) {
      instance.status = 'running'
      await this.executionRepository.upsert(workspaceId, instance)
      await this.workRunner.startRun(workspaceId, instance.id)
      await this.emitInstance(workspaceId, instance)
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
      await this.stopRunContainer(workspaceId, existing)
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
    await this.stopRunContainer(workspaceId, instance)
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
    for (const blockId of descendantIds(blocks, rootId)) {
      const run = await this.executionRepository.getByBlock(workspaceId, blockId)
      if (!run) continue
      await this.stopRunContainer(workspaceId, run)
      await this.workRunner.cancelRun(workspaceId, run.id)
      await this.executionRepository.deleteByBlock(workspaceId, blockId)
    }
  }

  /**
   * Best-effort: reclaim the per-run container backing an execution. The container is
   * addressed by the run (execution) id, so a backend that shares one across the run
   * (Cloudflare, local Docker) tears the whole thing down. A per-job backend (a
   * self-hosted pool) has no run container, so it cancels the run's IN-FLIGHT step job
   * instead — hence we pass the current step's job id alongside the run id. A no-op for
   * inline executors (no `stopJob`) and for an already-gone container/job; never
   * throws, so it can't derail the teardown that calls it.
   */
  private async stopRunContainer(workspaceId: string, instance: ExecutionInstance): Promise<void> {
    const executor = this.agentExecutor
    if (!isAsyncAgentExecutor(executor) || !executor.stopJob) return
    // The in-flight step's job id (when a job is parked), so a per-job backend can
    // cancel exactly it; the run-container backends ignore it and use the run id.
    const jobId = instance.steps[instance.currentStep]?.jobId ?? instance.id
    try {
      await executor.stopJob({ jobId, runId: instance.id, workspaceId })
    } catch {
      // The container may already be gone (eviction/completion) — nothing to reclaim.
    }
  }
}
