import {
  AiAgentExecutor,
  LlmFragmentSelector,
  inlineWebSearchOptionsFromEnv,
  resolveAgentConfig,
} from '@cat-factory/agents'
import {
  ConfluenceProvider,
  GitHubDocsProvider,
  HttpEnvironmentProvider,
  HttpRunnerPoolProvider,
  NotionProvider,
  PersonalSubscriptionService,
  ProviderSubscriptionService,
  RunnerPoolConnectionService,
  RunnerPoolTransport,
  EMAIL_CIPHER_INFO,
  SLACK_CIPHER_INFO,
  SlackNotificationChannel,
  TicketTrackerService,
  createGitHubIssueViaToken,
} from '@cat-factory/integrations'
import type {
  AgentExecutor,
  Clock,
  DocumentSourceProvider,
  FragmentOwnerKind,
  GitHubClient,
  GitHubInstallationRepository,
  ModelProvider,
  RateLimitRepository,
  RateLimitSnapshot,
  TaskConnectionRepository,
  TaskSourceProvider,
} from '@cat-factory/kernel'
import { type CoreDependencies, createCore } from '@cat-factory/orchestration'
import { createLangfuseSink } from '@cat-factory/observability-langfuse'
import {
  type AppConfig,
  type ResolveRepoTarget,
  type ResolveRunnerTransport,
  type ServerContainer,
  CompositeAgentExecutor,
  ContainerAgentExecutor,
  ContainerRepoBootstrapper,
  ContainerSessionService,
  FetchGitHubClient,
  GitHubAppAuth,
  GitHubAppRegistry,
  GitHubCiStatusProvider,
  GitHubMergeabilityProvider,
  GitHubPullRequestMerger,
  WebCryptoPasswordHasher,
  WebCryptoPersonalSecretCipher,
  WebCryptoSecretCipher,
  WebCryptoWebhookVerifier,
  buildResolveRepoTarget,
  createWebSearchUpstreamFromEnv,
  ensureWorkBranchViaRest,
  logger,
} from '@cat-factory/server'
import type { PgBoss } from 'pg-boss'
import { loadNodeConfig } from './config.js'
import type { DrizzleDb } from './db/client.js'
import { executionRuntime } from './execution/config.js'
import { PgBossBootstrapRunner } from './execution/bootstrapRunner.js'
import { PgBossWorkRunner } from './execution/pgBossRunner.js'
import { createNodeGateways } from './gateways.js'
import { createNodeModelProvider } from './modelProvider.js'
import {
  DrizzleGitHubInstallationRepository,
  DrizzleRunnerPoolConnectionRepository,
  DrizzleServiceFrameRepository,
} from './repositories/containerExecution.js'
import {
  DrizzleBranchProjectionRepository,
  DrizzleCheckRunProjectionRepository,
  DrizzleCommitProjectionRepository,
  DrizzleIssueProjectionRepository,
  DrizzlePullRequestProjectionRepository,
  DrizzleRepoProjectionRepository,
} from './repositories/github.js'
import { DrizzleProviderSubscriptionTokenRepository } from './repositories/providerSubscription.js'
import {
  DrizzlePersonalSubscriptionRepository,
  DrizzleSubscriptionActivationRepository,
} from './repositories/personalSubscription.js'
import { createDrizzleRepositories } from './repositories/drizzle.js'
import {
  DrizzleBootstrapJobRepository,
  DrizzleReferenceArchitectureRepository,
} from './repositories/bootstrap.js'
import {
  DrizzleDocumentConnectionRepository,
  DrizzleDocumentRepository,
} from './repositories/documents.js'
import {
  DrizzleEnvironmentConnectionRepository,
  DrizzleEnvironmentRegistryRepository,
} from './repositories/environments.js'
import {
  DrizzleFragmentSourceRepository,
  DrizzlePromptFragmentRepository,
} from './repositories/fragments.js'
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

// Memoised per object so a container build shares ONE model provider (hence one inline
// Langfuse sink) across the agent executor, requirements reviewer, doc planner and
// fragment selector, and ONE core trace sink — instead of each call constructing its
// own. Mirrors the Worker's `buildModelProvider` memoisation.
const modelProviderCache = new WeakMap<NodeJS.ProcessEnv, ModelProvider>()
const langfuseSinkCache = new WeakMap<AppConfig, CoreDependencies['llmTraceSink']>()

/** The Node model provider (instrumented when Langfuse is on), shared per `env`. */
function buildModelProvider(env: NodeJS.ProcessEnv): ModelProvider {
  const cached = modelProviderCache.get(env)
  if (cached) return cached
  const provider = createNodeModelProvider(env)
  modelProviderCache.set(env, provider)
  return provider
}

