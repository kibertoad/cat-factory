import type {
  BlockRepository,
  ExecutionRepository,
  PipelineRepository,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import type { AccountRepository, MembershipRepository } from '@cat-factory/kernel'
import type { ServiceRepository, WorkspaceMountRepository } from '@cat-factory/kernel'
import { ServiceMountService } from './modules/services/ServiceMountService.js'
import type { Clock, IdGenerator } from '@cat-factory/kernel'
import type { AgentExecutor } from '@cat-factory/kernel'
import type { TokenUsageRepository } from '@cat-factory/kernel'
import type { LlmCallMetricRepository } from '@cat-factory/kernel'
import type { LlmTraceSink } from '@cat-factory/kernel'
import { type WorkRunner, NoopWorkRunner } from '@cat-factory/kernel'
import { type ExecutionEventPublisher, NoopEventPublisher } from '@cat-factory/kernel'
import type { GitHubClient } from '@cat-factory/kernel'
import type { GitHubProvisioningClient } from '@cat-factory/kernel'
import type { WebhookVerifier } from '@cat-factory/kernel'
import type { ModelProvider, ModelRef } from '@cat-factory/kernel'
import type { DocumentSourceProvider } from '@cat-factory/kernel'
import type { DocumentConnectionRepository, DocumentRepository } from '@cat-factory/kernel'
import type { TaskSourceProvider } from '@cat-factory/kernel'
import type { TaskConnectionRepository, TaskRepository } from '@cat-factory/kernel'
import type { EnvironmentProvider } from '@cat-factory/kernel'
import type {
  EnvironmentConnectionRepository,
  EnvironmentRegistryRepository,
} from '@cat-factory/kernel'
import type { RunnerPoolConnectionRepository } from '@cat-factory/kernel'
import type { BootstrapJobRepository, ReferenceArchitectureRepository } from '@cat-factory/kernel'
import type { RepoBootstrapper } from '@cat-factory/kernel'
import type { BootstrapRunner } from '@cat-factory/kernel'
import type { RepoBlueprintRepository } from '@cat-factory/kernel'
import type { RepoScanner } from '@cat-factory/kernel'
import type { RequirementReviewRepository } from '@cat-factory/kernel'
import type { SubscriptionActivationRepository } from '@cat-factory/kernel'
import type {
  CiStatusProvider,
  MergePresetRepository,
  ModelDefaultsRepository,
  ServiceFragmentDefaultsRepository,
  NotificationChannel,
  NotificationRepository,
  PipelineScheduleRepository,
  PullRequestMerger,
  PullRequestMergeabilityProvider,
  TicketTrackerProvider,
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
} from '@cat-factory/kernel'
import { BoardService } from './modules/board/BoardService.js'
import { ExecutionService } from './modules/execution/ExecutionService.js'
import { PipelineService } from './modules/pipelines/PipelineService.js'
import { WorkspaceService } from '@cat-factory/workspaces'
import { AccountService } from '@cat-factory/workspaces'
import { SpendService, DEFAULT_SPEND_PRICING, type SpendPricing } from '@cat-factory/spend'
import { LlmObservabilityService } from './modules/observability/LlmObservabilityService.js'
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
  MapDocumentSourceRegistry,
  TaskConnectionService,
  TaskImportService,
  TaskLinkService,
  MapTaskSourceRegistry,
  EnvironmentConnectionService,
  EnvironmentProvisioningService,
  EnvironmentTeardownService,
  RunnerPoolConnectionService,
  SlackConnectionService,
  SlackSettingsService,
  SlackMemberMappingService,
} from '@cat-factory/integrations'
import { BootstrapService } from './modules/bootstrap/BootstrapService.js'
import { BoardScanService } from './modules/boardScan/BoardScanService.js'
import { RequirementReviewService } from './modules/requirements/RequirementReviewService.js'
import { NotificationService } from './modules/notifications/NotificationService.js'
import { MergePresetService } from './modules/merge/MergePresetService.js'
import { ModelDefaultsService } from './modules/modelDefaults/ModelDefaultsService.js'
import { ServiceFragmentDefaultsService } from './modules/serviceFragmentDefaults/ServiceFragmentDefaultsService.js'
import { RecurringPipelineService } from './modules/recurring/RecurringPipelineService.js'
import { TrackerSettingsService } from './modules/recurring/TrackerSettingsService.js'
import { BLUEPRINT_PIPELINE_ID } from '@cat-factory/kernel'
import {
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
  taskRepository?: TaskRepository

  // ---- Ephemeral environment integration (optional; wired when configured) -
  // Mirrors the GitHub/Confluence default-off convention. The module assembles
  // only when the provider, both repositories and the secret cipher are present,
  // so the engine (deterministic deployer step + env discovery) stays unchanged
  // when the feature is off. Per-tenant secrets are encrypted via `secretCipher`.
  environmentProvider?: EnvironmentProvider
  environmentConnectionRepository?: EnvironmentConnectionRepository
  environmentRegistryRepository?: EnvironmentRegistryRepository
  secretCipher?: SecretCipher

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

  // ---- Board scan ("scan repository" → blueprint) -------------------------
  // Blueprint reads assemble whenever the repository is present (the worker wires
  // it unconditionally). Actually *running* a scan also needs `repoScanner` — the
  // GitHub + sandbox-container machinery — which the worker wires only when those
  // prerequisites are met; without it the module still serves the persisted
  // blueprints but reports the scan path as unavailable.
  repoBlueprintRepository?: RepoBlueprintRepository
  repoScanner?: RepoScanner

  // ---- Requirements review (stateless reviewer agent) ---------------------
  // The review feature assembles whenever its repository is present (the worker
  // wires it unconditionally). The LLM is optional *within* the module: reads of
  // an existing review work without it, but running a review / incorporation
  // needs `modelProvider` + `documentPlannerModel` (reused as the reviewer ref).
  // The document/task repositories above are reused, when wired, to fold linked
  // PRDs and tracker issues into the reviewed requirements.
  requirementReviewRepository?: RequirementReviewRepository
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

  // ---- Prompt-fragment library (opt-in; ADR 0006) -------------------------
  // The managed, tenant-scoped catalog of best-practice fragments. The library
  // (per-tier CRUD + the merged-catalog resolver feeding every agent run)
  // assembles whenever `promptFragmentRepository` is present. Repo-sourced
  // fragments additionally need `fragmentSourceRepository`, the `githubClient`
  // (above) and an installation resolver. `fragmentSelector` is optional within
  // the module: absent → the deterministic matcher; present → the LLM selector.
  promptFragmentRepository?: PromptFragmentRepository
  fragmentSourceRepository?: FragmentSourceRepository
  fragmentSelector?: FragmentSelector
  resolveFragmentInstallationId?: ResolveFragmentInstallationId

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
  slackOAuth?: { clientId: string; clientSecret: string; redirectUrl: string }
  /** Reads a block's PR CI checks so the `ci` step can gate on green CI. */
  ciStatusProvider?: CiStatusProvider
  /** Reads a block's PR mergeability so the `conflicts` step can gate on it. */
  mergeabilityProvider?: PullRequestMergeabilityProvider
  /** Performs the real GitHub merge so a task's `done` means "PR merged". */
  pullRequestMerger?: PullRequestMerger
  /** Resolves a task's merge threshold preset (auto-merge ceilings + CI attempt budget). */
  mergePresetRepository?: MergePresetRepository
  /**
   * Stores a workspace's per-agent-kind default models (the model each agent kind
   * defaults to, overriding the env routing for that workspace). Optional and
   * default-off: absent → the `modelDefaults` module isn't assembled and the env
   * routing is used everywhere.
   */
  modelDefaultsRepository?: ModelDefaultsRepository
  /**
   * Stores a workspace's default service-fragment selection (the best-practice
   * fragment ids new services inherit). Optional and default-off: absent → the
   * `serviceFragmentDefaults` module isn't assembled, new services start with no
   * service-level fragments, and `code-aware` agents only see the block's own pins.
   */
  serviceFragmentDefaultsRepository?: ServiceFragmentDefaultsRepository

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
}

