import type {
  BlockRepository,
  ExecutionRepository,
  PipelineRepository,
  WorkspaceRepository,
} from './ports/repositories'
import type { Clock, IdGenerator } from './ports/runtime'
import type { AgentExecutor } from './ports/agent-executor'
import type { TokenUsageRepository } from './ports/token-usage'
import { type WorkRunner, NoopWorkRunner } from './ports/work-runner'
import { type ExecutionEventPublisher, NoopEventPublisher } from './ports/execution-events'
import type { GitHubClient } from './ports/github-client'
import type { WebhookVerifier } from './ports/webhook-verifier'
import type { ModelProvider, ModelRef } from './ports/model-provider'
import type { ConfluenceClient } from './ports/confluence-client'
import type {
  ConfluenceConnectionRepository,
  ConfluenceDocumentRepository,
} from './ports/confluence-repositories'
import type { EnvironmentProvider } from './ports/environment-provider'
import type {
  EnvironmentConnectionRepository,
  EnvironmentRegistryRepository,
} from './ports/environment-repositories'
import type { SecretCipher } from './ports/secret-cipher'
import type {
  BranchProjectionRepository,
  CheckRunProjectionRepository,
  CommitProjectionRepository,
  GitHubInstallationRepository,
  IssueProjectionRepository,
  PullRequestProjectionRepository,
  RepoProjectionRepository,
} from './ports/github-repositories'
import { BoardService } from './modules/board/BoardService'
import { ExecutionService } from './modules/execution/ExecutionService'
import { PipelineService } from './modules/pipelines/PipelineService'
import { WorkspaceService } from './modules/workspaces/WorkspaceService'
import { SpendService } from './modules/spend/SpendService'
import { DEFAULT_SPEND_PRICING, type SpendPricing } from './modules/spend/pricing'
import { GitHubInstallationService } from './modules/github/GitHubInstallationService'
import { GitHubService } from './modules/github/GitHubService'
import { GitHubSyncService } from './modules/github/GitHubSyncService'
import { WebhookService } from './modules/github/WebhookService'
import { ConfluenceConnectionService } from './modules/confluence/ConfluenceConnectionService'
import { ConfluenceImportService } from './modules/confluence/ConfluenceImportService'
import { ConfluencePlannerService } from './modules/confluence/ConfluencePlannerService'
import { ConfluenceLinkService } from './modules/confluence/ConfluenceLinkService'
import { EnvironmentConnectionService } from './modules/environments/EnvironmentConnectionService'
import { EnvironmentProvisioningService } from './modules/environments/EnvironmentProvisioningService'
import { EnvironmentTeardownService } from './modules/environments/EnvironmentTeardownService'

// Composition root for the domain layer. The worker's infrastructure builds the
// concrete ports (D1 repositories, crypto id/rng, the AI agent executor) and
// hands them here; `createCore` wires the module services together in dependency
// order and returns them. This is the framework-agnostic equivalent of the
// template's per-module DI config, minus the awilix machinery.

export interface CoreDependencies {
  workspaceRepository: WorkspaceRepository
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

  // ---- Confluence integration (optional; wired only when configured) ------
  // Mirrors the GitHub default-off convention. The Confluence module assembles
  // when the client + both repositories are present. `modelProvider` is
  // *optional within* the module: when
  // absent the planner uses its deterministic heading-based fallback, so import,
  // link and spawn still work. `confluenceDocumentRepository` is additionally
  // consumed by the execution engine to feed linked docs to agents as context.
  modelProvider?: ModelProvider
  /** Model the Confluence planner uses (the agents' default model ref). */
  confluencePlannerModel?: ModelRef
  confluenceClient?: ConfluenceClient
  confluenceConnectionRepository?: ConfluenceConnectionRepository
  confluenceDocumentRepository?: ConfluenceDocumentRepository

  // ---- Ephemeral environment integration (optional; wired when configured) -
  // Mirrors the GitHub/Confluence default-off convention. The module assembles
  // only when the provider, both repositories and the secret cipher are present,
  // so the engine (deterministic deployer step + env discovery) stays unchanged
  // when the feature is off. Per-tenant secrets are encrypted via `secretCipher`.
  environmentProvider?: EnvironmentProvider
  environmentConnectionRepository?: EnvironmentConnectionRepository
  environmentRegistryRepository?: EnvironmentRegistryRepository
  secretCipher?: SecretCipher
}

