import type {
  BlockRepository,
  ExecutionRepository,
  PipelineRepository,
  WorkspaceRepository,
} from './ports/repositories'
import type { AccountRepository, MembershipRepository } from './ports/account-repositories'
import type { Clock, IdGenerator } from './ports/runtime'
import type { AgentExecutor } from './ports/agent-executor'
import type { TokenUsageRepository } from './ports/token-usage'
import { type WorkRunner, NoopWorkRunner } from './ports/work-runner'
import { type ExecutionEventPublisher, NoopEventPublisher } from './ports/execution-events'
import type { GitHubClient } from './ports/github-client'
import type { GitHubProvisioningClient } from './ports/github-provisioning'
import type { WebhookVerifier } from './ports/webhook-verifier'
import type { ModelProvider, ModelRef } from './ports/model-provider'
import type { DocumentSourceProvider } from './ports/document-source'
import type {
  DocumentConnectionRepository,
  DocumentRepository,
} from './ports/document-repositories'
import type { TaskSourceProvider } from './ports/task-source'
import type { TaskConnectionRepository, TaskRepository } from './ports/task-repositories'
import type { EnvironmentProvider } from './ports/environment-provider'
import type {
  EnvironmentConnectionRepository,
  EnvironmentRegistryRepository,
} from './ports/environment-repositories'
import type { RunnerPoolConnectionRepository } from './ports/runner-pool-repositories'
import type {
  BootstrapJobRepository,
  ReferenceArchitectureRepository,
} from './ports/bootstrap-repositories'
import type { RepoBootstrapper } from './ports/repo-bootstrapper'
import type { BootstrapRunner } from './ports/bootstrap-runner'
import type { RepoBlueprintRepository } from './ports/board-scan-repositories'
import type { RepoScanner } from './ports/repo-scanner'
import type { RequirementReviewRepository } from './ports/requirement-review-repositories'
import type { SecretCipher } from './ports/secret-cipher'
import type {
  FragmentSourceRepository,
  PromptFragmentRepository,
} from './ports/fragment-repositories'
import type { FragmentSelector } from './ports/fragment-selector'
import type {
  BranchProjectionRepository,
  CheckRunProjectionRepository,
  CommitProjectionRepository,
  GitHubInstallation,
  GitHubInstallationRepository,
  IssueProjectionRepository,
  PullRequestProjectionRepository,
  RepoProjectionRepository,
} from './ports/github-repositories'
import { BoardService } from './modules/board/BoardService'
import { ExecutionService } from './modules/execution/ExecutionService'
import { PipelineService } from './modules/pipelines/PipelineService'
import { WorkspaceService } from './modules/workspaces/WorkspaceService'
import { AccountService } from './modules/accounts/AccountService'
import { SpendService } from './modules/spend/SpendService'
import { DEFAULT_SPEND_PRICING, type SpendPricing } from './modules/spend/pricing'
import { GitHubInstallationService } from './modules/github/GitHubInstallationService'
import { RepoProvisioningService } from './modules/github/RepoProvisioningService'
import { GitHubService } from './modules/github/GitHubService'
import { GitHubSyncService } from './modules/github/GitHubSyncService'
import { WebhookService } from './modules/github/WebhookService'
import { DocumentConnectionService } from './modules/documents/DocumentConnectionService'
import { DocumentImportService } from './modules/documents/DocumentImportService'
import { DocumentPlannerService } from './modules/documents/DocumentPlannerService'
import { DocumentLinkService } from './modules/documents/DocumentLinkService'
import { MapDocumentSourceRegistry } from './modules/documents/documents.logic'
import { TaskConnectionService } from './modules/tasks/TaskConnectionService'
import { TaskImportService } from './modules/tasks/TaskImportService'
import { TaskLinkService } from './modules/tasks/TaskLinkService'
import { MapTaskSourceRegistry } from './modules/tasks/tasks.logic'
import { EnvironmentConnectionService } from './modules/environments/EnvironmentConnectionService'
import { EnvironmentProvisioningService } from './modules/environments/EnvironmentProvisioningService'
import { EnvironmentTeardownService } from './modules/environments/EnvironmentTeardownService'
import { RunnerPoolConnectionService } from './modules/runners/RunnerPoolConnectionService'
import { BootstrapService } from './modules/bootstrap/BootstrapService'
import { BoardScanService } from './modules/boardScan/BoardScanService'
import { RequirementReviewService } from './modules/requirements/RequirementReviewService'
import { BLUEPRINT_PIPELINE_ID } from './domain/seed'
import { FragmentLibraryService } from './modules/fragmentLibrary/FragmentLibraryService'
import {
  FragmentSourceService,
  type ResolveFragmentInstallationId,
} from './modules/fragmentLibrary/FragmentSourceService'

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
   * Model the requirements reviewer uses. Independent of the documents config so
   * the reviewer works whenever a model provider is wired; the worker sets it to
   * the agents' default ref. Falls back to `documentPlannerModel` when absent.
   */
  requirementReviewModel?: ModelRef

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

