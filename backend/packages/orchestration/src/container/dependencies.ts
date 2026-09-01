// The dependency contract for `createCore` — every wire a runtime facade injects into the
// domain composition root.
//
// Extracted VERBATIM from `container.ts` (no behaviour change): the interface had grown to ~815
// lines of pure declaration, which was most of what pushed the composition root against its size
// ratchet. Follows the precedent set for `ExecutionServiceDependencies`: a declaration block this
// large is a cohesive unit of its own, and it is the single place a new optional integration is
// declared. `container.ts` re-exports the type, so no import site changes.

import type { ContentLibraryDependencies } from './content-library-dependencies.js'
import type { AgentKindRegistry } from '@cat-factory/agents'
import type { OpenRouterModelMeta, ResolvedValidationChecks } from '@cat-factory/contracts'
import type {
  AccountSettingsService,
  ComposeRuntime,
  CustomManifestTypeRegistry,
  DeployJobClient,
  DetectionConventions,
  EnvironmentBackendRegistry,
  RegisterHandlerInput,
  RunnerBackendRegistry,
  UserSecretKindRegistry,
  VcsPatConnectionService,
} from '@cat-factory/integrations'
import type {
  AccountInvitationRepository,
  AccountRepository,
  AgentContextSnapshotRepository,
  AgentExecutor,
  AgentPromptRepository,
  AgentSearchQueryRepository,
  AgentToolCallRepository,
  AuditLogReader,
  AuditRecorder,
  BlockRepository,
  BootstrapJobRepository,
  BootstrapRunner,
  BrainstormSessionRepository,
  BranchProjectionRepository,
  BranchUpdater,
  BugHuntAssessor,
  CheckRunProjectionRepository,
  ClarityReviewRepository,
  Clock,
  CommitProjectionRepository,
  ConsensusGroupRepository,
  CreateSharedStackInput,
  CustomManifestTypeRepository,
  DeployCloneTarget,
  DocInterviewRepository,
  DocumentConnectionRepository,
  DocumentConnectionStore,
  DocumentRepository,
  DocumentSourceProvider,
  EmailConnectionRepository,
  EmailSender,
  EnvConfigRepairJobRepository,
  EnvConfigRepairRunner,
  EnvConfigRepairer,
  EnvironmentConnectionRepository,
  EnvironmentProvider,
  EnvironmentRegistryRepository,
  EnvironmentTestRunRepository,
  EnvironmentTestRunner,
  EnvironmentUserHandlerRepository,
  ExecutionEventPublisher,
  ExecutionRepository,
  GateOutcomeRepository,
  GateRegistry,
  GitHubClient,
  GitHubInstallation,
  GitHubInstallationRepository,
  GitHubProvisioningClient,
  IdGenerator,
  IncidentEnrichmentConnectionRepository,
  InitiativePresetRegistry,
  InitiativeRepository,
  IssueProjectionRepository,
  IssueWritebackProvider,
  JudgeAssessor,
  JudgeRegistry,
  KaizenGradingRepository,
  KaizenVerifiedComboRepository,
  LlmCallMetricRepository,
  LlmTraceSink,
  LocalModelEndpointRepository,
  Logger,
  MembershipRepository,
  MergeTrackRecordRepository,
  ModelPresetRepository,
  ModelProvider,
  ModelProviderResolver,
  ModelRef,
  NotificationChannel,
  NotificationRepository,
  NotificationSettingsRepository,
  ObservabilityConnectionRepository,
  OperationalMetrics,
  PackageRegistryConnectionRepository,
  PasswordHasher,
  PasswordResetTokenRepository,
  PipelineRegistry,
  PipelineRepository,
  PipelineScheduleRepository,
  PlatformMetricsRepository,
  PrVerificationReportPublisher,
  PreflightHostProbes,
  PreviewTransport,
  ProviderCapabilities,
  ProviderRegistry,
  ProvisioningLogRepository,
  PullRequestMerger,
  PullRequestProjectionRepository,
  ReferenceArchitectureRepository,
  ReleaseHealthConfigRepository,
  RepoBootstrapper,
  RepoProjectionRepository,
  ReportsRepository,
  ResolveRunInitiatorToken,
  SpendRollupRepository,
  RequirementReviewRepository,
  ResolveBinaryArtifactStore,
  ResolveRepoFilesForCoords,
  ResolveRunRepoContext,
  AccountRiskPolicyRepository,
  RiskPolicyRepository,
  RiskPolicySuppressionRepository,
  RunInitiatorScope,
  RunLifecycleSink,
  RunnerPoolConnectionRepository,
  RunnerPoolProvider,
  SandboxExperimentRepository,
  SandboxFixtureRepository,
  SandboxGradeRepository,
  SandboxPromptVersionRepository,
  SandboxRunRepository,
  SecretCipher,
  SecretDelegate,
  ServiceFragmentDefaultsRepository,
  ServiceRepository,
  SharedStackRepository,
  SlackConnectionRepository,
  SlackMemberMappingRepository,
  SlackSettingsRepository,
  StepResolverRegistry,
  SubscriptionActivationRepository,
  TaskConnectionRepository,
  TaskConnectionStore,
  TaskRepository,
  TaskSourceProvider,
  TaskSourceSettingsRepository,
  TaskTypeRegistry,
  InlineUseCaseGenerator,
  InlineUseCaseRegistry,
  TestSecretRef,
  TicketTrackerProvider,
  TokenUsageRepository,
  TrackerCommentIngestRepository,
  TrackerSettingsRepository,
  UrlSafetyPolicy,
  UserRepoAccessRepository,
  UserRepository,
  TutorialProgressRepository,
  UserSettingsRepository,
  VcsProviderRegistry,
  VcsWebUrls,
  WebhookVerifier,
  WorkRunner,
  TaskTypeSuppressionRepository,
  WorkspaceAgentSettingsRepository,
  WorkspaceMemberRepository,
  WorkspaceMountRepository,
  WorkspaceRepository,
  WorkspaceSettingsRepository,
} from '@cat-factory/kernel'
import type { SpendPricing } from '@cat-factory/spend'
import type { TesterQualityReviewer } from '../modules/execution/TesterQualityReviewService.js'
import type { AgentContextObservabilityService } from '../modules/observability/AgentContextObservabilityService.js'
import type { SearchQueryObservabilityService } from '../modules/observability/SearchQueryObservabilityService.js'
import type { BuildPreviewJob } from '../modules/preview/PreviewService.js'

/**
 * The application's dependency bag: every port, registry and facade-provided seam `createCore`
 * assembles the container from.
 *
 * It EXTENDS {@link ContentLibraryDependencies}, whose members are declared next door: the three
 * content libraries are a cohesive group with their own module factory file, and holding their
 * declarations here is what pushed this one past its size budget. A facade populates one flat
 * object exactly as before.
 */
