import type {
  AccountRepository,
  AgentExecutor,
  AgentPromptRepository,
  BinaryGeneratorSource,
  BlockRepository,
  BlueprintService,
  BrainstormSessionRepository,
  BrainstormStage,
  BranchUpdater,
  ClarityReviewRepository,
  Clock,
  ConsensusGroupRepository,
  DocInterviewRepository,
  DocumentRepository,
  LinkedDocumentRefresher,
  ExecutionEventPublisher,
  ExecutionRepository,
  GateOutcomeRepository,
  GateRegistry,
  GroupCacheHandle,
  IdGenerator,
  InitiativePresetRegistry,
  InitiativeRepository,
  IssueWritebackProvider,
  JudgeAssessor,
  JudgeRegistry,
  LocalModelDeclarationsCacheValue,
  LocalModelEndpointRepository,
  Logger,
  ModelPresetCacheValue,
  ModelPresetRepository,
  ModelRef,
  OperationalMetrics,
  PipelineRegistry,
  PipelineRepository,
  PrVerificationReportPublisher,
  ProviderCapabilities,
  ProviderRegistry,
  ProvisioningLogRepository,
  PullRequestMerger,
  RequirementReviewRepository,
  ResolveBinaryArtifactStore,
  ResolveRunRepoContext,
  RiskPolicyCacheValue,
  RiskPolicyRepository,
  RunInitiatorScope,
  RunLifecycleSink,
  StepResolverRegistry,
  SubscriptionActivationRepository,
  TaskRepository,
  TaskTypeRegistry,
  TestSecretRef,
  TicketTrackerProvider,
  WorkRunner,
  WorkspaceAgentSettingsRepository,
  WorkspaceRepository,
  WorkspaceSettingsRepository,
} from '@cat-factory/kernel'
import type { AgentKindRegistry } from '@cat-factory/agents'
import type { ResolvedValidationChecks } from '@cat-factory/contracts'
import type {
  BugIntakeService,
  EnvironmentProvisioningService,
  EnvironmentTeardownService,
} from '@cat-factory/integrations'
import type { SpendService } from '@cat-factory/spend'
import type { BoardService } from '../board/BoardService.js'
import type { BrainstormService } from '../brainstorm/BrainstormService.js'
import type { ClarityReviewService } from '../clarity/ClarityReviewService.js'
import type { DocInterviewService } from '../docInterview/DocInterviewService.js'
import type { InitiativeInterviewService } from '../initiative/InitiativeInterviewService.js'
import type { InitiativeRunHarvest } from '../initiative/initiative.logic.js'
import type { InitiativeService } from '../initiative/InitiativeService.js'
import type { MergeTrackRecordService } from '../merge/MergeTrackRecordService.js'
import type { LlmObservabilityService } from '../observability/LlmObservabilityService.js'
import type { NotificationService } from '../notifications/NotificationService.js'
import type { RequirementReviewService } from '../requirements/RequirementReviewService.js'
import type { WorkspaceSettingsService } from '../settings/WorkspaceSettingsService.js'
import type {
  DocumentUrlResolver,
  FragmentBodyResolver,
  SkillResolver,
} from './AgentContextBuilder.js'
import type { FoundationalServiceResolver } from './run-foundational-services.js'
import type { ForkChatService } from './ForkChatService.js'
import type { KaizenScheduler } from './RunStateMachine.js'
import type { TesterQualityReviewer } from './TesterQualityReviewService.js'

// The injected collaborator contract of the {@link ExecutionService} — the engine's single
// `dependencies` object, split out of `ExecutionService.ts` so a ~350-line declaration block
// stops crowding the engine's control flow against its file-size budget (see
// `scripts/check-file-size.mjs`: budgets are split triggers, never numbers to raise). Purely
// declarative; re-exported from `ExecutionService.ts` so every existing importer is unchanged.