/** The task-source integration's services, present only when configured. */
export interface TasksModule {
  connectionService: TaskConnectionService
  importService: TaskImportService
  linkService: TaskLinkService
}

/** The environment integration's services, present only when configured. */
export interface EnvironmentsModule {
  connectionService: EnvironmentConnectionService
  provisioningService: EnvironmentProvisioningService
  teardownService: EnvironmentTeardownService
}

/** The self-hosted runner-pool integration's services, present only when configured. */
export interface RunnersModule {
  connectionService: RunnerPoolConnectionService
}

/** The repo-bootstrap feature's service, present only when its repositories exist. */
export interface BootstrapModule {
  service: BootstrapService
}

/** The board-scan feature's service, present only when its repository is wired. */
export interface BoardScanModule {
  service: BoardScanService
}

/** The requirements-review feature's service, present only when its repository is wired. */
export interface RequirementsModule {
  service: RequirementReviewService
}

/** The notifications feature's service, present only when its repository is wired. */
export interface NotificationsModule {
  service: NotificationService
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

/** The per-kind default-model feature's service, present only when its repository is wired. */
export interface ModelDefaultsModule {
  service: ModelDefaultsService
}

/** The default service-fragment feature's service, present only when its repository is wired. */
export interface ServiceFragmentDefaultsModule {
  service: ServiceFragmentDefaultsService
}

/** The recurring-pipeline feature's service, present only when its repository is wired. */
export interface RecurringModule {
  service: RecurringPipelineService
}

/** The issue-tracker-settings feature's service, present only when its repository is wired. */
export interface TrackerModule {
  service: TrackerSettingsService
}

/** The prompt-fragment library's services, present only when configured (ADR 0006). */
export interface FragmentLibraryModule {
  /**
   * Per-tier CRUD + the merged-catalog resolver. A management surface only: the run
   * path no longer consumes it (service-scoped `serviceFragmentIds` folded into
   * `code-aware` agents replaced the automatic per-run relevance selector).
   */
  libraryService: FragmentLibraryService
  /** Repo-sourced fragments; present only when the GitHub client + source repo are wired. */
  sourceService?: FragmentSourceService
}

export interface Core {
  workspaceService: WorkspaceService
  accountService: AccountService
  boardService: BoardService
  pipelineService: PipelineService
  executionService: ExecutionService
  spendService: SpendService
  /** Present only when the LLM-metric repository is wired (see CoreDependencies). */
  llmObservability?: LlmObservabilityService
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
  /** Present only when the repo-bootstrap repositories are wired (see CoreDependencies). */
  bootstrap?: BootstrapModule
  /** Present only when the board-scan repository is wired (see CoreDependencies). */
  boardScan?: BoardScanModule
  /** Present only when the requirements-review repository is wired (see CoreDependencies). */
  requirements?: RequirementsModule
  /** Present only when the notifications repository is wired (see CoreDependencies). */
  notifications?: NotificationsModule
  /** Present only when the Slack repositories + cipher are wired (see CoreDependencies). */
  slack?: SlackModule
  /** Present only when the merge-preset repository is wired (see CoreDependencies). */
  mergePresets?: MergePresetsModule
  /** Present only when the model-defaults repository is wired (see CoreDependencies). */
  modelDefaults?: ModelDefaultsModule
  /** Present only when the service-fragment-defaults repository is wired (see CoreDependencies). */
  serviceFragmentDefaults?: ServiceFragmentDefaultsModule
  /** Present only when the prompt-fragment library is configured (see CoreDependencies). */
  fragmentLibrary?: FragmentLibraryModule
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
function createGitHubModule(deps: CoreDependencies): GitHubModule | undefined {
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
    clock: deps.clock,
    commitBackfillHorizonMs: deps.commitBackfillHorizonMs,
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
    modelProvider: deps.modelProvider,
    modelRef: deps.documentPlannerModel,
  })
  const linkService = new DocumentLinkService({
    boardService,
    blockRepository: deps.blockRepository,
    documentRepository,
  })
  return { connectionService, importService, plannerService, linkService }
}