export interface CoreDependencies extends ContentLibraryDependencies {
  workspaceRepository: WorkspaceRepository
  /**
   * Workspace-level RBAC roster (workspace-rbac initiative). Threaded into
   * `WorkspaceService` so the gate can resolve a caller's effective role + the creator
   * auto-enroll can seed an admin row. Optional: absent (unwired / tests) ⇒ resolution
   * falls back to the account tier and auto-enroll is skipped.
   */
  workspaceMemberRepository?: WorkspaceMemberRepository
  /** Account tenancy: accounts own workspaces; memberships grant access (0017). */
  accountRepository: AccountRepository
  membershipRepository: MembershipRepository
  /** Canonical user identity (`users` + `user_identities`); keyed off by everything. */
  userRepository: UserRepository
  /** Hashes/verifies email-password credentials (WebCrypto PBKDF2). */
  passwordHasher: PasswordHasher
  /** Account invitations (email-based org onboarding). Optional: opt-in feature. */
  invitationRepository?: AccountInvitationRepository
  /** Per-account email-sender connections (UI-onboarded, DB-stored). Optional. */
  emailConnectionRepository?: EmailConnectionRepository
  /** Master-key cipher sealing the per-account email API key at rest. */
  emailSecretCipher?: SecretCipher
  /** Password-reset tokens ("forgot my password"). Optional: opt-in feature. */
  passwordResetTokenRepository?: PasswordResetTokenRepository
  /**
   * Resolve the deployment's system email sender (auth emails like password reset),
   * independent of the per-account connections. Absent ⇒ reset links are logged, not
   * emailed.
   */
  resolveSystemEmailSender?: () => Promise<EmailSender | null>
  /**
   * Base URL of the SPA (its origin) — the invite-accept / password-reset links point at it,
   * and the PR verification report builds its observability deep link from it. Absent ⇒ those
   * surfaces omit the link rather than emitting a dead one.
   */
  appBaseUrl?: string
  /**
   * Base URL of THIS BACKEND as the outside world reaches it (`PUBLIC_URL` on Node,
   * `WORKER_PUBLIC_URL` on the Worker). The PR verification report builds direct links to stored
   * artifacts' bytes from it, so a reviewer gets a screenshot rather than an opaque id.
   *
   * Kept apart from {@link appBaseUrl} rather than reused: the two coincide on a same-origin
   * deployment and diverge the moment the SPA is served from its own host, and a link built from
   * the wrong one is worse than no link at all. Absent ⇒ those rows carry ids only.
   */
  apiBaseUrl?: string
  /**
   * The structured logger every domain service emits through (`backend/docs/logging.md`).
   * A facade injects its pino-backed instance from `@cat-factory/server`; a test or harness
   * that does not care passes `noopLogger` explicitly.
   *
   * REQUIRED, deliberately. It was optional first, and the Worker's dependency literal simply
   * had no `logger` key — so on the deployed runtime every domain service fell back to
   * `noopLogger`, putting exactly the best-effort paths this logger exists to surface back in
   * the dark, with nothing failing to say so. An optional dep whose absence is silent and
   * whose presence is a facade-parity obligation is the wrong shape: making it required turns
   * that whole class of gap into a typecheck failure, the same guard the message-first
   * signature gives the call sites.
   */
  logger: Logger
  /**
   * Where operational EVENTS are counted (kernel `ports/operational-metrics.ts`) — container
   * dispatch failures, evictions, cache hit/miss, dropped telemetry. The dual of `logger`: a
   * log line answers "what happened to THIS run", a counter answers "how often is this
   * happening at all", and only the second one can tell an operator that a rate has changed.
   *
   * REQUIRED for exactly the reason `logger` is. An un-wired counter reads as a zero, and a
   * zero here is the most dangerous value in the whole initiative: it says "no evictions" on a
   * runtime where every container is dying. A facade with nothing to export passes
   * `noopOperationalMetrics` explicitly, which says that in code.
   */
  operationalMetrics: OperationalMetrics
  /**
   * Where privileged and destructive actions are RECORDED for an account admin to read back
   * (kernel `ports/audit.ts`). The narrow write seam, not the store: `record` never throws, so
   * an audited service is unchanged in shape from an unaudited one.
   *
   * REQUIRED for the third time and the same reason as `logger` and `operationalMetrics`, with
   * the sharpest version of the failure: an un-wired audit log reads as "nobody has changed
   * anything", which is indistinguishable from a quiet month and is the precise assurance the
   * log exists to give. A facade that does not persist audit events passes `noopAuditRecorder`
   * explicitly, which says so in code.
   */
  auditRecorder: AuditRecorder
  /**
   * The READ half of the same store, for the account-admin viewer.
   *
   * A second dependency rather than widening `auditRecorder`, because the two are handed to
   * different callers: domain services get the write seam and must not be able to paginate the
   * log, the viewer's controller gets this and must not be able to append to it. Both facades
   * satisfy them with the SAME object (an `AuditService` is both), so this costs a line at the
   * composition root and buys a capability boundary everywhere else.
   *
   * Optional, unlike the recorder, and the asymmetry is the honest one: an un-wired WRITE reads
   * as "nobody changed anything" and must never happen silently, while an un-wired READ is a
   * viewer that 503s and says so. A facade with no store passes nothing and the route refuses.
   */
  auditLogReader?: AuditLogReader
  blockRepository: BlockRepository
  pipelineRepository: PipelineRepository
  executionRepository: ExecutionRepository
  /**
   * In-org shared services (account-owned services + per-workspace mounts, 0030).
   * Optional so facades/tests without them wired keep the feature cleanly opt-in.
   */
  serviceRepository?: ServiceRepository
  workspaceMountRepository?: WorkspaceMountRepository
  idGenerator: IdGenerator
  clock: Clock
  /**
   * Performs each pipeline step. Wire AiAgentExecutor (optionally composed with
   * the container executor for repo-operating steps) for real work, or a fake in
   * tests.
   */
  agentExecutor: AgentExecutor
  /**
   * The app-owned agent-kind registry (built-ins + any a deployment registered by
   * reference). Optional + defaulted to `defaultAgentKindRegistry()` so existing
   * construction sites (tests, harnesses) don't break; each facade injects the SAME
   * instance it threads into its executors so custom kinds resolve consistently
   * everywhere. Read by the engine (traits / inline-surface / pre-post-op hooks) and
   * re-exposed on {@link Core} for the HTTP layer's snapshot projection.
   */
  agentKindRegistry?: AgentKindRegistry
  /**
   * The app-owned polling-gate registry. Optional + defaulted to `defaultGateRegistry()`
   * (EMPTY — the built-in `@cat-factory/gates` suite lives in that package, so the facade
   * installs it via `registerBuiltinGates(gateRegistry)` before injecting the SAME instance
   * here). A deployment registers custom gates by reference on that instance. Read by the
   * engine's gate machine (see {@link ExecutionService}); a facade that injects it also passes
   * the same instance to `validateRegistrations`. Existing construction sites (tests /
   * harnesses) that omit it get a bare registry, so gate steps pass through.
   */
  gateRegistry?: GateRegistry
  /**
   * The app-owned JUDGE registry — the fourth step-taxonomy bucket (an LLM assessment against a
   * rubric, compared to a per-task threshold, disposed as advance/park/bounce/fail). Optional +
   * defaulted to `defaultJudgeRegistry()` (EMPTY — the platform ships no built-in judges; the
   * `merger` stays a privileged built-in). Each facade injects the SAME instance a deployment
   * registers its judges on. See `docs/initiatives/judge-registry.md`.
   */
  judgeRegistry?: JudgeRegistry
  /**
   * The verdict producer behind every judge step. Optional: `createCore` builds the inline
   * `JudgeService` from the model-provider dependencies the facade already wires, so judges need
   * NO per-facade wiring. Injected explicitly only by a test/conformance harness that wants a
   * deterministic verdict. Absent/disabled ⇒ every judge step is a pass-through.
   */
  judgeAssessor?: JudgeAssessor
  /**
   * The ranking producer behind the interactive bug hunt. Optional for the same reason as
   * {@link CoreDependencies.judgeAssessor}: `createCore` builds the inline
   * `BugHuntAssessorService` from the model-provider dependencies the facade already wires, so
   * the hunt needs NO per-facade wiring. Injected explicitly only by a test/conformance harness
   * that wants a deterministic ranking. Absent/disabled ⇒ a hunt returns its board scan
   * unranked, flagged `analysisStatus: 'unavailable'`.
   */
  bugHuntAssessor?: BugHuntAssessor
  /**
   * The app-owned step-completion-resolver registry (deployment-registered resolvers).
   * Optional + defaulted to `defaultStepResolverRegistry()` (EMPTY — the built-in `merger`
   * resolver is a privileged engine built-in, not a registry entry). Each facade injects the
   * SAME instance it registers custom resolvers on. Read by the engine's completion hub.
   */
  stepResolverRegistry?: StepResolverRegistry
  /**
   * The app-owned provider registry (the deployment-supplied data sources a gate probes, keyed
   * by {@link ProviderToken}). Optional + defaulted to `defaultProviderRegistry()`. The engine's
   * gate machine reads it through the {@link GateContext} it builds (`RunDispatcher.makeGateContext`);
   * each facade news ONE instance, wires its configured gate providers on it (the
   * `@cat-factory/gates` `wireX` handles), and injects the SAME instance here. Existing
   * construction sites (tests / harnesses) that omit it get a fresh empty registry, so every gate
   * passes through.
   */
  providerRegistry?: ProviderRegistry
  /**
   * The app-owned pipeline registry (deployment-registered extra pipelines). Optional + defaulted
   * to `defaultPipelineRegistry()` (empty). Threaded into the workspace + pipeline services so a
   * deployment's custom pipelines are seeded into every new workspace and resolvable by id; a
   * facade injects the SAME instance it registers custom pipelines on. Existing construction sites
   * (tests / harnesses) that omit it get an empty registry (built-in catalog only).
   */
  pipelineRegistry?: PipelineRegistry
  /**
   * The app-owned custom task-type registry (deployment-registered namespaced task types).
   * Optional + defaulted to `defaultTaskTypeRegistry()` (EMPTY — there are no built-in custom
   * task types). Threaded into the board service so a custom-typed task resolves its default
   * pipeline, and re-exposed on {@link Core} for the HTTP layer's snapshot projection
   * (`customTaskTypes`); a facade injects the SAME instance it registers custom task types on.
   * Existing construction sites (tests / harnesses) that omit it get an empty registry.
   */
  taskTypeRegistry?: TaskTypeRegistry
  /**
   * The app-owned INLINE USE-CASE registry (the deployment's non-container model operations, which
   * `/api/v1/use-cases` publishes and invokes). Optional + defaulted to
   * `defaultInlineUseCaseRegistry()` (EMPTY: the platform ships no use case of its own, exactly as
   * it ships no custom task type). A facade injects the SAME instance a deployment registers on,
   * and re-exposes it on {@link Core} for the public surface and for `validateRegistrations`.
   */
  inlineUseCaseRegistry?: InlineUseCaseRegistry
  /**
   * The producer behind one invocation: it resolves a declared model option and runs the call.
   * Absent ⇒ the facade's model-derived generator, which is disabled with no provider wired and
   * makes every invocation a 503 naming that. Injected by the conformance harness as a
   * deterministic fake, exactly like `judgeAssessor` / `bugHuntAssessor`.
   */
  inlineUseCaseGenerator?: InlineUseCaseGenerator
  /**
   * The app-owned initiative-preset registry (built-in generic / docs-refresh / tech-migration
   * plus any a deployment registered by reference). Optional + defaulted to
   * `defaultInitiativePresetRegistry()` so existing construction sites (tests, harnesses) don't
   * break; each facade injects the SAME instance so custom presets resolve consistently everywhere.
   * Read by the initiative services (create / ingest / interviewer steering) + the spawned-run
   * preset context, and re-exposed on {@link Core} for the HTTP layer's snapshot descriptors + the
   * preset probe.
   */
  initiativePresetRegistry?: InitiativePresetRegistry
  /**
   * The app-owned VCS provider registry (the neutral webhook receiver resolves a provider
   * bundle through it). Optional + defaulted to `defaultVcsRegistry()`. NOT read by the engine
   * (like `userSecretKindRegistry`): it rides `CoreDependencies` purely so each facade reads the
   * SAME instance off `overrides` (the conformance-injection seam) and surfaces it on the
   * `ServerContainer` for the neutral webhook controller. A facade news one, registers the
   * providers its config enables on it, and threads that instance here.
   */
  vcsRegistry?: VcsProviderRegistry
  /**
   * Optional: resolve a block's run repo (installation + repo + default branch) bound to
   * a checkout-free {@link RepoFiles}, so a registered custom kind's pre/post-op hooks
   * read a targeted subset of the repo and commit rendered artifacts WITHOUT a checkout.
   * A facade composes it from its wired `GitHubClient` + `resolveRepoTarget`
   * (`makeResolveRunRepoContext`). Absent (tests / GitHub not connected) → the engine
   * skips every kind's pre/post-ops, exactly as a built-in kind has none.
   */
  resolveRunRepoContext?: ResolveRunRepoContext
  /**
   * Optional: resolve a VCS-neutral, repo-bound {@link RepoFiles} from explicit repo
   * coordinates (no block context), so the environments module can validate / bootstrap
   * a provider's config file in a repo the operator names. A facade composes it from its
   * wired `GitHubClient` + the workspace's installation/repo projection
   * (`makeResolveRepoFilesForCoords`). Absent → repo validation/bootstrap report "no VCS
   * connection".
   */
  resolveRepoFilesForCoords?: ResolveRepoFilesForCoords
  /**
   * Optional: dispatch / poll / release a CONTAINER-backed deploy job (real
   * `kubectl`/`kustomize`/`helm`) through the workspace's runner transport — the async
   * provisioning lifecycle the Kubernetes render path uses. A facade passes its
   * `RunnerJobClient` (structurally a {@link DeployJobClient}). Absent → container provisioning
   * is unavailable, so a render-needing config fails loudly (the raw-manifest REST path is
   * unaffected). See docs/initiatives/per-service-provision-types.md (phase 2).
   */
  deployJobClient?: DeployJobClient
  /**
   * Optional: resolve the manifests-repo clone target (HTTPS URL + ref + short-lived token) a
   * deploy container clones — VCS-specific, server-layer work the stateless provider can't do.
   * A facade composes it from its wired `GitHubClient` + `resolveRepoTarget`. Absent → no clone
   * target, so a render-needing config fails loudly (the synchronous raw path never needs it).
   */
  resolveDeployCloneTarget?: (
    workspaceId: string,
    blockId: string,
    ref?: string,
  ) => Promise<DeployCloneTarget | null>
  /**
   * Optional: the kind-scoped `agent_runs` rows for env-config-repair runs. Wired by a
   * facade alongside {@link envConfigRepairer}; absent → no durable repair runs.
   */
  envConfigRepairJobRepository?: EnvConfigRepairJobRepository
  /**
   * Optional: the side-effecting dispatch/poll/release of the repair container (the
   * server's `ContainerEnvConfigRepairer`). When wired (with the job repository), the
   * environments module builds an {@link EnvConfigRepairService} and routes the connection
   * service's `dispatchConfigRepair` seam through it (start the durable run, return its id).
   * Absent → the bootstrap op has no agent fallback.
   */
  envConfigRepairer?: EnvConfigRepairer
  /**
   * Optional: durably drives an env-config-repair run's poll loop (the worker's
   * `EnvConfigRepairWorkflow` / Node pg-boss). Absent → tests poll `pollJob` directly.
   */
  envConfigRepairRunner?: EnvConfigRepairRunner
  /**
   * Optional: the `environment_test_runs` rows backing the ephemeral-environment
   * self-test. Wired (with `resolveRunRepoContext` + the environments module) → the
   * environments module builds an {@link EnvironmentTestService}; absent → no self-test.
   */
  environmentTestRunRepository?: EnvironmentTestRunRepository
  /**
   * Optional: durably drives a self-test run's poll loop (the worker's
   * `EnvironmentTestWorkflow` / Node pg-boss). Absent → tests poll `pollEnvTest` directly.
   */
  environmentTestRunner?: EnvironmentTestRunner
  /**
   * Optional: runs the engine's gate-probe / merge GitHub reads under the run
   * initiator's ambient context so a per-user PAT is preferred (see
   * `RunInitiatorScope`). A facade injects the server's `runWithInitiator`. Absent →
   * pass-through (no per-user PAT preference; the deployment default is used).
   */
  runInitiatorScope?: RunInitiatorScope
  /** Ledger backing the spend safeguard (per-call token usage). */
  tokenUsageRepository: TokenUsageRepository
  /**
   * Sink backing LLM observability (full per-call prompt/response, output-limit
   * headroom, transport-vs-execution latency). Optional and default-off: when
   * present the proxy records every container-agent call and the engine rolls the
   * aggregates onto pipeline steps; absent → no observability is collected and
   * tests/unconfigured facades are unaffected.
   */
  llmCallMetricRepository?: LlmCallMetricRepository
  /**
   * Deployment-level rollup port over `agent_runs` (run outcomes, failure taxonomy, live/parked
   * depth, duration + trend) backing the platform-operator dashboard. Optional: when wired,
   * `createCore` builds {@link PlatformObservabilityService} and re-exposes it for the admin read
   * endpoint; absent (tests / unconfigured facades) → no platform view, engine unaffected.
   */
  platformMetricsRepository?: PlatformMetricsRepository
  /**
   * Settled-gate projection (`gate_outcomes`): written by the engine's gate machine as each
   * polling gate reaches a terminal verdict, read by the platform dashboard for the gate /
   * CI-fixer attempt statistics.
   *
   * REQUIRED, unlike the rollup port above, and for the reason `logger` and
   * `operationalMetrics` are: this one is WRITTEN by the engine, and an un-wired writer reads
   * downstream as "no gate on this deployment ever escalated", which is exactly what a healthy
   * deployment looks like. The rollup port is a pure READ whose absence removes a page; this
   * one's absence silently removes the truth from a page that still renders. A facade with no
   * such store passes {@link noopGateOutcomeRepository}, which says so in code.
   */
  gateOutcomeRepository: GateOutcomeRepository
  /**
   * Cross-cutting usage-analytics rollup port (spend per model/agent kind, spend + run
   * activity per workspace/service/task type, spend trend) backing the Reports view.
   * Optional: when wired, `createCore` builds {@link ReportsService} and re-exposes it for
   * the admin read endpoint; absent (tests / unconfigured facades) → no reports view.
   */
  reportsRepository?: ReportsRepository
  /**
   * The DURABLE cost-attribution rollup (`spend_days`) behind the Reports view's long
   * windows, materialised by the retention sweep and never pruned. Optional, like
   * {@link reportsRepository}: absent ⇒ every window falls back to the ledger and the
   * projection reports `source: 'ledger'` rather than presenting ledger numbers as durable
   * ones.
   */
  spendRollupRepository?: SpendRollupRepository
  /**
   * How long the `token_usage` ledger is retained (`TOKEN_USAGE_RETENTION_DAYS`, in ms). Not a
   * knob any service applies itself: the retention sweep owns the prune. It is here because a
   * board DELETE has to fold the board's un-rolled spend into {@link spendRollupRepository}
   * before the cascade takes the ledger rows, and how far back that fold walks is bounded by how
   * far back the ledger still holds anything. Wiring the same number both places is what keeps a
   * board's final fold covering exactly the days a sweep pass would have. 0 or absent ⇒ the
   * ledger is never pruned and the fold falls back to its own backfill floor.
   */
  tokenUsageRetentionMs?: number
  /**
   * Whether the LLM observability sink persists the full prompt body with each metric.
   * Defaults to true; set false (via `LLM_RECORD_PROMPTS=false`) to keep the numeric
   * telemetry while storing the complete prompts empty. Only meaningful when
   * `llmCallMetricRepository` is wired.
   */
  recordLlmPrompts?: boolean
  /**
   * Agent-context observability sink, built by the facade (it needs the same
   * snapshot repository the executor records through). When present the engine
   * re-exposes it for the read endpoint; the facade also injects it into the
   * container-agent executor for the write path. Absent → no agent context is stored.
   */
  agentContextObservability?: AgentContextObservabilityService
  /**
   * Agent-search-query observability sink, built by the facade (it needs the same
   * search-query repository the search proxy records through). When present the engine
   * re-exposes it for the read endpoint; the facade also injects it into the web-search
   * proxy for the write path. Absent → no search queries are stored.
   */
  searchQueryObservability?: SearchQueryObservabilityService
  /**
   * The two telemetry stores behind the sinks above, handed in ALONGSIDE them (the facade
   * builds each sink from its repository, so passing the repository too costs it one line).
   *
   * The sinks are WRITE services — recorders with a capture gate and a redaction pass — and
   * the remote debugging surface is a pure reader that needs neither. Threading these makes
   * the telemetry repository set symmetric with `llmCallMetricRepository` and
   * `provisioningLogRepository`, which the core already takes directly, so the debug reader
   * has ONE kind of dependency rather than two repositories and two services.
   *
   * Absent → the matching debug reads return empty pages and the run overview reports that
   * sink as unavailable, which is a different statement from a count of zero.
   */
  agentContextSnapshotRepository?: AgentContextSnapshotRepository
  agentSearchQueryRepository?: AgentSearchQueryRepository
  agentToolCallRepository?: AgentToolCallRepository
  /**
   * Optional external LLM trace sink (e.g. Langfuse). When wired, the observability
   * service fans every recorded call out to it as a generation. Opt-in and default-off;
   * a facade wires it only when configured (`selectLangfuseSink`).
   */
  llmTraceSink?: LlmTraceSink
  /**
   * Drives runs durably outside the starting request. Defaults to a no-op (tests);
   * the worker wires WorkflowsWorkRunner when the Workflows binding is present.
   */
  workRunner?: WorkRunner
  /**
   * Pushes execution/board changes to connected clients in real time, replacing
   * the browser's `tick` polling. Defaults to a no-op (tests, or any deployment
   * without the WORKSPACE_EVENTS binding); the worker wires
   * DurableObjectEventPublisher when that binding is present.
   */
  executionEventPublisher?: ExecutionEventPublisher
  /**
   * Pricing and budget for the spend safeguard. Defaults to the built-in
   * approximate EUR prices and a ~100 EUR/month limit; the worker overrides
   * this from env, and tests can inject a tiny limit to exercise pausing.
   */
  spendPricing?: SpendPricing
  /**
   * Optional resolver for a workspace's enabled OpenRouter dynamic-catalog models, so the
   * spend safeguard prices a metered `openrouter:<slug>` call at its real per-model rate
   * instead of the bare-`openrouter` fallback. Wired by each facade from its
   * `OpenRouterCatalogService`; absent → the static price table is used.
   */
  dynamicModelPricesFor?: (workspaceId: string) => Promise<OpenRouterModelMeta[]>

