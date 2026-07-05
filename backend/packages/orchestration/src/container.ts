import type {
  Block,
  BlockRepository,
  DeployCloneTarget,
  ExecutionRepository,
  PipelineRepository,
  ResolveRunRepoContext,
  RunInitiatorScope,
  RunRepoContext,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import { createAppCaches } from '@cat-factory/caching'
import type { AppCaches } from '@cat-factory/kernel'
import { getFragment } from '@cat-factory/prompt-fragments'
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
import type { EnvironmentProvider, RunnerPoolProvider, UrlSafetyPolicy } from '@cat-factory/kernel'
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
  MergePresetRepository,
  SharedStackRepository,
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
import { AccountService } from '@cat-factory/workspaces'
import { UserService } from '@cat-factory/workspaces'
import { InvitationService } from '@cat-factory/workspaces'
import { PasswordResetService } from '@cat-factory/workspaces'
import { EmailConnectionService } from '@cat-factory/integrations'
import { SpendService, DEFAULT_SPEND_PRICING, type SpendPricing } from '@cat-factory/spend'
import type { OpenRouterModelMeta } from '@cat-factory/contracts'
import { LlmObservabilityService } from './modules/observability/LlmObservabilityService.js'
import { AgentContextObservabilityService } from './modules/observability/AgentContextObservabilityService.js'
import {
  GitHubInstallationService,
  RepoProvisioningService,
  GitHubService,
  GitHubSyncService,
  WebhookService,
  DocumentConnectionService,
  DocumentContentResolverService,
  DocumentImportService,
  DocumentPlannerService,
  DocumentLinkService,
  MapDocumentSourceRegistry,
  TaskConnectionService,
  TaskImportService,
  TaskLinkService,
  BugIntakeService,
  MapTaskSourceRegistry,
  EnvironmentConnectionService,
  EnvironmentProvisioningService,
  EnvironmentTeardownService,
  EnvironmentUserHandlerService,
  RunnerPoolConnectionService,
  ProvisioningLogRecorder,
  ProvisioningLogService,
  SharedStackService,
  SlackConnectionService,
  SlackSettingsService,
  SlackMemberMappingService,
  defaultEnvironmentBackendRegistry,
  defaultRunnerBackendRegistry,
  type ComposeRuntime,
  type CustomManifestTypeRegistry,
  type DeployJobClient,
  type EnvironmentBackendRegistry,
  type RunnerBackendRegistry,
  type UserSecretKindRegistry,
} from '@cat-factory/integrations'
import { BootstrapService } from './modules/bootstrap/BootstrapService.js'
import { EnvConfigRepairService } from './modules/envConfigRepair/EnvConfigRepairService.js'
import { BoardScanService } from './modules/boardScan/BoardScanService.js'
import { RequirementReviewService } from './modules/requirements/RequirementReviewService.js'
import { DocInterviewService } from './modules/docInterview/DocInterviewService.js'
import {
  TesterQualityReviewService,
  type TesterQualityReviewer,
} from './modules/execution/TesterQualityReviewService.js'
import { KaizenService } from './modules/kaizen/KaizenService.js'
import { ClarityReviewService } from './modules/clarity/ClarityReviewService.js'
import { BrainstormService } from './modules/brainstorm/BrainstormService.js'
import { NotificationService } from './modules/notifications/NotificationService.js'
import { MergePresetService } from './modules/merge/MergePresetService.js'
import { SandboxService } from './modules/sandbox/SandboxService.js'
import { SandboxRunService } from './modules/sandbox/SandboxRunService.js'
import { WorkspaceSettingsService } from './modules/settings/WorkspaceSettingsService.js'
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
  FragmentLibraryService,
  FragmentSourceService,
  type ResolveFragmentInstallationId,
} from '@cat-factory/agents'

// Composition root for the domain layer. The worker's infrastructure builds the
// concrete ports (D1 repositories, crypto id/rng, the AI agent executor) and
// hands them here; `createCore` wires the module services together in dependency
// order and returns them. This is the framework-agnostic equivalent of the
// template's per-module DI config, minus the awilix machinery.