/**
 * Build the opt-in Langfuse trace sink (fetch-based, so identical to the Worker's
 * `selectLangfuseSink`). Returns undefined unless `LANGFUSE_ENABLED=true` and both keys
 * are set; the observability service then fans every recorded LLM call out to it.
 * Memoised per config so both wiring sites share one sink instance.
 */
function buildLangfuseSink(config: AppConfig): CoreDependencies['llmTraceSink'] {
  if (langfuseSinkCache.has(config)) return langfuseSinkCache.get(config)
  const sink =
    !config.langfuse.enabled || !config.langfuse.publicKey || !config.langfuse.secretKey
      ? undefined
      : createLangfuseSink({
          publicKey: config.langfuse.publicKey,
          secretKey: config.langfuse.secretKey,
          baseUrl: config.langfuse.baseUrl,
          logger,
        })
  langfuseSinkCache.set(config, sink)
  return sink
}

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
 * Wire account invitations + per-account email senders for the Node facade (parity
 * with the Worker's `selectEmailInvitationDeps`). Invitations are always available (an
 * invite link works without email); the email-connection store + cipher are wired only
 * when EMAIL is enabled, so an account can onboard a SendGrid/Resend key in the UI and
 * have invites emailed. The provider key is sealed with the shared ENCRYPTION_KEY.
 */
function selectNodeEmailInvitationDeps(
  config: AppConfig,
  repos: ReturnType<typeof createDrizzleRepositories>,
): Partial<CoreDependencies> {
  const deps: Partial<CoreDependencies> = {
    invitationRepository: repos.invitationRepository,
    appBaseUrl: config.email.appBaseUrl || undefined,
  }
  if (config.email.enabled && config.email.encryptionKey) {
    deps.emailConnectionRepository = repos.emailConnectionRepository
    deps.emailSecretCipher = new WebCryptoSecretCipher({
      masterKeyBase64: config.email.encryptionKey,
      info: EMAIL_CIPHER_INFO,
    })
  }
  return deps
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
    // Ensure the shared per-task work branch up front so every agent (including the
    // read-only architect) operates on the same branch — idempotent, best-effort. Writers
    // create it from base; read-only agents only probe (`options.create`).
    ensureWorkBranch: async (repo, branch, options) =>
      ensureWorkBranchViaRest({
        ...(config.github.apiBase ? { apiBase: config.github.apiBase } : {}),
        token: await mintInstallationToken(repo.installationId),
        owner: repo.owner,
        name: repo.name,
        baseBranch: repo.baseBranch,
        branch,
        create: options.create,
      }),
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
          // Route a dual-mode individual model (GLM) to the initiator's own subscription
          // when they have one; otherwise dispatch keeps it on the Cloudflare base.
          hasPersonalSubscription: (userId, vendor) => personalSubscriptions.has(userId, vendor),
        }
      : {}),
    proxyBaseUrl: `${publicUrl.replace(/\/+$/, '')}/v1`,
    // Point container agents' web search at the backend search proxy (no provider key
    // in the sandbox) whenever an upstream is configured for this deployment.
    webSearchProxyEnabled: Boolean(createWebSearchUpstreamFromEnv(env)),
    githubApiBase: config.github.apiBase,
    // Forward container tool spans to Langfuse (when configured) as child spans under
    // the run trace — the same sink the LLM proxy fans generations out to.
    llmTraceSink: buildLangfuseSink(config),
  })
}

/**
 * Build the repo bootstrapper (the "bootstrap repo" container dispatch) when its
 * prerequisites are configured — mirroring the Worker's `selectRepoBootstrapper` and
 * the container-executor prerequisites: a resolvable runner transport, the public URL
 * + session secret backing the LLM proxy, a token source, and a GitHub client.
 * Returns undefined otherwise (the bootstrap module then has no runner and the service
 * reports a clean dispatch failure). Bootstrap is an `architect`-kind run, so it
 * follows that kind's routing. The promoted `ContainerRepoBootstrapper` dispatches
 * through the same shared runner seam the container executor uses, so on Node it runs
 * against the self-hosted pool and on local against the per-job Docker container.
 */