  // ---- GitHub integration (optional; wired only when configured) ----------
  // These follow the integrations' "default-off" convention: the
  // worker wires them only when the GitHub App secrets/bindings are present, so
  // the existing core and tests are untouched when GitHub is unconfigured. When
  // all of them are supplied, `createCore` assembles the `github` module.
  githubClient?: GitHubClient
  githubInstallationRepository?: GitHubInstallationRepository
  /**
   * The per-workspace VCS PAT connect service (GitLab today), injected by a facade when GitLab
   * connect is wired (a sealing key + GitLab config). Exposed on {@link Core} and surfaced on the
   * ServerContainer, where the GitLab connect controller drives it. Absent ⇒ the connect endpoints
   * 503, exactly like the App-based `github` module when unconfigured.
   */
  vcsConnectionService?: VcsPatConnectionService
  /**
   * The browser-facing base URL of each provider's configured instance, derived from its API
   * base by the facade (`resolveVcsWebUrls`). Stamped onto every connection the SPA reads, which
   * renders each repo / pull request / issue link from it; a provider absent here reports a null
   * host and the SPA withholds those links rather than pointing at the public instance.
   */
  vcsWebUrls?: VcsWebUrls
  /**
   * "Does a run in this scope authenticate as its INITIATOR's own personal access token, or as
   * the deployment credential?" — the single built instance, shared with the engine's GitHub
   * client and each facade's container-dispatch mint (kernel's `createInitiatorPatGate` +
   * `@cat-factory/server`'s `createResolveRunInitiatorToken`).
   *
   * On the container it serves the credential CHECK: the board-load probe that warns a user
   * their token cannot push has to judge the token a run would ACTUALLY use, which means
   * honouring the workspace's `allowInitiatorPat` opt-out. Re-composing that gate in the
   * controller would have made a fourth copy of a security decision whose whole point is being
   * singular, and an opted-out workspace would then be nagged about a token no run touches.
   *
   * Absent ⇒ no per-user secret store is wired (no `ENCRYPTION_KEY`), which is the same
   * condition that already makes the preference inert; the check then judges the deployment
   * credential alone.
   */
  resolveRunInitiatorToken?: ResolveRunInitiatorToken
  repoProjectionRepository?: RepoProjectionRepository
  branchProjectionRepository?: BranchProjectionRepository
  pullRequestProjectionRepository?: PullRequestProjectionRepository
  issueProjectionRepository?: IssueProjectionRepository
  commitProjectionRepository?: CommitProjectionRepository
  checkRunProjectionRepository?: CheckRunProjectionRepository
  /**
   * The per-user "repos my PAT can reach" projection. When wired, the repo picker expands with
   * the viewer's PAT-reachable repos (recording their access for the board redaction). Optional.
   */
  userRepoAccessRepository?: UserRepoAccessRepository
  webhookVerifier?: WebhookVerifier
  /**
   * Bounds the initial commit backfill window (see GitHubSyncService). The worker
   * sets this from the commit retention horizon so backfill and retention agree;
   * undefined backfills the full history.
   */
  commitBackfillHorizonMs?: number
  /**
   * The privileged App's provisioning client (ADR 0005). Present only when a
   * privileged App is configured; backs the create-repo endpoint. Absent → the
   * `github` module exposes no `provisioningService` and creation stays manual.
   */
  repoProvisioningClient?: GitHubProvisioningClient
  /**
   * Whether the privileged App tier can create repos for an installation (ADR
   * 0005) — true when its owning App is the privileged one. Surfaced on the
   * connection so the UI drops the manual create step; absent → always false.
   */
  canCreateRepos?: (installation: GitHubInstallation) => boolean
  /**
   * Whether an installation actually granted `workflows: write`. Surfaced on the
   * connection so the UI can warn that agent pushes touching `.github/workflows/*`
   * would be rejected; absent → always false.
   */
  workflowsGranted?: (installation: GitHubInstallation) => Promise<boolean>

