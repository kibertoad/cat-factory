import {
  AiAgentExecutor,
  type AgentExecutor,
  type Core,
  type CoreDependencies,
  type DocumentSourceProvider,
  type TaskSourceProvider,
  type ExecutionEventPublisher,
  NoopWorkRunner,
  type WorkRunner,
  createCore,
  resolveAppTier,
} from '@cat-factory/core'
import { type AppConfig, loadConfig } from './config'
import type { Env } from './env'
import { CloudflareModelProvider } from './ai/CloudflareModelProvider'
import {
  ContainerAgentExecutor,
  type ResolveRepoTarget,
  type ResolveRunnerTransport,
} from './ai/ContainerAgentExecutor'
import { CloudflareContainerTransport } from './containers/CloudflareContainerTransport'
import { HttpRunnerPoolProvider } from './runners/HttpRunnerPoolProvider'
import { RunnerPoolTransport } from './runners/RunnerPoolTransport'
import { D1RunnerPoolConnectionRepository } from './repositories/D1RunnerPoolConnectionRepository'
import { RunnerPoolConnectionService } from '@cat-factory/core'
import { ContainerRepoBootstrapper } from './ai/ContainerRepoBootstrapper'
import { ContainerRepoScanner } from './ai/ContainerRepoScanner'
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
import { D1DocumentConnectionRepository } from './repositories/D1DocumentConnectionRepository'
import { D1DocumentRepository } from './repositories/D1DocumentRepository'
import { D1EnvironmentConnectionRepository } from './repositories/D1EnvironmentConnectionRepository'
import { D1EnvironmentRegistryRepository } from './repositories/D1EnvironmentRegistryRepository'
import { D1ReferenceArchitectureRepository } from './repositories/D1ReferenceArchitectureRepository'
import { D1BootstrapJobRepository } from './repositories/D1BootstrapJobRepository'
import { D1RepoBlueprintRepository } from './repositories/D1RepoBlueprintRepository'
import { HttpEnvironmentProvider } from './environments/HttpEnvironmentProvider'
import { WebCryptoSecretCipher } from './environments/WebCryptoSecretCipher'
import { GitHubAppAuth } from './github/GitHubAppAuth'
import { FetchGitHubClient } from './github/FetchGitHubClient'
import { FetchGitHubProvisioningClient } from './github/FetchGitHubProvisioningClient'
import { WebCryptoWebhookVerifier } from './github/WebCryptoWebhookVerifier'
import { ConfluenceProvider } from './documents/ConfluenceProvider'
import { NotionProvider } from './documents/NotionProvider'
import { JiraProvider } from './tasks/JiraProvider'
import { D1TaskConnectionRepository } from './repositories/D1TaskConnectionRepository'
import { D1TaskRepository } from './repositories/D1TaskRepository'
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

  // When container implementation is opted in OR a self-hosted runner pool is
  // enabled, route the repo-operating steps (`coder`, `mocker`, `playwright`) to a
  // real sandbox — a per-run Cloudflare Container or the workspace's own pool;
  // every other step stays inline (see CompositeAgentExecutor).
  if (config.agents.containerImpl || config.runners.enabled) {
    const container = buildContainerExecutor(env, config, db, clock)
    if (container) return new CompositeAgentExecutor(inline, container)
  }
  return inline
}

/**
 * Build the factory that picks a job's runner backend: a workspace's own
 * self-hosted runner pool when one is registered (and runner pools are enabled),
 * otherwise the per-run Cloudflare Container. Returns null when neither backend is
 * available, so {@link buildContainerExecutor} falls back to inline work.
 */
