import { AiAgentExecutor, inlineWebSearchOptionsFromEnv } from '@cat-factory/agents'
import {
  HttpRunnerPoolProvider,
  RunnerPoolConnectionService,
  RunnerPoolTransport,
  TicketTrackerService,
  createGitHubIssueViaToken,
} from '@cat-factory/integrations'
import type {
  AgentExecutor,
  BlockRepository,
  Clock,
  GitHubInstallationRepository,
  TaskConnectionRepository,
  TaskSourceProvider,
} from '@cat-factory/kernel'
import { type CoreDependencies, createCore } from '@cat-factory/orchestration'
import {
  type AppConfig,
  type ResolveRunnerTransport,
  type ServerContainer,
  CompositeAgentExecutor,
  ContainerAgentExecutor,
  ContainerSessionService,
  GitHubAppAuth,
  GitHubAppRegistry,
  WebCryptoSecretCipher,
  buildResolveRepoTarget,
  createWebSearchUpstreamFromEnv,
} from '@cat-factory/server'
import type { PgBoss } from 'pg-boss'
import { loadNodeConfig } from './config.js'
import type { DrizzleDb } from './db/client.js'
import { executionRuntime } from './execution/config.js'
import { PgBossWorkRunner } from './execution/pgBossRunner.js'
import { createNodeGateways } from './gateways.js'
import { createNodeModelProvider } from './modelProvider.js'
import {
  DrizzleGitHubInstallationRepository,
  DrizzleRepoProjectionRepository,
  DrizzleRunnerPoolConnectionRepository,
  DrizzleServiceFrameRepository,
} from './repositories/containerExecution.js'
import { createDrizzleRepositories } from './repositories/drizzle.js'
import { DrizzleTaskConnectionRepository, DrizzleTaskRepository } from './repositories/tasks.js'
import { CryptoIdGenerator, SystemClock } from './runtime.js'
import { JiraProvider } from './tasks/JiraProvider.js'

// HKDF domain tag separating runner-pool scheduler secrets from any other use of
// the same master key (mirrors the Worker's `cat-factory:runners`).
const RUNNERS_CIPHER_INFO = 'cat-factory:runners'

export interface NodeContainerOptions {
  /** The Drizzle/Postgres client (the single persistence layer). */
  db: DrizzleDb
  /**
   * Pre-built repositories; defaults to building them from {@link db}. Lets the caller
   * (e.g. {@link start}) share one set with the retention sweeper rather than rebuild.
   */
  repos?: ReturnType<typeof createDrizzleRepositories>
  /**
   * Started pg-boss instance for durable execution. When present the container wires
   * a {@link PgBossWorkRunner}; otherwise runs fall back to the engine's NoopWorkRunner
   * (the caller drives runs itself — e.g. tests).
   */
  boss?: PgBoss
  /** Pre-resolved config; defaults to `loadNodeConfig(env)`. */
  config?: AppConfig
  /** Environment source; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
  /** Override core dependencies — used by tests (e.g. a fake agent executor). */
  overrides?: Partial<CoreDependencies>
}

/**
 * Resolve which runner backend a workspace's container jobs dispatch to. The Node
 * facade has no built-in per-run container runtime (unlike the Worker's Cloudflare
 * Containers), so it serves a workspace's self-hosted runner pool when one is
 * registered and throws a clear error otherwise. Returns null (no transport at all)
 * when runner pools are not enabled. Mirrors the Worker's `buildResolveTransport`,
 * minus the Cloudflare-container path.
 */
function buildNodeResolveTransport(
  config: AppConfig,
  runnerPoolConnectionRepository: DrizzleRunnerPoolConnectionRepository,
  workspaceRepository: CoreDependencies['workspaceRepository'],
  clock: Clock,
): ResolveRunnerTransport | null {
  if (!config.runners.enabled || !config.runners.encryptionKey) return null
  const runnerService = new RunnerPoolConnectionService({
    runnerPoolConnectionRepository,
    workspaceRepository,
    secretCipher: new WebCryptoSecretCipher({
      masterKeyBase64: config.runners.encryptionKey,
      info: RUNNERS_CIPHER_INFO,
    }),
    clock,
  })
  const poolProvider = new HttpRunnerPoolProvider()
  return async (workspaceId) => {
    if (workspaceId) {
      const resolved = await runnerService.resolve(workspaceId)
      if (resolved) {
        return new RunnerPoolTransport(poolProvider, resolved.manifest, resolved.resolveSecret)
      }
    }
    throw new Error(
      `No runner backend available for workspace '${workspaceId ?? '(unknown)'}': the Node ` +
        `service runs repo-operating agents on a self-hosted runner pool — register one for ` +
        `this workspace (POST /workspaces/:id/runner-pools).`,
    )
  }
}