  // ---- Document-source integration (optional; wired only when configured) --
  // Mirrors the GitHub default-off convention. The documents module assembles
  // when at least one source provider + both repositories are present. Each
  // provider (Confluence, Notion, …) encapsulates one source's specifics behind
  // the DocumentSourceProvider port. `modelProvider` is *optional within* the
  // module: when absent the planner uses its deterministic heading-based
  // fallback, so import, link and spawn still work. `documentRepository` is
  // additionally consumed by the execution engine to feed linked docs to agents
  // as context.
  modelProvider?: ModelProvider
  /**
   * Resolve a {@link ModelProvider} for a run's credential scope (the DB-backed API-key
   * pool, account/workspace/user). Preferred over the static `modelProvider` by the
   * inline consumers (document planner, requirements reviewer); the facade supplies it
   * so inline calls use the same per-scope pool the container LLM proxy does.
   */
  modelProviderResolver?: ModelProviderResolver
  /** Model the document planner uses (the agents' default model ref). */
  documentPlannerModel?: ModelRef
  documentSourceProviders?: DocumentSourceProvider[]
  /** The SEALED connection rows (persistence only: this facade may hold no key for them). */
  documentConnectionRepository?: DocumentConnectionRepository
  /**
   * The credential-bearing view of the rows above, and the only thing the module's services hold.
   * Built by the facade beside the repository (`createDocumentConnectionStore`) so a
   * mothership-mode node composes the mothership delegate in and needs no local key. Absent
   * whenever the repository is: the two are one wiring decision.
   */
  documentConnectionStore?: DocumentConnectionStore
  documentRepository?: DocumentRepository

