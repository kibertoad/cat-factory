import type {
  AgentFailureKind,
  ResolveBinaryArtifactStore,
  Block,
  BlueprintService,
  ExecutionInstance,
  FollowUpsStepState,
  ForkDecisionStepState,
  ChooseForkInput,
  ForkChatRequestInput,
  PrReviewStepState,
  ResolvePrReviewInput,
  RiskPolicyRepository,
  PipelineStep,
  PullRequestMerger,
  StepReviewComment,
  SubscriptionActivationRepository,
  TicketTrackerProvider,
  IssueWritebackProvider,
} from '@cat-factory/kernel'
import {
  allPullRequests,
  DEFAULT_COMPANION_MAX_ATTEMPTS,
  pipelineHasVisualStep,
} from '@cat-factory/contracts'
import {
  companionFor,
  companionTargets,
  hasTrait,
  INTERVIEW_GATE_TRAIT,
  isCompanionKind,
} from '@cat-factory/agents'
import type { AgentKindRegistry } from '@cat-factory/agents'
import type {
  GateRegistry,
  InitiativePresetRegistry,
  RunInitiatorScope,
  StepResolverRegistry,
} from '@cat-factory/kernel'
import { assertPipelineLaunchable, type RunOrigin } from '../pipelines/pipelineShape.js'
import { shouldRunGatedStep } from './stepGating.logic.js'
import {
  resolveIndividualVendors,
  type HasPersonalSubscription,
} from './individualVendors.logic.js'
import {
  assertFound,
  ConflictError,
  type ModelRef,
  NotFoundError,
  type ProviderCapabilities,
  RunContendedError,
  ValidationError,
  type SubscriptionVendor,
} from '@cat-factory/kernel'
import { DEFAULT_RISK_POLICY } from '@cat-factory/kernel'
import {
  REQUIREMENTS_REVIEW_AGENT_KIND,
  CLARITY_REVIEW_AGENT_KIND,
  REQUIREMENTS_BRAINSTORM_AGENT_KIND,
  ARCHITECTURE_BRAINSTORM_AGENT_KIND,
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
  type SkillResolver,
} from './AgentContextBuilder.js'
import { CompanionController } from './CompanionController.js'
import { StepGraph } from './StepGraph.js'
import { RunStateMachine, type KaizenScheduler } from './RunStateMachine.js'
import { RunDispatcher } from './RunDispatcher.js'
import { RunAdmission } from './RunAdmission.js'
import { inferTechnicalLabel } from './technical.logic.js'
import { MergeResolver, type FinalizeMergeResult } from './MergeResolver.js'
import { orderPrsForMerge } from './mergeOrder.logic.js'
import { ReviewGateController, type ReviewKind } from './ReviewGateController.js'
import { buildBrainstormKind, buildClarityKind, buildRequirementsKind } from './review-kinds.js'
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
import { isRalphKind, resolveRalphConfig, seedRalphState } from './ralph.logic.js'
import type { TesterQualityReviewer } from './TesterQualityReviewService.js'
import { HumanTestController } from './HumanTestController.js'
import { VisualConfirmationController } from './VisualConfirmationController.js'
import type { NotificationService } from '../notifications/NotificationService.js'
import type { InitiativeService } from '../initiative/InitiativeService.js'
import type { InitiativeInterviewService } from '../initiative/InitiativeInterviewService.js'
import { InitiativeInterviewController } from './InitiativeInterviewController.js'
import type { DocInterviewService } from '../docInterview/DocInterviewService.js'
import { DocInterviewController } from './DocInterviewController.js'
import type { ForkChatService } from './ForkChatService.js'
import { FORK_DECISION_PRODUCER_KIND } from './forkDecision.logic.js'
import type { InitiativeRunHarvest } from '../initiative/initiative.logic.js'
import type { WorkspaceSettingsService } from '../settings/WorkspaceSettingsService.js'
import type { RequirementReviewService } from '../requirements/RequirementReviewService.js'
import type { ClarityReviewService } from '../clarity/ClarityReviewService.js'
import type { BrainstormService } from '../brainstorm/BrainstormService.js'
import type {
  IterationCapChoice,
  RequirementConcernLevel,
  StepGating,
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
import type { Clock, IdGenerator, PreloadedBlocks } from '@cat-factory/kernel'
import type { GroupCacheHandle, RiskPolicy, RiskPolicyCacheValue } from '@cat-factory/kernel'
import type { AgentExecutor, ResolveRunRepoContext, TestSecretRef } from '@cat-factory/kernel'
import { isAsyncAgentExecutor } from '@cat-factory/kernel'
import type { WorkRunner } from '@cat-factory/kernel'
import type { ExecutionEventPublisher } from '@cat-factory/kernel'
import type { DocumentRepository } from '@cat-factory/kernel'
import type { TaskRepository } from '@cat-factory/kernel'
import type {
  DocInterviewRepository,
  InitiativeRepository,
  RequirementReviewRepository,
} from '@cat-factory/kernel'
import type { ClarityReviewRepository } from '@cat-factory/kernel'
import type { BrainstormSessionRepository } from '@cat-factory/kernel'
import type {
  BugIntakeService,
  EnvironmentProvisioningService,
  EnvironmentTeardownService,
} from '@cat-factory/integrations'
import type { BranchUpdater } from '@cat-factory/kernel'
import { dependenciesMet, descendantIds, serviceOf } from '../board/board.logic.js'
import type { BoardService } from '../board/BoardService.js'
import type { SpendService } from '@cat-factory/spend'
import { requireWorkspace } from '@cat-factory/kernel'
import type { AdvanceOptions, AdvanceResult } from './advance.js'
import {
  carryForwardFailures,
  carryForwardOutputs,
  planResumedSteps,
  planRestartFromStep,
} from './retry.logic.js'

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
  /**
   * The app-owned agent-kind registry, threaded through to the trait/inline-surface checks
   * and a registered kind's pre/post-op hooks. `createCore` defaults it to
   * `defaultAgentKindRegistry()` when a facade doesn't inject the shared instance.
   */
  agentKindRegistry: AgentKindRegistry
  /**
   * The app-owned polling-gate registry (the built-in `@cat-factory/gates` suite installed by
   * the facade + any deployment-registered gates), threaded to the dispatcher's gate machine.
   * `createCore` defaults it to `defaultGateRegistry()` (empty) when a facade doesn't inject one.
   */
  gateRegistry: GateRegistry
  /**
   * The app-owned step-completion-resolver registry (deployment-registered resolvers),
   * threaded to the dispatcher. `createCore` defaults it to `defaultStepResolverRegistry()`.
   */
  stepResolverRegistry: StepResolverRegistry
  /**
   * The app-owned initiative-preset registry, threaded into the context builder so a spawned /
   * planning run resolves its preset steering. `createCore` defaults it to
   * `defaultInitiativePresetRegistry()` when a facade doesn't inject the shared instance.
   */
  initiativePresetRegistry: InitiativePresetRegistry
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
   * Optional: when the interactive document-interview feature is configured (WS5), a block's
   * synthesized authoring brief is read here and folded into the doc-writer's context. Absent
   * → the writer runs off the raw outline/description unchanged.
   */
  docInterviewRepository?: DocInterviewRepository
  /**
   * Optional: the requirements-review feature's service, present when the reviewer is
   * wired. Drives the special `requirements-review` gate step (run reviewer inline, the
   * iterative answer → incorporate → re-review loop). Absent → the gate step passes
   * through so pipelines run unchanged without the feature.
   */
  requirementReviewService?: RequirementReviewService
  /**
   * Optional: the interactive document-interview service (WS5). When wired, the
   * `doc-interviewer` step converses with the human (park/answer/resume) to refine a
   * document's scope/structure and synthesizes an authoring brief the writer starts from.
   * Absent (or no model) → the interviewer step passes through so document pipelines run
   * unchanged off the raw outline.
   */
  docInterviewService?: DocInterviewService
  /**
   * Optional: the inline grounded-chat responder for the implementation-fork decision phase.
   * When wired, a human chat turn about the surfaced forks is answered by an inline LLM in the
   * durable driver; absent (no model) the chat degrades to a canned "chat unavailable" reply so
   * pick / custom still work. Passed to the {@link ForkDecisionController}.
   */
  forkChatService?: ForkChatService
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
   * Optional: resolves a `skill` step's picked skill to its instructions + resource bodies for
   * the run (see {@link SkillResolver}). Wired only when the repo-sourced Claude Skills library is
   * configured; a skill step dispatched with this unwired fails loudly rather than running blank.
   */
  skillResolver?: SkillResolver
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
   * Optional: resolve the NON-secret refs (key + description) of the sensitive test credentials
   * for a run block's service frame, folded into the tester prompt by the context builder.
   * Wired from the facade's `TestSecretsService`; absent ⇒ no advertised secrets. NEVER values.
   */
  resolveTestSecretRefs?: (workspaceId: string, blockId: string) => Promise<TestSecretRef[]>
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
   * Optional: when the initiatives module is wired, the `initiative-planner` step's
   * plan draft is ingested into the block's initiative entity through this, and the
   * `initiative-committer` step flips it to `executing` + mirrors the in-repo
   * tracker. Absent → the initiative steps fail loudly (an initiative pipeline is
   * meaningless without the module) while every other pipeline runs unchanged.
   */
  initiativeService?: InitiativeService
  /**
   * Optional: the initiative store, wired into the agent-context builder so an
   * `initiative`-level run carries the interview + analysis context into the analyst/planner
   * prompts. Same repo the {@link initiativeService} wraps; absent → those steps run off the
   * raw block description.
   */
  initiativeRepository?: InitiativeRepository
  /**
   * Optional: the inline interviewer for the interactive-planning gate (slice 2). When
   * wired, the `initiative-interviewer` step interviews the human (park/answer/resume) and
   * synthesizes the goal/constraints brief onto the entity before the analyst/planner run.
   * Absent (or no model) → the interviewer step passes through and planning runs off the
   * raw block description. Requires {@link initiativeService} to persist the interview state.
   */
  initiativeInterviewService?: InitiativeInterviewService
  /**
   * Best-effort poke of the initiative execution loop (slice 3): called after a spawned task's
   * PR merges (`finalizeMerge`), so its owning initiative reconciles + advances immediately
   * rather than on the next cron sweep. Threaded through to the {@link RunStateMachine} for the
   * symmetric terminal-run poke. Fire-and-forget; a no-op when initiatives are unwired. The
   * optional `harvest` (slice 4) carries the settling run's follow-ups + failure cause.
   */
  pokeInitiativeLoop?: (
    workspaceId: string,
    initiativeBlockId: string,
    harvest?: InitiativeRunHarvest,
  ) => void
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
   * CI-fixer attempt budget). Absent → the built-in {@link DEFAULT_RISK_POLICY}.
   */
  riskPolicyRepository?: RiskPolicyRepository
  /**
   * Optional: the {@link AppCaches.riskPolicy} slice — read-through for `resolveRiskPolicy`
   * so the slow-moving merge-preset row isn't re-fetched on every gate evaluation. Absent →
   * every resolve hits the repository (tests / no cache wired). Invalidated by
   * `RiskPolicyService` on every preset write.
   */
  riskPolicyCache?: GroupCacheHandle<RiskPolicyCacheValue>
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
   * Optional: the recurring `bug-intake` step's read-and-claim helper. When wired, a `bug-intake`
   * step pulls one matching open issue from the schedule's configured tracker board, claims it, and
   * seeds the reused block from it; absent (no task sources wired) → the step is a no-op that
   * completes the run without touching the block, so the engine works unchanged.
   */
  bugIntakeService?: BugIntakeService
  /**
   * Optional: the LLM observability sink. When wired, each emit rolls the per-run
   * model-call aggregates onto the matching pipeline steps (`step.metrics`) so the
   * board shows tokens / output-limit headroom / transport-vs-execution latency
   * live. Absent (tests / unconfigured) → steps carry no `metrics`.
   */
  llmObservability?: LlmObservabilityService
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
  /** Requirements-review window actions (exposed via {@link requirementsReview}). */
  private readonly requirementsReviewActions: RequirementReviewActions
  /** Clarity-review (bug triage) window actions (exposed via {@link clarityReview}). */
  private readonly clarityReviewActions: ClarityReviewActions
  /** Brainstorm window actions (exposed via {@link brainstorm}). */
  private readonly brainstormActions: BrainstormActions
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
  private readonly riskPolicyRepository?: RiskPolicyRepository
  private readonly riskPolicyCache?: GroupCacheHandle<RiskPolicyCacheValue>
  private readonly issueWriteback?: IssueWritebackProvider
  private readonly subscriptionActivations?: SubscriptionActivationRepository
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
    docInterviewRepository,
    requirementReviewService,
    docInterviewService,
    forkChatService,
    testerQualityReviewer,
    kaizenScheduler,
    clarityReviewRepository,
    clarityReviewService,
    brainstormServices,
    brainstormSessionRepository,
    fragmentResolver,
    skillResolver,
    environmentProvisioning,
    resolveTestSecretRefs,
    environmentTeardown,
    branchUpdater,
    blueprintReconciler,
    initiativeService,
    initiativeRepository,
    initiativeInterviewService,
    notificationService,
    resolveBinaryArtifactStore,
    workspaceSettingsService,
    llmObservability,
    pullRequestMerger,
    riskPolicyRepository,
    riskPolicyCache,
    ticketTrackerProvider,
    issueWriteback,
    bugIntakeService,
    subscriptionActivationRepository,
    resolveWorkspaceModelDefault,
    resolveProviderCapabilities,
    inlineHarnessRef,
    resolveRunRepoContext,
    assertAgentBackendConfigured,
    runInitiatorScope,
    pokeInitiativeLoop,
    agentKindRegistry,
    gateRegistry,
    stepResolverRegistry,
    initiativePresetRegistry,
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
      pokeInitiativeLoop,
    })
    this.agentExecutor = agentExecutor
    this.agentKindRegistry = agentKindRegistry
    this.workRunner = workRunner
    this.events = executionEventPublisher
    this.board = boardService
    this.spend = spendService
    this.contextBuilder = new AgentContextBuilder({
      workspaceRepository,
      blockRepository,
      accountRepository,
      agentKindRegistry,
      initiativePresetRegistry,
      documents: documentRepository,
      documentUrlResolver,
      tasks: taskRepository,
      requirementReviews: requirementReviewRepository,
      docInterviews: docInterviewRepository,
      clarityReviews: clarityReviewRepository,
      brainstormSessions: brainstormSessionRepository,
      initiatives: initiativeRepository,
      environmentProvisioning,
      resolveTestSecretRefs,
      fragmentResolver,
      skillResolver,
    })
    // The run-admission preflights (the shared start/retry/restart `assert*` gate family).
    // The admission-only seams are forwarded here rather than stored on the engine.
    this.admission = new RunAdmission({
      workspaceRepository,
      blockRepository,
      executionRepository,
      contextBuilder: this.contextBuilder,
      agentKindRegistry,
      spend: spendService,
      environmentProvisioning,
      workspaceSettingsService,
      resolveBinaryArtifactStore,
      resolveProviderCapabilities,
      inlineHarnessRef,
      resolveWorkspaceModelDefault,
      assertAgentBackendConfigured,
    })
    this.mergeResolver = new MergeResolver({
      blockRepository,
      notificationService,
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
    this.testerController = new TesterController({
      blockRepository,
      notificationService,
      agentExecutor,
      contextBuilder: this.contextBuilder,
      resolveRiskPolicy: (ws, block) => this.resolveRiskPolicy(ws, block),
      stateMachine: this.runStateMachine,
      // The test quality-control companion's inline reviewer (when wired); absent → QC
      // pass-through. Stamps its verdicts with the engine clock.
      ...(testerQualityReviewer ? { qualityReviewer: testerQualityReviewer } : {}),
      clockNow: () => this.clock.now(),
    })
    this.ralphController = new RalphController({
      blockRepository,
      notificationService,
      agentExecutor,
      contextBuilder: this.contextBuilder,
      stateMachine: this.runStateMachine,
      clockNow: () => this.clock.now(),
    })
    this.humanTestController = new HumanTestController({
      blockRepository,
      executionRepository,
      workRunner,
      agentExecutor,
      contextBuilder: this.contextBuilder,
      notificationService,
      // The human-test gate READS the env the upstream `deployer` step provisioned (it no longer
      // stands up its own) — resolved by the block's OWN service frame, exactly as the tester
      // context resolves it, so the gate and the tester(s) share the one provisioned env. Left
      // undefined when no provider is wired (the gate degrades to manual mode).
      ...(environmentProvisioning
        ? {
            readEnvironment: async (ws, block) => {
              const frame = await this.contextBuilder.resolveServiceFrame(ws, block.id)
              const handle = await environmentProvisioning.getHandleForBlock(
                ws,
                block.id,
                frame?.id,
              )
              // Reconcile against the LIVE provider status when the stored record isn't yet
              // `ready`: the deployer records an async provider's env as `provisioning`, and nothing
              // re-polls that row once the deployer step completes, so a slow-but-now-ready env
              // would otherwise read stale and wrongly degrade the gate to manual mode. One refresh
              // reconciles it; an env still genuinely provisioning / failed degrades as before.
              // Best-effort — keep the stored handle if the status read throws.
              if (handle && handle.status !== 'ready') {
                try {
                  return await environmentProvisioning.refreshStatus(ws, handle.id)
                } catch {
                  return handle
                }
              }
              return handle
            },
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
      resolveRiskPolicy: (ws, block) => this.resolveRiskPolicy(ws, block),
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
      resolveRiskPolicy: (ws, block) => this.resolveRiskPolicy(ws, block),
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
      resolveRiskPolicy: (ws, block) => this.resolveRiskPolicy(ws, block),
      dispatchIterationCap: (ws, blockId, choice, handlers) =>
        this.dispatchIterationCap(ws, blockId, choice, handlers),
    })
    this.forkDecisionController = new ForkDecisionController({
      blockRepository,
      executionRepository,
      workRunner,
      stateMachine: this.runStateMachine,
      stepGraph: this.stepGraph,
      idGenerator,
      clock,
      notificationService,
      ...(forkChatService ? { forkChatService } : {}),
      resolveEffectiveDescription: (ws, block) =>
        this.contextBuilder.resolveEffectiveDescription(ws, block),
    })
    this.prReviewController = new PrReviewController({
      executionRepository,
      workRunner,
      stateMachine: this.runStateMachine,
      stepGraph: this.stepGraph,
      idGenerator,
      clock,
      notificationService,
    })
    // The review-gate subjects (requirements / clarity / the two brainstorm stages), built by
    // the factories in review-kinds.ts over one shared closure of collaborators — each subject's
    // differentiators live there, not on the engine.
    const reviewKindDeps = {
      events: executionEventPublisher,
      blockRepository,
      executionRepository,
      requirementReviewService,
      clarityReviewService,
      brainstormServices,
      issueWriteback,
    }
    this.requirementsKind = buildRequirementsKind(reviewKindDeps)
    this.clarityKind = buildClarityKind(reviewKindDeps)
    this.requirementsBrainstormKind = buildBrainstormKind(
      'requirements',
      REQUIREMENTS_BRAINSTORM_AGENT_KIND,
      reviewKindDeps,
    )
    this.architectureBrainstormKind = buildBrainstormKind(
      'architecture',
      ARCHITECTURE_BRAINSTORM_AGENT_KIND,
      reviewKindDeps,
    )
    // The interactive-planning interviewer gate — wired whenever the initiative store is
    // present (the entity is where its state lives). The interviewer LLM is optional: without
    // it (or without a model) the gate passes through, so planning still runs off the raw
    // block description. Absent initiative store → the `initiative-interviewer` step passes
    // through in RunDispatcher (an initiative pipeline can't run without the store anyway).
    this.initiativeInterviewController = initiativeService
      ? new InitiativeInterviewController({
          blockRepository,
          executionRepository,
          workRunner,
          stateMachine: this.runStateMachine,
          stepGraph: this.stepGraph,
          interviewService: initiativeInterviewService,
          initiativeService,
        })
      : undefined
    // The interactive document-interview gate (WS5) — wired whenever the interview service is
    // present. Without it (or without a model) the gate passes through, so document pipelines
    // still run off the raw outline. Self-contained persistence lives in the service.
    this.docInterviewController = docInterviewService
      ? new DocInterviewController({
          blockRepository,
          executionRepository,
          workRunner,
          stateMachine: this.runStateMachine,
          stepGraph: this.stepGraph,
          events: executionEventPublisher,
          docInterviewService,
        })
      : undefined
    // The per-step dispatch + completion spine. Composes the collaborators built above; the
    // merge subgraph stays on the engine, reached only through the injected `resolveRiskPolicy`
    // callback + the MergeResolver (which closes over the engine's `finalizeMerge`). The
    // controllers' `runAgent`/`previewStepModel`/`deployInputs`/`deployContext` closures resolve
    // through `this.runDispatcher` lazily, so this assignment trailing their construction is safe.
    this.runDispatcher = new RunDispatcher({
      blockRepository,
      executionRepository,
      agentExecutor,
      agentKindRegistry,
      gateRegistry,
      stepResolverRegistry,
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
      runInitiatorScope: runInitiatorScopeFn,
      environmentProvisioning,
      ticketTrackerProvider,
      issueWriteback,
      bugIntakeService,
      notificationService,
      blueprintReconciler,
      initiativeService,
      resolveRunRepoContext,
      resolveProviderCapabilities,
      resolveRiskPolicy: (ws, block) => this.resolveRiskPolicy(ws, block),
      modelIdIsMetered: (id, caps) => this.admission.modelIdIsMetered(id, caps),
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
    this.prMerger = pullRequestMerger
    this.notifications = notificationService
    this.riskPolicyRepository = riskPolicyRepository
    this.riskPolicyCache = riskPolicyCache
    this.issueWriteback = issueWriteback
    this.subscriptionActivations = subscriptionActivationRepository
    this.pokeInitiativeLoop = pokeInitiativeLoop
    this.resolveWorkspaceModelDefault = resolveWorkspaceModelDefault
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
    /**
     * How this run is being launched: a `'manual'` one-off task (default) or a `'recurring'`
     * schedule fire ({@link RecurringPipelineService.fire}). Gates the pipeline's declared
     * `availability` — a `'recurring'`-only pipeline can't be started manually and vice versa
     * (see {@link assertPipelineLaunchable}). A retry/restart re-drives an already-validated
     * run, so it never re-checks this.
     */
    origin: RunOrigin = 'manual',
    /**
     * Per-run approval-gate override (the initiative-preset gate-override seam). When supplied
     * it REPLACES the pipeline's declared `gates` for THIS run only — one boolean per pipeline
     * step, indexed by the pipeline's ORIGINAL step index exactly like `pipeline.gates`, so it
     * must be parallel to `pipeline.agentKinds`. `undefined` ⇒ today's behaviour (the pipeline's
     * own gates). The initiative loop threads an item's `spawn.gates` through here; a preset's
     * review mapping computes the array from the user's `humanReview` choice. The override is
     * copied onto the run's steps (`requiresApproval`), so a retry/restart — which re-drive the
     * STORED steps — preserve it with no extra persistence.
     */
    gatesOverride?: boolean[],
  ): Promise<ExecutionInstance> {
    await this.requireWorkspace(workspaceId)
    const block = await this.requireBlock(workspaceId, blockId)
    const pipeline = assertFound(
      await this.pipelineRepository.get(workspaceId, pipelineId),
      'Pipeline',
      pipelineId,
    )

    // Launch-constraint gate (start-only, NOT part of the shared retry re-validation): reject a
    // manual start of a recurring-only pipeline (or a scheduled fire of a one-off-only one), and
    // a bug-intake pipeline that isn't recurring. Before any side effects.
    assertPipelineLaunchable(pipeline.agentKinds, pipeline.availability, origin, pipeline.enabled)

    // Per-run gate override must be parallel to the pipeline's steps (one boolean per step,
    // original-index-aligned like `pipeline.gates`). A mismatch means a preset's review mapping
    // is out of step with the pipeline it targets — reject up front, before any side effects.
    if (gatesOverride && gatesOverride.length !== pipeline.agentKinds.length) {
      throw new ValidationError(
        `Gate override has ${gatesOverride.length} entr${gatesOverride.length === 1 ? 'y' : 'ies'} but pipeline '${pipeline.id}' has ${pipeline.agentKinds.length} step(s).`,
      )
    }

    // Shared config/resource preconditions (pipeline shape, frame type, tester infra, binary
    // storage, agent backend, provider/preset satisfiability, budget) — the SAME gate a retry
    // runs, so the two can't drift. See assertRunnable.
    await this.admission.assertRunnable(workspaceId, block, pipeline, initiatedBy)

    // A Ralph-loop step needs a programmatic completion command (its exit condition); refuse to
    // start a misconfigured run rather than dispatch a validation-less coding pass that never
    // gates. The command is a per-task agent-config value (the SPA also requires it at creation).
    if (
      pipeline.agentKinds.some(isRalphKind) &&
      !resolveRalphConfig(block.agentConfig).validationCommand
    ) {
      throw new ValidationError(
        'A Ralph loop task needs a validation command (its completion criterion) before it can ' +
          'start. Set one in the task configuration.',
      )
    }

    // START-ONLY gates below: a retry REPLACES the failed run rather than adding a new one, so
    // the concurrency limit doesn't apply to it, and a re-drive of an already-started task isn't
    // re-gated on its dependencies.

    // Enforce the workspace's per-service running-task limit (off by default) — a clear,
    // actionable error before any side effects, so the human knows why the start was refused.
    await this.admission.assertWithinTaskLimit(workspaceId, block)

    // Hard dependency gate: a task cannot start while any block it `dependsOn` is unfinished
    // (not yet `done`/merged). Enforced server-side so it holds for manual starts, recurring
    // fires, auto-start propagation and direct API calls alike — the frontend's runnable
    // check is only a hint. Before any side effects so nothing is torn down on a refusal.
    await this.admission.assertDependenciesMet(workspaceId, block)

    // Mint the activation next: if the credential can't be unlocked, fail before
    // tearing down the block's prior run or creating a new one.
    const executionId = this.idGenerator.next('exec')
    await activate?.(executionId)

    // Read the block's prior run once: a manual re-start of an already-running block REPLACES
    // it (the board offers "start" on a live block), so we pass its id to `insertLive` as the
    // `replaceId` it supersedes atomically. A genuinely-CONCURRENT second start reads the SAME
    // prior (or none), so only one insert wins and the other is rejected 409 — the loser's
    // `replaceId` deletes only what it read, never the winner's fresh row (see insertLive).
    const prior = await this.executionRepository.getByBlock(workspaceId, blockId)
    // Replacing the block's prior run: clear its per-run activation now (it never reaches
    // the terminal cleanup in emitInstance when it's still running), so a replaced run's
    // system-encrypted token copy doesn't linger to its TTL. Keyed by the OLD run id, so
    // the activation just minted for the new run is untouched.
    if (this.subscriptionActivations && prior && prior.id !== executionId) {
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

    // NB: do NOT `deleteByBlock` here — `insertLiveRunOrConflict` (below) atomically clears the
    // block's terminal rows AND the `prior` run it replaces, then inserts the new live run, so a
    // concurrent double-start is rejected by the live-run index instead of both wiping each
    // other's row (see insertLive).

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
          // recordStepResult). A per-run override (the initiative-preset seam) wins over the
          // pipeline's own gate for this step; else the pipeline definition at run start. Both
          // read by the step's ORIGINAL index `i`, so they stay aligned to the kind even when
          // earlier steps are disabled.
          requiresApproval: gatesOverride?.[i] ?? pipeline.gates?.[i] ?? false,
          approval: null,
          // A consensus-enabled step runs through the multi-model mechanism (the consensus
          // executor reads this off the context). Copied from the pipeline at run start.
          ...(pipeline.consensus?.[i] ? { consensus: pipeline.consensus[i] } : {}),
          // Estimate gating: when set+enabled the step is skipped at runtime unless the
          // block estimate (written by an earlier task-estimator step) meets the threshold.
          ...(pipeline.gating?.[i] ? { gating: pipeline.gating[i] } : {}),
          // The extensible per-step options bag (the new home for per-step parameters — see
          // stepOptionsSchema). Copied from the pipeline at run start, keyed by the step's
          // ORIGINAL index `i`, so it stays aligned to the kind even when earlier steps are
          // disabled. Today it carries the requirements-review `autoRecommend` toggle.
          ...(pipeline.stepOptions?.[i] ? { stepOptions: pipeline.stepOptions[i] } : {}),
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
                  maxAttempts: DEFAULT_RISK_POLICY.maxTesterQualityIterations,
                  verdicts: [],
                  ...(pipeline.testerQuality?.[i]?.gating
                    ? { gating: pipeline.testerQuality[i]!.gating }
                    : {}),
                },
              }
            : {}),
          // A `ralph` step carries its persistent-loop state — the iteration count, the budget,
          // and the programmatic completion command — seeded from the block's per-task agent
          // config. Riding the persisted step is what lets a mid-loop run survive a restart
          // (both durable drivers + sweepers re-drive from it). See ralph.logic.ts.
          ...(isRalphKind(kind)
            ? { ralph: seedRalphState(resolveRalphConfig(block.agentConfig)) }
            : {}),
        }
      })
    if (steps.length === 0) {
      throw new ValidationError('Pipeline has no enabled steps to run.')
    }
    // For a visual (UI-test) pipeline on a frontend frame, resolve its backend bindings ONCE at
    // start and stamp both the resolved bindings and the non-fatal advisories (duplicate env vars,
    // or a partial-live set of bound services) on the run. The bindings are a frozen snapshot so
    // the SPA's run/step detail projects what the run ACTUALLY drove against (truthful after the
    // envs are torn down). Only paid for a visual pipeline — the same condition the tester infra
    // gate keys off — so a plain backend run does no extra env read. Absent → no notes/bindings.
    const frontendRun = pipelineHasVisualStep({ agentKinds: pipeline.agentKinds })
      ? await this.contextBuilder.resolveFrontendRunInfo(workspaceId, block)
      : undefined
    const instance: ExecutionInstance = {
      id: executionId,
      blockId,
      pipelineId: pipeline.id,
      pipelineName: pipeline.name,
      steps,
      currentStep: 0,
      status: 'running',
      initiatedBy: initiatedBy ?? null,
      createdAt: this.clock.now(),
      ...(frontendRun?.notes.length ? { notes: frontendRun.notes } : {}),
      ...(frontendRun?.bindings.length ? { frontendBindings: frontendRun.bindings } : {}),
    }
    await this.insertLiveRunOrConflict(workspaceId, instance, prior?.id)
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
      if (error instanceof RunContendedError) return { kind: 'continue' }
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
      // The interactive-interviewer gates (marked with the `interview-gate` trait) ride the shared
      // InterviewGateController spine, which resumes by re-running the (slow) interviewer LLM in the
      // durable driver: `continue`/`proceed` set `pendingInterview` on the parked step and wake the
      // driver. Fall through so `InterviewGateController.evaluate` runs that pass instead of
      // immediately re-parking — otherwise the interview never advances and the window stays stuck on
      // the same questions. Trait-based (not kind-based) so a new interviewer needs no engine change.
      const reentrantInterview =
        hasTrait(step.agentKind, INTERVIEW_GATE_TRAIT, this.agentKindRegistry) &&
        !!step.pendingInterview
      // The implementation-fork decision phase is re-entrant on a chat turn: the human sent a
      // grounded question about the surfaced forks, which sets `pendingForkChat` on the parked
      // coder step and wakes the driver. Fall through so the fork step handler computes the reply
      // inline (in the driver, off the HTTP request) and re-parks, instead of immediately
      // re-parking on the stale approval id.
      const reentrantForkDecision =
        step.agentKind === FORK_DECISION_PRODUCER_KIND && !!step.pendingForkChat
      if (
        !reentrantRequirements &&
        !reentrantHumanTest &&
        !reentrantVisualConfirm &&
        !reentrantInterview &&
        !reentrantForkDecision
      ) {
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
  // the `advanceRunPastGate`/`settleAdvancedGate` split (run under `mutateInstance`), and
  // {@link dispatchIterationCap}.

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
    if (hasTrait(step.agentKind, INTERVIEW_GATE_TRAIT, this.agentKindRegistry)) {
      throw new ConflictError(
        'Resolve the interview through its interview window, not the approval gate',
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
    // Optimistic-concurrency human-action write (race-audit 2.2 controller-half): both non-cancel
    // branches persist under `mutateInstance` (load fresh → re-find the gate → mutate → CAS), so a
    // concurrent driver poll — or a `stopRun`/`cancel` racing this resolve — can't be clobbered by a
    // blind full-row upsert, and a cancelled run is never resurrected. The pure in-memory mutation
    // runs inside the CAS; the non-idempotent side effects (block writes, `technical` inference,
    // driver signal, emit) run once after, on the winning snapshot — the same pure/side-effect split
    // `approveStep` and the review gate-resume use. The validation snapshot below gives a fast
    // 404/409 (and the idempotent already-resolved early return).
    const snapshot = assertFound(
      await this.executionRepository.get(workspaceId, executionId),
      'Execution',
      executionId,
    )
    const snapStep = snapshot.steps.find((s) => s.approval?.id === approvalId)
    if (!snapStep || !snapStep.approval) throw new NotFoundError('Approval', approvalId)
    if (!snapStep.companion?.exceeded) {
      throw new ConflictError(`Approval '${approvalId}' is not a companion iteration-cap gate`)
    }
    if (snapStep.approval.status === 'approved') return snapshot

    // The state the caller sees: the winning post-mutation snapshot for extra-round/proceed, or
    // the pre-cancel snapshot for stop-reset (the run row is deleted, so there's nothing to re-read).
    let result = snapshot
    await this.dispatchIterationCap(workspaceId, snapshot.blockId, choice, {
      // Grant one more automatic rework: raise the budget by one, clear the cap flag, then loop
      // the producer back through the companion to re-grade (`loopCompanionProducer` re-arms the
      // run `running`). The last verdict's feedback drives the rework.
      extraRound: async () => {
        let signalId: string | undefined
        const persisted = await this.runStateMachine.mutateInstance(
          workspaceId,
          executionId,
          (inst) => {
            const i = inst.steps.findIndex((s) => s.approval?.id === approvalId)
            const s = inst.steps[i]
            if (!s?.companion || !s.approval) throw new NotFoundError('Approval', approvalId)
            // Another writer already resolved this gate: no-op (idempotent) and skip the signal.
            if (s.approval.status === 'approved') {
              signalId = undefined
              return
            }
            s.companion.maxAttempts += 1
            s.companion.exceeded = undefined
            const producer = inst.steps[this.stepGraph.companionProducerIndex(inst, i)]
            // Capture the approval id BEFORE `loopCompanionProducer`: it resets the companion
            // step for re-run (`resetStepForRerun`), which NULLS `s.approval`, so reading
            // `s.approval.id` after would throw. The signal targets the gate's original approval.
            signalId = s.approval.id
            this.stepGraph.loopCompanionProducer(inst, i, {
              previousProposal: producer?.output ?? '',
              feedback: s.companion.verdicts.at(-1)?.feedback ?? '',
            })
          },
        )
        result = persisted
        if (!signalId) return
        await this.runStateMachine.updateBlockProgress(workspaceId, persisted, 'in_progress')
        await this.workRunner.signalDecision(workspaceId, persisted.id, signalId, 'extra-round')
        await this.runStateMachine.emitInstance(workspaceId, persisted)
      },
      // Proceed: accept the producer's current output and advance past the gate.
      proceed: async () => {
        let stepIndex = -1
        const persisted = await this.runStateMachine.mutateInstance(
          workspaceId,
          executionId,
          (inst) => {
            stepIndex = inst.steps.findIndex((s) => s.approval?.id === approvalId)
            const s = inst.steps[stepIndex]
            if (!s?.companion || !s.approval) throw new NotFoundError('Approval', approvalId)
            if (s.approval.status === 'approved') {
              stepIndex = -1
              return
            }
            s.companion.exceeded = undefined
            s.approval.status = 'approved'
            this.runStateMachine.advanceRunPastGate(inst, stepIndex)
          },
        )
        result = persisted
        if (stepIndex === -1) return
        // The spec-companion never reached its automatic PASS branch, but both signals are
        // persisted (the producer's `noBusinessSpecs` + this step's `technicalCorroborated`),
        // so infer the block's `technical` label here too — best-effort, human-authority
        // preserved — before settling the advance.
        const step = persisted.steps[stepIndex]!
        if (step.agentKind === 'spec-companion') {
          const producer =
            persisted.steps[this.stepGraph.companionProducerIndex(persisted, stepIndex)]
          const block = await this.blockRepository.get(workspaceId, persisted.blockId)
          if (producer && block) await this.inferBlockTechnical(workspaceId, block, producer, step)
        }
        await this.runStateMachine.settleAdvancedGate(workspaceId, persisted, stepIndex)
      },
    })
    return result
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
    // Nothing depends on the merged block (the common case) — skip the cross-workspace
    // augment and the pipeline list entirely rather than paying reads with no dependent to act on.
    if (dependents.length === 0) return
    // A dependent's OTHER blockers may live in another workspace (a shared service); resolve
    // them so `dependenciesMet` doesn't treat a cross-workspace blocker as missing-⇒-satisfied.
    await this.admission.augmentWithCrossWorkspaceDeps(
      blocks,
      dependents.flatMap((d) => d.dependsOn),
    )
    // Resolve every dependent's pipeline from ONE workspace list, not a per-dependent
    // point-read in the loop (banned N+1): index the catalog by id, and take the board's
    // "Run" default (the first pipeline) for any dependent with no pinned pipeline.
    const pipelines = await this.pipelineRepository.listByWorkspace(workspaceId)
    const pipelinesById = new Map(pipelines.map((p) => [p.id, p]))
    const firstPipeline = pipelines[0] ?? null
    for (const dependent of dependents) {
      // All of the dependent's blockers must now be satisfied (not just the one that merged).
      if (!dependenciesMet(blocks, dependent.id)) continue
      // Only auto-start a fresh task — never replace a run already in flight or a finished one.
      if (dependent.status !== 'planned' && dependent.status !== 'ready') continue
      const pipeline = dependent.pipelineId
        ? (pipelinesById.get(dependent.pipelineId) ?? null)
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
   * preset, else the workspace default, else the built-in {@link DEFAULT_RISK_POLICY}.
   * Returns just the thresholds the engine compares against (+ the CI attempt budget).
   */
  private async resolveRiskPolicy(
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
    forkDecision?: StepGating | null
  }> {
    const repo = this.riskPolicyRepository
    if (repo) {
      // Read each preset through the cache slice when wired: the row is slow-moving admin config
      // re-read on every gate evaluation. Group by workspace (one write drops the whole library),
      // keyed per resolved id so a picked preset and the default cache separately. A null (deleted
      // id / unseeded default) caches as a value and still falls through, exactly as an uncached
      // read would (the `RiskPolicyCacheValue` wrapper).
      const read = async (
        key: string,
        load: () => Promise<RiskPolicy | null>,
      ): Promise<RiskPolicy | null> => {
        const cache = this.riskPolicyCache
        if (!cache) return load()
        return (await cache.get(key, workspaceId, async () => ({ policy: await load() }))).policy
      }
      if (block.riskPolicyId) {
        const id = block.riskPolicyId
        const picked = await read(`picked:${id}`, () => repo.get(workspaceId, id))
        if (picked) return picked
      }
      const fallback = await read('default', () => repo.getDefault(workspaceId))
      if (fallback) return fallback
    }
    return DEFAULT_RISK_POLICY
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
    reason: string | null = null,
  ): Promise<void> {
    return this.runStateMachine.failRun(workspaceId, executionId, message, kind, detail, reason)
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
    await this.admission.assertRunnable(
      workspaceId,
      block,
      this.admission.runnableShapeOf(previous.steps),
      initiatedBy ?? previous.initiatedBy,
    )

    const { steps, currentStep } = planResumedSteps(previous)
    // Mint the activation before replacing the failed run, so a bad password aborts
    // the retry without losing the retryable terminal run.
    const newId = this.idGenerator.next('exec')
    const replaceId = previous.id
    await activate?.(newId)
    // Replace the terminal failed run for this block with the resumed one (single run per
    // block, matching the board's by-block projection). This mints a FRESH run id; the
    // atomic `insertLiveRunOrConflict` below replaces `previous` (via `replaceId`) and clears
    // any terminal rows in the SAME transaction, so a concurrent double-retry is serialised by
    // the live-run index (the loser gets a 409) instead of both deleting-then-inserting.
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
      // A retry resumes at the first UNFINISHED step, so it discards no completed output —
      // this just carries any prior restart's successful-output trail forward unchanged.
      outputHistory: carryForwardOutputs(previous, currentStep, this.clock.now()),
    }
    await this.insertLiveRunOrConflict(workspaceId, instance, replaceId)
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
    await this.admission.assertRunnable(
      workspaceId,
      block,
      this.admission.runnableShapeOf(previous.steps),
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
    const replaceId = previous.id
    await activate?.(newId)
    // Like retry(), this mints a FRESH run id. `insertLiveRunOrConflict` atomically supersedes
    // the torn-down source run (`replaceId`, which here may still be LIVE — running/paused/
    // blocked) and clears terminal rows in one transaction, so a concurrent start that already
    // created a NEW live run for the block loses (409) instead of being silently clobbered.
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
      // A restart resets the chosen step + every later one, discarding their outputs — record
      // the SUCCESSFUL ones so the step-detail execution history keeps what they produced, not
      // only the errors. Attributed by step index and accumulated across successive restarts.
      outputHistory: carryForwardOutputs(previous, currentStep, this.clock.now()),
    }
    await this.insertLiveRunOrConflict(workspaceId, instance, replaceId)
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
   * Insert a freshly-built run, enforcing the one-live-run-per-block invariant at the DB in a
   * single atomic write (see `ExecutionRepository.insertLive`). Callers must NOT `deleteByBlock`
   * first: `insertLive` itself clears the block's terminal rows (and `replaceId`, the specific
   * prior run a `retry`/`restart` is knowingly superseding) in the SAME transaction as the
   * insert. A `false` return means a genuinely-concurrent start (double click,
   * recurring-vs-manual, notification-vs-human retry) already created the block's live run — so
   * we REFUSE this duplicate rather than materialise a second driver + container on the same
   * branch. The winning run is untouched (the losing transaction only deletes terminal rows /
   * its own `replaceId`, never the winner). Surfaces as a 409 the SPA shows as a toast.
   */
  private async insertLiveRunOrConflict(
    workspaceId: string,
    instance: ExecutionInstance,
    replaceId?: string,
  ): Promise<void> {
    const inserted = await this.executionRepository.insertLive(workspaceId, instance, { replaceId })
    if (!inserted) {
      // No machine `reason`: this is a rare double-start edge, not a distinct client-handled
      // conflict, so the human message drives the SPA's generic 409 toast (no new
      // ConflictReason + exhaustive-Record/i18n cascade for a transient race).
      throw new ConflictError('A run is already active for this block.')
    }
  }

  /**
   * Resume every run paused by the spend safeguard in this workspace. Flips them
   * back to `running` and re-drives the durable runner. If the budget is still
   * exhausted the spend gate will simply pause them again on their next step.
   */
  async resumePaused(workspaceId: string): Promise<ExecutionInstance[]> {
    await this.requireWorkspace(workspaceId)
    // Lean projection: only the paused runs' ids are needed to re-drive them — no `detail` decode.
    const live = await this.executionRepository.listLive(workspaceId)
    const paused = live.filter((e) => e.status === 'paused')
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
        // `startRun` re-drives runners that re-create the run from scratch (pg-boss re-enqueues
        // the same id). On Cloudflare the paused run's Workflows instance is still ALIVE parked
        // on a `waitForEvent`, so `startRun`'s `create` no-ops there; `signalResume` delivers the
        // event that wakes it immediately instead of waiting out the periodic budget re-check.
        await this.workRunner.startRun(workspaceId, resumed.id)
        await this.workRunner.signalResume?.(workspaceId, resumed.id)
        await this.runStateMachine.emitInstance(workspaceId, resumed)
      }
    }
    // Clear the workspace-scoped `budget_paused` card now the pause is being lifted (F3). If the
    // budget is still exhausted a resumed run re-pauses and re-raises it on its next step.
    await this.runStateMachine.clearBudgetPaused(workspaceId)
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
   *
   * Returns the workspace block list it loaded so the immediately-following `removeBlock`
   * can reuse it instead of re-listing the whole board (this teardown deletes only run
   * records, never blocks, so the list is still current) — see {@link PreloadedBlocks}.
   */
  async teardownForBlockTree(workspaceId: string, rootId: string): Promise<PreloadedBlocks> {
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
    return { workspaceId, blocks }
  }
}