/**
 * Build the container agent executor (repo-operating steps: coder, mocker,
 * playwright, blueprints, ci-fixer, conflict-resolver, merger) when its
 * prerequisites are configured: the GitHub App (id + private key) to mint the push
 * token, the public URL backing the LLM proxy, the session secret to sign proxy
 * tokens, and a runner backend. Returns null when any is missing, so the composite
 * fails those kinds loudly rather than running them as useless one-shot LLM calls.
 */
function buildNodeContainerExecutor(
  env: NodeJS.ProcessEnv,
  config: AppConfig,
  db: DrizzleDb,
  clock: Clock,
  installationRepository: GitHubInstallationRepository,
  blockRepository: BlockRepository,
  resolveTransport: ResolveRunnerTransport | null,
  resolveWorkspaceModelDefault: (
    workspaceId: string,
    agentKind: string,
  ) => Promise<string | undefined>,
): AgentExecutor | null {
  const privateKeyPem = env.GITHUB_APP_PRIVATE_KEY?.trim()
  // The harness reaches models only through this service's LLM proxy; `PUBLIC_URL`
  // is this service's externally reachable base (the runner pool must be able to
  // reach it). Pi posts to `${PUBLIC_URL}/v1/chat/completions`.
  const publicUrl = env.PUBLIC_URL?.trim()
  const sessionSecret = config.auth.sessionSecret

  if (
    !config.github.enabled ||
    !privateKeyPem ||
    !publicUrl ||
    !sessionSecret ||
    !resolveTransport
  ) {
    return null
  }

  const registry = new GitHubAppRegistry({
    default: {
      appId: config.github.appId,
      auth: new GitHubAppAuth({
        appId: config.github.appId,
        privateKeyPem,
        installationRepository,
        clock,
        apiBase: config.github.apiBase,
      }),
    },
    installationRepository,
  })

  return new ContainerAgentExecutor({
    resolveTransport,
    agentRouting: config.agents.routing,
    resolveBlockModel: config.agents.resolveBlockModel,
    resolveWorkspaceModelDefault,
    resolveRepoTarget: buildResolveRepoTarget({
      installationRepository,
      repoProjectionRepository: new DrizzleRepoProjectionRepository(db),
      blockRepository,
      serviceRepository: new DrizzleServiceFrameRepository(db),
    }),
    mintInstallationToken: (id) => registry.installationToken(id),
    sessionService: new ContainerSessionService({ secret: sessionSecret }),
    proxyBaseUrl: `${publicUrl.replace(/\/+$/, '')}/v1`,
    // Point container agents' web search at the backend search proxy (no provider key
    // in the sandbox) whenever an upstream is configured for this deployment.
    webSearchProxyEnabled: Boolean(createWebSearchUpstreamFromEnv(env)),
    githubApiBase: config.github.apiBase,
  })
}

/** Files a GitHub issue for a service frame, or null when none can be resolved. */
type GitHubIssueFiler = (request: {
  workspaceId: string
  frameId: string
  title: string
  body: string
}) => Promise<{ externalId: string; url: string } | null>

/**
 * Build the GitHub-issue tracker filer for the tech-debt pipeline when the GitHub
 * App is configured. It resolves the service's repo from the workspace's
 * `github_repos` projection and mints a short-lived token from that workspace's OWN
 * App installation (per-tenant) — the same infra the container executor uses — then
 * files the issue via the token. Returns undefined when the App isn't configured (the
 * GitHub tracker then passes through). A run whose service isn't linked to a repo
 * resolves to null (a clean pass-through, not a run failure).
 */
function buildNodeGitHubIssueFiler(
  env: NodeJS.ProcessEnv,
  config: AppConfig,
  db: DrizzleDb,
  clock: Clock,
  installationRepository: GitHubInstallationRepository,
  blockRepository: BlockRepository,
): GitHubIssueFiler | undefined {
  const privateKeyPem = env.GITHUB_APP_PRIVATE_KEY?.trim()
  if (!config.github.enabled || !privateKeyPem) return undefined

  const registry = new GitHubAppRegistry({
    default: {
      appId: config.github.appId,
      auth: new GitHubAppAuth({
        appId: config.github.appId,
        privateKeyPem,
        installationRepository,
        clock,
        apiBase: config.github.apiBase,
      }),
    },
    installationRepository,
  })
  const resolveRepoTarget = buildResolveRepoTarget({
    installationRepository,
    repoProjectionRepository: new DrizzleRepoProjectionRepository(db),
    blockRepository,
    serviceRepository: new DrizzleServiceFrameRepository(db),
  })

  return async (request) => {
    let repo: Awaited<ReturnType<typeof resolveRepoTarget>>
    try {
      repo = await resolveRepoTarget(request.workspaceId, request.frameId)
    } catch {
      // The service isn't linked to a repo — nothing to file against; pass through.
      return null
    }
    if (!repo) return null
    const token = await registry.installationToken(repo.installationId)
    const issue = await createGitHubIssueViaToken({
      fetchImpl: fetch,
      token,
      owner: repo.owner,
      repo: repo.name,
      title: request.title,
      body: request.body,
      apiBase: config.github.apiBase,
    })
    return { externalId: `${repo.owner}/${repo.name}#${issue.number}`, url: issue.url }
  }
}