  // ---- Task-source integration (optional; wired only when configured) ------
  // A sibling of the document-source integration for external issue trackers
  // (Jira, …). Mirrors the same default-off convention: the tasks module
  // assembles when at least one source provider + both repositories are present.
  // Each provider encapsulates one tracker's specifics behind the
  // TaskSourceProvider port. `taskRepository` is additionally consumed by the
  // execution engine to feed issues linked to a block to agents as context.
  taskSourceProviders?: TaskSourceProvider[]
  /** The SEALED connection rows (persistence only: this facade may hold no key for them). */
  taskConnectionRepository?: TaskConnectionRepository
  /** Their credential-bearing view; the document-source sibling above carries the rationale. */
  taskConnectionStore?: TaskConnectionStore
  /** Per-workspace on/off toggle for each task source (absent row ⇒ enabled). */
  taskSourceSettingsRepository?: TaskSourceSettingsRepository
  taskRepository?: TaskRepository
  /**
   * Idempotency markers for INBOUND tracker comments (the ticket-reply half of the clarification
   * loop). Absent ⇒ ticket replies are ignored entirely, because applying a comment's commands
   * without a claim would re-answer the same finding on every vendor redelivery. See
   * `backend/docs/adr/0032-tracker-webhook-intake.md`.
   */
  trackerCommentIngestRepository?: TrackerCommentIngestRepository

  // ---- Ephemeral environment integration (optional; wired when configured) -
  // Mirrors the GitHub/Confluence default-off convention. The module assembles
  // only when both repositories and the secret cipher are present (the provider is
  // resolved per-workspace from the env-backend registry by the stored `kind`), so
  // the engine (deterministic deployer step + env discovery) stays unchanged when the
  // feature is off. Per-tenant secrets are encrypted via `secretCipher`.
  environmentConnectionRepository?: EnvironmentConnectionRepository
  environmentRegistryRepository?: EnvironmentRegistryRepository
  /**
   * A deployment's pre-declared environment-handler SEEDS (each a `RegisterHandlerInput`). When
   * supplied (and the environments module is wired), `createCore` builds an
   * `EnvironmentHandlerSeeder` over them and exposes it on the container: the runtime
   * boot-backfills every existing workspace and `WorkspaceService.create` seeds each new one, so a
   * deployment (via a custom environment adapter) supplies the infra handler from its config instead of a human
   * filling the Infrastructure → Test environments form. Seeding is idempotent + per-seed
   * fault-tolerant. Absent / empty ⇒ no seeding.
   */
  seedEnvironmentHandlers?: RegisterHandlerInput[]
  /**
   * A deployment's pre-declared SHARED STACKS (each a `CreateSharedStackInput`) — the long-lived
   * compose infra its services' preview environments attach to. The sibling of
   * {@link seedEnvironmentHandlers} and wired the same way: `createCore` builds a
   * `SharedStackSeeder` over them and exposes it on the container, the runtime boot-backfills
   * every existing workspace, and `WorkspaceService.create` seeds each new one.
   *
   * This is what lets a deployment declare its infra dependencies IN CODE instead of through the
   * SPA: a seed's ordered compose layers may be inline documents, paths in ANOTHER repo, or paths
   * in the stack's own clone, so a stack that owns no repo at all is expressible. Seeding is
   * idempotent (matched by name) + per-seed fault-tolerant. Absent / empty ⇒ no seeding.
   */
  seedSharedStacks?: CreateSharedStackInput[]
  /**
   * The browsable-frontend-PREVIEW container transport (slice 5c) — the per-runtime half that
   * publishes a served app's port to a host port and keeps the container alive. Wired ONLY on a
   * runtime with a host-port-publish primitive (local Docker/Apple); the Worker never wires it,
   * so the preview module stays absent there and the controller 503s. Assembles the preview
   * module only alongside {@link buildPreviewJob} + {@link environmentRegistryRepository}.
   */
  previewTransport?: PreviewTransport
  /**
   * Builds the harness `mode: 'preview'` job for a `frontend` frame (repo/token/session + the
   * frontend infra spec) — a facade-provided seam because it needs the server-layer repo/auth
   * resolution. Paired with {@link previewTransport}.
   */
  buildPreviewJob?: BuildPreviewJob
  /**
   * Workspace-defined custom-manifest-type catalog (the UI-editable half of the custom
   * provision-type catalog). Absent ⇒ the catalog is the registered code types only.
   */
  customManifestTypeRepository?: CustomManifestTypeRepository
  /**
   * Per-USER infra handler overrides (local mode): the per-user layer over a workspace's
   * per-type handlers. Persisted in both runtimes; the local-only behaviour is enforced at
   * the controller mount (slice 4). Absent ⇒ no per-user overrides.
   */
  environmentUserHandlerRepository?: EnvironmentUserHandlerRepository
  /** The app-owned registry of code-defined custom manifest types (merged into the catalog). */
  customManifestTypeRegistry?: CustomManifestTypeRegistry
  secretCipher?: SecretCipher
  /**
   * Present ONLY on a mothership-mode node: opens (and seals) the ORG-owned credentials this
   * process holds no key for, by asking the mothership over `/internal/secrets/{unseal,seal}`.
   * Threaded into every service that handles one of kernel's `OrgSecretSource` rows, where
   * `createOrgSecretCipher` composes it with {@link secretCipher}. Absent (every hosted
   * deployment, and local mode over its own Postgres) ⇒ byte-for-byte the local cipher.
   */
  secretDelegate?: SecretDelegate
  /**
   * INTERNAL override: when set, this provider is used for every env operation instead of
   * the kind registry. NOT a public facade seam (a native backend registers into the
   * injected `environmentBackendRegistry`) — it exists only for the cross-runtime conformance
   * suite, which must inject a fake provider (validate-repo / config-repair) through a
   * schema-locked connect API. Production facades leave it unset → the registry path.
   */
  environmentProvider?: EnvironmentProvider
  /**
   * The app-owned environment-backend registry (kind → provider). A facade builds it via
   * `createBackendRegistries()` and registers any custom backends by reference before
   * injecting it here. Absent ⇒ a fresh registry with just the built-in `manifest` +
   * `kubernetes` kinds (`defaultEnvironmentBackendRegistry()`).
   */
  environmentBackendRegistry?: EnvironmentBackendRegistry
  // ---- Unified provisioning event log (optional; high-churn separate store) --
  // When wired, the env provision/teardown services record their attempts here and
  // the read service backs the "View logs" drawers + the run-details env surface.
  // Absent ⇒ provisioning is entirely unchanged. The repository lives in a
  // physically separate store (its own Postgres schema / D1 binding) per facade.
  provisioningLogRepository?: ProvisioningLogRepository
  // Whether this runtime can honor a Kubernetes env backend's custom TLS material (a
  // private CA / insecure-skip). The Cloudflare Worker can't (no undici) and sets
  // `false`, so a kubernetes env config with a CA is rejected at registration rather
  // than dying at first apply. Absent ⇒ supported (Node/local). Mirrors
  // `runnerCustomTlsSupported`.
  environmentCustomTlsSupported?: boolean
  // Operator-configured URL/host safety policy for the ENVIRONMENT-provisioning
  // integration (the manifest baseUrl + the returned env URL). Absent => strict
  // (https-only, no private/internal hosts). A trusted facade widens it so an in-house
  // adapter can reach an internal platform on a private/VPN host. Scoped independently of
  // the runner pool: widening one integration must not widen the other's SSRF guard.
  environmentUrlSafetyPolicy?: UrlSafetyPolicy
  // Deployment-level, ADDITIVE extensions to the built-in provisioning-detection conventions
  // (extra compose file names/dirs, seed dirs, env-template dirs), read from
  // `config.environments.detectionConventions` by each facade and threaded into BOTH detection
  // consumers (the connection service's `detectServiceProvisioning` + the shared-stack `detect`), so
  // an org broadens detection to its house repo layout without a code edit. Absent ⇒ built-in.
  detectionConventions?: DetectionConventions