export interface CoreDependencies {
  workspaceRepository: WorkspaceRepository
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
  mergePresetRepository?: MergePresetRepository
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
   * Stores a workspace's model presets (the named model→agent mappings a task picks
   * from; each is a base model applied to every agent kind plus per-kind overrides).
   * Optional and default-off: absent → the `modelPresets` module isn't assembled and
   * the env routing is used everywhere. When wired, an unpinned step resolves to the
   * task's selected/default preset (the built-in default points everything at Kimi K2.7).
   */
  modelPresetRepository?: ModelPresetRepository
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
   * Whether the deployment's container runtime can run the Tester's LOCAL
   * docker-compose infra via Docker-in-Docker. Defaults to `true` (Cloudflare, Node,
   * tests). The local facade sets it from the selected runtime — `false` for Apple
   * `container` (one VM per container, no nesting) — so the engine refuses a
   * local-infra Tester run there ("limited mode") instead of dispatching a job that
   * can't stand its dependencies up.
   */
  localTestInfraSupported?: boolean
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
export interface EnvConfigRepairModule {
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
export interface AccountSettingsModule {
  service: AccountSettingsService
}

/** The Slack integration's services, present only when its repositories are wired. */
export interface SlackModule {
  connectionService: SlackConnectionService
  settingsService: SlackSettingsService
  memberMappingService: SlackMemberMappingService
}

/** The merge-preset feature's service, present only when its repository is wired. */
export interface MergePresetsModule {
  service: MergePresetService
}

/** The shared-stacks feature's service, present only when its repository is wired. */
export interface SharedStacksModule {
  service: SharedStackService
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

export interface Core {
  workspaceService: WorkspaceService
  accountService: AccountService
  userService: UserService
  /** Present only when the invitation repository is wired (see CoreDependencies). */
  invitations?: InvitationService
  /** Present only when the password-reset token repository is wired. */
  passwordReset?: PasswordResetService
  /** Present only when the email-connection repository + cipher are wired. */
  email?: EmailConnectionService
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
   * The real-time event publisher the engine pushes transitions through. Exposed so
   * the runtime-neutral LLM proxy can push a compact `llmCall` activity event per
   * model call (live "Model activity", independent of the durable driver). Defaults
   * to {@link NoopEventPublisher}; a facade with a real-time transport injects its own.
   */
  executionEventPublisher: ExecutionEventPublisher
  /** Present only when the LLM-metric repository is wired (see CoreDependencies). */
  llmObservability?: LlmObservabilityService
  /** Present only when the agent-context snapshot repository is wired (see CoreDependencies). */
  agentContextObservability?: AgentContextObservabilityService
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
  mergePresets?: MergePresetsModule
  /** Present only when the shared-stack repository is wired (see CoreDependencies). */
  sharedStacks?: SharedStacksModule
  /** Present only when the Sandbox repositories are wired (see CoreDependencies). */
  sandbox?: SandboxModule
  /** Present only when the workspace-settings repository is wired (see CoreDependencies). */
  settings?: WorkspaceSettingsModule
  /** Present only when the model-preset repository is wired (see CoreDependencies). */
  modelPresets?: ModelPresetsModule
  /** Present only when the service-fragment-defaults repository is wired (see CoreDependencies). */
  serviceFragmentDefaults?: ServiceFragmentDefaultsModule
  /** Present only when the prompt-fragment library is configured (see CoreDependencies). */
  fragmentLibrary?: FragmentLibraryModule
  /** Present only when the initiative repository is wired (see CoreDependencies). */
  initiatives?: InitiativesModule
  /** Present only when the recurring-pipeline repository is wired (see CoreDependencies). */
  recurring?: RecurringModule
  /** Present only when the tracker-settings repository is wired (see CoreDependencies). */
  tracker?: TrackerModule
  /** Present only when the service + mount repositories are wired (in-org sharing). */
  services?: ServicesModule
}

export interface ServicesModule {
  service: ServiceMountService
}

/** Assemble the in-org service-sharing module when its repositories are wired. */
function createServicesModule(deps: CoreDependencies): ServicesModule | undefined {
  const { serviceRepository, workspaceMountRepository } = deps
  if (!serviceRepository || !workspaceMountRepository) return undefined
  const service = new ServiceMountService({
    serviceRepository,
    workspaceMountRepository,
    workspaceRepository: deps.workspaceRepository,
    idGenerator: deps.idGenerator,
    clock: deps.clock,
  })
  return { service }
}

/**
 * Assemble the GitHub module when every dependency it needs is present;
 * otherwise return undefined so the feature stays cleanly opt-in.
 */
function createGitHubModule(deps: CoreDependencies, caches: AppCaches): GitHubModule | undefined {
  const {
    githubClient,
    githubInstallationRepository,
    repoProjectionRepository,
    branchProjectionRepository,
    pullRequestProjectionRepository,
    issueProjectionRepository,
    commitProjectionRepository,
    checkRunProjectionRepository,
    webhookVerifier,
  } = deps
  if (
    !githubClient ||
    !githubInstallationRepository ||
    !repoProjectionRepository ||
    !branchProjectionRepository ||
    !pullRequestProjectionRepository ||
    !issueProjectionRepository ||
    !commitProjectionRepository ||
    !checkRunProjectionRepository ||
    !webhookVerifier
  ) {
    return undefined
  }

  const installationService = new GitHubInstallationService({
    githubClient,
    githubInstallationRepository,
    workspaceRepository: deps.workspaceRepository,
    clock: deps.clock,
    canCreateRepos: deps.canCreateRepos,
    workflowsGranted: deps.workflowsGranted,
  })
  const syncService = new GitHubSyncService({
    githubClient,
    githubInstallationRepository,
    repoProjectionRepository,
    branchProjectionRepository,
    pullRequestProjectionRepository,
    issueProjectionRepository,
    commitProjectionRepository,
    checkRunProjectionRepository,
    userRepoAccessRepository: deps.userRepoAccessRepository,
    clock: deps.clock,
    commitBackfillHorizonMs: deps.commitBackfillHorizonMs,
    // Drop a workspace's cached repo projection (slice 3) after any link/sync write.
    repoProjectionCache: caches.repoProjection,
  })
  const webhookService = new WebhookService({
    githubInstallationRepository,
    repoProjectionRepository,
    branchProjectionRepository,
    pullRequestProjectionRepository,
    issueProjectionRepository,
    commitProjectionRepository,
    checkRunProjectionRepository,
    clock: deps.clock,
    repoProjectionCache: caches.repoProjection,
  })
  const service = new GitHubService({
    githubClient,
    repoProjectionRepository,
    branchProjectionRepository,
    pullRequestProjectionRepository,
    issueProjectionRepository,
    clock: deps.clock,
  })
  const provisioningService = deps.repoProvisioningClient
    ? new RepoProvisioningService({ client: deps.repoProvisioningClient })
    : undefined
  return {
    installationService,
    syncService,
    webhookService,
    service,
    webhookVerifier,
    provisioningService,
  }
}

/**
 * Assemble the document-source module when at least one provider + both
 * repositories are present. The model provider is optional: with it the planner
 * uses an LLM, and without it the deterministic heading parser — so the module
 * stays usable for import/link/spawn even when no LLM is configured.
 */
function createDocumentsModule(
  deps: CoreDependencies,
  boardService: BoardService,
): DocumentsModule | undefined {
  const { documentSourceProviders, documentConnectionRepository, documentRepository } = deps
  if (
    !documentSourceProviders ||
    documentSourceProviders.length === 0 ||
    !documentConnectionRepository ||
    !documentRepository
  ) {
    return undefined
  }

  const registry = new MapDocumentSourceRegistry(documentSourceProviders)
  const connectionService = new DocumentConnectionService({
    documentConnectionRepository,
    registry,
    workspaceRepository: deps.workspaceRepository,
    clock: deps.clock,
  })
  const importService = new DocumentImportService({
    registry,
    documentRepository,
    connectionService,
    workspaceRepository: deps.workspaceRepository,
    clock: deps.clock,
  })
  const plannerService = new DocumentPlannerService({
    modelProviderResolver: deps.modelProviderResolver,
    modelProvider: deps.modelProvider,
    modelRef: deps.documentPlannerModel,
  })
  const linkService = new DocumentLinkService({
    boardService,
    blockRepository: deps.blockRepository,
    documentRepository,
  })
  const contentResolver = new DocumentContentResolverService({ registry, connectionService })
  return { connectionService, importService, plannerService, linkService, contentResolver }
}

/**
 * Assemble the task-source module when at least one provider + both repositories
 * are present; otherwise return undefined so the feature stays cleanly opt-in.
 * Unlike the documents module there is no planner — issues are linked for
 * context, not expanded into board structure.
 */
function createTasksModule(
  deps: CoreDependencies,
  boardService: BoardService,
): TasksModule | undefined {
  const {
    taskSourceProviders,
    taskConnectionRepository,
    taskSourceSettingsRepository,
    taskRepository,
  } = deps
  if (
    !taskSourceProviders ||
    taskSourceProviders.length === 0 ||
    !taskConnectionRepository ||
    !taskSourceSettingsRepository ||
    !taskRepository
  ) {
    return undefined
  }

  const registry = new MapTaskSourceRegistry(taskSourceProviders)
  const connectionService = new TaskConnectionService({
    taskConnectionRepository,
    taskSourceSettingsRepository,
    registry,
    workspaceRepository: deps.workspaceRepository,
    clock: deps.clock,
    // GitHub Issues' availability is the installed GitHub App's presence; absent when
    // the GitHub integration isn't wired (the provider then isn't registered anyway).
    ...(deps.githubInstallationRepository
      ? { installations: deps.githubInstallationRepository }
      : {}),
    // Linear OAuth app credentials live in per-account deployment settings (sealed),
    // resolved dynamically — mirroring the Slack OAuth model. Absent ⇒ the "Connect with
    // Linear" flow isn't offered (manual API-key paste still works).
    ...(deps.accountSettings
      ? {
          resolveLinearOAuth: (accountKey: string) =>
            deps.accountSettings!.resolve(accountKey).then((s) => s.linearOAuth),
        }
      : {}),
  })
  const importService = new TaskImportService({
    registry,
    taskRepository,
    connectionService,
    workspaceRepository: deps.workspaceRepository,
    clock: deps.clock,
  })
  const linkService = new TaskLinkService({
    boardService,
    blockRepository: deps.blockRepository,
    taskRepository,
    importService,
  })
  // The recurring bug-intake step's read-and-claim helper — wired only when a schedule
  // repository is present (an intake fire resolves the schedule's `issueIntake` config by
  // block). Composes the just-built import/link services + the source registry, so it stays
  // provider-neutral and runtime-symmetric.
  const bugIntakeService = deps.pipelineScheduleRepository
    ? new BugIntakeService({
        pipelineScheduleRepository: deps.pipelineScheduleRepository,
        taskSourceRegistry: registry,
        taskConnectionRepository,
        importService,
        linkService,
        taskRepository,
      })
    : undefined
  return {
    connectionService,
    importService,
    linkService,
    ...(bugIntakeService ? { bugIntakeService } : {}),
  }
}

/**
 * Assemble the environment integration when its provider, both repositories and
 * the secret cipher are present; otherwise return undefined so the feature stays
 * cleanly opt-in (the deterministic deployer and env discovery in the engine are
 * gated on the provisioning service being wired).
 */
function createEnvironmentsModule(
  deps: CoreDependencies,
  provisioningLog: ProvisioningLogRecorder | undefined,
  eventPublisher: ExecutionEventPublisher | undefined,
  sharedStackService: SharedStackService | undefined,
): EnvironmentsModule | undefined {
  const { environmentConnectionRepository, environmentRegistryRepository, secretCipher } = deps
  if (!environmentConnectionRepository || !environmentRegistryRepository || !secretCipher) {
    return undefined
  }

  // Durable async config repair is wired when both the dispatcher (the side-effecting
  // container plumbing) and the kind-scoped job repository are present. The repair service
  // and the connection service are mutually dependent: the connection service's
  // `dispatchConfigRepair` seam STARTS a repair run (→ repairService), and the repair run's
  // success path RE-VALIDATES via the connection service. We break the cycle by capturing
  // `repairService` in a closure that is only invoked at request time (after assignment).
  const canRepair = !!(deps.envConfigRepairer && deps.envConfigRepairJobRepository)
  let repairService: EnvConfigRepairService | undefined

  const connectionService = new EnvironmentConnectionService({
    environmentConnectionRepository,
    workspaceRepository: deps.workspaceRepository,
    secretCipher,
    clock: deps.clock,
    environmentBackendRegistry:
      deps.environmentBackendRegistry ?? defaultEnvironmentBackendRegistry(),
    ...(deps.customManifestTypeRepository
      ? { customManifestTypeRepository: deps.customManifestTypeRepository }
      : {}),
    ...(deps.customManifestTypeRegistry
      ? { customManifestTypeRegistry: deps.customManifestTypeRegistry }
      : {}),
    ...(deps.environmentCustomTlsSupported !== undefined
      ? { customTlsSupported: deps.environmentCustomTlsSupported }
      : {}),
    ...(deps.environmentProvider ? { environmentProvider: deps.environmentProvider } : {}),
    ...(deps.environmentUrlSafetyPolicy ? { urlPolicy: deps.environmentUrlSafetyPolicy } : {}),
    ...(deps.resolveRepoFilesForCoords
      ? { resolveRepoFilesForWorkspace: deps.resolveRepoFilesForCoords }
      : {}),
    ...(canRepair
      ? {
          dispatchConfigRepair: (input) =>
            repairService!
              .start(input.workspaceId, {
                owner: input.owner,
                repo: input.repo,
                gitRef: input.gitRef,
                issues: input.issues,
                ...(input.inputs ? { inputs: input.inputs } : {}),
                ...(input.promptOverride ? { promptOverride: input.promptOverride } : {}),
                ...(input.manifestPath ? { manifestPath: input.manifestPath } : {}),
              })
              .then((job) => ({ jobId: job.id })),
        }
      : {}),
    ...(provisioningLog ? { provisioningLog } : {}),
  })

  if (canRepair) {
    repairService = new EnvConfigRepairService({
      envConfigRepairJobRepository: deps.envConfigRepairJobRepository!,
      workspaceRepository: deps.workspaceRepository,
      idGenerator: deps.idGenerator,
      clock: deps.clock,
      repairer: deps.envConfigRepairer!,
      ...(deps.envConfigRepairRunner ? { runner: deps.envConfigRepairRunner } : {}),
      ...(eventPublisher ? { eventPublisher } : {}),
      revalidate: (input) => connectionService.revalidate(input),
    })
  }
  // The per-USER override store is wired ONLY when its repository is present — which, by
  // design, ONLY the local facade does (so per-user overrides + the per-user controller are
  // local-mode-only, with no runtime branch in shared code). Its `resolveOverrides` is the
  // `resolveUserHandlerOverrides` seam the provisioning service layers over the workspace
  // handlers for the run initiator.
  const userHandlerService = deps.environmentUserHandlerRepository
    ? new EnvironmentUserHandlerService({
        userHandlerRepository: deps.environmentUserHandlerRepository,
        environmentBackendRegistry:
          deps.environmentBackendRegistry ?? defaultEnvironmentBackendRegistry(),
        secretCipher,
        clock: deps.clock,
        ...(deps.environmentCustomTlsSupported !== undefined
          ? { customTlsSupported: deps.environmentCustomTlsSupported }
          : {}),
        ...(deps.environmentUrlSafetyPolicy ? { urlPolicy: deps.environmentUrlSafetyPolicy } : {}),
        ...(deps.logger ? { logger: deps.logger } : {}),
      })
    : undefined
  const provisioningService = new EnvironmentProvisioningService({
    connectionService,
    environmentRegistryRepository,
    secretCipher,
    idGenerator: deps.idGenerator,
    clock: deps.clock,
    ...(deps.environmentUrlSafetyPolicy ? { urlPolicy: deps.environmentUrlSafetyPolicy } : {}),
    ...(deps.resolveRunRepoContext ? { resolveRunRepoContext: deps.resolveRunRepoContext } : {}),
    ...(deps.resolveRepoFilesForCoords
      ? { resolveRepoFilesForWorkspace: deps.resolveRepoFilesForCoords }
      : {}),
    ...(userHandlerService
      ? {
          resolveUserHandlerOverrides: (userId, ws) =>
            userHandlerService.resolveOverrides(userId, ws),
        }
      : {}),
    // The async, container-backed deploy lifecycle (kustomize/helm) is wired when the facade
    // supplies the runner transport + the clone-target resolver; absent ⇒ only the synchronous
    // raw-manifest REST path runs (a render-needing config fails loudly).
    ...(deps.deployJobClient ? { deployJobClient: deps.deployJobClient } : {}),
    ...(deps.resolveDeployCloneTarget
      ? { resolveDeployCloneTarget: deps.resolveDeployCloneTarget }
      : {}),
    // A compose stack recipe's `sharedStackRefs` are brought up (provider-before-consumer) through
    // the shared-stack service, whose managed networks the compose provider attaches the per-PR
    // project to. Wired only when the shared-stacks module exists (its repository is present on
    // every facade); the lifecycle itself refuses without a host daemon.
    ...(sharedStackService
      ? { ensureSharedStacks: (ws, refs) => sharedStackService.ensureRefsUp(ws, refs) }
      : {}),
    ...(provisioningLog ? { provisioningLog } : {}),
  })
  const teardownService = new EnvironmentTeardownService({
    connectionService,
    environmentRegistryRepository,
    secretCipher,
    clock: deps.clock,
    ...(provisioningLog ? { provisioningLog } : {}),
  })
  return {
    connectionService,
    provisioningService,
    teardownService,
    ...(userHandlerService ? { userHandlerService } : {}),
    ...(repairService ? { envConfigRepair: { service: repairService } } : {}),
  }
}

/**
 * Assemble the self-hosted runner-pool module when its connection repository and
 * the secret cipher are present; otherwise return undefined so the feature stays
 * cleanly opt-in. Per-tenant scheduler-API secrets are encrypted via the cipher.
 */
function createRunnersModule(deps: CoreDependencies): RunnersModule | undefined {
  const { runnerPoolConnectionRepository, runnerSecretCipher } = deps
  if (!runnerPoolConnectionRepository || !runnerSecretCipher) return undefined

  const connectionService = new RunnerPoolConnectionService({
    runnerPoolConnectionRepository,
    workspaceRepository: deps.workspaceRepository,
    secretCipher: runnerSecretCipher,
    clock: deps.clock,
    runnerBackendRegistry: deps.runnerBackendRegistry ?? defaultRunnerBackendRegistry(),
    ...(deps.runnerPoolProvider ? { runnerPoolProvider: deps.runnerPoolProvider } : {}),
    ...(deps.runnerUrlSafetyPolicy ? { urlPolicy: deps.runnerUrlSafetyPolicy } : {}),
    ...(deps.runnerCustomTlsSupported !== undefined
      ? { customTlsSupported: deps.runnerCustomTlsSupported }
      : {}),
  })
  return { connectionService }
}

/**
 * Assemble the repo-bootstrap module when both its repositories are present (the
 * worker wires them unconditionally). The `repoBootstrapper` is passed through
 * but optional: the service exposes CRUD regardless and only gates the run path
 * on its presence.
 */
function createBootstrapModule(
  deps: CoreDependencies,
  eventPublisher: ExecutionEventPublisher,
  onBootstrapSucceeded?: (workspaceId: string, blockId: string) => Promise<void>,
): BootstrapModule | undefined {
  const { referenceArchitectureRepository, bootstrapJobRepository } = deps
  if (!referenceArchitectureRepository || !bootstrapJobRepository) return undefined

  const service = new BootstrapService({
    referenceArchitectureRepository,
    bootstrapJobRepository,
    workspaceRepository: deps.workspaceRepository,
    blockRepository: deps.blockRepository,
    serviceRepository: deps.serviceRepository,
    workspaceMountRepository: deps.workspaceMountRepository,
    serviceFragmentDefaultsRepository: deps.serviceFragmentDefaultsRepository,
    idGenerator: deps.idGenerator,
    clock: deps.clock,
    repoBootstrapper: deps.repoBootstrapper,
    bootstrapRunner: deps.bootstrapRunner,
    eventPublisher,
    ...(onBootstrapSucceeded ? { onBootstrapSucceeded } : {}),
  })
  return { service }
}

/**
 * Assemble the requirements-review module when its repository is present (the
 * worker wires it unconditionally). The model provider/ref are optional within
 * the module — reads work without them and the run paths surface a clear error —
 * and the document/task repositories are reused, when wired, to fold linked PRDs
 * and tracker issues into the reviewed requirements.
 */
/**
 * Build the inline reviewer for the test quality-control companion. It resolves its model
 * exactly like the requirements reviewer (block pin → workspace per-kind default → routing
 * default). Returns `undefined` when no model provider is configured, so the Tester gate's QC
 * step is a pass-through in unconfigured facades / tests.
 */
function createTesterQualityReviewer(
  deps: CoreDependencies,
): TesterQualityReviewService | undefined {
  if (!deps.modelProviderResolver && !deps.modelProvider) return undefined
  return new TesterQualityReviewService({
    modelProviderResolver: deps.modelProviderResolver,
    modelProvider: deps.modelProvider,
    modelRef: deps.requirementReviewModel ?? deps.documentPlannerModel,
    resolveBlockModel: deps.requirementReviewResolveModel,
    ...(deps.inlineHarnessRef ? { runsInline: deps.inlineHarnessRef } : {}),
    resolveWorkspaceModelDefault: deps.modelPresetRepository
      ? (workspaceId, agentKind, modelPresetId) =>
          resolvePresetModelForKind(
            deps.modelPresetRepository!,
            workspaceId,
            agentKind,
            modelPresetId,
          )
      : undefined,
  })
}

/**
 * Build the interactive document-interview service (WS5). Self-contained (owns its session
 * store + the inline LLM); resolves its model exactly like the requirements reviewer (block
 * pin → workspace per-kind default → routing default). Returns `undefined` when no session
 * store is wired, so the `doc-interviewer` step passes through in unconfigured facades / tests.
 * The LLM is optional within the service (the `enabled` getter is false without a model), so a
 * store-but-no-model deployment still short-circuits the interviewer.
 */
function createDocInterviewService(deps: CoreDependencies): DocInterviewService | undefined {
  const { docInterviewRepository } = deps
  if (!docInterviewRepository) return undefined
  return new DocInterviewService({
    docInterviewRepository,
    idGenerator: deps.idGenerator,
    clock: deps.clock,
    modelProviderResolver: deps.modelProviderResolver,
    modelProvider: deps.modelProvider,
    modelRef: deps.requirementReviewModel ?? deps.documentPlannerModel,
    resolveBlockModel: deps.requirementReviewResolveModel,
    ...(deps.inlineHarnessRef ? { runsInline: deps.inlineHarnessRef } : {}),
    resolveWorkspaceModelDefault: deps.modelPresetRepository
      ? (workspaceId, agentKind, modelPresetId) =>
          resolvePresetModelForKind(
            deps.modelPresetRepository!,
            workspaceId,
            agentKind,
            modelPresetId,
          )
      : undefined,
  })
}

function createRequirementsModule(
  deps: CoreDependencies,
  notificationService?: NotificationService,
  fragmentLibrary?: FragmentLibraryModule,
): RequirementsModule | undefined {
  const { requirementReviewRepository } = deps
  if (!requirementReviewRepository) return undefined

  const service = new RequirementReviewService({
    requirementReviewRepository,
    blockRepository: deps.blockRepository,
    idGenerator: deps.idGenerator,
    clock: deps.clock,
    // Tell product people + the task creator to react to a review's findings (when
    // the notifications subsystem is wired). Best-effort; absent → no notification.
    notificationService,
    modelProviderResolver: deps.modelProviderResolver,
    modelProvider: deps.modelProvider,
    // The dedicated reviewer ref, else the document planner's (both the agents' default).
    modelRef: deps.requirementReviewModel ?? deps.documentPlannerModel,
    // Honour a block's pinned model with the direct/Cloudflare fallback, like the executor.
    resolveBlockModel: deps.requirementReviewResolveModel,
    // In local mode, run the reviewer inline through the ambient Claude Code / Codex CLI on a
    // subscription model instead of degrading to the routing default.
    ...(deps.inlineHarnessRef ? { runsInline: deps.inlineHarnessRef } : {}),
    // Honour the workspace's model presets for the `requirements` kind too, so the
    // reviewer resolves its model exactly like a pipeline step. Reuses the already
    // wired model-preset repository (the workspace default preset); absent → only
    // block-pin + routing default.
    resolveWorkspaceModelDefault: deps.modelPresetRepository
      ? (workspaceId, agentKind, modelPresetId) =>
          resolvePresetModelForKind(
            deps.modelPresetRepository!,
            workspaceId,
            agentKind,
            modelPresetId,
          )
      : undefined,
    documentRepository: deps.documentRepository,
    taskRepository: deps.taskRepository,
    // The Requirement Writer (second companion) grounds recommendations on the run's repo
    // (`spec/` + `tech-spec/` via the checkout-free RepoFiles) — wired in all three facades.
    resolveRunRepoContext: deps.resolveRunRepoContext,
    // …and on the block's best-practice fragments (team/org standards), checked FIRST. Walk
    // the owning frame's service standards then union the block's own pins (same precedence
    // as the agent context builder), resolved against the merged tenant catalog when the
    // fragment library is wired (so managed + document-backed fragments ground the review
    // exactly like they reach a code-aware run), else the static universal pool.
    resolveBlockFragments: async (workspaceId: string, blockId: string) => {
      const block = await deps.blockRepository.get(workspaceId, blockId)
      if (!block) return []
      const ids: string[] = []
      const seen = new Set<string>()
      const add = (id: string) => {
        if (!seen.has(id)) {
          seen.add(id)
          ids.push(id)
        }
      }
      let current: Block | null = block
      for (let i = 0; current && i < 8; i++) {
        if (current.level === 'frame' || !current.parentId) {
          for (const id of current.serviceFragmentIds ?? []) add(id)
          break
        }
        current = await deps.blockRepository.get(workspaceId, current.parentId)
      }
      for (const id of block.fragmentIds ?? []) add(id)
      if (fragmentLibrary) {
        // Resolve the merged tenant catalog ONCE and reuse it for both the titles map and
        // the body resolution (which would otherwise re-resolve the same catalog).
        const catalog = await fragmentLibrary.libraryService.resolveCatalog(workspaceId)
        const titles = new Map(catalog.map((e) => [e.id, e.title]))
        const bodies = await fragmentLibrary.libraryService.resolveBodiesForRun(
          workspaceId,
          ids,
          catalog,
        )
        return bodies.map(({ id, body }) => ({ id, title: titles.get(id) ?? id, body }))
      }
      const out: { id: string; title: string; body: string }[] = []
      for (const id of ids) {
        const fragment = getFragment(id)
        if (fragment) out.push({ id, title: fragment.title, body: fragment.body })
      }
      return out
    },
    // `webSearch` (gateway-RAG) is wired by the web-search-connection workstream; until then
    // the Writer still gets provider-hosted web search on Anthropic/OpenAI models.
    // When an upstream `requirements-brainstorm` dialogue settled a converged direction, the
    // reviewer critiques THAT (the refined requirements) instead of the raw description.
    resolveBrainstormDirection: deps.brainstormSessionRepository
      ? async (workspaceId: string, blockId: string) => {
          const session = await deps.brainstormSessionRepository!.getByBlockStage(
            workspaceId,
            blockId,
            'requirements',
          )
          return session?.status === 'incorporated' && session.convergedDirection
            ? session.convergedDirection
            : undefined
        }
      : undefined,
  })
  return { service }
}

/**
 * Assemble the brainstorm (structured-dialogue) module when its repository is present (both
 * runtime facades wire it unconditionally). Mirrors {@link createClarityModule}: it builds ONE
 * {@link BrainstormService} per stage (sharing the repository) and reuses the requirements
 * reviewer's model config since all the inline reviewers resolve their model identically. The
 * architecture stage seeds from the refined requirements (a requirements review's incorporated
 * doc, else the requirements-brainstorm's converged direction).
 */
function createBrainstormModule(
  deps: CoreDependencies,
  notificationService?: NotificationService,
): BrainstormModule | undefined {
  const { brainstormSessionRepository } = deps
  if (!brainstormSessionRepository) return undefined

  const resolveWorkspaceModelDefault = deps.modelPresetRepository
    ? (workspaceId: string, agentKind: string, modelPresetId?: string) =>
        resolvePresetModelForKind(
          deps.modelPresetRepository!,
          workspaceId,
          agentKind,
          modelPresetId,
        )
    : undefined

  // The architecture stage's seed: the most refined requirements available — a settled
  // requirements review's incorporated doc, else the requirements-brainstorm's direction.
  const resolveRefinedRequirements = async (
    workspaceId: string,
    blockId: string,
  ): Promise<string | undefined> => {
    const review = await deps.requirementReviewRepository?.getByBlock(workspaceId, blockId)
    if (review?.status === 'incorporated' && review.incorporatedRequirements) {
      return review.incorporatedRequirements
    }
    const session = await brainstormSessionRepository.getByBlockStage(
      workspaceId,
      blockId,
      'requirements',
    )
    return session?.status === 'incorporated' && session.convergedDirection
      ? session.convergedDirection
      : undefined
  }

  const common = {
    brainstormSessionRepository,
    blockRepository: deps.blockRepository,
    idGenerator: deps.idGenerator,
    clock: deps.clock,
    notificationService,
    modelProviderResolver: deps.modelProviderResolver,
    modelProvider: deps.modelProvider,
    modelRef: deps.requirementReviewModel ?? deps.documentPlannerModel,
    resolveBlockModel: deps.requirementReviewResolveModel,
    ...(deps.inlineHarnessRef ? { runsInline: deps.inlineHarnessRef } : {}),
    resolveWorkspaceModelDefault,
  }

  return {
    services: {
      requirements: new BrainstormService({ ...common, stage: 'requirements' }),
      architecture: new BrainstormService({
        ...common,
        stage: 'architecture',
        resolveRefinedRequirements,
      }),
    },
  }
}

/**
 * Assemble the Kaizen module when its repositories are wired (both runtime facades wire them
 * unconditionally). The grader resolves its model for the `kaizen` kind the same way the
 * requirements reviewer does — block pin > workspace per-kind default > routing default —
 * so operators configure it in Model Configuration alongside every other agent. Needs the
 * telemetry repos (LLM-call metrics + agent-context snapshots) to read what each step was
 * given; absent → the module isn't built and no grading is scheduled.
 */
function createKaizenModule(deps: CoreDependencies): KaizenModule | undefined {
  const { kaizenGradingRepository, kaizenVerifiedComboRepository } = deps
  if (!kaizenGradingRepository || !kaizenVerifiedComboRepository) return undefined
  if (!deps.llmCallMetricRepository || !deps.agentContextObservability) return undefined

  const service = new KaizenService({
    kaizenGradingRepository,
    kaizenVerifiedComboRepository,
    blockRepository: deps.blockRepository,
    llmCallMetricRepository: deps.llmCallMetricRepository,
    agentContextObservability: deps.agentContextObservability,
    workspaceSettingsRepository: deps.workspaceSettingsRepository,
    idGenerator: deps.idGenerator,
    clock: deps.clock,
    events: deps.executionEventPublisher,
    modelProviderResolver: deps.modelProviderResolver,
    modelProvider: deps.modelProvider,
    // Reuse the reviewer's routing default ref + block-model resolver (the agents' default).
    modelRef: deps.requirementReviewModel ?? deps.documentPlannerModel,
    resolveBlockModel: deps.requirementReviewResolveModel,
    ...(deps.inlineHarnessRef ? { runsInline: deps.inlineHarnessRef } : {}),
    // Resolve the workspace's per-kind default for `kaizen`, like a pipeline step.
    resolveWorkspaceModelDefault: deps.modelPresetRepository
      ? (workspaceId, agentKind, modelPresetId) =>
          resolvePresetModelForKind(
            deps.modelPresetRepository!,
            workspaceId,
            agentKind,
            modelPresetId,
          )
      : undefined,
  })
  return { service }
}

/**
 * Assemble the clarity-review module when its repository is present (both runtime facades
 * wire it unconditionally). Mirrors {@link createRequirementsModule}: it reuses the
 * requirements reviewer's model config (the same routing default) since both reviewers
 * resolve their model identically.
 */
function createClarityModule(
  deps: CoreDependencies,
  notificationService?: NotificationService,
): ClarityModule | undefined {
  const { clarityReviewRepository } = deps
  if (!clarityReviewRepository) return undefined

  const service = new ClarityReviewService({
    clarityReviewRepository,
    blockRepository: deps.blockRepository,
    idGenerator: deps.idGenerator,
    clock: deps.clock,
    notificationService,
    modelProviderResolver: deps.modelProviderResolver,
    modelProvider: deps.modelProvider,
    modelRef: deps.requirementReviewModel ?? deps.documentPlannerModel,
    resolveBlockModel: deps.requirementReviewResolveModel,
    ...(deps.inlineHarnessRef ? { runsInline: deps.inlineHarnessRef } : {}),
    resolveWorkspaceModelDefault: deps.modelPresetRepository
      ? (workspaceId, agentKind, modelPresetId) =>
          resolvePresetModelForKind(
            deps.modelPresetRepository!,
            workspaceId,
            agentKind,
            modelPresetId,
          )
      : undefined,
  })
  return { service }
}

/**
 * Assemble the prompt-fragment library when its fragment repository is present.
 * The library service (CRUD + the per-run catalog resolver) always assembles;
 * the repo-source service additionally needs the GitHub client, the source
 * repository and an installation resolver. The selector is optional — absent it
 * falls back to deterministic matching. Returns undefined so the feature stays
 * cleanly opt-in (the engine then uses the block's manual fragmentIds).
 */
function createFragmentLibraryModule(
  deps: CoreDependencies,
  documentContentResolver: DocumentContentResolver | undefined,
  caches: AppCaches,
): FragmentLibraryModule | undefined {
  const { promptFragmentRepository } = deps
  if (!promptFragmentRepository) return undefined

  const libraryService = new FragmentLibraryService({
    promptFragmentRepository,
    workspaceRepository: deps.workspaceRepository,
    clock: deps.clock,
    selector: deps.fragmentSelector,
    // An explicitly-injected resolver (tests/conformance) wins; otherwise use the
    // one the document-source module built from this deployment's providers.
    documentContentResolver: deps.documentContentResolver ?? documentContentResolver,
    catalogCache: caches.fragmentCatalog,
    documentBodyCache: caches.fragmentDocumentBody,
  })

  const sourceService =
    deps.fragmentSourceRepository && deps.githubClient && deps.resolveFragmentInstallationId
      ? new FragmentSourceService({
          fragmentSourceRepository: deps.fragmentSourceRepository,
          promptFragmentRepository,
          githubClient: deps.githubClient,
          resolveInstallationId: deps.resolveFragmentInstallationId,
          idGenerator: deps.idGenerator,
          clock: deps.clock,
          // A sync/unlink mutates the same catalog the library caches — route its
          // invalidation through the library so the eviction policy stays in one place.
          invalidateCatalog: (ownerKind, ownerId) =>
            libraryService.invalidateCatalogTier(ownerKind, ownerId),
        })
      : undefined

  return { libraryService, sourceService }
}

/**
 * Assemble the notifications module when its repository is present (the worker
 * wires it unconditionally). The delivery channel is optional within the module —
 * without it the rows still persist (the inbox + snapshot work) but nothing is
 * pushed; the worker wires the in-app channel, and email/Slack compose in later.
 */
function createNotificationsModule(deps: CoreDependencies): NotificationsModule | undefined {
  const { notificationRepository } = deps
  if (!notificationRepository) return undefined
  const service = new NotificationService({
    notificationRepository,
    workspaceRepository: deps.workspaceRepository,
    idGenerator: deps.idGenerator,
    clock: deps.clock,
    channel: deps.notificationChannel,
  })
  return { service }
}

/**
 * Assemble the Slack integration module when its three repositories and the
 * secret cipher are present. Powers the management API (connect/settings/member
 * map); the actual Slack delivery is a `notificationChannel` composed in by the
 * facade. OAuth is optional — manual-token onboarding works without it.
 */
function createSlackModule(deps: CoreDependencies): SlackModule | undefined {
  const {
    slackConnectionRepository,
    slackSettingsRepository,
    slackMemberMappingRepository,
    slackSecretCipher,
  } = deps
  if (
    !slackConnectionRepository ||
    !slackSettingsRepository ||
    !slackMemberMappingRepository ||
    !slackSecretCipher
  ) {
    return undefined
  }
  return {
    connectionService: new SlackConnectionService({
      slackConnectionRepository,
      workspaceRepository: deps.workspaceRepository,
      secretCipher: slackSecretCipher,
      clock: deps.clock,
      resolveOAuth: deps.accountSettings
        ? (accountKey) => deps.accountSettings!.resolve(accountKey).then((s) => s.slackOAuth)
        : undefined,
    }),
    settingsService: new SlackSettingsService({
      slackSettingsRepository,
      workspaceRepository: deps.workspaceRepository,
      clock: deps.clock,
    }),
    memberMappingService: new SlackMemberMappingService({
      slackMemberMappingRepository,
      workspaceRepository: deps.workspaceRepository,
      clock: deps.clock,
    }),
  }
}

/** Assemble the merge-preset module when its repository is present. */
function createMergePresetsModule(deps: CoreDependencies): MergePresetsModule | undefined {
  const { mergePresetRepository } = deps
  if (!mergePresetRepository) return undefined
  const service = new MergePresetService({
    mergePresetRepository,
    workspaceRepository: deps.workspaceRepository,
    idGenerator: deps.idGenerator,
    clock: deps.clock,
  })
  return { service }
}

/**
 * Assemble the shared-stacks module when its repository is present. The `composeRuntime` is
 * optional — wired only on the local facade, so CRUD works everywhere but the lifecycle
 * (ensureUp/teardown) refuses without a host daemon (the documented compose runtime-binding
 * exception). Persistence is fully runtime-symmetric.
 */
function createSharedStacksModule(deps: CoreDependencies): SharedStacksModule | undefined {
  const { sharedStackRepository } = deps
  if (!sharedStackRepository) return undefined
  const service = new SharedStackService({
    sharedStackRepository,
    workspaceRepository: deps.workspaceRepository,
    idGenerator: deps.idGenerator,
    clock: deps.clock,
    ...(deps.composeRuntime ? { composeRuntime: deps.composeRuntime } : {}),
    ...(deps.sharedStackCloneToken ? { cloneToken: deps.sharedStackCloneToken } : {}),
  })
  return { service }
}

/**
 * Assemble the Sandbox module when its five repositories are present (both runtime
 * facades wire them together). Reuses the requirements reviewer's inline model config —
 * the per-scope provider resolver, the routing default ref, and the block-model resolver
 * — so a Sandbox cell (and the judge) resolves its catalog id exactly like a pipeline step.
 */
function createSandboxModule(
  deps: CoreDependencies,
  agentKindRegistry: AgentKindRegistry,
): SandboxModule | undefined {
  const {
    sandboxPromptVersionRepository,
    sandboxFixtureRepository,
    sandboxExperimentRepository,
    sandboxRunRepository,
    sandboxGradeRepository,
  } = deps
  if (
    !sandboxPromptVersionRepository ||
    !sandboxFixtureRepository ||
    !sandboxExperimentRepository ||
    !sandboxRunRepository ||
    !sandboxGradeRepository
  ) {
    return undefined
  }
  const repositories = {
    sandboxPromptVersionRepository,
    sandboxFixtureRepository,
    sandboxExperimentRepository,
    sandboxRunRepository,
    sandboxGradeRepository,
    workspaceRepository: deps.workspaceRepository,
    idGenerator: deps.idGenerator,
    clock: deps.clock,
    agentKindRegistry,
  }
  const defaultModelRef = deps.requirementReviewModel ?? deps.documentPlannerModel
  const service = new SandboxService({ ...repositories, defaultModelRef })
  const runService = new SandboxRunService({
    ...repositories,
    modelProviderResolver: deps.modelProviderResolver,
    modelProvider: deps.modelProvider,
    resolveModelId: deps.requirementReviewResolveModel,
    defaultModelRef,
    ...(deps.inlineHarnessRef ? { runsInline: deps.inlineHarnessRef } : {}),
  })
  return { service, runService }
}

/** Assemble the workspace-settings module when its repository is present. */
function createWorkspaceSettingsModule(
  deps: CoreDependencies,
): WorkspaceSettingsModule | undefined {
  const { workspaceSettingsRepository } = deps
  if (!workspaceSettingsRepository) return undefined
  const service = new WorkspaceSettingsService({
    workspaceSettingsRepository,
    workspaceRepository: deps.workspaceRepository,
  })
  return { service }
}

/** Assemble the release-health (observability) module when its repos + cipher are present. */
function createReleaseHealthModule(deps: CoreDependencies): ReleaseHealthModule | undefined {
  const {
    observabilityConnectionRepository,
    releaseHealthConfigRepository,
    observabilitySecretCipher,
  } = deps
  if (
    !observabilityConnectionRepository ||
    !releaseHealthConfigRepository ||
    !observabilitySecretCipher
  ) {
    return undefined
  }
  const service = new ReleaseHealthService({
    observabilityConnectionRepository,
    releaseHealthConfigRepository,
    observabilitySecretCipher,
    workspaceRepository: deps.workspaceRepository,
    blockRepository: deps.blockRepository,
    clock: deps.clock,
  })
  return { service }
}

/** Assemble the package-registries module when its repo + cipher are present. */
function createPackageRegistriesModule(
  deps: CoreDependencies,
): PackageRegistriesModule | undefined {
  const { packageRegistryConnectionRepository, packageRegistrySecretCipher } = deps
  if (!packageRegistryConnectionRepository || !packageRegistrySecretCipher) {
    return undefined
  }
  const service = new PackageRegistryService({
    packageRegistryConnectionRepository,
    packageRegistrySecretCipher,
    workspaceRepository: deps.workspaceRepository,
    clock: deps.clock,
    idGenerator: deps.idGenerator,
  })
  return { service }
}

/**
 * Assemble the browsable-frontend-preview module when its per-runtime transport + the facade's
 * job builder + the env registry are all wired (local/node with a host-port-publish runtime).
 * Absent on the Worker (no preview transport) ⇒ the controller 503s there.
 */
function createPreviewModule(deps: CoreDependencies): PreviewModule | undefined {
  const { previewTransport, buildPreviewJob, environmentRegistryRepository } = deps
  if (!previewTransport || !buildPreviewJob || !environmentRegistryRepository) return undefined
  const service = new PreviewService({
    previewTransport,
    buildPreviewJob,
    environmentRegistryRepository,
    idGenerator: deps.idGenerator,
    clock: deps.clock,
  })
  return { service }
}

/** Assemble the incident-enrichment settings module when its repo + cipher are present. */
function createIncidentEnrichmentModule(
  deps: CoreDependencies,
): IncidentEnrichmentModule | undefined {
  const { incidentEnrichmentConnectionRepository, incidentEnrichmentSecretCipher } = deps
  if (!incidentEnrichmentConnectionRepository || !incidentEnrichmentSecretCipher) return undefined
  const service = new IncidentEnrichmentService({
    incidentEnrichmentConnectionRepository,
    incidentEnrichmentSecretCipher,
    workspaceRepository: deps.workspaceRepository,
    clock: deps.clock,
  })
  return { service }
}

/** Assemble the model-presets module when its repository is present. */
function createModelPresetsModule(deps: CoreDependencies): ModelPresetsModule | undefined {
  const { modelPresetRepository } = deps
  if (!modelPresetRepository) return undefined
  const service = new ModelPresetService({
    modelPresetRepository,
    workspaceRepository: deps.workspaceRepository,
    idGenerator: deps.idGenerator,
    clock: deps.clock,
  })
  return { service }
}

/** Assemble the service-fragment-defaults module when its repository is present. */
function createServiceFragmentDefaultsModule(
  deps: CoreDependencies,
): ServiceFragmentDefaultsModule | undefined {
  const { serviceFragmentDefaultsRepository } = deps
  if (!serviceFragmentDefaultsRepository) return undefined
  const service = new ServiceFragmentDefaultsService({
    serviceFragmentDefaultsRepository,
    workspaceRepository: deps.workspaceRepository,
  })
  return { service }
}

/** Assemble the tracker-settings module when its repository is present. */
function createTrackerModule(deps: CoreDependencies): TrackerModule | undefined {
  const { trackerSettingsRepository } = deps
  if (!trackerSettingsRepository) return undefined
  const service = new TrackerSettingsService({
    trackerSettingsRepository,
    workspaceRepository: deps.workspaceRepository,
    clock: deps.clock,
  })
  return { service }
}

/**
 * Assemble the recurring-pipeline module when its repository is present. Built
 * after the execution engine since each fire starts a pipeline through it.
 */
function createRecurringModule(
  deps: CoreDependencies,
  executionService: ExecutionService,
  executionEventPublisher: ExecutionEventPublisher,
  taskConnectionService?: TaskConnectionService,
): RecurringModule | undefined {
  const { pipelineScheduleRepository } = deps
  if (!pipelineScheduleRepository) return undefined
  const service = new RecurringPipelineService({
    pipelineScheduleRepository,
    workspaceRepository: deps.workspaceRepository,
    pipelineRepository: deps.pipelineRepository,
    blockRepository: deps.blockRepository,
    executionRepository: deps.executionRepository,
    executionService,
    idGenerator: deps.idGenerator,
    clock: deps.clock,
    serviceRepository: deps.serviceRepository,
    workspaceMountRepository: deps.workspaceMountRepository,
    // Validates a `bug-intake` pipeline's schedule carries an `issueIntake` config whose source
    // is a connected task source. Absent (no task sources wired) → the presence check still runs.
    taskConnectionService,
    // Pushes a `block-added` board event when the reused block is created, so it appears live.
    executionEventPublisher,
  })
  return { service }
}

export function createCore(dependencies: CoreDependencies): Core {
  // Resolve the app-owned agent-kind registry ONCE: the facade's injected instance (so a
  // deployment's custom kinds are visible) else a fresh built-ins-only registry. The SAME
  // instance is threaded into the engine and re-exposed on `Core` for the HTTP snapshot.
  const agentKindRegistry = dependencies.agentKindRegistry ?? defaultAgentKindRegistry()
  const workRunner = dependencies.workRunner ?? new NoopWorkRunner()
  const executionEventPublisher = dependencies.executionEventPublisher ?? new NoopEventPublisher()
  // The cache bag the caching-initiative slices read through. A facade passes its own
  // (Redis-notified on multi-node Node, isolate-safe on the Worker); tests and harnesses
  // fall back to bare in-memory loaders, so the cached path — including the services'
  // write-site invalidation — is exercised everywhere. Built here (before the services that
  // invalidate through it) so it can be threaded into all of them.
  const caches = dependencies.caches ?? createAppCaches()
  // Pass the resolved publisher so board mutations push a coarse `boardChanged` to every
  // user on the workspace (and every board mounting a shared service) — both facades route
  // here, so the wiring is symmetric by construction. The repo-projection cache lets
  // `addServiceFromRepo`'s monorepo-flag write invalidate the same group the resolver reads.
  const boardService = new BoardService({
    ...dependencies,
    executionEventPublisher,
    repoProjectionCache: caches.repoProjection,
  })
  const workspaceService = new WorkspaceService(dependencies)
  const accountService = new AccountService({
    accountRepository: dependencies.accountRepository,
    membershipRepository: dependencies.membershipRepository,
    userRepository: dependencies.userRepository,
    idGenerator: dependencies.idGenerator,
    clock: dependencies.clock,
  })
  const userService = new UserService({
    userRepository: dependencies.userRepository,
    passwordHasher: dependencies.passwordHasher,
    idGenerator: dependencies.idGenerator,
    clock: dependencies.clock,
  })
  const email =
    dependencies.emailConnectionRepository && dependencies.emailSecretCipher
      ? new EmailConnectionService({
          emailConnectionRepository: dependencies.emailConnectionRepository,
          secretCipher: dependencies.emailSecretCipher,
          clock: dependencies.clock,
        })
      : undefined
  const invitations = dependencies.invitationRepository
    ? new InvitationService({
        invitationRepository: dependencies.invitationRepository,
        accountRepository: dependencies.accountRepository,
        membershipRepository: dependencies.membershipRepository,
        idGenerator: dependencies.idGenerator,
        clock: dependencies.clock,
        // Resolve the inviting account's own (DB-stored) email sender at send time.
        resolveEmailSender: email ? (accountId) => email.resolveSender(accountId) : undefined,
        appBaseUrl: dependencies.appBaseUrl,
      })
    : undefined
  const passwordReset = dependencies.passwordResetTokenRepository
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
    : undefined
  const pipelineService = new PipelineService(dependencies)
  const spendService = new SpendService({
    tokenUsageRepository: dependencies.tokenUsageRepository,
    idGenerator: dependencies.idGenerator,
    clock: dependencies.clock,
    pricing: dependencies.spendPricing ?? DEFAULT_SPEND_PRICING,
    workspaceSettingsRepository: dependencies.workspaceSettingsRepository,
    dynamicPricesFor: dependencies.dynamicModelPricesFor,
  })
  const llmObservability = dependencies.llmCallMetricRepository
    ? new LlmObservabilityService({
        llmCallMetricRepository: dependencies.llmCallMetricRepository,
        idGenerator: dependencies.idGenerator,
        clock: dependencies.clock,
        recordPrompts: dependencies.recordLlmPrompts ?? true,
        traceSink: dependencies.llmTraceSink,
        workspaceSettingsRepository: dependencies.workspaceSettingsRepository,
      })
    : undefined
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
  const provisioningLogs = dependencies.provisioningLogRepository
    ? {
        service: new ProvisioningLogService({ repository: dependencies.provisioningLogRepository }),
      }
    : undefined
  // Built before the environments module so a compose stack recipe's `sharedStackRefs` can be
  // brought up (provider-before-consumer) through this service during provisioning. Persistence is
  // runtime-symmetric (present on every facade); the lifecycle only runs where a host daemon is
  // wired (`composeRuntime` — the local facade), else `ensureRefsUp` returns a clean error.
  const sharedStacks = createSharedStacksModule(dependencies)
  const environments = createEnvironmentsModule(
    dependencies,
    provisioningLogRecorder,
    executionEventPublisher,
    sharedStacks?.service,
  )
  // Built before the fragment library so a document-backed fragment can re-resolve
  // its linked Confluence/Notion/GitHub page through the document module's reader.
  const documents = createDocumentsModule(dependencies, boardService)
  const fragmentLibrary = createFragmentLibraryModule(
    dependencies,
    documents?.contentResolver,
    caches,
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
  const notifications = createNotificationsModule(dependencies)
  const slack = createSlackModule(dependencies)
  const mergePresets = createMergePresetsModule(dependencies)
  const sandbox = createSandboxModule(dependencies, agentKindRegistry)
  // Built before the execution engine so the per-service running-task limit can be
  // enforced at start() (and the escalation sweep can read the waiting threshold).
  const settings = createWorkspaceSettingsModule(dependencies)
  const releaseHealth = createReleaseHealthModule(dependencies)
  const packageRegistries = createPackageRegistriesModule(dependencies)
  const preview = createPreviewModule(dependencies)
  const incidentEnrichmentSettings = createIncidentEnrichmentModule(dependencies)
  const modelPresets = createModelPresetsModule(dependencies)
  const serviceFragmentDefaults = createServiceFragmentDefaultsModule(dependencies)
  // Built before the execution engine so the planning pipeline's plan ingest + the
  // committer step's tracker mirror can run through it.
  const initiativeService = dependencies.initiativeRepository
    ? new InitiativeService({
        workspaceRepository: dependencies.workspaceRepository,
        blockRepository: dependencies.blockRepository,
        initiativeRepository: dependencies.initiativeRepository,
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
  })
  // Built before the execution engine so the special `requirements-review` gate step can
  // drive the inline reviewer + the iterative answer → incorporate → re-review loop.
  const requirements = createRequirementsModule(
    dependencies,
    notifications?.service,
    fragmentLibrary,
  )
  const docInterview = createDocInterviewService(dependencies)
  const clarity = createClarityModule(dependencies, notifications?.service)
  const brainstorm = createBrainstormModule(dependencies, notifications?.service)
  // Built before the execution engine so the engine's terminal hook can schedule a
  // post-run Kaizen grading for each completed agent step.
  const kaizen = createKaizenModule(dependencies)

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
  const tasks = createTasksModule(dependencies, boardService)

  const executionService = new ExecutionService({
    ...dependencies,
    agentKindRegistry,
    workRunner,
    executionEventPublisher,
    boardService,
    pokeInitiativeLoop,
    bugIntakeService: tasks?.bugIntakeService,
    spendService,
    // Route runtime fragment-id resolution through the merged tenant catalog (so
    // managed + document-backed fragments reach a run), present only when the
    // library is configured; otherwise the engine falls back to the static pool.
    fragmentResolver: fragmentLibrary?.libraryService,
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
    // The test quality-control companion's inline reviewer, resolved like every other inline
    // review (block pin → workspace preset → routing default). Built only when a model
    // provider is available; absent → the Tester gate's QC step is a pass-through.
    testerQualityReviewer:
      dependencies.testerQualityReviewer ?? createTesterQualityReviewer(dependencies),
    clarityReviewService: clarity?.service,
    brainstormServices: brainstorm?.services,
    kaizenScheduler: kaizen?.service,
    environmentProvisioning: environments?.provisioningService,
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

  const github = createGitHubModule(dependencies, caches)
  const runners = createRunnersModule(dependencies)
  // After a bootstrap succeeds, map the new repo into a blueprint + the board by
  // starting the blueprint-only pipeline against the service frame.
  const bootstrap = createBootstrapModule(dependencies, executionEventPublisher, (ws, blockId) =>
    executionService.start(ws, blockId, BLUEPRINT_PIPELINE_ID).then(() => undefined),
  )
  const tracker = createTrackerModule(dependencies)
  const recurring = createRecurringModule(
    dependencies,
    executionService,
    executionEventPublisher,
    tasks?.connectionService,
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
  const initiatives =
    initiativeService && initiativeLoop
      ? { service: initiativeService, loop: initiativeLoop }
      : undefined
  const services = createServicesModule(dependencies)

  return {
    workspaceService,
    accountService,
    userService,
    ...(invitations ? { invitations } : {}),
    ...(passwordReset ? { passwordReset } : {}),
    ...(email ? { email } : {}),
    boardService,
    pipelineService,
    executionService,
    spendService,
    agentKindRegistry,
    executionEventPublisher,
    ...(llmObservability ? { llmObservability } : {}),
    ...(dependencies.agentContextObservability
      ? { agentContextObservability: dependencies.agentContextObservability }
      : {}),
    ...(github ? { github } : {}),
    ...(documents ? { documents } : {}),
    ...(tasks ? { tasks } : {}),
    ...(environments ? { environments } : {}),
    ...(environments?.envConfigRepair ? { envConfigRepair: environments.envConfigRepair } : {}),
    ...(runners ? { runners } : {}),
    ...(provisioningLogs ? { provisioningLogs } : {}),
    ...(bootstrap ? { bootstrap } : {}),
    ...(requirements ? { requirements } : {}),
    ...(kaizen ? { kaizen } : {}),
    ...(clarity ? { clarity } : {}),
    ...(brainstorm ? { brainstorm } : {}),
    ...(notifications ? { notifications } : {}),
    ...(slack ? { slack } : {}),
    ...(mergePresets ? { mergePresets } : {}),
    ...(sharedStacks ? { sharedStacks } : {}),
    ...(sandbox ? { sandbox } : {}),
    ...(settings ? { settings } : {}),
    ...(releaseHealth ? { releaseHealth } : {}),
    ...(packageRegistries ? { packageRegistries } : {}),
    ...(preview ? { preview } : {}),
    ...(incidentEnrichmentSettings ? { incidentEnrichmentSettings } : {}),
    ...(dependencies.accountSettings
      ? { accountSettings: { service: dependencies.accountSettings } }
      : {}),
    ...(modelPresets ? { modelPresets } : {}),
    ...(serviceFragmentDefaults ? { serviceFragmentDefaults } : {}),
    ...(fragmentLibrary ? { fragmentLibrary } : {}),
    ...(initiatives ? { initiatives } : {}),
    ...(recurring ? { recurring } : {}),
    ...(tracker ? { tracker } : {}),
    ...(services ? { services } : {}),
  }
}
