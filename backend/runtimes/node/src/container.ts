import { AiAgentExecutor, inlineWebSearchOptionsFromEnv } from '@cat-factory/agents'
import {
  HttpRunnerPoolProvider,
  PersonalSubscriptionService,
  ProviderSubscriptionService,
  RunnerPoolConnectionService,
  RunnerPoolTransport,
  SLACK_CIPHER_INFO,
  SlackNotificationChannel,
  TicketTrackerService,
  createGitHubIssueViaToken,
} from '@cat-factory/integrations'
import type {
  AgentExecutor,
  Clock,
  GitHubClient,
  GitHubInstallationRepository,
  RateLimitRepository,
  RateLimitSnapshot,
  TaskConnectionRepository,
  TaskSourceProvider,
} from '@cat-factory/kernel'
import { type CoreDependencies, createCore } from '@cat-factory/orchestration'
import {
  type AppConfig,
  type ResolveRepoTarget,
  type ResolveRunnerTransport,
  type ServerContainer,
  CompositeAgentExecutor,
  ContainerAgentExecutor,
  ContainerSessionService,
  FetchGitHubClient,
  GitHubAppAuth,
  GitHubAppRegistry,
  GitHubCiStatusProvider,
  GitHubMergeabilityProvider,
  GitHubPullRequestMerger,
  WebCryptoPersonalSecretCipher,
  WebCryptoSecretCipher,
  buildResolveRepoTarget,
  createWebSearchUpstreamFromEnv,
  logger,
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
import { DrizzleProviderSubscriptionTokenRepository } from './repositories/providerSubscription.js'
import {
  DrizzlePersonalSubscriptionRepository,
  DrizzleSubscriptionActivationRepository,
} from './repositories/personalSubscription.js'
import { createDrizzleRepositories } from './repositories/drizzle.js'
import { DrizzleNotificationRepository } from './repositories/notifications.js'
import {
  DrizzleSlackConnectionRepository,
  DrizzleSlackMemberMappingRepository,
  DrizzleSlackSettingsRepository,
} from './repositories/slack.js'
import { DrizzleTaskConnectionRepository, DrizzleTaskRepository } from './repositories/tasks.js'
import { CryptoIdGenerator, SystemClock } from './runtime.js'
import { JiraProvider } from './tasks/JiraProvider.js'

// HKDF domain tag separating runner-pool scheduler secrets from any other use of
// the same master key (mirrors the Worker's `cat-factory:runners`).
const RUNNERS_CIPHER_INFO = 'cat-factory:runners'

/**
 * Wire the Slack integration when enabled: the notification *channel* (an extra
 * delivery transport composed onto the notification mechanism — Node has no in-app
 * channel, so this is its only one) plus the management repositories (per-account
 * connect + per-workspace routing + member map) and the bot-token cipher. The
 * per-account bot token is sealed with the shared ENCRYPTION_KEY under a
 * slack-scoped HKDF info, mirroring the Worker. OAuth credentials are optional.
 */
function selectNodeSlackDeps(
  config: AppConfig,
  db: DrizzleDb,
  repos: ReturnType<typeof createDrizzleRepositories>,
): Partial<CoreDependencies> {
  if (!config.slack.enabled || !config.slack.encryptionKey) return {}
  const secretCipher = new WebCryptoSecretCipher({
    masterKeyBase64: config.slack.encryptionKey,
    info: SLACK_CIPHER_INFO,
  })
  const slackConnectionRepository = new DrizzleSlackConnectionRepository(db)
  const slackSettingsRepository = new DrizzleSlackSettingsRepository(db)
  const slackMemberMappingRepository = new DrizzleSlackMemberMappingRepository(db)
  return {
    notificationChannel: new SlackNotificationChannel({
      workspaceRepository: repos.workspaceRepository,
      slackConnectionRepository,
      slackSettingsRepository,
      slackMemberMappingRepository,
      blockRepository: repos.blockRepository,
      secretCipher,
      // Best-effort delivery still surfaces failures (revoked token, missing channel
      // invite) through the structured logger so a broken route is diagnosable.
      onError: (error, ctx) =>
        logger.warn(
          { err: error instanceof Error ? error.message : String(error), ...ctx },
          'slack notification delivery failed',
        ),
    }),
    slackConnectionRepository,
    slackSettingsRepository,
    slackMemberMappingRepository,
    slackSecretCipher: secretCipher,
    ...(config.slack.oauth ? { slackOAuth: config.slack.oauth } : {}),
  }
}

/**
 * Rate-limit accounting is best-effort telemetry the Worker persists to D1; the Node
 * facade has no such table, so it drops the snapshots (exactly like the local facade).
 */
class NoopRateLimitRepository implements RateLimitRepository {
  record(_snapshot: RateLimitSnapshot): Promise<void> {
    return Promise.resolve()
  }
  deleteOlderThan(_epochMs: number): Promise<number> {
    return Promise.resolve(0)
  }
}

/**
 * The workspace-spanning GitHub App registry, built once and shared by everything that
 * needs an App credential: the container executor's push-token mint, the tech-debt
 * issue filer, and the CI / merge / mergeability gate client. Returns undefined when
 * the App isn't configured (`github.enabled` + `GITHUB_APP_PRIVATE_KEY`), so each
 * caller degrades the way it always has.
 */
function buildNodeAppRegistry(
  env: NodeJS.ProcessEnv,
  config: AppConfig,
  clock: Clock,
  installationRepository: GitHubInstallationRepository,
): GitHubAppRegistry | undefined {
  const privateKeyPem = env.GITHUB_APP_PRIVATE_KEY?.trim()
  if (!config.github.enabled || !privateKeyPem) return undefined
  return new GitHubAppRegistry({
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
}

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
  /**
   * Override the runner backend the container-agent steps dispatch to. When provided
   * (even as `null`) it REPLACES the default self-hosted-pool resolution, so a sibling
   * facade can supply its own transport (e.g. the local-mode Docker transport) without
   * registering a runner pool. Undefined → the default Node behaviour (resolve a
   * workspace's self-hosted pool when runner pools are enabled).
   */
  resolveTransport?: ResolveRunnerTransport | null
  /**
   * Override how the container executor mints the push/clone token. When provided it
   * REPLACES the GitHub-App token mint, so a sibling facade can authenticate with a
   * static credential instead of an App installation (e.g. a PAT in local mode). The
   * `installationId` argument is then ignored. Undefined → mint via the GitHub App
   * (requires `GITHUB_APP_PRIVATE_KEY`).
   */
  mintInstallationToken?: (installationId: number) => Promise<string>
  /**
   * A GitHub client used to wire the CI gate + the merge / mergeability providers
   * (so a run gates on real CI and merges for real). When provided, the
   * `ciStatusProvider`, `mergeabilityProvider` and `pullRequestMerger` are wired from
   * it + the resolved repo target. Undefined → those gates pass through (the existing
   * Node behaviour). The local facade passes a PAT-backed client.
   */
  githubClient?: GitHubClient
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
 * prerequisites are configured: a token source for the push/clone token, the public
 * URL backing the LLM proxy, the session secret to sign proxy tokens, and a runner
 * backend. Returns null when any is missing, so the composite fails those kinds
 * loudly rather than running them as useless one-shot LLM calls.
 *
 * The token source is pluggable: a sibling facade may pass `mintInstallationToken`
 * (e.g. a static PAT for local mode), otherwise it is minted via the GitHub App
 * registry (which additionally requires the App private key + `github.enabled`).
 */
function buildNodeContainerExecutor(
  env: NodeJS.ProcessEnv,
  config: AppConfig,
  appRegistry: GitHubAppRegistry | undefined,
  resolveRepoTarget: ResolveRepoTarget,
  resolveTransport: ResolveRunnerTransport | null,
  resolveWorkspaceModelDefault: (
    workspaceId: string,
    agentKind: string,
  ) => Promise<string | undefined>,
  mintInstallationTokenOverride?: (installationId: number) => Promise<string>,
  subscriptions?: ProviderSubscriptionService,
  personalSubscriptions?: PersonalSubscriptionService,
): AgentExecutor | null {
  // The harness reaches models only through this service's LLM proxy; `PUBLIC_URL`
  // is this service's externally reachable base (the runner pool / local container
  // must be able to reach it). Pi posts to `${PUBLIC_URL}/v1/chat/completions`.
  const publicUrl = env.PUBLIC_URL?.trim()
  const sessionSecret = config.auth.sessionSecret

  if (!publicUrl || !sessionSecret || !resolveTransport) return null

  // Token source: an explicit override (e.g. a static PAT in local mode) wins; else
  // the GitHub App registry mints a per-installation token (when the App is configured).
  const mintInstallationToken =
    mintInstallationTokenOverride ??
    (appRegistry ? (id: number) => appRegistry.installationToken(id) : undefined)
  if (!mintInstallationToken) return null

  return new ContainerAgentExecutor({
    resolveTransport,
    agentRouting: config.agents.routing,
    resolveBlockModel: config.agents.resolveBlockModel,
    resolveWorkspaceModelDefault,
    resolveRepoTarget,
    mintInstallationToken,
    sessionService: new ContainerSessionService({ secret: sessionSecret }),
    // The subscription harnesses (Claude Code / Codex) lease a pooled token and
    // attribute usage back for usage-aware rotation; absent ⇒ those harnesses are
    // unavailable and a subscription-only model fails loudly at dispatch.
    ...(subscriptions
      ? {
          leaseSubscriptionToken: (workspaceId, vendor) =>
            subscriptions.leaseToken(workspaceId, vendor),
          recordSubscriptionUsage: (workspaceId, tokenId, usage) =>
            subscriptions.recordTokenUsage(workspaceId, tokenId, usage),
          hasSubscriptionToken: (workspaceId, vendor) =>
            subscriptions.hasToken(workspaceId, vendor),
        }
      : {}),
    // Individual-usage harnesses (Claude) lease the run-initiator's OWN activated
    // personal credential; absent ⇒ such models fail loudly at dispatch.
    ...(personalSubscriptions
      ? {
          leasePersonalSubscriptionToken: (executionId, userId, vendor) =>
            personalSubscriptions.leaseForRun(executionId, userId, vendor),
        }
      : {}),
    proxyBaseUrl: `${publicUrl.replace(/\/+$/, '')}/v1`,
    // Point container agents' web search at the backend search proxy (no provider key
    // in the sandbox) whenever an upstream is configured for this deployment.
    webSearchProxyEnabled: Boolean(createWebSearchUpstreamFromEnv(env)),
    githubApiBase: config.github.apiBase,
  })
}

/**
 * Build the workspace subscription-token pool service for the Node/local facade
 * (Postgres-backed), or undefined when the shared ENCRYPTION_KEY is absent. Tokens
 * are sealed under a subscriptions-scoped HKDF info of the shared master key.
 */
function buildNodeSubscriptionService(
  env: NodeJS.ProcessEnv,
  db: DrizzleDb,
  workspaceRepository: CoreDependencies['workspaceRepository'],
  idGenerator: CoreDependencies['idGenerator'],
  clock: Clock,
): ProviderSubscriptionService | undefined {
  const masterKeyBase64 = env.ENCRYPTION_KEY?.trim()
  if (!masterKeyBase64) return undefined
  return new ProviderSubscriptionService({
    providerSubscriptionTokenRepository: new DrizzleProviderSubscriptionTokenRepository(db),
    workspaceRepository,
    secretCipher: new WebCryptoSecretCipher({
      masterKeyBase64,
      info: 'cat-factory:provider-subscriptions',
    }),
    idGenerator,
    clock,
  })
}

/**
 * Build the per-USER individual-usage subscription service (Claude) for the Node/local
 * facade (Postgres-backed), or undefined when the shared ENCRYPTION_KEY is absent.
 * Double-encrypts the credential (password layer inside the system layer). Mirrors the
 * Worker's buildPersonalSubscriptionService.
 */
function buildNodePersonalSubscriptionService(
  env: NodeJS.ProcessEnv,
  db: DrizzleDb,
  idGenerator: CoreDependencies['idGenerator'],
  clock: Clock,
): PersonalSubscriptionService | undefined {
  const masterKeyBase64 = env.ENCRYPTION_KEY?.trim()
  if (!masterKeyBase64) return undefined
  return new PersonalSubscriptionService({
    personalSubscriptionRepository: new DrizzlePersonalSubscriptionRepository(db),
    subscriptionActivationRepository: new DrizzleSubscriptionActivationRepository(db),
    secretCipher: new WebCryptoSecretCipher({
      masterKeyBase64,
      info: 'cat-factory:personal-subscriptions',
    }),
    personalCipher: new WebCryptoPersonalSecretCipher(),
    idGenerator,
    clock,
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
  config: AppConfig,
  registry: GitHubAppRegistry | undefined,
  resolveRepoTarget: ResolveRepoTarget,
): GitHubIssueFiler | undefined {
  if (!registry) return undefined

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

  // The GitHub App registry, built once when the App is configured and shared by the
  // container executor's push-token mint, the tech-debt issue filer, and the CI / merge
  // gate client below. Undefined when the App isn't configured.
  const appRegistry = buildNodeAppRegistry(env, config, clock, githubInstallationRepository)

  // The repo a running block targets (installation + owner/name), resolved from the
  // github_repos projection. Built once and shared by the container executor, the
  // GitHub-issue tracker filer, and the CI / merge providers.
  const resolveRepoTarget = buildResolveRepoTarget({
    installationRepository: githubInstallationRepository,
    repoProjectionRepository: new DrizzleRepoProjectionRepository(options.db),
    blockRepository: repos.blockRepository,
    serviceRepository: new DrizzleServiceFrameRepository(options.db),
  })

  // A sibling facade (local mode) may inject its own transport — even `null` — which
  // replaces the default self-hosted-pool resolution; undefined keeps Node's default.
  const resolveTransport =
    options.resolveTransport !== undefined
      ? options.resolveTransport
      : buildNodeResolveTransport(
          config,
          runnerPoolConnectionRepository,
          repos.workspaceRepository,
          clock,
        )
  // The subscription-token pool (Claude Code / Codex credentials), shared by the
  // container executor (lease + usage feedback) and the vendor-credential controller.
  const subscriptions = buildNodeSubscriptionService(
    env,
    options.db,
    repos.workspaceRepository,
    idGenerator,
    clock,
  )
  // The per-user individual-usage subscription store (Claude), shared by the
  // container executor's personal lease and the personal-subscription controller.
  const personalSubscriptions = buildNodePersonalSubscriptionService(
    env,
    options.db,
    idGenerator,
    clock,
  )

  const container = buildNodeContainerExecutor(
    env,
    config,
    appRegistry,
    resolveRepoTarget,
    resolveTransport,
    resolveWorkspaceModelDefault,
    options.mintInstallationToken,
    subscriptions,
    personalSubscriptions,
  )

  // Always a composite: inline kinds run as one-shot LLM calls; repo-operating kinds
  // route to the container (and fail loudly when its prerequisites are unconfigured).
  const agentExecutor = new CompositeAgentExecutor(inline, container)

  // GitHub-issue tracker: file the tech-debt pipeline's issue through the workspace's
  // own GitHub App installation (per-tenant), resolving the service's repo from the
  // github_repos projection — the same per-tenant infra the container executor uses.
  const fileGitHubIssue = buildNodeGitHubIssueFiler(config, appRegistry, resolveRepoTarget)

  // The GitHub client backing the CI gate + merge / mergeability providers: an injected
  // one wins (the local facade supplies a PAT-backed client), else — when the GitHub App
  // is configured — one minted from the shared App registry, so a stock Node deployment
  // with an App ALSO gates on real GitHub Actions CI and merges the PR for real (parity
  // with the Worker). Undefined → these stay unwired and the gates pass through.
  const githubClient: GitHubClient | undefined =
    options.githubClient ??
    (appRegistry
      ? new FetchGitHubClient({
          registry: appRegistry,
          rateLimitRepository: new NoopRateLimitRepository(),
          idGenerator,
          clock,
          apiBase: config.github.apiBase,
        })
      : undefined)
  const githubGateDeps: Partial<CoreDependencies> = githubClient
    ? {
        ciStatusProvider: new GitHubCiStatusProvider({
          githubClient,
          resolveRepoTarget,
          blockRepository: repos.blockRepository,
        }),
        mergeabilityProvider: new GitHubMergeabilityProvider({
          githubClient,
          resolveRepoTarget,
          blockRepository: repos.blockRepository,
        }),
        pullRequestMerger: new GitHubPullRequestMerger({
          githubClient,
          resolveRepoTarget,
          blockRepository: repos.blockRepository,
        }),
      }
    : {}

  const dependencies: CoreDependencies = {
    workspaceRepository: repos.workspaceRepository,
    accountRepository: repos.accountRepository,
    membershipRepository: repos.membershipRepository,
    blockRepository: repos.blockRepository,
    pipelineRepository: repos.pipelineRepository,
    executionRepository: repos.executionRepository,
    // Clear a finished run's personal-credential activation promptly (TTL sweep is the backstop).
    subscriptionActivationRepository: new DrizzleSubscriptionActivationRepository(options.db),
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
    serviceFragmentDefaultsRepository: repos.serviceFragmentDefaultsRepository,
    // Requirements-review feature (stateless reviewer + the requirements-rework
    // step). Wired identically to the Cloudflare facade's `selectRequirementsDeps`
    // so both runtimes serve the review/rework API AND substitute a block's reworked
    // requirements into the agent context (the cross-runtime conformance suite asserts
    // the substitution against both stores). The reviewer's model resolves exactly
    // like a pipeline step: block-pin > workspace per-kind default > routing default
    // (which falls back to Cloudflare Workers AI unless a direct key is set).
    requirementReviewRepository: repos.requirementReviewRepository,
    modelProvider: createNodeModelProvider(env),
    requirementReviewModel: config.agents.routing.default.ref,
    requirementReviewResolveModel: config.agents.resolveBlockModel,
    // Notifications subsystem (parity with the Worker, which wires it unconditionally):
    // the inbox + the human-action surfaces. Node has no real-time push, so the rows
    // persist (inbox + snapshot) and any channel composed below — e.g. Slack — delivers.
    notificationRepository: new DrizzleNotificationRepository(options.db),
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
    ...githubGateDeps,
    // Slack: an extra notification transport (the channel) + its management module.
    // Default-off; when enabled it composes the Slack channel onto the notification
    // mechanism, identically to the Worker.
    ...selectNodeSlackDeps(config, options.db, repos),
    ...options.overrides,
  }

  return {
    ...createCore(dependencies),
    config,
    agentRunRepository: repos.agentRunRepository,
    gateways: createNodeGateways(env),
    // The vendor-credential (subscription token pool) service the shared controller
    // reads; present when the shared ENCRYPTION_KEY is configured.
    subscriptions,
    // The per-user individual-usage subscription store (Claude); present when the
    // shared ENCRYPTION_KEY is configured.
    personalSubscriptions,
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