  // ---- Self-hosted runner pool ("bring your own infra"; opt-in) ------------
  // Lets a workspace route its repo-operating coding jobs to its own container
  // runner pool instead of Cloudflare Containers. The module assembles when the
  // connection repository and the secret cipher are present (the worker wires
  // them only when RUNNERS_ENABLED + a master key are set); the actual transport
  // selection lives in the worker's container executor. Per-tenant scheduler-API
  // secrets are encrypted via `runnerSecretCipher` (its own master key + HKDF
  // domain, independent of the environment module's `secretCipher`).
  runnerPoolConnectionRepository?: RunnerPoolConnectionRepository
  runnerSecretCipher?: SecretCipher
  // The pool provider instance, so the runners connection service can surface a
  // descriptor + connection test for the manifest backend (the generic HTTP pool, or a
  // native one). Absent ⇒ no descriptor/test (the SPA falls back to the manifest editor
  // with no test button). The backend KIND is resolved from the stored config via the
  // runner-backend registry, not injected here.
  runnerPoolProvider?: RunnerPoolProvider
  /**
   * The app-owned runner-backend registry (kind → provider). A facade builds it via
   * `createBackendRegistries()` and registers any custom backends by reference before
   * injecting it here. Absent ⇒ a fresh registry with just the built-in `manifest` +
   * `kubernetes` kinds (`defaultRunnerBackendRegistry()`).
   */
  runnerBackendRegistry?: RunnerBackendRegistry
  /**
   * The app-owned registry of per-user secret KINDS (a GitHub PAT built-in today). Carried on
   * the dependency bag so each facade reads the SAME instance off `overrides` and threads it
   * into its `UserSecretService` (an integrations service built directly by the facade, not by
   * `createCore`). A deployment registers a custom kind by reference. Absent ⇒ a fresh registry
   * with just the built-in `github_pat` kind (`defaultUserSecretKindRegistry()`).
   */
  userSecretKindRegistry?: UserSecretKindRegistry
  // URL/host safety policy for the RUNNER-POOL integration (the scheduler baseUrl).
  // Absent => strict. Scoped independently of `environmentUrlSafetyPolicy` so an
  // operator widening the env allow-list does not silently widen the pool's SSRF guard.
  runnerUrlSafetyPolicy?: UrlSafetyPolicy
  // Whether this runtime can honor a runner backend's custom TLS trust material (a
  // private CA / insecure-skip). The Cloudflare Worker cannot (no undici / custom-CA
  // fetch) and sets `false`, so a Kubernetes config with a CA is rejected at
  // registration rather than dying at first dispatch. Absent ⇒ supported (Node/local).
  runnerCustomTlsSupported?: boolean

  // ---- Repo bootstrap (reference architectures + "bootstrap repo" task) ----
  // Reference-architecture CRUD assembles whenever both repositories are present
  // (the worker wires them unconditionally). Actually *running* a bootstrap also
  // needs `repoBootstrapper` — the GitHub + sandbox-container machinery — which
  // the worker wires only when those prerequisites are met; without it the module
  // still serves CRUD but reports the run path as unavailable.
  referenceArchitectureRepository?: ReferenceArchitectureRepository
  bootstrapJobRepository?: BootstrapJobRepository
  repoBootstrapper?: RepoBootstrapper
  /** Durably drives a bootstrap run's poll loop; without it, runs aren't auto-driven. */
  bootstrapRunner?: BootstrapRunner

  // ---- Requirements review (stateless reviewer agent) ---------------------
  // The review feature assembles whenever its repository is present (the worker
  // wires it unconditionally). The LLM is optional *within* the module: reads of
  // an existing review work without it, but running a review / incorporation
  // needs `modelProvider` + `documentPlannerModel` (reused as the reviewer ref).
  // The document/task repositories above are reused, when wired, to fold linked
  // PRDs and tracker issues into the reviewed requirements.
  requirementReviewRepository?: RequirementReviewRepository
  /**
   * Persistence for the interactive document-interview feature (WS5). Mirrors
   * `requirementReviewRepository`: both runtime facades wire it unconditionally. The
   * doc-interview service reuses the requirements reviewer's model config below, and it is
   * also read by the agent-context builder to fold the synthesized brief into the writer's
   * context. The interviewer LLM is optional within the module (a document pipeline runs off
   * the raw outline when no model is wired).
   */
  docInterviewRepository?: DocInterviewRepository
  /**
   * Persistence for the Kaizen agent (post-run grading of agent steps + the verified-combo
   * library). Both runtime facades wire both repos unconditionally. The Kaizen module
   * assembles whenever they are present; the LLM grader resolves its model for the `kaizen`
   * kind exactly like the requirements reviewer (block pin > workspace default > routing).
   */
  kaizenGradingRepository?: KaizenGradingRepository
  kaizenVerifiedComboRepository?: KaizenVerifiedComboRepository
  /**
   * Persistence for the clarity-review (bug-report triage) feature. Mirrors
   * `requirementReviewRepository`: both runtime facades wire it unconditionally. The
   * clarity service reuses the requirements reviewer's model config below.
   */
  clarityReviewRepository?: ClarityReviewRepository
  /**
   * Persistence for the brainstorm (structured-dialogue) feature. Mirrors
   * `requirementReviewRepository`: both runtime facades wire it unconditionally. The two
   * brainstorm services (one per stage) reuse the requirements reviewer's model config below.
   */
  brainstormSessionRepository?: BrainstormSessionRepository
  /**
   * Optional: per-run personal-credential activations (individual-usage subscriptions).
   * Passed through to the ExecutionService so a finished run's activation is cleared
   * promptly. Both runtime facades wire it when ENCRYPTION_KEY is present.
   */
  subscriptionActivationRepository?: SubscriptionActivationRepository
  /**
   * Default model the requirements reviewer uses when a block pins none.
   * Independent of the documents config so the reviewer works whenever a model
   * provider is wired; the worker sets it to the agents' routing default (which
   * resolves to Cloudflare Workers AI unless a direct key is set). Falls back to
   * `documentPlannerModel` when absent.
   */
  requirementReviewModel?: ModelRef
  /**
   * Resolve a block's pinned model id to a ref for the reviewer, honouring the
   * direct/Cloudflare fallback — the same resolver the agent executor uses. The
   * worker wires `config.agents.resolveBlockModel`; absent → the reviewer always
   * uses the default ref above.
   */
  requirementReviewResolveModel?: (modelId: string | undefined) => ModelRef | undefined
  /**
   * Override the test quality-control companion's inline reviewer. Normally `createCore`
   * builds a {@link TesterQualityReviewService} from the model-provider deps; injecting a
   * reviewer here replaces that (the cross-runtime conformance suite drives the full QC loop
   * through a deterministic fake reviewer this way). Absent ⇒ the reviewer is built from the
   * model deps, or is a pass-through when no model resolves.
   */
  testerQualityReviewer?: TesterQualityReviewer
  /**
   * Whether a container-only subscription harness ref (`claude-code` / `codex`) can run as
   * an INLINE LLM call in this deployment — true only in local mode, where the developer's
   * ambient CLI login is driven as a host subprocess. Threaded into every inline service
   * (requirements/clarity reviewers, brainstorm, kaizen, sandbox) so an ambient-eligible
   * harness ref is kept (served by the harness-aware model provider) instead of degraded to
   * the routing default, and into the start guard's inline-model check. From
   * `config.agents.inlineHarnessRef`; absent on Node/Worker (no inline harness path).
   */
  inlineHarnessRef?: (ref: ModelRef) => boolean

