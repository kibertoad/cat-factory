import type {
  BlockRepository,
  DeployCloneTarget,
  ExecutionRepository,
  PipelineRepository,
  ResolveRunRepoContext,
  RunInitiatorScope,
  RunRepoContext,
  WorkspaceMemberRepository,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import { createAppCaches } from '@cat-factory/caching'
import type { AppCaches } from '@cat-factory/kernel'
import { ModuleRegistry } from './container/module-registry.js'
import {
  createServicesModule,
  createGitHubModule,
  createDocumentsModule,
  createTasksModule,
  createEnvironmentsModule,
  createRunnersModule,
  createBootstrapModule,
  createTesterQualityReviewer,
  createDocInterviewService,
  createForkChatService,
  resolveBlockRunContext,
  createRequirementsModule,
  createBrainstormModule,
  createKaizenModule,
  createClarityModule,
  createNotificationsModule,
  createSlackModule,
  createRiskPoliciesModule,
  createSharedStacksModule,
  createPreflightModule,
  createSandboxModule,
  createWorkspaceSettingsModule,
  createReleaseHealthModule,
  createPackageRegistriesModule,
  createPreviewModule,
  createIncidentEnrichmentModule,
  createModelPresetsModule,
  createServiceFragmentDefaultsModule,
  createTrackerModule,
  createRecurringModule,
} from './container/modules.js'
import type { AccountRepository, MembershipRepository } from '@cat-factory/kernel'
import type {
  AccountInvitationRepository,
  EmailConnectionRepository,
  EmailSender,
  PasswordHasher,
  PasswordResetTokenRepository,
  UserRepository,
} from '@cat-factory/kernel'
import type { ServiceRepository, WorkspaceMountRepository } from '@cat-factory/kernel'
import { ServiceMountService } from './modules/services/ServiceMountService.js'
import type { Clock, IdGenerator } from '@cat-factory/kernel'
import type { PreviewTransport } from '@cat-factory/kernel'
import type { AgentExecutor } from '@cat-factory/kernel'
import type { TokenUsageRepository } from '@cat-factory/kernel'
import type { LlmCallMetricRepository } from '@cat-factory/kernel'
import type { PlatformMetricsRepository } from '@cat-factory/kernel'
import type { ProvisioningLogRepository } from '@cat-factory/kernel'
import type { LlmTraceSink } from '@cat-factory/kernel'
import { type WorkRunner, NoopWorkRunner } from '@cat-factory/kernel'
import { type ExecutionEventPublisher, NoopEventPublisher } from '@cat-factory/kernel'
import type { GitHubClient } from '@cat-factory/kernel'
import type { GitHubProvisioningClient } from '@cat-factory/kernel'
import type { WebhookVerifier } from '@cat-factory/kernel'
import type {
  ModelProvider,
  ModelProviderResolver,
  ModelRef,
  ProviderCapabilities,
} from '@cat-factory/kernel'
import type { DocumentContentResolver, DocumentSourceProvider } from '@cat-factory/kernel'
import type { DocumentConnectionRepository, DocumentRepository } from '@cat-factory/kernel'
import type { TaskSourceProvider } from '@cat-factory/kernel'
import type {
  TaskConnectionRepository,
  TaskRepository,
  TaskSourceSettingsRepository,
} from '@cat-factory/kernel'
import type {
  EnvironmentProvider,
  PreflightHostProbes,
  RunnerPoolProvider,
  UrlSafetyPolicy,
} from '@cat-factory/kernel'
import type {
  CustomManifestTypeRepository,
  EnvironmentConnectionRepository,
  EnvironmentRegistryRepository,
  EnvironmentUserHandlerRepository,
} from '@cat-factory/kernel'
import type { RunnerPoolConnectionRepository } from '@cat-factory/kernel'
import type { BootstrapJobRepository, ReferenceArchitectureRepository } from '@cat-factory/kernel'
import type { RepoBootstrapper } from '@cat-factory/kernel'
import type { BootstrapRunner } from '@cat-factory/kernel'
import type {
  EnvConfigRepairJobRepository,
  EnvConfigRepairer,
  EnvConfigRepairRunner,
} from '@cat-factory/kernel'
import type { EnvironmentTestRunRepository, EnvironmentTestRunner } from '@cat-factory/kernel'
import type { RequirementReviewRepository } from '@cat-factory/kernel'
import type { DocInterviewRepository } from '@cat-factory/kernel'
import type { KaizenGradingRepository, KaizenVerifiedComboRepository } from '@cat-factory/kernel'
import type { ClarityReviewRepository } from '@cat-factory/kernel'
import type { BrainstormSessionRepository, BrainstormStage } from '@cat-factory/kernel'
import type { SubscriptionActivationRepository } from '@cat-factory/kernel'
import type {
  SandboxPromptVersionRepository,
  SandboxFixtureRepository,
  SandboxExperimentRepository,
  SandboxRunRepository,
  SandboxGradeRepository,
} from '@cat-factory/kernel'
import type {
  RiskPolicyRepository,
  SharedStackRepository,
  UserSettingsRepository,
  WorkspaceSettingsRepository,
  ModelPresetRepository,
  ServiceFragmentDefaultsRepository,
  NotificationChannel,
  NotificationRepository,
  InitiativeRepository,
  PipelineScheduleRepository,
  PullRequestMerger,
  BranchUpdater,
  ResolveBinaryArtifactStore,
  ObservabilityConnectionRepository,
  IncidentEnrichmentConnectionRepository,
  PackageRegistryConnectionRepository,
  ReleaseHealthConfigRepository,
  TestSecretRef,
  TicketTrackerProvider,
  IssueWritebackProvider,
  TrackerSettingsRepository,
} from '@cat-factory/kernel'
import type {
  SlackConnectionRepository,
  SlackMemberMappingRepository,
  SlackSettingsRepository,
} from '@cat-factory/kernel'
import type { SecretCipher } from '@cat-factory/kernel'
import type { FragmentSourceRepository, PromptFragmentRepository } from '@cat-factory/kernel'
import type { FragmentSelector } from '@cat-factory/kernel'
import type {
  AccountSkillRepository,
  SkillSourceRepository,
  SkillSourceResyncRequest,
} from '@cat-factory/kernel'
import type {
  BranchProjectionRepository,
  CheckRunProjectionRepository,
  CommitProjectionRepository,
  GitHubInstallation,
  GitHubInstallationRepository,
  IssueProjectionRepository,
  PullRequestProjectionRepository,
  RepoProjectionRepository,
  UserRepoAccessRepository,
} from '@cat-factory/kernel'
import { BoardService } from './modules/board/BoardService.js'
import { ExecutionService } from './modules/execution/ExecutionService.js'
import { PipelineService } from './modules/pipelines/PipelineService.js'
import { WorkspaceService } from '@cat-factory/workspaces'
import { WorkspaceMemberService } from '@cat-factory/workspaces'
import { AccountService } from '@cat-factory/workspaces'
import { UserService } from '@cat-factory/workspaces'
import { InvitationService } from '@cat-factory/workspaces'
import { PasswordResetService } from '@cat-factory/workspaces'
import { EmailConnectionService } from '@cat-factory/integrations'
import { SpendService, DEFAULT_SPEND_PRICING, type SpendPricing } from '@cat-factory/spend'
import type { OpenRouterModelMeta } from '@cat-factory/contracts'
import { LlmObservabilityService } from './modules/observability/LlmObservabilityService.js'
import { AgentContextObservabilityService } from './modules/observability/AgentContextObservabilityService.js'
import { SearchQueryObservabilityService } from './modules/observability/SearchQueryObservabilityService.js'
import { PlatformObservabilityService } from './modules/observability/PlatformObservabilityService.js'
import {
  GitHubInstallationService,
  RepoProvisioningService,
  GitHubService,
  GitHubSyncService,
  WebhookService,
  DocumentConnectionService,
  DocumentImportService,
  DocumentPlannerService,
  DocumentLinkService,
  TaskConnectionService,
  TaskImportService,
  TaskLinkService,
  BugIntakeService,
  EnvironmentConnectionService,
  EnvironmentProvisioningService,
  EnvironmentTeardownService,
  EnvironmentUserHandlerService,
  RunnerPoolConnectionService,
  PreflightService,
  ProvisioningLogRecorder,
  ProvisioningLogService,
  SharedStackService,
  SlackConnectionService,
  SlackSettingsService,
  SlackMemberMappingService,
  type ComposeRuntime,
  type CustomManifestTypeRegistry,
  type DeployJobClient,
  type DetectionConventions,
  type EnvironmentBackendRegistry,
  type RunnerBackendRegistry,
  type UserSecretKindRegistry,
} from '@cat-factory/integrations'
import { BootstrapService } from './modules/bootstrap/BootstrapService.js'
import { EnvConfigRepairService } from './modules/envConfigRepair/EnvConfigRepairService.js'
import { EnvironmentTestService } from './modules/environments/EnvironmentTestService.js'
import { BoardScanService } from './modules/boardScan/BoardScanService.js'
import { RequirementReviewService } from './modules/requirements/RequirementReviewService.js'
import { type TesterQualityReviewer } from './modules/execution/TesterQualityReviewService.js'
import { KaizenService } from './modules/kaizen/KaizenService.js'
import { ClarityReviewService } from './modules/clarity/ClarityReviewService.js'
import { BrainstormService } from './modules/brainstorm/BrainstormService.js'
import { NotificationService } from './modules/notifications/NotificationService.js'
import { RiskPolicyService } from './modules/merge/RiskPolicyService.js'
import { SandboxService } from './modules/sandbox/SandboxService.js'
import { SandboxRunService } from './modules/sandbox/SandboxRunService.js'
import { WorkspaceSettingsService } from './modules/settings/WorkspaceSettingsService.js'
import { UserSettingsService } from './modules/settings/UserSettingsService.js'
import { ReleaseHealthService } from './modules/releaseHealth/ReleaseHealthService.js'
import { PackageRegistryService } from './modules/packageRegistries/PackageRegistryService.js'
import { PreviewService, type BuildPreviewJob } from './modules/preview/PreviewService.js'
import { IncidentEnrichmentService } from './modules/incidentEnrichment/IncidentEnrichmentService.js'
import type { AccountSettingsService } from '@cat-factory/integrations'
import {
  ModelPresetService,
  resolvePresetModelForKind,
} from './modules/modelPresets/ModelPresetService.js'
import { ServiceFragmentDefaultsService } from './modules/serviceFragmentDefaults/ServiceFragmentDefaultsService.js'
import { RecurringPipelineService } from './modules/recurring/RecurringPipelineService.js'
import { TrackerSettingsService } from './modules/recurring/TrackerSettingsService.js'
import { InitiativeService } from './modules/initiative/InitiativeService.js'
import { InitiativeLoopService } from './modules/initiative/InitiativeLoopService.js'
import type { InitiativeRunHarvest } from './modules/initiative/initiative.logic.js'
import { InitiativeInterviewService } from './modules/initiative/InitiativeInterviewService.js'
import { BLUEPRINT_PIPELINE_ID } from '@cat-factory/kernel'
import {
  type AgentKindRegistry,
  defaultAgentKindRegistry,
  defaultInitiativePresetRegistry,
  FragmentLibraryService,
  FragmentSourceService,
  type ResolveFragmentInstallationId,
  SkillCatalogService,
  SkillSourceService,
  SkillRunResolver,
  type ResolveSkillInstallationId,
} from '@cat-factory/agents'
import {
  createFragmentLibraryModule,
  createSkillLibraryModule,
} from './container-content-libraries.js'
import type {
  GateRegistry,
  InitiativePresetRegistry,
  StepResolverRegistry,
} from '@cat-factory/kernel'
import { defaultGateRegistry, defaultStepResolverRegistry } from '@cat-factory/kernel'

// Composition root for the domain layer. The worker's infrastructure builds the
// concrete ports (D1 repositories, crypto id/rng, the AI agent executor) and
// hands them here; `createCore` wires the module services together in dependency
// order and returns them. This is the framework-agnostic equivalent of the
// template's per-module DI config, minus the awilix machinery.

export interface CoreDependencies {
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
  /** Base URL the invite-accept link points at (SPA origin). */
  appBaseUrl?: string
  /** Optional structural logger (the facade's pino logger) for best-effort diagnostics. */
  logger?: { info(obj: Record<string, unknown>, msg?: string): void }
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
   * The app-owned step-completion-resolver registry (deployment-registered resolvers).
   * Optional + defaulted to `defaultStepResolverRegistry()` (EMPTY — the built-in `merger`
   * resolver is a privileged engine built-in, not a registry entry). Each facade injects the
   * SAME instance it registers custom resolvers on. Read by the engine's completion hub.
   */
  stepResolverRegistry?: StepResolverRegistry
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
  resolveRepoFilesForCoords?: (
    workspaceId: string,
    coords: { owner: string; repo: string; provider?: 'github' | 'gitlab' },
  ) => Promise<RunRepoContext | null>
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
  documentConnectionRepository?: DocumentConnectionRepository
  documentRepository?: DocumentRepository

  // ---- Task-source integration (optional; wired only when configured) ------
  // A sibling of the document-source integration for external issue trackers
  // (Jira, …). Mirrors the same default-off convention: the tasks module
  // assembles when at least one source provider + both repositories are present.
  // Each provider encapsulates one tracker's specifics behind the
  // TaskSourceProvider port. `taskRepository` is additionally consumed by the
  // execution engine to feed issues linked to a block to agents as context.
  taskSourceProviders?: TaskSourceProvider[]
  taskConnectionRepository?: TaskConnectionRepository
  /** Per-workspace on/off toggle for each task source (absent row ⇒ enabled). */
  taskSourceSettingsRepository?: TaskSourceSettingsRepository
  taskRepository?: TaskRepository

  // ---- Ephemeral environment integration (optional; wired when configured) -
  // Mirrors the GitHub/Confluence default-off convention. The module assembles
  // only when both repositories and the secret cipher are present (the provider is
  // resolved per-workspace from the env-backend registry by the stored `kind`), so
  // the engine (deterministic deployer step + env discovery) stays unchanged when the
  // feature is off. Per-tenant secrets are encrypted via `secretCipher`.
  environmentConnectionRepository?: EnvironmentConnectionRepository
  environmentRegistryRepository?: EnvironmentRegistryRepository
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

  // ---- Prompt-fragment library (opt-in; ADR 0006) -------------------------
  // The managed, tenant-scoped catalog of best-practice fragments. The library
  // (per-tier CRUD + the merged-catalog resolver feeding every agent run)
  // assembles whenever `promptFragmentRepository` is present. Repo-sourced
  // fragments additionally need `fragmentSourceRepository`, the `githubClient`
  // (above) and an installation resolver. `fragmentSelector` is optional within
  // the module: absent → the deterministic matcher; present → the LLM selector.
  /**
   * The app-owned cache bag (docs/initiatives/caching-layer.md). A facade builds
   * it once per process via `createAppCaches` — Node threads in the Redis-backed
   * invalidation notifications in multi-node deployments, the Worker passes the
   * isolate-safe profile. Absent (tests / harnesses) ⇒ `createCore` builds bare
   * in-memory defaults, whose coherence the services' own invalidation calls keep.
   */
  caches?: AppCaches

  promptFragmentRepository?: PromptFragmentRepository
  fragmentSourceRepository?: FragmentSourceRepository
  fragmentSelector?: FragmentSelector
  resolveFragmentInstallationId?: ResolveFragmentInstallationId
  /**
   * Live document reader for **document-backed** fragments (Confluence/Notion/
   * GitHub files linked as living best-practice fragments). Wired by a facade
   * from its document-source registry + connection service; absent → linking a
   * document as a fragment is rejected and run resolution uses cached bodies.
   */
  documentContentResolver?: DocumentContentResolver

  // ---- Repo-sourced Claude Skills library (opt-in; docs/initiatives/repo-skills.md) ----
  // An account's catalog of repo-authored Claude skills. The catalog read assembles
  // whenever `accountSkillRepository` is present; the source sync additionally needs
  // `skillSourceRepository`, the `githubClient` (above) and an installation resolver.
  accountSkillRepository?: AccountSkillRepository
  skillSourceRepository?: SkillSourceRepository
  resolveSkillInstallationId?: ResolveSkillInstallationId
  /**
   * Enqueues a targeted skill-source resync onto the runtime's GitHub-sync queue — the
   * push-webhook freshness fan-out (slice 4). Facade-provided (Worker Queue / Node pg-boss);
   * absent (no queue, or a pure-logic test) ⇒ no proactive resync, and freshness is guaranteed
   * at dispatch by the resolver's head-commit probe instead.
   */
  enqueueSkillResync?: (request: SkillSourceResyncRequest) => Promise<void>

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
  /** Resolves a task's merge threshold preset (auto-merge ceilings + CI attempt budget). */
  riskPolicyRepository?: RiskPolicyRepository
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
   * on the local facade from the same source-control PAT the agent containers push with; absent ⇒
   * unauthenticated clone (public repos only).
   */
  sharedStackCloneToken?: string
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
   */
  resolveProviderCapabilities?: (
    workspaceId: string,
    initiatedBy?: string | null,
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

/** The GitHub integration's services, present only when the app is configured. */
export interface GitHubModule {
  installationService: GitHubInstallationService
  syncService: GitHubSyncService
  webhookService: WebhookService
  service: GitHubService
  webhookVerifier: WebhookVerifier
  /**
   * Direct repo creation (privileged App tier, ADR 0005). Present only when a
   * privileged provisioning client is wired; absent → creation stays manual.
   */
  provisioningService?: RepoProvisioningService
}

/** The document-source integration's services, present only when configured. */
export interface DocumentsModule {
  connectionService: DocumentConnectionService
  importService: DocumentImportService
  plannerService: DocumentPlannerService
  linkService: DocumentLinkService
  /** Live read seam for document-backed prompt fragments (re-resolved at run time). */
  contentResolver: DocumentContentResolver
}

/** The task-source integration's services, present only when configured. */
export interface TasksModule {
  connectionService: TaskConnectionService
  importService: TaskImportService
  linkService: TaskLinkService
  /**
   * The recurring `bug-intake` engine step's read-and-claim helper (present only when a
   * schedule repository is wired). Injected into the execution engine so the `bug-intake`
   * step can pull one matching issue from the schedule's tracker board and claim it.
   */
  bugIntakeService?: BugIntakeService
}

/** The environment integration's services, present only when configured. */
export interface EnvironmentsModule {
  connectionService: EnvironmentConnectionService
  provisioningService: EnvironmentProvisioningService
  teardownService: EnvironmentTeardownService
  /**
   * The per-USER infra handler override store (local mode). Present only when the facade
   * wired `environmentUserHandlerRepository` (the local facade does; Worker/Node don't), so
   * the per-user-override controller 503s and provisioning ignores user overrides elsewhere.
   */
  userHandlerService?: EnvironmentUserHandlerService
  /** The durable env-config-repair service, present only when its deps are wired. */
  envConfigRepair?: EnvConfigRepairModule
  /**
   * The ephemeral-environment self-test service, present only when its run repository +
   * `resolveRunRepoContext` are wired (needs a git provider to create/delete the branch).
   */
  environmentTest?: EnvironmentTestService
}

/** The self-hosted runner-pool integration's services, present only when configured. */
export interface RunnersModule {
  connectionService: RunnerPoolConnectionService
}

/** The provisioning event-log read service, present only when its store is wired. */
export interface ProvisioningLogsModule {
  service: ProvisioningLogService
}

/** The repo-bootstrap feature's service, present only when its repositories exist. */
export interface BootstrapModule {
  service: BootstrapService
}

/** The env-config-repair feature's durable service, present only when its deps are wired. */
interface EnvConfigRepairModule {
  service: EnvConfigRepairService
}

/** The requirements-review feature's service, present only when its repository is wired. */
export interface RequirementsModule {
  service: RequirementReviewService
}

/** The Kaizen feature's service, present only when its repositories are wired. */
export interface KaizenModule {
  service: KaizenService
}

/** The clarity-review feature's service, present only when its repository is wired. */
export interface ClarityModule {
  service: ClarityReviewService
}

/** The brainstorm feature's per-stage services, present only when its repository is wired. */
export interface BrainstormModule {
  services: Record<BrainstormStage, BrainstormService>
}

/** The notifications feature's service, present only when its repository is wired. */
export interface NotificationsModule {
  service: NotificationService
}

/** The post-release-health (Datadog) settings service, present only when wired. */
export interface ReleaseHealthModule {
  service: ReleaseHealthService
}

/** The private package-registry settings service, present only when wired. */
export interface PackageRegistriesModule {
  service: PackageRegistryService
}

/** The browsable-frontend-preview service, present only when a preview transport is wired. */
export interface PreviewModule {
  service: PreviewService
}

/** The incident-enrichment (PagerDuty + incident.io) settings service, present only when wired. */
export interface IncidentEnrichmentModule {
  service: IncidentEnrichmentService
}

/** The per-account deployment-settings service, present only when wired (facade-built). */
interface AccountSettingsModule {
  service: AccountSettingsService
}

/** The Slack integration's services, present only when its repositories are wired. */
export interface SlackModule {
  connectionService: SlackConnectionService
  settingsService: SlackSettingsService
  memberMappingService: SlackMemberMappingService
}

/** The merge-preset feature's service, present only when its repository is wired. */
export interface RiskPoliciesModule {
  service: RiskPolicyService
}

/** The shared-stacks feature's service, present only when its repository is wired. */
export interface SharedStacksModule {
  service: SharedStackService
}

/** The preflight feature's service, present only when the host-probe seam is wired (local facade). */
export interface PreflightsModule {
  service: PreflightService
}

/** The Sandbox feature's services, present only when its repositories are wired. */
export interface SandboxModule {
  /** Management CRUD (prompt versions, fixtures, experiments). */
  service: SandboxService
  /** The run-driver + judge (`launch` an experiment). */
  runService: SandboxRunService
}

/** The workspace-settings feature's service, present only when its repository is wired. */
export interface WorkspaceSettingsModule {
  service: WorkspaceSettingsService
}

/** The per-user-settings feature's service, present only when its repository is wired. */
interface UserSettingsModule {
  service: UserSettingsService
}

/** The model-preset feature's service, present only when its repository is wired. */
export interface ModelPresetsModule {
  service: ModelPresetService
}

/** The default service-fragment feature's service, present only when its repository is wired. */
export interface ServiceFragmentDefaultsModule {
  service: ServiceFragmentDefaultsService
}

/** The recurring-pipeline feature's service, present only when its repository is wired. */
export interface RecurringModule {
  service: RecurringPipelineService
}

/** The initiatives feature's service + execution loop, present only when its repository is wired. */
export interface InitiativesModule {
  service: InitiativeService
  /** The execution loop (slice 3): tick/runDue driven by the cron seams + terminal pokes. */
  loop: InitiativeLoopService
}

/** The issue-tracker-settings feature's service, present only when its repository is wired. */
export interface TrackerModule {
  service: TrackerSettingsService
}

/** The prompt-fragment library's services, present only when configured (ADR 0006). */
export interface FragmentLibraryModule {
  /**
   * Per-tier CRUD + the merged-catalog resolver. The run path consumes it through
   * `resolveBodiesForRun` (wired as the engine's `fragmentResolver`), so an already-
   * selected id — a frame's `serviceFragmentIds` / a block pin — resolves against the
   * merged tenant catalog (managed + document-backed fragments included). Only the
   * automatic per-run relevance selector (`resolveForRun`) is retired from the run path.
   */
  libraryService: FragmentLibraryService
  /** Repo-sourced fragments; present only when the GitHub client + source repo are wired. */
  sourceService?: FragmentSourceService
}

/**
 * The repo-sourced Claude Skills library's services, present only when configured
 * (docs/initiatives/repo-skills.md). Assembles whenever `accountSkillRepository` is wired.
 */
export interface SkillLibraryModule {
  /** The account skill-catalog read (cached), consumed by the management surface + the run path. */
  catalogService: SkillCatalogService
  /** Repo-source sync; present only when the GitHub client + source repo are wired. */
  sourceService?: SkillSourceService
  /**
   * Resolves a `skill` step's picked skill (instructions + resource bodies at the pinned commit)
   * for the execution engine (`skillResolver`). Present only when the source repo + GitHub client
   * are wired (it needs them to fetch resource bodies) — the same prerequisites as the sync
   * service. Absent ⇒ a skill step fails loudly at dispatch.
   */
  runResolver?: SkillRunResolver
}

/**
 * The always-present core services every facade wires — the composition root's SPINE. These
 * are unconditional (no `?`): a `Core` never lacks them. Split out from the optional modules
 * ({@link OptionalCoreModules}) so the two concerns are named separately and the domain
 * container (`createCore`) can assemble the optional set through a {@link ModuleRegistry}
 * while the spine — which carries the genuine circular late-bindings — stays explicit.
 */
export interface CoreSpine {
  workspaceService: WorkspaceService
  accountService: AccountService
  userService: UserService
  boardService: BoardService
  pipelineService: PipelineService
  executionService: ExecutionService
  spendService: SpendService
  /**
   * The app-owned agent-kind registry the engine resolved (the facade's injected instance,
   * else the built-ins-only default). Re-exposed so the HTTP layer's workspace-snapshot
   * projection reads the SAME instance the engine + executors use.
   */
  agentKindRegistry: AgentKindRegistry
  /**
   * The app-owned polling-gate registry the engine resolved (the facade's injected instance,
   * with the built-in `@cat-factory/gates` suite installed, else the empty default). Re-exposed
   * so the facade passes the SAME instance to `validateRegistrations` at boot.
   */
  gateRegistry: GateRegistry
  /**
   * The app-owned initiative-preset registry the engine resolved (the facade's injected instance,
   * else the built-ins-only default). Re-exposed so the HTTP layer's workspace-snapshot descriptors
   * + the preset probe read the SAME instance the initiative services use.
   */
  initiativePresetRegistry: InitiativePresetRegistry
  /**
   * The real-time event publisher the engine pushes transitions through. Exposed so
   * the runtime-neutral LLM proxy can push a compact `llmCall` activity event per
   * model call (live "Model activity", independent of the durable driver). Defaults
   * to {@link NoopEventPublisher}; a facade with a real-time transport injects its own.
   */
  executionEventPublisher: ExecutionEventPublisher
  /**
   * The app-owned cache bag (built by the facade via `createAppCaches`, or a bare in-memory
   * default when a harness passes none). Exposed so the shared controllers can read a cached
   * slice (the `/models` catalog's account-policy read) and invalidate one after a write (the
   * account-settings update drops `accountModelPolicy`). Always present.
   */
  caches: AppCaches
}

/**
 * The OPTIONAL modules the domain container wires only when their prerequisites are configured
 * — every feature that can be absent (its repositories/cipher/provider unwired). Assembled by
 * `createCore` through a {@link ModuleRegistry}: each key is `build`-declared once and emitted
 * in a single place, so a feature is present iff its factory yielded a value. The
 * {@link ModuleRegistry} reads these keys, so keep the two in step.
 */
export interface OptionalCoreModules {
  /**
   * Workspace-RBAC roster + access-mode management (workspace-rbac initiative). Present only
   * when the workspace-member repository is wired (both facades wire it); absent ⇒ the members
   * controller reports 503. Every roster/access-mode write invalidates the `workspaceAccess` cache.
   */
  workspaceMemberService?: WorkspaceMemberService
  /** Present only when the invitation repository is wired (see CoreDependencies). */
  invitations?: InvitationService
  /** Present only when the password-reset token repository is wired. */
  passwordReset?: PasswordResetService
  /** Present only when the email-connection repository + cipher are wired. */
  email?: EmailConnectionService
  /** Present only when the LLM-metric repository is wired (see CoreDependencies). */
  llmObservability?: LlmObservabilityService
  /** Present only when the platform-metrics rollup repository is wired (see CoreDependencies). */
  platformObservability?: PlatformObservabilityService
  /** Present only when the agent-context snapshot repository is wired (see CoreDependencies). */
  agentContextObservability?: AgentContextObservabilityService
  /** Present only when the agent-search-query repository is wired (see CoreDependencies). */
  searchQueryObservability?: SearchQueryObservabilityService
  /** Present only when the GitHub integration is configured (see CoreDependencies). */
  github?: GitHubModule
  /** Present only when the document-source integration is configured (see CoreDependencies). */
  documents?: DocumentsModule
  /** Present only when the task-source integration is configured (see CoreDependencies). */
  tasks?: TasksModule
  /** Present only when the environment integration is configured (see CoreDependencies). */
  environments?: EnvironmentsModule
  /** Present only when the self-hosted runner-pool integration is configured. */
  runners?: RunnersModule
  /** Present only when the provisioning event-log store is wired (see CoreDependencies). */
  provisioningLogs?: ProvisioningLogsModule
  /** Present only when the repo-bootstrap repositories are wired (see CoreDependencies). */
  bootstrap?: BootstrapModule
  /** Present only when the env-config-repair deps are wired (see CoreDependencies). */
  envConfigRepair?: EnvConfigRepairModule
  /** Present only when the requirements-review repository is wired (see CoreDependencies). */
  requirements?: RequirementsModule
  /** Present only when the Kaizen repositories are wired (see CoreDependencies). */
  kaizen?: KaizenModule
  /** Present only when the clarity-review repository is wired (see CoreDependencies). */
  clarity?: ClarityModule
  /** Present only when the brainstorm repository is wired (see CoreDependencies). */
  brainstorm?: BrainstormModule
  /** Present only when the notifications repository is wired (see CoreDependencies). */
  notifications?: NotificationsModule
  /** Present only when the Datadog connection + release-health config repos + cipher are wired. */
  releaseHealth?: ReleaseHealthModule
  /** Present only when the package-registry connection repo + cipher are wired. */
  packageRegistries?: PackageRegistriesModule
  /** Present only when a preview transport + job builder are wired (local/node — see CoreDependencies). */
  preview?: PreviewModule
  /** Present only when the incident-enrichment connection repo + cipher are wired. */
  incidentEnrichmentSettings?: IncidentEnrichmentModule
  /** Present only when the per-account settings service is wired (facade-built). */
  accountSettings?: AccountSettingsModule
  /** Present only when the Slack repositories + cipher are wired (see CoreDependencies). */
  slack?: SlackModule
  /** Present only when the merge-preset repository is wired (see CoreDependencies). */
  riskPolicies?: RiskPoliciesModule
  /** Present only when the shared-stack repository is wired (see CoreDependencies). */
  sharedStacks?: SharedStacksModule
  /** Present only when the host-probe seam is wired (local facade — see CoreDependencies). */
  preflight?: PreflightsModule
  /** Present only when the Sandbox repositories are wired (see CoreDependencies). */
  sandbox?: SandboxModule
  /** Present only when the workspace-settings repository is wired (see CoreDependencies). */
  settings?: WorkspaceSettingsModule
  /** Present only when the per-user-settings repository is wired (see CoreDependencies). */
  userSettings?: UserSettingsModule
  /** Present only when the model-preset repository is wired (see CoreDependencies). */
  modelPresets?: ModelPresetsModule
  /** Present only when the service-fragment-defaults repository is wired (see CoreDependencies). */
  serviceFragmentDefaults?: ServiceFragmentDefaultsModule
  /** Present only when the prompt-fragment library is configured (see CoreDependencies). */
  fragmentLibrary?: FragmentLibraryModule
  /** Present only when the repo-sourced Claude Skills library is configured (see CoreDependencies). */
  skillLibrary?: SkillLibraryModule
  /** Present only when the initiative repository is wired (see CoreDependencies). */
  initiatives?: InitiativesModule
  /** Present only when the recurring-pipeline repository is wired (see CoreDependencies). */
  recurring?: RecurringModule
  /** Present only when the tracker-settings repository is wired (see CoreDependencies). */
  tracker?: TrackerModule
  /** Present only when the service + mount repositories are wired (in-org sharing). */
  services?: ServicesModule
}

/**
 * The assembled domain container: the always-present {@link CoreSpine} plus the
 * conditionally-wired {@link OptionalCoreModules}. Shape-identical to the flat interface it
 * replaced, so every consumer is unchanged.
 */
export interface Core extends CoreSpine, OptionalCoreModules {}

export interface ServicesModule {
  service: ServiceMountService
}

/** Assemble the in-org service-sharing module when its repositories are wired. */

export function createCore(dependencies: CoreDependencies): Core {
  // Resolve the app-owned agent-kind registry ONCE: the facade's injected instance (so a
  // deployment's custom kinds are visible) else a fresh built-ins-only registry. The SAME
  // instance is threaded into the engine and re-exposed on `Core` for the HTTP snapshot.
  const agentKindRegistry = dependencies.agentKindRegistry ?? defaultAgentKindRegistry()
  // Resolve the app-owned gate + step-resolver registries ONCE (same reasoning): the facade's
  // injected instances (so the built-in gates + a deployment's custom gates/resolvers are
  // visible), else fresh empty registries so gate steps pass through in bare test builds.
  const gateRegistry = dependencies.gateRegistry ?? defaultGateRegistry()
  const stepResolverRegistry = dependencies.stepResolverRegistry ?? defaultStepResolverRegistry()
  // Resolve the app-owned initiative-preset registry ONCE (same reasoning as the agent-kind one):
  // the facade's injected instance, else a fresh registry preloaded with the built-in presets.
  const initiativePresetRegistry =
    dependencies.initiativePresetRegistry ?? defaultInitiativePresetRegistry()
  const workRunner = dependencies.workRunner ?? new NoopWorkRunner()
  const executionEventPublisher = dependencies.executionEventPublisher ?? new NoopEventPublisher()
  // The cache bag the caching-initiative slices read through. A facade passes its own
  // (Redis-notified on multi-node Node, isolate-safe on the Worker); tests and harnesses
  // fall back to bare in-memory loaders, so the cached path — including the services'
  // write-site invalidation — is exercised everywhere. Built here (before the services that
  // invalidate through it) so it can be threaded into all of them.
  const caches = dependencies.caches ?? createAppCaches()
  // The optional-module registry: every feature that is wired only when its prerequisites are
  // configured is `build`-declared through this, instead of a scattered `const x = createX(...)`
  // + a matching `...(x ? { x } : {})` return spread. Registration order below IS dependency
  // order: `build` returns the value, so a module consumed downstream is kept in a local and
  // threaded into the later factories that need it (`modules.get(...)` is there for a reader that
  // holds no local). The whole set is emitted in one place via `...modules.assemble()` at the
  // return. The core spine (below) stays explicit —
  // it carries the genuine circular late-bindings (account ⇄ spend, engine ⇄ initiative loop).
  const modules = new ModuleRegistry()
  // Pass the resolved publisher so board mutations push a coarse `boardChanged` to every
  // user on the workspace (and every board mounting a shared service) — both facades route
  // here, so the wiring is symmetric by construction. The repo-projection cache lets
  // `addServiceFromRepo`'s monorepo-flag write invalidate the same group the resolver reads.
  const boardService = new BoardService({
    ...dependencies,
    executionEventPublisher,
    repoProjectionCache: caches.repoProjection,
  })
  const workspaceService = new WorkspaceService({
    ...dependencies,
    // A board delete drops its cached access decisions (workspace-rbac).
    workspaceAccessCache: caches.workspaceAccess,
  })
  // Workspace-RBAC roster + access-mode management (workspace-rbac, slice 5). Present only when
  // the member repository is wired (both facades wire it; tests/no-roster leave it absent, so the
  // members controller 503s). Every roster/access-mode write drops the board's access cache group.
  modules.build('workspaceMemberService', () =>
    dependencies.workspaceMemberRepository
      ? new WorkspaceMemberService({
          workspaceMemberRepository: dependencies.workspaceMemberRepository,
          workspaceRepository: dependencies.workspaceRepository,
          membershipRepository: dependencies.membershipRepository,
          userRepository: dependencies.userRepository,
          clock: dependencies.clock,
          workspaceAccessCache: caches.workspaceAccess,
        })
      : undefined,
  )
  // Late-bound so the account service can invalidate the spend service's cached
  // account-budget limit on an account-budget edit (spendService is built below).
  let spendServiceRef: SpendService | undefined
  const accountService = new AccountService({
    accountRepository: dependencies.accountRepository,
    membershipRepository: dependencies.membershipRepository,
    userRepository: dependencies.userRepository,
    idGenerator: dependencies.idGenerator,
    clock: dependencies.clock,
    onAccountBudgetChanged: (accountId) => spendServiceRef?.invalidateAccountLimit(accountId),
    // A membership grant/role change alters board access across the account, so drop the
    // workspace-access cache wholesale (workspace-rbac — the coarse fallback for a rare write).
    onAccountMembershipChanged: () => caches.workspaceAccess.invalidateAll(),
    // Reject an account budget above the operator cap on write (late-bound: spendService
    // is built below, and the cap is a static deployment fact once it is).
    resolveAccountBudgetCap: () => spendServiceRef?.budgetCaps().accountMonthlyLimitMax,
  })
  const userService = new UserService({
    userRepository: dependencies.userRepository,
    passwordHasher: dependencies.passwordHasher,
    idGenerator: dependencies.idGenerator,
    clock: dependencies.clock,
  })
  const email = modules.build('email', () =>
    dependencies.emailConnectionRepository && dependencies.emailSecretCipher
      ? new EmailConnectionService({
          emailConnectionRepository: dependencies.emailConnectionRepository,
          secretCipher: dependencies.emailSecretCipher,
          clock: dependencies.clock,
        })
      : undefined,
  )
  modules.build('invitations', () =>
    dependencies.invitationRepository
      ? new InvitationService({
          invitationRepository: dependencies.invitationRepository,
          accountRepository: dependencies.accountRepository,
          membershipRepository: dependencies.membershipRepository,
          idGenerator: dependencies.idGenerator,
          clock: dependencies.clock,
          // Resolve the inviting account's own (DB-stored) email sender at send time.
          resolveEmailSender: email ? (accountId) => email.resolveSender(accountId) : undefined,
          appBaseUrl: dependencies.appBaseUrl,
          // Accepting an invitation grants membership ⇒ drop the workspace-access cache (workspace-rbac).
          onAccountMembershipChanged: () => caches.workspaceAccess.invalidateAll(),
        })
      : undefined,
  )
  modules.build('passwordReset', () =>
    dependencies.passwordResetTokenRepository
      ? new PasswordResetService({
          passwordResetTokenRepository: dependencies.passwordResetTokenRepository,
          userRepository: dependencies.userRepository,
          passwordHasher: dependencies.passwordHasher,
          idGenerator: dependencies.idGenerator,
          clock: dependencies.clock,
          resolveSystemEmailSender: dependencies.resolveSystemEmailSender,
          appBaseUrl: dependencies.appBaseUrl,
          logger: dependencies.logger,
        })
      : undefined,
  )
  const pipelineService = new PipelineService(dependencies)
  const spendService = new SpendService({
    tokenUsageRepository: dependencies.tokenUsageRepository,
    idGenerator: dependencies.idGenerator,
    clock: dependencies.clock,
    pricing: dependencies.spendPricing ?? DEFAULT_SPEND_PRICING,
    workspaceSettingsRepository: dependencies.workspaceSettingsRepository,
    accountRepository: dependencies.accountRepository,
    userSettingsRepository: dependencies.userSettingsRepository,
    dynamicPricesFor: dependencies.dynamicModelPricesFor,
    // The pricing overlay reads the workspace-settings row through the shared slice
    // (invalidated by WorkspaceSettingsService.update); the two budget-limit slices are
    // invalidated by the account/user budget-change callbacks below.
    workspaceSettingsCache: caches.workspaceSettings,
    accountBudgetLimitCache: caches.accountBudgetLimit,
    userBudgetLimitCache: caches.userBudgetLimit,
  })
  spendServiceRef = spendService
  modules.build('userSettings', () =>
    dependencies.userSettingsRepository
      ? {
          service: new UserSettingsService({
            userSettingsRepository: dependencies.userSettingsRepository,
            onUserBudgetChanged: (userId) => spendService.invalidateUserLimit(userId),
            // Reject a user budget above the operator cap on write.
            resolveUserBudgetCap: () => spendService.budgetCaps().userMonthlyLimitMax,
          }),
        }
      : undefined,
  )
  const llmObservability = modules.build('llmObservability', () =>
    dependencies.llmCallMetricRepository
      ? new LlmObservabilityService({
          llmCallMetricRepository: dependencies.llmCallMetricRepository,
          idGenerator: dependencies.idGenerator,
          clock: dependencies.clock,
          recordPrompts: dependencies.recordLlmPrompts ?? true,
          traceSink: dependencies.llmTraceSink,
          workspaceSettingsRepository: dependencies.workspaceSettingsRepository,
          workspaceSettingsCache: caches.workspaceSettings,
        })
      : undefined,
  )
  modules.build('platformObservability', () =>
    dependencies.platformMetricsRepository
      ? new PlatformObservabilityService({
          platformMetricsRepository: dependencies.platformMetricsRepository,
          clock: dependencies.clock,
        })
      : undefined,
  )
  // The provisioning event log lives in a separate high-churn store. When its
  // repository is wired, build a best-effort recorder (threaded into the env
  // services) + the read service (exposed for the logs controller). The container
  // transports are wrapped with their own recorder in each facade's resolveTransport.
  const provisioningLogRecorder = dependencies.provisioningLogRepository
    ? new ProvisioningLogRecorder({
        repository: dependencies.provisioningLogRepository,
        idGenerator: dependencies.idGenerator,
        clock: dependencies.clock,
      })
    : undefined
  modules.build('provisioningLogs', () =>
    dependencies.provisioningLogRepository
      ? {
          service: new ProvisioningLogService({
            repository: dependencies.provisioningLogRepository,
          }),
        }
      : undefined,
  )
  // Built before the shared-stacks + environments modules so a compose stack recipe's
  // `prerequisites` (and a shared stack's own prerequisites) are re-run at provision / bring-up
  // start through this service. The host probes exist only on the local facade; absent ⇒ a recipe /
  // stack that declares prerequisites fails loudly (the preflight API 503s too).
  const preflight = modules.build('preflight', () => createPreflightModule(dependencies))
  // Built before the environments module so a compose stack recipe's `sharedStackRefs` can be
  // brought up (provider-before-consumer) through this service during provisioning. Persistence is
  // runtime-symmetric (present on every facade); the lifecycle only runs where a host daemon is
  // wired (`composeRuntime` — the local facade), else `ensureRefsUp` returns a clean error. It gets
  // the preflight service so a shared stack re-checks its own machine prerequisites at bring-up.
  const sharedStacks = modules.build('sharedStacks', () =>
    createSharedStacksModule(dependencies, preflight?.service),
  )
  const environments = modules.build('environments', () =>
    createEnvironmentsModule(
      dependencies,
      provisioningLogRecorder,
      executionEventPublisher,
      sharedStacks?.service,
      preflight?.service,
    ),
  )
  // Built before the fragment library so a document-backed fragment can re-resolve
  // its linked Confluence/Notion/GitHub page through the document module's reader.
  const documents = modules.build('documents', () =>
    createDocumentsModule(dependencies, boardService),
  )
  const fragmentLibrary = modules.build('fragmentLibrary', () =>
    createFragmentLibraryModule(dependencies, documents?.contentResolver, caches),
  )
  const skillLibrary = modules.build('skillLibrary', () =>
    createSkillLibraryModule(dependencies, caches),
  )

  // Reconciles a `blueprints` step's decomposition onto the board. Needs only the
  // board service + block repository (both always present), so it is wired
  // unconditionally — there is no standalone scan command or persisted blueprint store.
  const blueprintReconciler = new BoardScanService({
    boardService,
    blockRepository: dependencies.blockRepository,
  })
  // Built before the execution engine so it can raise merge-review / CI-failed /
  // pipeline-complete notifications during a run (when the module is configured).
  const notifications = modules.build('notifications', () =>
    createNotificationsModule(dependencies),
  )
  modules.build('slack', () => createSlackModule(dependencies))
  modules.build('riskPolicies', () => createRiskPoliciesModule(dependencies, caches))
  modules.build('sandbox', () => createSandboxModule(dependencies, agentKindRegistry))
  // Built before the execution engine so the per-service running-task limit can be
  // enforced at start() (and the escalation sweep can read the waiting threshold).
  const settings = modules.build('settings', () =>
    createWorkspaceSettingsModule(dependencies, caches.workspaceSettings),
  )
  modules.build('releaseHealth', () => createReleaseHealthModule(dependencies))
  modules.build('packageRegistries', () => createPackageRegistriesModule(dependencies))
  modules.build('preview', () => createPreviewModule(dependencies))
  modules.build('incidentEnrichmentSettings', () => createIncidentEnrichmentModule(dependencies))
  modules.build('modelPresets', () => createModelPresetsModule(dependencies))
  modules.build('serviceFragmentDefaults', () => createServiceFragmentDefaultsModule(dependencies))
  // Built before the execution engine so the planning pipeline's plan ingest + the
  // committer step's tracker mirror can run through it.
  const initiativeService = dependencies.initiativeRepository
    ? new InitiativeService({
        workspaceRepository: dependencies.workspaceRepository,
        blockRepository: dependencies.blockRepository,
        initiativeRepository: dependencies.initiativeRepository,
        initiativePresetRegistry,
        events: executionEventPublisher,
        clock: dependencies.clock,
        idGenerator: dependencies.idGenerator,
        // Validate the plan's pipeline ids at ingest (fail a plan that names a missing pipeline
        // loudly during planning, rather than surfacing it as a per-item spawn deviation later).
        pipelineRepository: dependencies.pipelineRepository,
      })
    : undefined
  // The interactive-planning interviewer's inline LLM (slice 2). Resolves its model exactly
  // like the requirements reviewer — the routing default, honouring a block pin and the
  // workspace's model preset for the `initiative-interviewer` kind — so it needs no dedicated
  // facade wiring. `enabled` gates it: with no model provider the interviewer gate passes
  // through and planning runs off the raw block description.
  const initiativeInterviewService = new InitiativeInterviewService({
    initiativePresetRegistry,
    modelProviderResolver: dependencies.modelProviderResolver,
    modelProvider: dependencies.modelProvider,
    modelRef: dependencies.requirementReviewModel ?? dependencies.documentPlannerModel,
    resolveBlockModel: dependencies.requirementReviewResolveModel,
    ...(dependencies.inlineHarnessRef ? { runsInline: dependencies.inlineHarnessRef } : {}),
    resolveWorkspaceModelDefault: dependencies.modelPresetRepository
      ? (workspaceId, agentKind, modelPresetId) =>
          resolvePresetModelForKind(
            dependencies.modelPresetRepository!,
            workspaceId,
            agentKind,
            modelPresetId,
          )
      : undefined,
    resolveRunContext: resolveBlockRunContext(dependencies),
  })
  // Built before the execution engine so the special `requirements-review` gate step can
  // drive the inline reviewer + the iterative answer → incorporate → re-review loop.
  const requirements = modules.build('requirements', () =>
    createRequirementsModule(dependencies, notifications?.service, fragmentLibrary),
  )
  const docInterview = createDocInterviewService(dependencies)
  const forkChat = createForkChatService(dependencies)
  const clarity = modules.build('clarity', () =>
    createClarityModule(dependencies, notifications?.service),
  )
  const brainstorm = modules.build('brainstorm', () =>
    createBrainstormModule(dependencies, notifications?.service),
  )
  // Built before the execution engine so the engine's terminal hook can schedule a
  // post-run Kaizen grading for each completed agent step.
  const kaizen = modules.build('kaizen', () => createKaizenModule(dependencies))

  // Late-bound so the engine's terminal hooks can poke the execution loop, which is built AFTER
  // the engine (the loop depends on `executionService.start`). Fire-and-forget; a null ref (the
  // loop unwired, or the settled block not part of an initiative) is a no-op.
  let initiativeLoopRef: InitiativeLoopService | undefined
  const pokeInitiativeLoop = (
    workspaceId: string,
    initiativeBlockId: string,
    harvest?: InitiativeRunHarvest,
  ): void => {
    void initiativeLoopRef?.pokeForInitiativeBlock(workspaceId, initiativeBlockId, harvest)
  }

  // Built before the execution engine so the engine's `bug-intake` step can drive the
  // read-and-claim intake helper (`tasks.bugIntakeService`). Also feeds the recurring module's
  // schedule intake-config validation below.
  const tasks = modules.build('tasks', () => createTasksModule(dependencies, boardService))

  const executionService = new ExecutionService({
    ...dependencies,
    agentKindRegistry,
    gateRegistry,
    stepResolverRegistry,
    initiativePresetRegistry,
    workRunner,
    executionEventPublisher,
    boardService,
    pokeInitiativeLoop,
    bugIntakeService: tasks?.bugIntakeService,
    spendService,
    // Read-through slice for `resolveRiskPolicy` (the merge preset re-read on every gate
    // evaluation); `RiskPolicyService` invalidates it on every preset write.
    riskPolicyCache: caches.riskPolicy,
    // Route runtime fragment-id resolution through the merged tenant catalog (so
    // managed + document-backed fragments reach a run), present only when the
    // library is configured; otherwise the engine falls back to the static pool.
    fragmentResolver: fragmentLibrary?.libraryService,
    // Route a `skill` step's skill resolution (instructions + resource bodies at the pinned
    // commit) through the skill library, present only when it's configured; a skill step
    // dispatched without it fails loudly rather than running blank.
    skillResolver: skillLibrary?.runResolver,
    // Canonicalise a URL pasted into a block description to the document's stable
    // (source, externalId) via the providers' parseRef, so a Figma/Notion/etc. link
    // auto-matches its imported page even with a title segment or tracking params the
    // stored canonical url omits. Absent providers → undefined (url-string match only).
    documentUrlResolver: dependencies.documentSourceProviders?.length
      ? (url: string) => {
          for (const provider of dependencies.documentSourceProviders!) {
            const externalId = provider.parseRef(url)
            if (externalId) return { source: provider.kind, externalId }
          }
          return null
        }
      : undefined,
    requirementReviewService: requirements?.service,
    docInterviewService: docInterview,
    forkChatService: forkChat,
    // The test quality-control companion's inline reviewer, resolved like every other inline
    // review (block pin → workspace preset → routing default). Built only when a model
    // provider is available; absent → the Tester gate's QC step is a pass-through.
    testerQualityReviewer:
      dependencies.testerQualityReviewer ?? createTesterQualityReviewer(dependencies),
    clarityReviewService: clarity?.service,
    brainstormServices: brainstorm?.services,
    kaizenScheduler: kaizen?.service,
    environmentProvisioning: environments?.provisioningService,
    resolveTestSecretRefs: dependencies.resolveTestSecretRefs,
    environmentTeardown: environments?.teardownService,
    branchUpdater: dependencies.branchUpdater,
    blueprintReconciler,
    initiativeService,
    initiativeRepository: dependencies.initiativeRepository,
    initiativeInterviewService,
    notificationService: notifications?.service,
    workspaceSettingsService: settings?.service,
    llmObservability,
    ticketTrackerProvider: dependencies.ticketTrackerProvider,
    issueWriteback: dependencies.issueWritebackProvider,
    // Let the personal-credential gate + start guard resolve the model the same way
    // dispatch does, so a run whose block has no pin but resolves (via its preset) to an
    // individual-usage model is still gated up-front. Reuses the model-preset repository.
    resolveWorkspaceModelDefault: dependencies.modelPresetRepository
      ? (workspaceId, agentKind, modelPresetId) =>
          resolvePresetModelForKind(
            dependencies.modelPresetRepository!,
            workspaceId,
            agentKind,
            modelPresetId,
          )
      : undefined,
  })

  modules.build('github', () => createGitHubModule(dependencies, caches))
  modules.build('runners', () => createRunnersModule(dependencies))
  // After a bootstrap succeeds, map the new repo into a blueprint + the board by
  // starting the blueprint-only pipeline against the service frame.
  modules.build('bootstrap', () =>
    createBootstrapModule(dependencies, executionEventPublisher, (ws, blockId) =>
      executionService.start(ws, blockId, BLUEPRINT_PIPELINE_ID).then(() => undefined),
    ),
  )
  modules.build('tracker', () => createTrackerModule(dependencies))
  modules.build('recurring', () =>
    createRecurringModule(
      dependencies,
      executionService,
      executionEventPublisher,
      tasks?.connectionService,
    ),
  )
  // The env-config-repair module is a sub-module of `environments` — surfaced as its own top-level
  // `Core.envConfigRepair` key. Registered here (not in the `environments` build above) so it emits
  // through the same registry rather than a bespoke return spread.
  modules.build('envConfigRepair', () => environments?.envConfigRepair)
  // Observability + per-account settings that a facade builds and passes through on the deps bag.
  modules.build('agentContextObservability', () => dependencies.agentContextObservability)
  modules.build('searchQueryObservability', () => dependencies.searchQueryObservability)
  modules.build('accountSettings', () =>
    dependencies.accountSettings ? { service: dependencies.accountSettings } : undefined,
  )
  // The initiative EXECUTION LOOP (slice 3): built after the engine (it drives
  // `executionService.start` to spawn tasks), then late-bound into the terminal poke above so a
  // settling child run advances its owning initiative immediately. Present only when initiatives
  // are wired; the cron/interval sweepers call `loop.runDue`.
  const initiativeLoop =
    initiativeService && dependencies.initiativeRepository
      ? new InitiativeLoopService({
          initiativeRepository: dependencies.initiativeRepository,
          initiativeService,
          blockRepository: dependencies.blockRepository,
          pipelineRepository: dependencies.pipelineRepository,
          executionService,
          events: executionEventPublisher,
          clock: dependencies.clock,
          idGenerator: dependencies.idGenerator,
          notificationService: notifications?.service,
          resolveRunRepoContext: dependencies.resolveRunRepoContext,
          serviceRepository: dependencies.serviceRepository,
        })
      : undefined
  initiativeLoopRef = initiativeLoop
  modules.build('initiatives', () =>
    initiativeService && initiativeLoop
      ? { service: initiativeService, loop: initiativeLoop }
      : undefined,
  )
  modules.build('services', () => createServicesModule(dependencies))

  // The always-present spine, plus every optional module the registry assembled in ONE place
  // (unwired keys absent) — replacing the ~40 hand-written `...(x ? { x } : {})` return spreads.
  return {
    caches,
    workspaceService,
    accountService,
    userService,
    boardService,
    pipelineService,
    executionService,
    spendService,
    agentKindRegistry,
    gateRegistry,
    initiativePresetRegistry,
    executionEventPublisher,
    ...modules.assemble(),
  }
}