/**
 * Assemble the task-source module when at least one provider + both repositories
 * are present; otherwise return undefined so the feature stays cleanly opt-in.
 * Unlike the documents module there is no planner — issues are linked for
 * context, not expanded into board structure.
 */
function createTasksModule(deps: CoreDependencies): TasksModule | undefined {
  const { taskSourceProviders, taskConnectionRepository, taskRepository } = deps
  if (
    !taskSourceProviders ||
    taskSourceProviders.length === 0 ||
    !taskConnectionRepository ||
    !taskRepository
  ) {
    return undefined
  }

  const registry = new MapTaskSourceRegistry(taskSourceProviders)
  const connectionService = new TaskConnectionService({
    taskConnectionRepository,
    registry,
    workspaceRepository: deps.workspaceRepository,
    clock: deps.clock,
  })
  const importService = new TaskImportService({
    registry,
    taskRepository,
    connectionService,
    workspaceRepository: deps.workspaceRepository,
    clock: deps.clock,
  })
  const linkService = new TaskLinkService({
    blockRepository: deps.blockRepository,
    taskRepository,
  })
  return { connectionService, importService, linkService }
}

/**
 * Assemble the environment integration when its provider, both repositories and
 * the secret cipher are present; otherwise return undefined so the feature stays
 * cleanly opt-in (the deterministic deployer and env discovery in the engine are
 * gated on the provisioning service being wired).
 */