  // ---- Notifications + merge lifecycle (optional; wired when configured) ----
  // The notifications subsystem (the in-app inbox + the board's human-action
  // surfaces) assembles whenever `notificationRepository` is present (the worker
  // wires it unconditionally). `notificationChannel` is the delivery extension
  // seam — in-app push today, email/Slack later via CompositeNotificationChannel;
  // absent → the rows still persist but nothing is pushed. The CI gate / real
  // merge / per-task thresholds are each optional within the engine, mirroring the
  // GitHub default-off convention: without them the engine degrades gracefully
  // (CI gate passes through, `done` is a board-only flip, the built-in preset is used).
  notificationRepository?: NotificationRepository
  notificationChannel?: NotificationChannel
  /**
   * The notification MANAGER's store: which types this workspace delivers on which channel
   * (`in_app` / `email`). Powers the settings API here; the facade builds the same service
   * from the same repository to gate the channels it composes, so the surface a human edits
   * and the decision the delivery path makes read one row. Absent ⇒ the settings surface
   * 503s and every type keeps its shipped default.
   */
  notificationSettingsRepository?: NotificationSettingsRepository
  /**
   * The outbound RUN-LIFECYCLE push (`run.started` / `run.completed` / `run.failed`) — the other
   * half of what a headless integration needs, since the happy path (a pipeline whose `merger`
   * merges its own PR) raises no notification at all and so travels down no channel. Built by
   * `buildNotificationWebhookSupport` alongside the notification channel, from the same row and
   * cipher, so a facade cannot wire one and forget the other. Absent ⇒ nothing is pushed.
   */
  runLifecycleSink?: RunLifecycleSink

  // ---- Slack integration (optional; an extra notification transport) ----
  // The Slack module (per-account connect + per-workspace routing + member map)
  // assembles when its three repositories AND a secret cipher are present (the
  // cipher seals the bot token at rest, HKDF tag `cat-factory:slack`). The Slack
  // *delivery* itself is wired separately as a `notificationChannel` composed into
  // the CompositeNotificationChannel — these deps power the management API. The
  // OAuth credentials are optional (manual-token onboarding works without them).
  slackConnectionRepository?: SlackConnectionRepository
  slackSettingsRepository?: SlackSettingsRepository
  slackMemberMappingRepository?: SlackMemberMappingRepository
  slackSecretCipher?: SecretCipher
  /**
   * Per-account deployment settings (Slack OAuth / web-search / Langfuse creds + tuning).
   * Built in the facade (it needs the repo + cipher, and the facade also wires the
   * Langfuse sink + web-search proxy off it before Core is built). When present, Core
   * exposes it for the admin controller and derives the Slack OAuth resolver from it.
   */
  accountSettings?: AccountSettingsService
  // The `ci` / `conflicts` / `post-release-health` gates' providers (CI status,
  // mergeability, release health) + the on-call incident enrichment are no longer engine
  // dependencies: the gate suite ships as `@cat-factory/gates` and each facade wires those
  // providers into it via the package's `wireX` handles. Only the merge collaborators below
  // remain on the engine (the `merger` resolver stays a privileged built-in).
  /** Merges the repo default branch into a block's PR branch (human-test "pull main"). */
  branchUpdater?: BranchUpdater
  /**
   * Resolves the binary-artifact store (UI screenshots + reference designs) for a
   * workspace's account; the blob backend is configured per-account in the UI. The
   * visual-confirmation gate calls this with the run's workspace id. Absent (or resolving to
   * null — storage not configured) → the gate passes through (auto-advances).
   */
  resolveBinaryArtifactStore?: ResolveBinaryArtifactStore
  /** Performs the real GitHub merge so a task's `done` means "PR merged". */
  pullRequestMerger?: PullRequestMerger
  /**
   * Publishes the engine's verification report (CI verdict, tester report, ephemeral
   * environment lifecycle, merge assessment, run metadata + observability deep link) onto the
   * run's pull request, as a marker-delimited section updated idempotently in place. Composed
   * per facade from its ENGINE VCS client, so a GitLab deployment publishes through the same
   * port. Absent → the engine behaves exactly as it did before the feature.
   */
  prVerificationReportPublisher?: PrVerificationReportPublisher
  /** Stores a workspace's observability connection (provider + sealed credentials). */
  observabilityConnectionRepository?: ObservabilityConnectionRepository
  /** Stores per-block monitor/SLO mappings the post-release-health gate reads. */
  releaseHealthConfigRepository?: ReleaseHealthConfigRepository
  /**
   * Resolve the NON-secret refs (key + description) of the sensitive test credentials for a run
   * block's service frame, folded into the tester prompt. Wired from the facade's
   * `TestSecretsService`; absent ⇒ no advertised secrets. NEVER returns a value.
   */
  resolveTestSecretRefs?: (workspaceId: string, blockId: string) => Promise<TestSecretRef[]>
  /**
   * Resolve the PRE-PR VALIDATION CHECKS configured for a SERVICE FRAME — the commands the
   * harness runs against the checkout before opening a PR. Wired from the facade's
   * `ValidationConfigService`; absent (or resolving to `null`) ⇒ no checks travel on the job
   * body and the harness runs its existing path unchanged.
   *
   * Keyed by the frame, not the run block: `AgentContextBuilder` walks the frame→module→task
   * ancestry exactly ONCE per dispatch and threads that frame into every frame-scoped resolver,
   * so this one reuses it rather than paying a second walk.
   */
  resolveValidationChecks?: (
    workspaceId: string,
    frameId: string,
  ) => Promise<ResolvedValidationChecks | null>
  /** Seals observability credentials at rest (domain tag 'cat-factory:observability'). */
  observabilitySecretCipher?: SecretCipher
  /** Stores a workspace's incident-enrichment connection (sealed PagerDuty + incident.io). */
  incidentEnrichmentConnectionRepository?: IncidentEnrichmentConnectionRepository
  /** Seals incident-enrichment creds at rest (domain tag 'cat-factory:incident-enrichment'). */
  incidentEnrichmentSecretCipher?: SecretCipher
  /** Stores a workspace's private package-registry entries (sealed npm/GitHub Packages tokens). */
  packageRegistryConnectionRepository?: PackageRegistryConnectionRepository
  /** Seals registry tokens at rest (domain tag 'cat-factory:package-registries'). */
  packageRegistrySecretCipher?: SecretCipher
  /** A board's OWN risk policies: the built-in catalog copied in at creation, plus what it authored. */
  riskPolicyRepository?: RiskPolicyRepository
  /**
   * The ACCOUNT-tier risk policy library (ADR 0055): postures authored once for a whole account,
   * which every board under it inherits read-only and may clone or hide. Absent ⇒ nothing is
   * inherited and every board's library is exactly its own rows, which is the behaviour before the
   * tier existed.
   */
  accountRiskPolicyRepository?: AccountRiskPolicyRepository
  /**
   * Which inherited account policies a board HIDES. Absent ⇒ a board hides nothing, which offers a
   * posture rather than silently withdrawing one: the direction where a facade mid-migration can
   * only show too much, never resolve a policy its own editor called hidden.
   */
  riskPolicySuppressionRepository?: RiskPolicySuppressionRepository
  /**
   * Optional: persistence for the merge track record (one row per merge decision — change class,
   * merger scores, reviewer-effort tag, outcome — plus the per-class SQL rollups). Absent ⇒ the
   * whole feature is inert: no classification, no records, no rollups, and the merge policy falls
   * back to the score thresholds exactly as before.
   */
  mergeTrackRecordRepository?: MergeTrackRecordRepository
  /** A workspace's shared stacks (long-lived compose infra a consumer environment attaches to). */
  sharedStackRepository?: SharedStackRepository
  /**
   * The host Docker seam a shared stack's bring-up/teardown drives. Wired ONLY on the local
   * facade (host daemon); absent elsewhere ⇒ shared-stack CRUD works but the lifecycle endpoints
   * refuse (the documented compose runtime-binding exception).
   */
  composeRuntime?: ComposeRuntime
  /**
   * The VCS token a shared stack's bring-up clones its repo with (for a private `cloneUrl`). Wired
   * on the local facade from the same source-control PAT the agent containers push with; absent
   * (or answering undefined) ⇒ unauthenticated clone (public repos only). Read per bring-up
   * because the only facade that wires it can have its credential installed while it runs.
   */
  sharedStackCloneToken?: () => string | undefined
  /**
   * The host-bound PREFLIGHT probes (docker daemon / disk / RAM / registry login / reachability /
   * mkcert / hosts / secrets marker). Wired ONLY on the local facade (a host daemon); present ⇒ the
   * preflight module + API are built and a stack recipe's `prerequisites` are enforced at provision
   * start. Absent ⇒ the preflight API 503s and a recipe that declares prerequisites fails loudly.
   */
  preflightHostProbes?: PreflightHostProbes
  // ---- Sandbox (parallel prompt/model testing surface; opt-in) --------------
  // Flat repository fields like every other feature; both runtime facades contribute
  // them by spreading one sandbox-owned `Partial<CoreDependencies>` mixin (the
  // `selectSandboxDeps`/`sandboxDependencies` factory), so neither facade's container
  // body enumerates them. Present (all five) → the `sandbox` module assembles its
  // management CRUD + run-driver; the reviewer-style inline model config
  // (`modelProviderResolver`/`requirementReviewModel`/`requirementReviewResolveModel`)
  // is reused so a cell resolves its model like a pipeline step.
  sandboxPromptVersionRepository?: SandboxPromptVersionRepository
  sandboxFixtureRepository?: SandboxFixtureRepository
  sandboxExperimentRepository?: SandboxExperimentRepository
  sandboxRunRepository?: SandboxRunRepository
  sandboxGradeRepository?: SandboxGradeRepository
  /**
   * Stores a workspace's runtime settings (the human-wait escalation threshold + the
   * per-service running-task limit policy). Optional and default-off: absent → the
   * `settings` module isn't assembled, the limit is never enforced, and the escalation
   * sweep falls back to the built-in default threshold.
   */
  workspaceSettingsRepository?: WorkspaceSettingsRepository
  /**
   * Stores per-user settings (today: the user-tier spend budget). Wired by every
   * persistence-backed facade; absent → the user budget tier is inert (tests/conformance).
   */
  /**
   * Per-user in-app tutorial progress. Optional: a facade that wires none leaves the SPA on its
   * browser-persisted copy, which is exactly the behaviour before this store existed rather than
   * a half-wired feature.
   */
  tutorialProgressRepository?: TutorialProgressRepository
  userSettingsRepository?: UserSettingsRepository
  /**
   * Stores a workspace's model presets (the named model→agent mappings a task picks
   * from; each is a base model applied to every agent kind plus per-kind overrides).
   * Optional and default-off: absent → the `modelPresets` module isn't assembled and
   * the env routing is used everywhere. When wired, an unpinned step resolves to the
   * task's selected/default preset (the built-in default points everything at Kimi K2.7).
   */
  modelPresetRepository?: ModelPresetRepository
  /**
   * Stores each USER's locally-run model endpoints (Ollama / LM Studio / …). The engine reads it
   * for ONE thing: what the run initiator DECLARED about the local models they enabled, which a
   * dispatch folds onto its resolved ref (a local model has no catalog entry to carry the
   * per-flavour facts every other model's ref does). The credential half of the same store (the
   * base URL and sealed bearer key a run-time forward needs) is reached through
   * `LocalModelEndpointService` in the facade instead, which is also where the runner-URL policy
   * lives. Optional: absent → local refs stay undeclared, and a run states that rather than
   * guessing.
   */
  localModelEndpointRepository?: LocalModelEndpointRepository
  /**
   * Stores a workspace's consensus-GROUP library — the reusable, estimate-gated panels a
   * pipeline step escalates to (`ConsensusStepConfig.groupIds`). Optional and default-off:
   * absent → the `consensusGroups` module isn't assembled, the controller 503s, and a
   * consensus step runs with the inline participants authored on it. Read on the RUN path
   * too: `AgentContextBuilder` resolves a step's tier set at dispatch.
   */
  consensusGroupRepository?: ConsensusGroupRepository
  /**
   * Stores a workspace's agent system-prompt overrides — an append-only revision log per agent
   * kind, edited from the pipeline builder, whose live entry REPLACES the kind's shipped
   * system prompt for every run in that workspace. Optional and default-off: absent → the
   * `agentPrompts` module isn't assembled and every kind runs the prompt it ships with.
   */
  agentPromptRepository?: AgentPromptRepository
  /**
   * Stores a workspace's per-agent-kind generation settings — today the output-token ceiling,
   * edited from the pipeline builder beside the prompt overrides. Optional and default-off:
   * absent → the `workspaceAgentSettings` module isn't assembled, the controller 503s, and every
   * kind runs on the deployment routing ceiling. Read on the RUN path too: `AgentContextBuilder`
   * resolves the dispatched kind's ceiling at dispatch.
   */
  workspaceAgentSettingsRepository?: WorkspaceAgentSettingsRepository
  /**
   * Stores which deployment-registered custom task types (REUSABLE OPERATIONS) a workspace HIDES
   * from its create picker (`backend/docs/reusable-operations.md`). Optional and default-off:
   * absent → the `taskTypeSuppressions` module isn't assembled, the controller 503s, and every
   * board offers every registered operation, which is today's behaviour. Read on the CREATION path
   * too: `BoardService` refuses a task of a suppressed type, so no door bypasses the picker.
   */
  taskTypeSuppressionRepository?: TaskTypeSuppressionRepository
  /**
   * The catalog id of the built-in model preset a fresh workspace is seeded with as its
   * DEFAULT: Cloudflare/Node deploy `mdp_kimi` (Cloudflare-runnable on the bare baseline),
   * local deploy `mdp_claude`. Deployment-level, applied only at first seed, so a user's
   * later manual default choice is always preserved. Absent → the catalog default (Kimi).
   */
  defaultModelPresetId?: string
  /**
   * Resolve the provider capabilities (configured direct API keys + subscription
   * vendors + whether Cloudflare AI is enabled) for a workspace and the run initiator.
   * The pipeline-start guard uses it to block a run whose steps' canonical models have
   * no usable provider. Wired by each facade from its API-key + subscription services;
   * absent → the guard is skipped.
   *
   * `modelPresetId` is the preset the caller is resolving under (a block's selected one, absent →
   * the workspace default preset), which is what carries the preset's `providerPreference` onto
   * the capability set — so the guard walks a model's routes in the SAME order the dispatch will.
   */
  resolveProviderCapabilities?: (
    workspaceId: string,
    initiatedBy?: string | null,
    modelPresetId?: string,
  ) => Promise<ProviderCapabilities>
  /**
   * Stores a workspace's default service-fragment selection (the best-practice
   * fragment ids new services inherit). Optional and default-off: absent → the
   * `serviceFragmentDefaults` module isn't assembled, new services start with no
   * service-level fragments, and `code-aware` agents only see the block's own pins.
   */
  serviceFragmentDefaultsRepository?: ServiceFragmentDefaultsRepository

