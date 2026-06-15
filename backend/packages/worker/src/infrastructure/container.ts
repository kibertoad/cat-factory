import {
  AiAgentExecutor,
  type AgentExecutor,
  type Core,
  type CoreDependencies,
  type ExecutionEventPublisher,
  NoopWorkRunner,
  type WorkRunner,
  createCore,
} from '@cat-factory/core'
import { type AppConfig, loadConfig } from './config'
import type { Env } from './env'
import { CloudflareModelProvider } from './ai/CloudflareModelProvider'
import { ContainerAgentExecutor, type ResolveRepoTarget } from './ai/ContainerAgentExecutor'
import { ContainerRepoBootstrapper } from './ai/ContainerRepoBootstrapper'
import { CompositeAgentExecutor } from './ai/CompositeAgentExecutor'
import { ContainerSessionService } from './containers/ContainerSessionService'
import { DurableObjectEventPublisher } from './events/DurableObjectEventPublisher'
import { WorkflowsWorkRunner } from './workflows/WorkflowsWorkRunner'
import { D1BlockRepository } from './repositories/D1BlockRepository'
import { D1ExecutionRepository } from './repositories/D1ExecutionRepository'
import { D1PipelineRepository } from './repositories/D1PipelineRepository'
import { D1TokenUsageRepository } from './repositories/D1TokenUsageRepository'
import { D1WorkspaceRepository } from './repositories/D1WorkspaceRepository'
import { D1GitHubInstallationRepository } from './repositories/D1GitHubInstallationRepository'
import { D1RepoProjectionRepository } from './repositories/D1RepoProjectionRepository'
import { D1BranchProjectionRepository } from './repositories/D1BranchProjectionRepository'
import { D1PullRequestProjectionRepository } from './repositories/D1PullRequestProjectionRepository'
import { D1IssueProjectionRepository } from './repositories/D1IssueProjectionRepository'
import { D1CommitProjectionRepository } from './repositories/D1CommitProjectionRepository'
import { D1CheckRunProjectionRepository } from './repositories/D1CheckRunProjectionRepository'
import { D1RateLimitRepository } from './repositories/D1RateLimitRepository'
import { D1ConfluenceConnectionRepository } from './repositories/D1ConfluenceConnectionRepository'
import { D1ConfluenceDocumentRepository } from './repositories/D1ConfluenceDocumentRepository'
import { D1EnvironmentConnectionRepository } from './repositories/D1EnvironmentConnectionRepository'
import { D1EnvironmentRegistryRepository } from './repositories/D1EnvironmentRegistryRepository'
import { D1ReferenceArchitectureRepository } from './repositories/D1ReferenceArchitectureRepository'
import { D1BootstrapJobRepository } from './repositories/D1BootstrapJobRepository'
import { HttpEnvironmentProvider } from './environments/HttpEnvironmentProvider'
import { WebCryptoSecretCipher } from './environments/WebCryptoSecretCipher'
import { GitHubAppAuth } from './github/GitHubAppAuth'
import { FetchGitHubClient } from './github/FetchGitHubClient'
import { WebCryptoWebhookVerifier } from './github/WebCryptoWebhookVerifier'
import { FetchConfluenceClient } from './confluence/FetchConfluenceClient'
import { CryptoIdGenerator, SystemClock } from './runtime'
import type { Clock, IdGenerator } from '@cat-factory/core'
import type { D1Database } from '@cloudflare/workers-types'

// The infrastructure composition root: turn a Worker `env` into the concrete
// ports (D1 repositories, runtime, the chosen agent executor) and assemble the
// domain core. Built once per request — instantiation is cheap and each request
// gets its own D1 handle from `env`.

export interface Container extends Core {
  config: AppConfig
}

/**
 * Pick the agent that performs pipeline steps: real LLM work via the Vercel AI
 * SDK, optionally composed with a per-run sandbox container for the repo-operating
 * steps (`coder`, `mocker`, `playwright`) when container implementation is opted
 * in and wired. Tests bypass this entirely by overriding `agentExecutor` with a fake.
 */
function selectAgentExecutor(
  env: Env,
  config: AppConfig,
  db: D1Database,
  clock: Clock,
): AgentExecutor {
  const inline = new AiAgentExecutor({
    modelProvider: new CloudflareModelProvider({ env }),
    agentRouting: config.agents.routing,
    resolveBlockModel: config.agents.resolveBlockModel,
  })

  // When container implementation is opted in and its prerequisites are wired,
  // route the repo-operating steps (`coder`, `mocker`, `playwright`) to a real
  // sandbox; every other step stays inline (see CompositeAgentExecutor).
  if (config.agents.containerImpl) {
    const container = buildContainerExecutor(env, config, db, clock)
    if (container) return new CompositeAgentExecutor(inline, container)
  }
  return inline
}

/**
 * Build the container-based implementation executor, or return null when its
 * prerequisites are missing (the binding, a configured GitHub App, the proxy's
 * public URL and signing secret) — the caller then falls back to inline work.
 */