/** Reconciles a Blueprinter step's tree onto the board in place (BoardScanService). */
export interface BlueprintReconciler {
  reconcileBlueprint(
    workspaceId: string,
    frameId: string | null,
    service: BlueprintService,
  ): Promise<unknown>
}

export interface ExecutionServiceDependencies {
  workspaceRepository: WorkspaceRepository
  blockRepository: BlockRepository
  pipelineRepository: PipelineRepository
  /**
   * The app-owned pipeline registry, so run resolution can ADOPT a catalog built-in the workspace
   * was never seeded with (`pipelines/pipelineAdoption.ts`). Optional, because the BUILT-IN catalog
   * lives in code and stays adoptable without it; a facade must still thread it, or a DEPLOYMENT's
   * own registered pipeline (a reusable operation's canned pipeline) is unadoptable and a task
   * pinning it 404s on any board older than the registration. Read the resolved
   * `runtime.pipelineRegistry`, never a facade's own optional argument, so the engine and
   * `PipelineService` share ONE instance.
   */
  pipelineRegistry?: PipelineRegistry
  /**
   * The deployment's operational counters. Required, per the rule an un-wired counter breaks: a
   * zero and an unreported signal are different facts and only one of them is honest. Today the
   * engine's own increment is `pipeline.adopted` (see `pipelines/pipelineAdoption.ts`); it arrives
   * through the `CoreDependencies` spread, where it is required too.
   */
  operationalMetrics: OperationalMetrics
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
   * The app-owned custom task-type registry, threaded to {@link AgentContextBuilder} so a
   * custom-typed task's collected PARAMETERS reach the prompt under their descriptor's labels.
   * Optional: a facade that registers no task types (the stock product) passes none and every
   * run resolves exactly as before.
   */
  taskTypeRegistry?: TaskTypeRegistry
  /**
   * The app-owned polling-gate registry (the built-in `@cat-factory/gates` suite installed by
   * the facade + any deployment-registered gates), threaded to the dispatcher's gate machine.
   * `createCore` defaults it to `defaultGateRegistry()` (empty) when a facade doesn't inject one.
   */
  gateRegistry: GateRegistry
  /**
   * The app-owned JUDGE registry (the fourth step-taxonomy bucket) + the verdict producer.
   * `createCore` defaults the registry to an empty `defaultJudgeRegistry()` and the assessor to
   * the inline `JudgeService` built from the model-provider deps, so a facade needs no
   * judge-specific wiring; an absent/disabled assessor makes judge steps pass-throughs. See
   * `docs/initiatives/judge-registry.md`.
   */
  judgeRegistry: JudgeRegistry
  judgeAssessor?: JudgeAssessor
  /**
   * The app-owned step-completion-resolver registry (deployment-registered resolvers),
   * threaded to the dispatcher. `createCore` defaults it to `defaultStepResolverRegistry()`.
   */
  stepResolverRegistry: StepResolverRegistry
  /**
   * The app-owned provider registry (gate data sources keyed by {@link ProviderToken}), threaded
   * to the dispatcher's gate machine so its {@link GateContext} reads the wired providers.
   * `createCore` defaults it to `defaultProviderRegistry()` (empty ⇒ every gate passes through).
   */
  providerRegistry: ProviderRegistry
  /**
   * The app-owned initiative-preset registry, threaded into the context builder so a spawned /
   * planning run resolves its preset steering. `createCore` defaults it to
   * `defaultInitiativePresetRegistry()` when a facade doesn't inject the shared instance.
   */
  initiativePresetRegistry: InitiativePresetRegistry
  /**
   * Optional: the workspace's agent system-prompt override log, threaded into the context
   * builder so each dispatch runs the prompt the workspace edited for that kind. Absent ⇒
   * every kind runs its shipped prompt (the feature is simply off).
   */
  agentPromptRepository?: AgentPromptRepository
  /**
   * Optional: the workspace's per-agent-kind generation settings, threaded into the context
   * builder so each dispatch resolves the output-token ceiling configured for that kind (a
   * pipeline step's own option still wins). Absent ⇒ every kind runs on the deployment routing
   * ceiling (the feature is simply off).
   */
  workspaceAgentSettingsRepository?: WorkspaceAgentSettingsRepository
  /**
   * Optional: the workspace's model-preset library, threaded into the context builder so each
   * dispatch resolves the ROUTE order the block's preset states (`providerPreference`) once and
   * every executor reads it off the context. Absent ⇒ every dispatch walks the deployment's
   * default route order (the feature is simply off).
   */
  modelPresetRepository?: ModelPresetRepository
  /**
   * Optional: the per-USER locally-run model endpoints, threaded into the context builder so each
   * dispatch resolves what the RUN INITIATOR declared about the local models they enabled (today:
   * whether one reads images) and every executor reads it off the resolved ref. Absent ⇒ a local
   * ref stays undeclared, which reads as unknown rather than as a model refusing images.
   */
  localModelEndpointRepository?: LocalModelEndpointRepository
  /**
   * Optional: the workspace's consensus-GROUP library, threaded into the context builder so a
   * consensus step naming a tier set resolves the group its task's estimate earned. Absent ⇒ a
   * consensus step runs the inline participants authored on it.
   */
  consensusGroupRepository?: ConsensusGroupRepository
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
   * Optional: re-confirms each linked document against its source at dispatch time (cheap version
   * probe through the app cache, re-import only on a change), so an agent reads the CURRENT revision
   * of a page instead of the copy import stored — a design frame edited after import otherwise feeds
   * every later run the old markdown, silently. Forwarded to {@link AgentContextBuilder}; absent →
   * no refresh and no freshness note.
   */
  documentRefresher?: LinkedDocumentRefresher
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
   * Optional: the FOUNDATIONAL SERVICES catalog seam (backend/docs/adr/0031-foundational-services.md).
   * Supplies a design kind its catalog and a consumer kind the API contracts of the services that
   * design declared, both as injected `.cat-context/` files. Absent ⇒ neither is injected.
   */
  foundationalServiceResolver?: FoundationalServiceResolver
  /**
   * Optional: the deployment's GENERATIVE BINARY INTEGRATIONS, which a binary-generating step
   * selects from to PRODUCE its artifacts — the twin of the catalog seam above, which is where
   * those artifacts GO. Read at admission (a selected integration must be registered, and must
   * cover every content type the step declares) and at dispatch (the brief, plus the non-secret
   * projection the container executor resolves credentials from). Absent ⇒ no integration
   * resolves, and both the refusal and the brief state that.
   *
   * A SOURCE rather than the registry itself, because on a mothership-mode node the set is the
   * MOTHERSHIP's: the picker that selected an id and the admission that resolves it must be
   * looking at one set, and this node's own build can only hold a second, drifting copy.
   */
  binaryGeneratorSource?: BinaryGeneratorSource
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
   * facades), exactly like the existing optional engine deps. `modelPresetId` carries the
   * preset's route `providerPreference` onto the capability set, so the guard walks a model's
   * routes in the same order the dispatch will.
   */
  resolveProviderCapabilities?: (
    workspaceId: string,
    initiatedBy?: string | null,
    modelPresetId?: string,
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
   * Optional: resolve the pre-PR validation checks configured for a run block's service frame,
   * folded onto the agent run context by the context builder and forwarded on the coding job
   * body by the container executor. Wired from the facade's `ValidationConfigService`; absent ⇒
   * no checks, so the harness's existing path is byte-for-byte unchanged.
   */
  resolveValidationChecks?: (
    workspaceId: string,
    frameId: string,
  ) => Promise<ResolvedValidationChecks | null>
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
   * Optional: pushes run-lifecycle edges (`run.started` / `run.completed` / `run.failed`) to the
   * workspace's registered outbound endpoint, so a headless integration learns its task finished
   * without polling. Absent → nothing is pushed and runs behave byte-for-byte as before.
   */
  runLifecycleSink?: RunLifecycleSink
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
   * CI-fixer attempt budget). Absent → the built-in `FALLBACK_RISK_POLICY`, which auto-merges
   * nothing: an engine with no preset library configured lands no pull request on its own.
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
   * Optional: the {@link AppCaches.modelPreset} slice — read-through for the block's MODEL preset,
   * whose two run-path columns (the step's model for the kind, the route order) every dispatch
   * resolves. Absent → every dispatch hits the repository (tests / no cache wired). Invalidated by
   * `ModelPresetService` on every preset write.
   */
  modelPresetCache?: GroupCacheHandle<ModelPresetCacheValue>
  /**
   * Optional: the {@link AppCaches.localModelDeclarations} slice, read-through for what the run
   * INITIATOR declared about the locally-run models they enabled. Same profile as the preset slice
   * above, keyed on the user rather than the workspace, and read by every dispatch for the same
   * reason: the winning model is not known until the shared resolver has walked its sources. Absent
   * → every dispatch hits the repository. Invalidated by the endpoint write paths.
   */
  localModelDeclarationsCache?: GroupCacheHandle<LocalModelDeclarationsCacheValue>
  /**
   * Optional: the merge track record — the per-class change classification the merge policy's
   * per-class rules key off, plus the best-effort record of every merge decision (and the
   * reviewer-effort tag a human leaves). Absent (no repository wired / tests) ⇒ classification
   * yields `unknown`, no per-class rule matches, nothing is persisted, and the merge path
   * behaves exactly as it did before this existed.
   */
  mergeTrackRecord?: MergeTrackRecordService
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
  /**
   * Optional: writes the engine's verification report (CI verdict, tester report, ephemeral
   * environment lifecycle, merge assessment, run metadata + an observability deep link) onto
   * the run's pull request as a marker-delimited, idempotently-updated section. A facade
   * composes it from its engine VCS client, so GitLab deployments publish too. Absent (tests,
   * a no-VCS deployment) → the engine behaves exactly as it did before the feature.
   */
  prVerificationReportPublisher?: PrVerificationReportPublisher
  /**
   * Optional: the provisioning event log, read by the verification report to DATE the ephemeral
   * environment's lifecycle (when it came up, when it was reclaimed, and how many attempts
   * failed). Absent → the environment section reports the lifecycle as un-evidenced rather than
   * as an environment nobody tore down.
   */
  provisioningLogRepository?: ProvisioningLogRepository
  /**
   * Optional: the deployment's public SPA base URL, used to build the verification report's
   * observability deep link. Absent → the report carries no link rather than a dead one.
   */
  appBaseUrl?: string
  /**
   * Optional: this deployment's own externally-reachable BACKEND base URL, from which the
   * verification report builds direct links to stored artifacts' bytes. Absent → those rows carry
   * their artifact ids and no link.
   */
  apiBaseUrl?: string
  /**
   * Optional: the per-workspace settings row, read by the verification-report hook for the
   * `publishPrVerificationReport` opt-out. Absent ⇒ the default (on).
   */
  workspaceSettingsRepository?: WorkspaceSettingsRepository
  /**
   * Optional: the settled-gate projection behind the operator dashboard's gate/CI-fixer
   * attempt statistics. Written best-effort when a polling gate reaches a terminal verdict.
   * Absent ⇒ nothing is projected and the dashboard reports no gate statistics, which is the
   * honest reading for a deployment that does not keep the sink.
   */
  gateOutcomeRepository?: GateOutcomeRepository
  /**
   * Optional structured logger (the facade's pino logger) for the engine's best-effort paths —
   * today the PR verification report, whose whole contract is that it never fails a run. Absent
   * ⇒ those failures are silent, which is why every facade wires it.
   */
  logger?: Logger
}