/**
 * The Node composition root: assemble the framework-agnostic domain `Core` with
 * Drizzle/Postgres repositories + Node implementations of the runtime ports, then
 * attach the shared-controller extras (`config`, the kind-spanning agent-run repo,
 * the runtime gateways). The same persistence is used in dev, test and prod — tests
 * run against a real Postgres, exactly as the Worker runs against a real D1.
 *
 * Repo-operating agent steps (coder, blueprints, merger, …) run in a container
 * dispatched to a workspace's self-hosted runner pool — the shared
 * `ContainerAgentExecutor`, exactly as on the Worker. When the prerequisites (GitHub
 * App, `PUBLIC_URL`, `AUTH_SESSION_SECRET`, `ENCRYPTION_KEY`) are absent the
 * composite still serves inline kinds but fails container kinds loudly.
 */
export function buildNodeContainer(options: NodeContainerOptions): ServerContainer {
  const env = options.env ?? process.env
  const config = options.config ?? loadNodeConfig(env)
  const clock = new SystemClock()
  const idGenerator = new CryptoIdGenerator()
  const repos = options.repos ?? createDrizzleRepositories(options.db, clock)

  // Honour the workspace's per-agent-kind defaults at run time (block-pinned >
  // workspace per-kind default > env routing), uniformly for inline and container kinds.
  const resolveWorkspaceModelDefault = (workspaceId: string, agentKind: string) =>
    repos.modelDefaultsRepository.getForKind(workspaceId, agentKind).then((v) => v ?? undefined)

  const inline = new AiAgentExecutor({
    modelProvider: createNodeModelProvider(env),
    agentRouting: config.agents.routing,
    resolveBlockModel: config.agents.resolveBlockModel,
    resolveWorkspaceModelDefault,
    // Opt-in provider web search for the inline design/research kinds (no-op unless
    // INLINE_WEB_SEARCH_ENABLED and an Anthropic/OpenAI model).
    webSearch: inlineWebSearchOptionsFromEnv(env),
  })

  // Task-source integration (Jira). Always on (config load requires ENCRYPTION_KEY);
  // tenants connect their own Jira site through the UI and the credentials are stored
  // per-workspace, encrypted at rest. The tracker resolves each workspace's own
  // credentials from this same store (multi-tenant), mirroring the Cloudflare facade.
  const tasks = selectNodeTasksDeps(config, options.db)

  // Persistence the container-execution path needs (built from the same db). The
  // runner-pool repo also backs the `runners` Core module so a pool is registrable
  // via the API; the installation repo backs both token minting and repo resolution.
  const runnerPoolConnectionRepository = new DrizzleRunnerPoolConnectionRepository(options.db)
  const githubInstallationRepository = new DrizzleGitHubInstallationRepository(options.db)

  const resolveTransport = buildNodeResolveTransport(
    config,
    runnerPoolConnectionRepository,
    repos.workspaceRepository,
    clock,
  )
  const container = buildNodeContainerExecutor(
    env,
    config,
    options.db,
    clock,
    githubInstallationRepository,
    repos.blockRepository,
    resolveTransport,
    resolveWorkspaceModelDefault,
  )

  // Always a composite: inline kinds run as one-shot LLM calls; repo-operating kinds
  // route to the container (and fail loudly when its prerequisites are unconfigured).
  const agentExecutor = new CompositeAgentExecutor(inline, container)

  // GitHub-issue tracker: file the tech-debt pipeline's issue through the workspace's
  // own GitHub App installation (per-tenant), resolving the service's repo from the
  // github_repos projection — the same per-tenant infra the container executor uses.
  const fileGitHubIssue = buildNodeGitHubIssueFiler(
    env,
    config,
    options.db,
    clock,
    githubInstallationRepository,
    repos.blockRepository,
  )

  const dependencies: CoreDependencies = {
    workspaceRepository: repos.workspaceRepository,
    accountRepository: repos.accountRepository,
    membershipRepository: repos.membershipRepository,
    blockRepository: repos.blockRepository,
    pipelineRepository: repos.pipelineRepository,
    executionRepository: repos.executionRepository,
    // In-org shared services. NOTE: the Node facade has no real-time transport yet (runs fall
    // back to the engine's NoopEventPublisher), so it does NOT wrap a FanOutEventPublisher the
    // way the Cloudflare facade does. When real-time lands here, decorate the publisher with
    // `FanOutEventPublisher` (from @cat-factory/server) — wired with these two repos — to fan a
    // shared service's live events out to every board that mounts it.
    serviceRepository: repos.serviceRepository,
    workspaceMountRepository: repos.workspaceMountRepository,
    tokenUsageRepository: repos.tokenUsageRepository,
    llmCallMetricRepository: repos.llmCallMetricRepository,
    recordLlmPrompts: config.observability.recordPrompts,
    modelDefaultsRepository: repos.modelDefaultsRepository,
    ...tasks.deps,
    // Recurring pipelines + the workspace tracker selection. The tracker provider
    // files the tech-debt pipeline's issue by resolving the *workspace's* connected
    // integration: GitHub issues through the workspace's GitHub App installation,
    // Jira tickets from the per-workspace encrypted connection store — both per-tenant.
    pipelineScheduleRepository: repos.pipelineScheduleRepository,
    trackerSettingsRepository: repos.trackerSettingsRepository,
    ticketTrackerProvider: new TicketTrackerService({
      trackerSettingsRepository: repos.trackerSettingsRepository,
      fetchImpl: fetch,
      ...(fileGitHubIssue ? { fileGitHubIssue } : {}),
      ...(tasks.taskConnectionRepository
        ? {
            resolveJiraConnection: async (workspaceId) => {
              const connection = await tasks.taskConnectionRepository!.getByWorkspace(
                workspaceId,
                'jira',
              )
              const { baseUrl, accountEmail, apiToken } = connection?.credentials ?? {}
              if (!baseUrl || !accountEmail || !apiToken) return null
              return { baseUrl, accountEmail, apiToken }
            },
          }
        : {}),
    }),
    idGenerator,
    clock,
    agentExecutor,
    spendPricing: config.spend,
    // The runner-pool integration assembles when enabled, so a workspace can
    // register the self-hosted pool its container agents dispatch to.
    ...(config.runners.enabled && config.runners.encryptionKey
      ? {
          runnerPoolConnectionRepository,
          runnerSecretCipher: new WebCryptoSecretCipher({
            masterKeyBase64: config.runners.encryptionKey,
            info: RUNNERS_CIPHER_INFO,
          }),
        }
      : {}),
    ...(options.boss
      ? { workRunner: new PgBossWorkRunner(options.boss, executionRuntime(config, env).queue) }
      : {}),
    ...options.overrides,
  }

  return {
    ...createCore(dependencies),
    config,
    agentRunRepository: repos.agentRunRepository,
    gateways: createNodeGateways(env),
  }
}