function buildContainerExecutor(
  env: Env,
  config: AppConfig,
  db: D1Database,
  clock: Clock,
): AgentExecutor | null {
  if (
    !env.IMPL_CONTAINER ||
    !config.github.enabled ||
    !env.GITHUB_APP_PRIVATE_KEY ||
    !env.WORKER_PUBLIC_URL ||
    !env.AUTH_SESSION_SECRET
  ) {
    return null
  }

  const installationRepository = new D1GitHubInstallationRepository({ db })
  const repoRepository = new D1RepoProjectionRepository({ db })
  const auth = new GitHubAppAuth({
    appId: config.github.appId,
    privateKeyPem: env.GITHUB_APP_PRIVATE_KEY,
    installationRepository,
    clock,
    apiBase: config.github.apiBase,
  })

  // Pick the repo linked to the running block, else the workspace's first repo.
  const resolveRepoTarget: ResolveRepoTarget = async (workspaceId, blockId) => {
    const installation = await installationRepository.getByWorkspace(workspaceId)
    if (!installation) return null
    const repos = await repoRepository.list(workspaceId)
    const repo = repos.find((r) => r.blockId === blockId) ?? repos[0]
    if (!repo) return null
    return {
      installationId: installation.installationId,
      owner: repo.owner,
      name: repo.name,
      baseBranch: repo.defaultBranch ?? 'main',
    }
  }

  return new ContainerAgentExecutor({
    container: env.IMPL_CONTAINER,
    agentRouting: config.agents.routing,
    resolveBlockModel: config.agents.resolveBlockModel,
    resolveRepoTarget,
    mintInstallationToken: (id) => auth.installationToken(id),
    sessionService: new ContainerSessionService({ secret: env.AUTH_SESSION_SECRET }),
    proxyBaseUrl: `${env.WORKER_PUBLIC_URL.replace(/\/+$/, '')}/v1`,
    githubApiBase: config.github.apiBase,
  })
}

/**
 * Pick how runs are driven:
 *   - a Workflows binding present → durable, server-driven execution
 *   - otherwise                   → no-op (e.g. tests, which override this anyway)
 * Tests override `workRunner` with a fake and drive the engine via advanceInstance.
 */
function selectWorkRunner(env: Env): WorkRunner {
  if (env.EXECUTION_WORKFLOW) {
    return new WorkflowsWorkRunner({
      workflow: env.EXECUTION_WORKFLOW,
      queue: env.EXECUTION_QUEUE,
    })
  }
  return new NoopWorkRunner()
}

/**
 * Pick how execution/board changes are pushed to clients:
 *   - WORKSPACE_EVENTS binding present → fan out via the per-workspace hub DO
 *   - otherwise                        → undefined (core falls back to a no-op)
 * Tests leave the binding unset; the engine simply pushes nothing.
 */
function selectEventPublisher(env: Env): ExecutionEventPublisher | undefined {
  if (!env.WORKSPACE_EVENTS) return undefined
  return new DurableObjectEventPublisher(env.WORKSPACE_EVENTS)
}

/**
 * Build the GitHub integration's concrete ports when an App is configured,
 * mirroring `selectWorkRunner`. Returns an empty object otherwise, so `createCore`
 * leaves the `github` module unassembled and the feature stays opt-in.
 */
function selectGitHubDeps(
  env: Env,
  config: AppConfig,
  db: D1Database,
  clock: Clock,
  idGenerator: IdGenerator,
): Partial<CoreDependencies> {
  if (!config.github.enabled) return {}

  const githubInstallationRepository = new D1GitHubInstallationRepository({ db })
  const auth = new GitHubAppAuth({
    appId: config.github.appId,
    privateKeyPem: env.GITHUB_APP_PRIVATE_KEY!,
    installationRepository: githubInstallationRepository,
    clock,
    apiBase: config.github.apiBase,
  })
  const githubClient = new FetchGitHubClient({
    auth,
    rateLimitRepository: new D1RateLimitRepository({ db, idGenerator }),
    idGenerator,
    clock,
    apiBase: config.github.apiBase,
  })
  return {
    githubClient,
    githubInstallationRepository,
    repoProjectionRepository: new D1RepoProjectionRepository({ db }),
    branchProjectionRepository: new D1BranchProjectionRepository({ db }),
    pullRequestProjectionRepository: new D1PullRequestProjectionRepository({ db }),
    issueProjectionRepository: new D1IssueProjectionRepository({ db }),
    commitProjectionRepository: new D1CommitProjectionRepository({ db }),
    checkRunProjectionRepository: new D1CheckRunProjectionRepository({ db }),
    webhookVerifier: new WebCryptoWebhookVerifier(env.GITHUB_WEBHOOK_SECRET!),
    // Bound the initial backfill to the commit retention horizon (0 = full).
    commitBackfillHorizonMs: config.retention.commitMs || undefined,
  }
}

/**
 * Build the Confluence integration's concrete ports when opted in. The model
 * provider is wired only in 'llm' planner mode (it just needs a provider
 * credential); the planner degrades to its deterministic parser if no model is
 * usable. Returns `{}` when disabled, so `createCore` leaves the `confluence`
 * module unassembled.
 */