function selectNodeRepoBootstrapper(deps: {
  env: NodeJS.ProcessEnv
  config: AppConfig
  resolveTransport: ResolveRunnerTransport | null
  installationRepository: GitHubInstallationRepository
  bootstrapJobRepository: ConstructorParameters<
    typeof ContainerRepoBootstrapper
  >[0]['bootstrapJobRepository']
  repoRepository: ConstructorParameters<typeof ContainerRepoBootstrapper>[0]['repoRepository']
  githubClient: GitHubClient | undefined
  mintInstallationToken: ((installationId: number) => Promise<string>) | undefined
}): ContainerRepoBootstrapper | undefined {
  const publicUrl = deps.env.PUBLIC_URL?.trim()
  const sessionSecret = deps.config.auth.sessionSecret
  if (
    !deps.resolveTransport ||
    !publicUrl ||
    !sessionSecret ||
    !deps.githubClient ||
    !deps.mintInstallationToken
  ) {
    return undefined
  }
  return new ContainerRepoBootstrapper({
    resolveTransport: deps.resolveTransport,
    installationRepository: deps.installationRepository,
    bootstrapJobRepository: deps.bootstrapJobRepository,
    repoRepository: deps.repoRepository,
    githubClient: deps.githubClient,
    mintInstallationToken: deps.mintInstallationToken,
    sessionService: new ContainerSessionService({ secret: sessionSecret }),
    model: resolveAgentConfig(deps.config.agents.routing, 'architect').ref,
    proxyBaseUrl: `${publicUrl.replace(/\/+$/, '')}/v1`,
    githubApiBase: deps.config.github.apiBase,
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
    modelProvider: buildModelProvider(env),
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
  // The repositories projection (+ sync cursors), shared by `buildResolveRepoTarget`
  // (block→repo resolution) and the GitHub sync/webhook module below.
  const repoProjectionRepository = new DrizzleRepoProjectionRepository(options.db)

  // The GitHub App registry, built once when the App is configured and shared by the
  // container executor's push-token mint, the tech-debt issue filer, and the CI / merge
  // gate client below. Undefined when the App isn't configured.
  const appRegistry = buildNodeAppRegistry(env, config, clock, githubInstallationRepository)

  // The repo a running block targets (installation + owner/name), resolved from the
  // github_repos projection. Built once and shared by the container executor, the
  // GitHub-issue tracker filer, and the CI / merge providers.
  const resolveRepoTarget = buildResolveRepoTarget({
    installationRepository: githubInstallationRepository,
    repoProjectionRepository,
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

  // GitHub installation + projections + sync/webhook module: wired when the App is
  // configured (a real githubClient), mirroring the Worker's selectGitHubDeps. This
  // turns the GitHub read endpoints + the inline webhook/backfill sync on for Node —
  // the sync engine (GitHubSyncService) is runtime-neutral, so populating the
  // projection repos here makes the inline ingest actually persist (parity with the
  // Worker, which fans the same sync through a queue/Workflow). `canCreateRepos` /
  // `workflowsGranted` come from the App registry when present (advisory).
  const githubModuleDeps: Partial<CoreDependencies> =
    config.github.enabled && githubClient
      ? {
          githubClient,
          githubInstallationRepository,
          repoProjectionRepository,
          branchProjectionRepository: new DrizzleBranchProjectionRepository(options.db),
          pullRequestProjectionRepository: new DrizzlePullRequestProjectionRepository(options.db),
          issueProjectionRepository: new DrizzleIssueProjectionRepository(options.db),
          commitProjectionRepository: new DrizzleCommitProjectionRepository(options.db),
          checkRunProjectionRepository: new DrizzleCheckRunProjectionRepository(options.db),
          webhookVerifier: new WebCryptoWebhookVerifier(config.github.webhookSecret),
          // Bound the initial backfill to the commit retention horizon (0 = full).
          commitBackfillHorizonMs: config.retention.commitMs || undefined,
          ...(appRegistry
            ? {
                canCreateRepos: (installation) => appRegistry.canCreateRepos(installation),
                workflowsGranted: async (installation) => {
                  const perms = await appRegistry.installationPermissions(
                    installation.installationId,
                  )
                  return perms.workflows === 'write'
                },
              }
            : {}),
        }
      : {}

  // Repo-bootstrap: the reference-architecture library + the bootstrap runs (stored as
  // kind='bootstrap' rows of agent_runs). The repos are wired unconditionally (the
  // module + ref-arch CRUD then work like the Worker); the container-dispatching
  // `repoBootstrapper` wires only when its prerequisites are met (transport + proxy +
  // token + GitHub client) — the same token source the container executor uses.
  const bootstrapJobRepository = new DrizzleBootstrapJobRepository(options.db)
  const bootstrapMintInstallationToken =
    options.mintInstallationToken ??
    (appRegistry ? (id: number) => appRegistry.installationToken(id) : undefined)
  const repoBootstrapper = selectNodeRepoBootstrapper({
    env,
    config,
    resolveTransport,
    installationRepository: githubInstallationRepository,
    bootstrapJobRepository,
    repoRepository: repoProjectionRepository,
    githubClient,
    mintInstallationToken: bootstrapMintInstallationToken,
  })

  const dependencies: CoreDependencies = {
    workspaceRepository: repos.workspaceRepository,
    accountRepository: repos.accountRepository,
    membershipRepository: repos.membershipRepository,
    userRepository: repos.userRepository,
    passwordHasher: new WebCryptoPasswordHasher(),
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
    // Opt-in Langfuse trace sink (fans every recorded LLM call out as a generation).
    // Built only when configured; otherwise undefined and there is no external emission.
    llmTraceSink: buildLangfuseSink(config),
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
    // Merge threshold presets: the per-workspace auto-merge ceiling library a task's
    // merge gate resolves (block-pinned preset > workspace default). Wired
    // unconditionally, exactly like the Worker's `selectMergeLifecycleDeps`, so the
    // preset CRUD API + the merger step's threshold resolution work identically.
    mergePresetRepository: repos.mergePresetRepository,
    // Board-scan: the persisted repository blueprints (the service → modules map the
    // blueprint pipeline step reconciles, and the manual scan command writes). Wiring
    // the repo makes the board-scan module + blueprint read endpoints available, like
    // the Worker (which wires it unconditionally). Actually *running* a scan also needs
    // a `repoScanner` — a per-run container that clones + decomposes the repo. The Node
    // facade has no such synchronous scanner, so `service.canScan` stays false and the
    // scan endpoint returns its graceful 503 (the blueprint decomposition itself runs as
    // a normal `blueprints` pipeline step through the runner transport, like the Worker).
    repoBlueprintRepository: repos.repoBlueprintRepository,
    modelProvider: buildModelProvider(env),
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
      ? {
          workRunner: new PgBossWorkRunner(options.boss, executionRuntime(config, env).queue),
          // The durable bootstrap driver (analogue of the Worker's BootstrapWorkflow):
          // BootstrapService.startRun enqueues a drive job that polls the run to terminal.
          bootstrapRunner: new PgBossBootstrapRunner(
            options.boss,
            executionRuntime(config, env).queue,
          ),
        }
      : {}),
    ...githubGateDeps,
    // GitHub installation + repo/branch/PR/issue/commit/check-run projections + the
    // sync/webhook module (inline ingest persists to these repos on Node).
    ...githubModuleDeps,
    // Repo-bootstrap: the reference-architecture library + bootstrap-run store make the
    // module + API available; `repoBootstrapper` (when wired) dispatches the bootstrap
    // container through the shared runner seam, and `bootstrapRunner` (pg-boss, below)
    // durably drives its poll loop — parity with the Worker's BootstrapWorkflow.
    referenceArchitectureRepository: new DrizzleReferenceArchitectureRepository(options.db),
    bootstrapJobRepository,
    ...(repoBootstrapper ? { repoBootstrapper } : {}),
    // Document sources (Confluence / Notion / GitHub docs): wired from the shared
    // integration providers exactly like the Worker, so a workspace can connect a
    // source and import requirement/PRD/RFC pages as agent context.
    ...selectNodeDocumentsDeps(config, options.db, githubClient, githubInstallationRepository),
    // Ephemeral environments (opt-in): a workspace registers its own environment
    // management API; the tester provisions/destroys per-run environments from it.
    ...selectNodeEnvironmentsDeps(config, options.db),
    // Prompt-fragment library (ADR 0006; opt-in): the managed tenant-scoped catalog
    // of best-practice fragments feeding every agent run, wired exactly like the
    // Worker's selectFragmentLibraryDeps (repos + installation resolver + selector).
    ...selectNodeFragmentLibraryDeps(
      config,
      env,
      options.db,
      githubClient,
      githubInstallationRepository,
    ),
    // Slack: an extra notification transport (the channel) + its management module.
    // Default-off; when enabled it composes the Slack channel onto the notification
    // mechanism, identically to the Worker.
    ...selectNodeSlackDeps(config, options.db, repos),
    // Account invitations + per-account email senders (UI-onboarded, DB-stored).
    ...selectNodeEmailInvitationDeps(config, repos),
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

/**
 * Wire the document-source integration for the Node facade, mirroring the Worker's
 * `selectDocumentsDeps`: the shared `@cat-factory/integrations` provider shells
 * (Confluence/Notion always; GitHub-docs only when a GitHub client is available, since
 * it reuses the workspace's App installation), the Drizzle connection/document repos,
 * and — in `llm` planner mode — the default model ref the doc→board planner runs with
 * (the container's `modelProvider` is shared). Source credentials are encrypted at rest
 * under a documents-scoped HKDF info, keyed by the shared ENCRYPTION_KEY.
 */
function selectNodeDocumentsDeps(
  config: AppConfig,
  db: DrizzleDb,
  githubClient: GitHubClient | undefined,
  installations: GitHubInstallationRepository,
): Partial<CoreDependencies> {
  if (!config.documents.enabled || !config.documents.encryptionKey) return {}
  const providers: DocumentSourceProvider[] = []
  if (config.documents.sources.includes('confluence')) providers.push(new ConfluenceProvider())
  if (config.documents.sources.includes('notion')) providers.push(new NotionProvider())
  if (config.documents.sources.includes('github') && githubClient) {
    providers.push(new GitHubDocsProvider({ githubClient, installations }))
  }
  if (providers.length === 0) return {}
  return {
    documentSourceProviders: providers,
    documentConnectionRepository: new DrizzleDocumentConnectionRepository(
      db,
      new WebCryptoSecretCipher({
        masterKeyBase64: config.documents.encryptionKey,
        info: 'cat-factory:documents',
      }),
    ),
    documentRepository: new DrizzleDocumentRepository(db),
    ...(config.documents.planner === 'llm'
      ? { documentPlannerModel: config.agents.routing.default.ref }
      : {}),
  }
}

/**
 * Wire the ephemeral-environment integration for the Node facade when enabled,
 * mirroring the Worker's `selectEnvironmentsDeps`: the shared `HttpEnvironmentProvider`
 * (a manifest-driven `fetch` shell), the Drizzle connection + registry repos, and the
 * environment-scoped `SecretCipher`. Per-tenant management-API secrets are encrypted at
 * rest with the shared ENCRYPTION_KEY. Disabled → `{}` and the module stays off.
 */
function selectNodeEnvironmentsDeps(config: AppConfig, db: DrizzleDb): Partial<CoreDependencies> {
  if (!config.environments.enabled || !config.environments.encryptionKey) return {}
  return {
    environmentProvider: new HttpEnvironmentProvider(),
    environmentConnectionRepository: new DrizzleEnvironmentConnectionRepository(db),
    environmentRegistryRepository: new DrizzleEnvironmentRegistryRepository(db),
    secretCipher: new WebCryptoSecretCipher({
      masterKeyBase64: config.environments.encryptionKey,
    }),
  }
}

/**
 * Wire the prompt-fragment library (ADR 0006) for the Node facade when opted in,
 * mirroring the Worker's `selectFragmentLibraryDeps`: the two Drizzle repositories,
 * the installation resolver repo-source sync uses to read guideline repos through the
 * tier's GitHub installation, and — in `llm` selector mode — the shared
 * `LlmFragmentSelector` over the Node model provider (else the core deterministic
 * matcher, via `fragmentSelector: undefined`). Disabled → `{}` and the module stays
 * unassembled (the engine falls back to the static built-in catalog).
 */
function selectNodeFragmentLibraryDeps(
  config: AppConfig,
  env: NodeJS.ProcessEnv,
  db: DrizzleDb,
  githubClient: GitHubClient | undefined,
  installations: GitHubInstallationRepository,
): Partial<CoreDependencies> {
  if (!config.fragmentLibrary.enabled) return {}
  const resolveFragmentInstallationId = async (
    ownerKind: FragmentOwnerKind,
    ownerId: string,
  ): Promise<number | null> => {
    if (ownerKind === 'workspace') {
      return (await installations.getByWorkspace(ownerId))?.installationId ?? null
    }
    const active = await installations.listActive()
    return active.find((i) => i.accountId === ownerId)?.installationId ?? null
  }
  return {
    promptFragmentRepository: new DrizzlePromptFragmentRepository(db),
    fragmentSourceRepository: new DrizzleFragmentSourceRepository(db),
    // Repo-sourced fragments read guideline files through the workspace's App
    // installation; only wired when a real GitHub client is available (parity with
    // the Worker — hand-authored fragments work without it).
    ...(githubClient ? { githubClient, resolveFragmentInstallationId } : {}),
    ...(config.fragmentLibrary.selector === 'llm'
      ? {
          fragmentSelector: new LlmFragmentSelector({
            modelProvider: buildModelProvider(env),
            modelRef: config.agents.routing.default.ref,
          }),
        }
      : {}),
  }
}