function buildResolveTransport(
  env: Env,
  config: AppConfig,
  db: D1Database,
  clock: Clock,
): ResolveRunnerTransport | null {
  const cloudflare = env.IMPL_CONTAINER
    ? new CloudflareContainerTransport(env.IMPL_CONTAINER)
    : null

  // The self-hosted pool path: one stateless manifest interpreter (its OAuth cache
  // shared) plus a connection service to resolve each workspace's manifest+secrets.
  let runnerService: RunnerPoolConnectionService | undefined
  let poolProvider: HttpRunnerPoolProvider | undefined
  if (config.runners.enabled) {
    runnerService = new RunnerPoolConnectionService({
      runnerPoolConnectionRepository: new D1RunnerPoolConnectionRepository({ db }),
      workspaceRepository: new D1WorkspaceRepository({ db }),
      secretCipher: new WebCryptoSecretCipher({
        masterKeyBase64: config.runners.encryptionKey!,
        info: 'cat-factory:runners',
      }),
      clock,
    })
    poolProvider = new HttpRunnerPoolProvider()
  }

  if (!cloudflare && !runnerService) return null

  return async (workspaceId) => {
    if (runnerService && poolProvider && workspaceId) {
      const resolved = await runnerService.resolve(workspaceId)
      if (resolved) {
        return new RunnerPoolTransport(poolProvider, resolved.manifest, resolved.resolveSecret)
      }
    }
    if (cloudflare) return cloudflare
    throw new Error(
      `No runner backend available for workspace '${workspaceId ?? '(unknown)'}': ` +
        `register a runner pool or enable Cloudflare Containers`,
    )
  }
}

/**
 * Build the container-based implementation executor, or return null when its
 * prerequisites are missing (a runner backend — Cloudflare Containers and/or a
 * self-hosted pool — plus a configured GitHub App, the proxy's public URL and the
 * signing secret) — the caller then falls back to inline work.
 */
function buildContainerExecutor(
  env: Env,
  config: AppConfig,
  db: D1Database,
  clock: Clock,
): AgentExecutor | null {
  if (
    !config.github.enabled ||
    !env.GITHUB_APP_PRIVATE_KEY ||
    !env.WORKER_PUBLIC_URL ||
    !env.AUTH_SESSION_SECRET
  ) {
    return null
  }

  const resolveTransport = buildResolveTransport(env, config, db, clock)
  if (!resolveTransport) return null

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
    resolveTransport,
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
 * The privileged App tier (ADR 0005), built only when a second App is configured
 * (`GITHUB_PRIVILEGED_APP_ID` + key). It carries `Administration: write` and is
 * used solely to create repos for allow-listed orgs; `canCreateReposForOrg` is the
 * (config-only) allow-list check the UI and bootstrapper guard on. Returns
 * undefined when unconfigured, so everything stays on the restricted default App.
 */
function selectPrivilegedProvisioning(
  env: Env,
  config: AppConfig,
  db: D1Database,
  clock: Clock,
):
  | {
      provisioningClient: FetchGitHubProvisioningClient
      canCreateReposForOrg: (login: string) => boolean
    }
  | undefined {
  const privileged = config.github.privilegedApp
  if (!privileged || !env.GITHUB_PRIVILEGED_APP_PRIVATE_KEY) return undefined

  const auth = new GitHubAppAuth({
    appId: privileged.appId,
    privateKeyPem: env.GITHUB_PRIVILEGED_APP_PRIVATE_KEY,
    installationRepository: new D1GitHubInstallationRepository({ db }),
    clock,
    apiBase: config.github.apiBase,
  })
  const provisioningClient = new FetchGitHubProvisioningClient({
    auth,
    apiBase: config.github.apiBase,
  })
  // Fail closed: only allow-listed orgs are privileged (see resolveAppTier).
  const tierConfig = { privilegedOrgs: privileged.privilegedOrgs }
  const canCreateReposForOrg = (login: string) => resolveAppTier(login, tierConfig) === 'privileged'
  return { provisioningClient, canCreateReposForOrg }
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
  // Privileged App tier (ADR 0005): when configured, its client backs the
  // create-repo endpoint and its allow-list flags `canCreateRepos` on the
  // connection. Absent → repo creation stays the manual "create on GitHub" flow.
  const privileged = selectPrivilegedProvisioning(env, config, db, clock)
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
    repoProvisioningClient: privileged?.provisioningClient,
    canCreateReposForOrg: privileged?.canCreateReposForOrg,
  }
}

/**
 * Build the document-source integration's concrete ports when opted in: the
 * configured source providers (Confluence, Notion, …) plus the two D1
 * repositories. The model provider is wired only in 'llm' planner mode (it just
 * needs a provider credential); the planner degrades to its deterministic parser
 * if no model is usable. Returns `{}` when disabled, so `createCore` leaves the
 * `documents` module unassembled.
 */