/** The prompt-fragment library's services, present only when configured (ADR 0006). */
export interface FragmentLibraryModule {
  /** Per-tier CRUD + the merged-catalog resolver (also the run-path FragmentResolver). */
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
  /** Present only when the prompt-fragment library is configured (see CoreDependencies). */
  fragmentLibrary?: FragmentLibraryModule
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
function createRequirementsModule(deps: CoreDependencies): RequirementsModule | undefined {
  const { requirementReviewRepository } = deps
  if (!requirementReviewRepository) return undefined

  const service = new RequirementReviewService({
    requirementReviewRepository,
    blockRepository: deps.blockRepository,
    idGenerator: deps.idGenerator,
    clock: deps.clock,
    modelProvider: deps.modelProvider,
    // The dedicated reviewer ref, else the document planner's (both the agents' default).
    modelRef: deps.requirementReviewModel ?? deps.documentPlannerModel,
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
  const environments = createEnvironmentsModule(dependencies)
  const fragmentLibrary = createFragmentLibraryModule(dependencies)

  // Built before the execution engine so a `blueprints` step can reconcile its
  // decomposition onto the board through it (when the module is configured).
  const boardScan = createBoardScanModule(dependencies, boardService)

  const executionService = new ExecutionService({
    ...dependencies,
    workRunner,
    executionEventPublisher,
    boardService,
    spendService,
    environmentProvisioning: environments?.provisioningService,
    // The library service is itself the run-path FragmentResolver (it merges the
    // tenant catalog + runs selection); injected so every agent kind benefits.
    fragmentResolver: fragmentLibrary?.libraryService,
    blueprintReconciler: boardScan?.service,
  })

  const github = createGitHubModule(dependencies)
  const documents = createDocumentsModule(dependencies, boardService)
  const tasks = createTasksModule(dependencies)
  const requirements = createRequirementsModule(dependencies)
  const runners = createRunnersModule(dependencies)
  // After a bootstrap succeeds, map the new repo into a blueprint + the board by
  // starting the blueprint-only pipeline against the service frame.
  const bootstrap = createBootstrapModule(dependencies, executionEventPublisher, (ws, blockId) =>
    executionService.start(ws, blockId, BLUEPRINT_PIPELINE_ID).then(() => undefined),
  )

  return {
    workspaceService,
    accountService,
    boardService,
    pipelineService,
    executionService,
    spendService,
    ...(github ? { github } : {}),
    ...(documents ? { documents } : {}),
    ...(tasks ? { tasks } : {}),
    ...(environments ? { environments } : {}),
    ...(runners ? { runners } : {}),
    ...(bootstrap ? { bootstrap } : {}),
    ...(boardScan ? { boardScan } : {}),
    ...(requirements ? { requirements } : {}),
    ...(fragmentLibrary ? { fragmentLibrary } : {}),
  }
}