function createEnvironmentsModule(deps: CoreDependencies): EnvironmentsModule | undefined {
  const {
    environmentProvider,
    environmentConnectionRepository,
    environmentRegistryRepository,
    secretCipher,
  } = deps
  if (
    !environmentProvider ||
    !environmentConnectionRepository ||
    !environmentRegistryRepository ||
    !secretCipher
  ) {
    return undefined
  }

  const connectionService = new EnvironmentConnectionService({
    environmentConnectionRepository,
    workspaceRepository: deps.workspaceRepository,
    secretCipher,
    clock: deps.clock,
  })
  const provisioningService = new EnvironmentProvisioningService({
    connectionService,
    environmentProvider,
    environmentRegistryRepository,
    secretCipher,
    idGenerator: deps.idGenerator,
    clock: deps.clock,
  })
  const teardownService = new EnvironmentTeardownService({
    connectionService,
    environmentProvider,
    environmentRegistryRepository,
    secretCipher,
    clock: deps.clock,
  })
  return { connectionService, provisioningService, teardownService }
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
 * Assemble the board-scan module when its blueprint repository is present (the
 * worker wires it unconditionally). The `repoScanner` is passed through but
 * optional: the service serves the persisted blueprints regardless and only gates
 * the scan path on its presence.
 */
function createBoardScanModule(
  deps: CoreDependencies,
  boardService: BoardService,
): BoardScanModule | undefined {
  const { repoBlueprintRepository } = deps
  if (!repoBlueprintRepository) return undefined

  const service = new BoardScanService({
    repoBlueprintRepository,
    workspaceRepository: deps.workspaceRepository,
    boardService,
    blockRepository: deps.blockRepository,
    idGenerator: deps.idGenerator,
    clock: deps.clock,
    repoScanner: deps.repoScanner,
    repoProjectionRepository: deps.repoProjectionRepository,
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
function createRequirementsModule(
  deps: CoreDependencies,
  notificationService?: NotificationService,
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
    modelProvider: deps.modelProvider,
    // The dedicated reviewer ref, else the document planner's (both the agents' default).
    modelRef: deps.requirementReviewModel ?? deps.documentPlannerModel,
    // Honour a block's pinned model with the direct/Cloudflare fallback, like the executor.
    resolveBlockModel: deps.requirementReviewResolveModel,
    // Honour the workspace's per-kind default for the `requirements` kind too, so the
    // reviewer resolves its model exactly like a pipeline step. Reuses the already
    // wired model-defaults repository; absent → only block-pin + routing default.
    resolveWorkspaceModelDefault: deps.modelDefaultsRepository
      ? (workspaceId, agentKind) =>
          deps
            .modelDefaultsRepository!.getForKind(workspaceId, agentKind)
            .then((v) => v ?? undefined)
      : undefined,
    documentRepository: deps.documentRepository,
    taskRepository: deps.taskRepository,
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
function createFragmentLibraryModule(deps: CoreDependencies): FragmentLibraryModule | undefined {
  const { promptFragmentRepository } = deps
  if (!promptFragmentRepository) return undefined

  const libraryService = new FragmentLibraryService({
    promptFragmentRepository,
    workspaceRepository: deps.workspaceRepository,
    clock: deps.clock,
    selector: deps.fragmentSelector,
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
      oauth: deps.slackOAuth,
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

/** Assemble the model-defaults module when its repository is present. */
function createModelDefaultsModule(deps: CoreDependencies): ModelDefaultsModule | undefined {
  const { modelDefaultsRepository } = deps
  if (!modelDefaultsRepository) return undefined
  const service = new ModelDefaultsService({
    modelDefaultsRepository,
    workspaceRepository: deps.workspaceRepository,
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
  })
  return { service }
}

export function createCore(dependencies: CoreDependencies): Core {
  const workRunner = dependencies.workRunner ?? new NoopWorkRunner()
  const executionEventPublisher = dependencies.executionEventPublisher ?? new NoopEventPublisher()
  const boardService = new BoardService(dependencies)
  const workspaceService = new WorkspaceService(dependencies)
  const accountService = new AccountService({
    accountRepository: dependencies.accountRepository,
    membershipRepository: dependencies.membershipRepository,
    idGenerator: dependencies.idGenerator,
    clock: dependencies.clock,
  })
  const pipelineService = new PipelineService(dependencies)
  const spendService = new SpendService({
    tokenUsageRepository: dependencies.tokenUsageRepository,
    idGenerator: dependencies.idGenerator,
    clock: dependencies.clock,
    pricing: dependencies.spendPricing ?? DEFAULT_SPEND_PRICING,
  })
  const llmObservability = dependencies.llmCallMetricRepository
    ? new LlmObservabilityService({
        llmCallMetricRepository: dependencies.llmCallMetricRepository,
        idGenerator: dependencies.idGenerator,
        clock: dependencies.clock,
        recordPrompts: dependencies.recordLlmPrompts ?? true,
        traceSink: dependencies.llmTraceSink,
      })
    : undefined
  const environments = createEnvironmentsModule(dependencies)
  const fragmentLibrary = createFragmentLibraryModule(dependencies)

  // Built before the execution engine so a `blueprints` step can reconcile its
  // decomposition onto the board through it (when the module is configured).
  const boardScan = createBoardScanModule(dependencies, boardService)
  // Built before the execution engine so it can raise merge-review / CI-failed /
  // pipeline-complete notifications during a run (when the module is configured).
  const notifications = createNotificationsModule(dependencies)
  const slack = createSlackModule(dependencies)
  const mergePresets = createMergePresetsModule(dependencies)
  const modelDefaults = createModelDefaultsModule(dependencies)
  const serviceFragmentDefaults = createServiceFragmentDefaultsModule(dependencies)

  const executionService = new ExecutionService({
    ...dependencies,
    workRunner,
    executionEventPublisher,
    boardService,
    spendService,
    environmentProvisioning: environments?.provisioningService,
    blueprintReconciler: boardScan?.service,
    notificationService: notifications?.service,
    llmObservability,
    ticketTrackerProvider: dependencies.ticketTrackerProvider,
    // Let the personal-credential gate resolve the workspace per-kind default model the
    // same way dispatch does, so a run whose block has no pin but an individual-usage
    // workspace default is still gated up-front. Reuses the model-defaults repository.
    resolveWorkspaceModelDefault: dependencies.modelDefaultsRepository
      ? (workspaceId, agentKind) =>
          dependencies
            .modelDefaultsRepository!.getForKind(workspaceId, agentKind)
            .then((v) => v ?? undefined)
      : undefined,
  })

  const github = createGitHubModule(dependencies)
  const documents = createDocumentsModule(dependencies, boardService)
  const tasks = createTasksModule(dependencies)
  const requirements = createRequirementsModule(dependencies, notifications?.service)
  const runners = createRunnersModule(dependencies)
  // After a bootstrap succeeds, map the new repo into a blueprint + the board by
  // starting the blueprint-only pipeline against the service frame.
  const bootstrap = createBootstrapModule(dependencies, executionEventPublisher, (ws, blockId) =>
    executionService.start(ws, blockId, BLUEPRINT_PIPELINE_ID).then(() => undefined),
  )
  const tracker = createTrackerModule(dependencies)
  const recurring = createRecurringModule(dependencies, executionService)
  const services = createServicesModule(dependencies)

  return {
    workspaceService,
    accountService,
    boardService,
    pipelineService,
    executionService,
    spendService,
    ...(llmObservability ? { llmObservability } : {}),
    ...(github ? { github } : {}),
    ...(documents ? { documents } : {}),
    ...(tasks ? { tasks } : {}),
    ...(environments ? { environments } : {}),
    ...(runners ? { runners } : {}),
    ...(bootstrap ? { bootstrap } : {}),
    ...(boardScan ? { boardScan } : {}),
    ...(requirements ? { requirements } : {}),
    ...(notifications ? { notifications } : {}),
    ...(slack ? { slack } : {}),
    ...(mergePresets ? { mergePresets } : {}),
    ...(modelDefaults ? { modelDefaults } : {}),
    ...(serviceFragmentDefaults ? { serviceFragmentDefaults } : {}),
    ...(fragmentLibrary ? { fragmentLibrary } : {}),
    ...(recurring ? { recurring } : {}),
    ...(tracker ? { tracker } : {}),
    ...(services ? { services } : {}),
  }
}