function selectDocumentsDeps(
  env: Env,
  config: AppConfig,
  db: D1Database,
): Partial<CoreDependencies> {
  if (!config.documents.enabled) return {}
  const providers: DocumentSourceProvider[] = []
  if (config.documents.sources.includes('confluence')) providers.push(new ConfluenceProvider())
  if (config.documents.sources.includes('notion')) providers.push(new NotionProvider())
  if (providers.length === 0) return {}
  return {
    documentSourceProviders: providers,
    documentConnectionRepository: new D1DocumentConnectionRepository({
      db,
      // The config gate guarantees the key is present when enabled; source
      // credentials are encrypted at rest under a documents-scoped HKDF info.
      cipher: new WebCryptoSecretCipher({
        masterKeyBase64: config.documents.encryptionKey!,
        info: 'cat-factory:documents',
      }),
    }),
    documentRepository: new D1DocumentRepository({ db }),
    ...(config.documents.planner === 'llm'
      ? {
          modelProvider: new CloudflareModelProvider({ env }),
          documentPlannerModel: config.agents.routing.default.ref,
        }
      : {}),
  }
}

/**
 * Build the task-source integration's concrete ports when opted in. Mirrors
 * `selectDocumentsDeps` but with no planner — issues are linked for context, not
 * expanded into board structure. Returns `{}` when disabled, so `createCore`
 * leaves the `tasks` module unassembled.
 */
function selectTasksDeps(env: Env, config: AppConfig, db: D1Database): Partial<CoreDependencies> {
  if (!config.tasks.enabled) return {}
  const providers: TaskSourceProvider[] = []
  if (config.tasks.sources.includes('jira')) providers.push(new JiraProvider())
  if (providers.length === 0) return {}
  return {
    taskSourceProviders: providers,
    taskConnectionRepository: new D1TaskConnectionRepository({
      db,
      // The config gate guarantees the key is present when enabled; source
      // credentials are encrypted at rest under a tasks-scoped HKDF info.
      cipher: new WebCryptoSecretCipher({
        masterKeyBase64: config.tasks.encryptionKey!,
        info: 'cat-factory:tasks',
      }),
    }),
    taskRepository: new D1TaskRepository({ db }),
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
 * Build the self-hosted runner-pool integration's concrete ports when opted in:
 * the D1 connection repository and a dedicated Web Crypto cipher (its own master
 * key + HKDF domain, separate from the environment module's). This assembles
 * `Core.runners` (the connection-management API); the per-job transport selection
 * lives in `buildResolveTransport` above. Returns `{}` when disabled.
 */
function selectRunnersDeps(env: Env, config: AppConfig, db: D1Database): Partial<CoreDependencies> {
  if (!config.runners.enabled) return {}
  return {
    runnerPoolConnectionRepository: new D1RunnerPoolConnectionRepository({ db }),
    runnerSecretCipher: new WebCryptoSecretCipher({
      masterKeyBase64: config.runners.encryptionKey!,
      info: 'cat-factory:runners',
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

/**
 * Build the container-backed repo scanner for the "scan repository" command,
 * gated on the same prerequisites as the implementation container (the binding, a
 * configured GitHub App, the proxy's public URL and signing secret). Returns
 * undefined otherwise, leaving blueprint reads available while the scan path
 * reports itself unavailable.
 */
function selectRepoScanner(
  env: Env,
  config: AppConfig,
  db: D1Database,
  clock: Clock,
): ContainerRepoScanner | undefined {
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

  return new ContainerRepoScanner({
    container: env.IMPL_CONTAINER,
    installationRepository,
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
    // Board-scan: the blueprint repository is wired unconditionally (reads are
    // always available); the scan path additionally needs the container scanner.
    repoBlueprintRepository: new D1RepoBlueprintRepository({ db }),
    repoScanner: selectRepoScanner(env, config, db, clock),
    ...selectGitHubDeps(env, config, db, clock, idGenerator),
    ...selectDocumentsDeps(env, config, db),
    ...selectTasksDeps(env, config, db),
    ...selectEnvironmentsDeps(env, config, db),
    ...selectRunnersDeps(env, config, db),
    ...overrides,
  }

  return { ...createCore(dependencies), config }
}