/** The GitHub integration's services, present only when the app is configured. */
export interface GitHubModule {
  installationService: GitHubInstallationService
  syncService: GitHubSyncService
  webhookService: WebhookService
  service: GitHubService
  webhookVerifier: WebhookVerifier
}

/** The Confluence integration's services, present only when configured. */
export interface ConfluenceModule {
  connectionService: ConfluenceConnectionService
  importService: ConfluenceImportService
  plannerService: ConfluencePlannerService
  linkService: ConfluenceLinkService
}

/** The environment integration's services, present only when configured. */
export interface EnvironmentsModule {
  connectionService: EnvironmentConnectionService
  provisioningService: EnvironmentProvisioningService
  teardownService: EnvironmentTeardownService
}

export interface Core {
  workspaceService: WorkspaceService
  boardService: BoardService
  pipelineService: PipelineService
  executionService: ExecutionService
  spendService: SpendService
  /** Present only when the GitHub integration is configured (see CoreDependencies). */
  github?: GitHubModule
  /** Present only when the Confluence integration is configured (see CoreDependencies). */
  confluence?: ConfluenceModule
  /** Present only when the environment integration is configured (see CoreDependencies). */
  environments?: EnvironmentsModule
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
  return { installationService, syncService, webhookService, service, webhookVerifier }
}

/**
 * Assemble the Confluence module when its client + both repositories are
 * present. The model provider is optional: with it the planner uses an LLM, and
 * without it the deterministic heading parser — so the module stays usable for
 * import/link/spawn even when no LLM is configured.
 */
function createConfluenceModule(
  deps: CoreDependencies,
  boardService: BoardService,
): ConfluenceModule | undefined {
  const { confluenceClient, confluenceConnectionRepository, confluenceDocumentRepository } = deps
  if (!confluenceClient || !confluenceConnectionRepository || !confluenceDocumentRepository) {
    return undefined
  }

  const connectionService = new ConfluenceConnectionService({
    confluenceConnectionRepository,
    workspaceRepository: deps.workspaceRepository,
    clock: deps.clock,
  })
  const importService = new ConfluenceImportService({
    confluenceClient,
    confluenceDocumentRepository,
    connectionService,
    workspaceRepository: deps.workspaceRepository,
    clock: deps.clock,
  })
  const plannerService = new ConfluencePlannerService({
    modelProvider: deps.modelProvider,
    modelRef: deps.confluencePlannerModel,
  })
  const linkService = new ConfluenceLinkService({
    boardService,
    blockRepository: deps.blockRepository,
    confluenceDocumentRepository,
  })
  return { connectionService, importService, plannerService, linkService }
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

export function createCore(dependencies: CoreDependencies): Core {
  const workRunner = dependencies.workRunner ?? new NoopWorkRunner()
  const executionEventPublisher = dependencies.executionEventPublisher ?? new NoopEventPublisher()
  const boardService = new BoardService(dependencies)
  const workspaceService = new WorkspaceService(dependencies)
  const pipelineService = new PipelineService(dependencies)
  const spendService = new SpendService({
    tokenUsageRepository: dependencies.tokenUsageRepository,
    idGenerator: dependencies.idGenerator,
    clock: dependencies.clock,
    pricing: dependencies.spendPricing ?? DEFAULT_SPEND_PRICING,
  })
  const environments = createEnvironmentsModule(dependencies)

  const executionService = new ExecutionService({
    ...dependencies,
    workRunner,
    executionEventPublisher,
    boardService,
    spendService,
    environmentProvisioning: environments?.provisioningService,
  })

  const github = createGitHubModule(dependencies)
  const confluence = createConfluenceModule(dependencies, boardService)

  return {
    workspaceService,
    boardService,
    pipelineService,
    executionService,
    spendService,
    ...(github ? { github } : {}),
    ...(confluence ? { confluence } : {}),
    ...(environments ? { environments } : {}),
  }
}