/**
 * Wire the task-source integration for the Node facade when it is enabled (the
 * `tasks` module then assembles so tenants can connect Jira through the existing
 * UI). Returns the `CoreDependencies` fragment plus the connection repository so the
 * tracker can resolve each workspace's Jira credentials from the same store.
 * No registered providers → `{ deps: {} }` and both the tasks module and the Jira
 * tracker stay off (the encryption key is guaranteed present by `loadTasksConfig`).
 */
function selectNodeTasksDeps(
  config: AppConfig,
  db: DrizzleDb,
): { deps: Partial<CoreDependencies>; taskConnectionRepository?: TaskConnectionRepository } {
  if (!config.tasks.enabled || !config.tasks.encryptionKey) return { deps: {} }
  const providers: TaskSourceProvider[] = []
  if (config.tasks.sources.includes('jira')) providers.push(new JiraProvider())
  if (providers.length === 0) return { deps: {} }

  const taskConnectionRepository = new DrizzleTaskConnectionRepository(
    db,
    // Source credentials are encrypted at rest under a tasks-scoped HKDF info (the
    // same domain the Cloudflare facade uses), keyed by the shared ENCRYPTION_KEY.
    new WebCryptoSecretCipher({
      masterKeyBase64: config.tasks.encryptionKey,
      info: 'cat-factory:tasks',
    }),
  )
  return {
    deps: {
      taskSourceProviders: providers,
      taskConnectionRepository,
      taskRepository: new DrizzleTaskRepository(db),
    },
    taskConnectionRepository,
  }
}