  // ---- Initiatives (optional; wired when the repository is present) ----------
  /**
   * Persistence for initiatives (the long-running multi-task work container).
   * When present the initiatives module assembles: the create/read API, the
   * planning pipeline's plan ingest, and the committer step's tracker mirror.
   * Absent → the module is off and the initiative pipeline steps fail loudly.
   */
  initiativeRepository?: InitiativeRepository

  // ---- Recurring pipelines + issue tracker (optional; wired when configured) -
  // The recurring-pipeline feature (scheduled runs of a pipeline against a
  // service) assembles when `pipelineScheduleRepository` is present. The
  // tracker-settings feature (the workspace's GitHub/Jira selection) assembles
  // when `trackerSettingsRepository` is present. `ticketTrackerProvider` is the
  // write port the tech-debt pipeline's `tracker` step uses to file an issue;
  // absent → that step passes through. All default-off so unconfigured facades and
  // tests are unaffected.
  pipelineScheduleRepository?: PipelineScheduleRepository
  trackerSettingsRepository?: TrackerSettingsRepository
  ticketTrackerProvider?: TicketTrackerProvider
  // Writes back to a task's linked tracker issue(s) as its PR progresses (comment
  // on PR open; comment + close on merge). Absent → no writeback. Gated per
  // workspace + per task inside the provider.
  issueWritebackProvider?: IssueWritebackProvider

  // ---- Local-runtime capability (optional; set by the local facade) ---------
  /**
   * Optional: assert the workspace has a usable container-agent backend before a run
   * starts (local mode delegating agents to an unregistered runner pool throws here).
   * Absent → no start-time check (Cloudflare/Node have a fixed backend).
   */
  assertAgentBackendConfigured?: (workspaceId: string) => Promise<void>
}