function selectConfluenceDeps(
  env: Env,
  config: AppConfig,
  db: D1Database,
): Partial<CoreDependencies> {
  if (!config.confluence.enabled) return {}
  return {
    confluenceClient: new FetchConfluenceClient(),
    confluenceConnectionRepository: new D1ConfluenceConnectionRepository({ db }),
    confluenceDocumentRepository: new D1ConfluenceDocumentRepository({ db }),
    ...(config.confluence.planner === 'llm'
      ? {
          modelProvider: new CloudflareModelProvider({ env }),
          confluencePlannerModel: config.agents.routing.default.ref,
        }
      : {}),
  }
}

/**
 * Build the ephemeral environment integration's concrete ports when opted in.
 * Requires the encryption key (the config gate already enforces this), so the
 * generic HTTP provider, the D1 repositories and the Web Crypto cipher are wired
 * together. Returns `{}` when disabled, so `createCore` leaves the `environments`
 * module unassembled and the deterministic deployer / env discovery stay off.
 */
function selectEnvironmentsDeps(
  env: Env,
  config: AppConfig,
  db: D1Database,
): Partial<CoreDependencies> {
  if (!config.environments.enabled) return {}
  return {
    environmentProvider: new HttpEnvironmentProvider(),
    environmentConnectionRepository: new D1EnvironmentConnectionRepository({ db }),
    environmentRegistryRepository: new D1EnvironmentRegistryRepository({ db }),
    secretCipher: new WebCryptoSecretCipher({
      masterKeyBase64: config.environments.encryptionKey!,
    }),
  }
}

/**
 * Build the container-backed repo bootstrapper for the "bootstrap repo" task,
 * gated on the same prerequisites as the implementation container (the binding, a
 * configured GitHub App, the proxy's public URL and signing secret). Returns
 * undefined otherwise, leaving reference-architecture CRUD available while the run
 * path reports itself unavailable.
 */
function selectRepoBootstrapper(
  env: Env,
  config: AppConfig,
  db: D1Database,
  clock: Clock,
  idGenerator: IdGenerator,
): ContainerRepoBootstrapper | undefined {
  if (
    !env.IMPL_CONTAINER ||
    !config.github.enabled ||
    !env.GITHUB_APP_PRIVATE_KEY ||
    !env.WORKER_PUBLIC_URL ||
    !env.AUTH_SESSION_SECRET
  ) {
    return undefined
  }

  const installationRepository = new D1GitHubInstallationRepository({ db })
  const auth = new GitHubAppAuth({
    appId: config.github.appId,
    privateKeyPem: env.GITHUB_APP_PRIVATE_KEY,
    installationRepository,
    clock,
    apiBase: config.github.apiBase,
  })
  const githubClient = new FetchGitHubClient({
    auth,
    rateLimitRepository: new D1RateLimitRepository({ db, idGenerator }),
    idGenerator,
    clock,
    apiBase: config.github.apiBase,
  })

  return new ContainerRepoBootstrapper({
    container: env.IMPL_CONTAINER,
    installationRepository,
    githubClient,
    mintInstallationToken: (id) => auth.installationToken(id),
    sessionService: new ContainerSessionService({ secret: env.AUTH_SESSION_SECRET }),
    model: config.agents.routing.default.ref,
    proxyBaseUrl: `${env.WORKER_PUBLIC_URL.replace(/\/+$/, '')}/v1`,
    githubApiBase: config.github.apiBase,
  })
}

export function buildContainer(env: Env, overrides: Partial<CoreDependencies> = {}): Container {
  const config = loadConfig(env)
  const db = env.DB
  const clock = new SystemClock()
  const idGenerator = new CryptoIdGenerator()

  const dependencies: CoreDependencies = {
    workspaceRepository: new D1WorkspaceRepository({ db }),
    blockRepository: new D1BlockRepository({ db }),
    pipelineRepository: new D1PipelineRepository({ db }),
    executionRepository: new D1ExecutionRepository({ db, clock }),
    tokenUsageRepository: new D1TokenUsageRepository({ db }),
    idGenerator,
    clock,
    agentExecutor: selectAgentExecutor(env, config, db, clock),
    workRunner: selectWorkRunner(env),
    executionEventPublisher: selectEventPublisher(env),
    spendPricing: config.spend,
    // Repo-bootstrap repositories are wired unconditionally (reference-architecture
    // CRUD is always available); the run path additionally needs the bootstrapper.
    referenceArchitectureRepository: new D1ReferenceArchitectureRepository({ db }),
    bootstrapJobRepository: new D1BootstrapJobRepository({ db }),
    repoBootstrapper: selectRepoBootstrapper(env, config, db, clock, idGenerator),
    ...selectGitHubDeps(env, config, db, clock, idGenerator),
    ...selectConfluenceDeps(env, config, db),
    ...selectEnvironmentsDeps(env, config, db),
    ...overrides,
  }

  return { ...createCore(dependencies), config }
}
