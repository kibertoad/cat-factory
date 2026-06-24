import {
  type AgentExecutor,
  type Clock,
  CompositeNotificationChannel,
  CompositeIncidentEnrichmentProvider,
  type IncidentEnrichmentProvider,
  type DocumentSourceProvider,
  type ExecutionEventPublisher,
  type FragmentOwnerKind,
  type IdGenerator,
  type ModelProviderResolver,
  type NotificationChannel,
  NoopWorkRunner,
  type TaskSourceProvider,
  type WorkRunner,
} from '@cat-factory/kernel'
import {
  AiAgentExecutor,
  inlineWebSearchOptionsFromEnv,
  resolveAgentConfig,
} from '@cat-factory/agents'
import { cloudflareBindingRegistry } from '@cat-factory/provider-cloudflare'
import {
  ConfluenceProvider,
  GitHubDocsProvider,
  GitHubIssuesProvider,
  JiraProvider,
  HttpEnvironmentProvider,
  NotionProvider,
  EMAIL_CIPHER_INFO,
  ApiKeyService,
  LocalModelEndpointService,
  PersonalSubscriptionService,
  ProviderSubscriptionService,
  RunnerPoolConnectionService,
  SLACK_CIPHER_INFO,
  SlackNotificationChannel,
  TicketTrackerService,
  DATADOG_CIPHER_INFO,
  DatadogReleaseHealthProvider,
  PagerDutyEnrichmentProvider,
  IncidentIoEnrichmentProvider,
} from '@cat-factory/integrations'
import { type CoreDependencies, createCore } from '@cat-factory/orchestration'
import { createLangfuseSink } from '@cat-factory/observability-langfuse'
import {
  buildResolveRepoTarget as buildSharedResolveRepoTarget,
  ensureWorkBranchViaRest,
  FanOutEventPublisher,
  InAppNotificationChannel,
  WebCryptoPasswordHasher,
  WebCryptoPersonalSecretCipher,
  createWebSearchUpstreamFromEnv,
  logger,
  createScopedModelProviderResolver,
  resolveUrlSafetyPolicy,
  resolveWorkspaceCapabilities,
  type ServerContainer,
} from '@cat-factory/server'
import { type AppConfig, loadConfig } from './config'
import { loadLangfuseConfig } from './config/langfuse'
import { loadObservabilityConfig } from './config/observability'
import type { Env } from './env'
import { baseUrlFor } from './ai/providerEndpoints'
import { resolveExtraRegistries } from './ai/registries'
import { DoRealtimeGateway } from './gateways/DoRealtimeGateway'
import { CfGitHubWebhookIngest, WorkflowsBackfillScheduler } from './gateways/GitHubGateways'
import { WorkersAiLlmUpstream } from './ai/WorkersAiLlmUpstream'
import {
  ContainerAgentExecutor,
  type ResolveRepoTarget,
  type ResolveRunnerTransport,
} from './ai/ContainerAgentExecutor'
import { CloudflareContainerTransport } from './containers/CloudflareContainerTransport'
import { ContainerInstanceRegistry } from './containers/ContainerInstanceRegistry'
import { D1LiveContainerRepository } from './repositories/D1LiveContainerRepository'
import { HttpRunnerPoolProvider } from './runners/HttpRunnerPoolProvider'
import { RunnerPoolTransport } from './runners/RunnerPoolTransport'
import { D1RunnerPoolConnectionRepository } from './repositories/D1RunnerPoolConnectionRepository'
import { D1ProviderSubscriptionTokenRepository } from './repositories/D1ProviderSubscriptionTokenRepository'
import { D1ProviderApiKeyRepository } from './repositories/D1ProviderApiKeyRepository'
import {
  D1PersonalSubscriptionRepository,
  D1SubscriptionActivationRepository,
} from './repositories/D1PersonalSubscriptionRepository'
import { D1LocalModelEndpointRepository } from './repositories/D1LocalModelEndpointRepository'
import { ContainerRepoBootstrapper } from './ai/ContainerRepoBootstrapper'
import { CompositeAgentExecutor } from './ai/CompositeAgentExecutor'
import { ContainerSessionService } from './containers/ContainerSessionService'
import { DurableObjectEventPublisher } from './events/DurableObjectEventPublisher'
import { WorkflowsWorkRunner } from './workflows/WorkflowsWorkRunner'
import { WorkflowsBootstrapRunner } from './workflows/WorkflowsBootstrapRunner'
import { D1BlockRepository } from './repositories/D1BlockRepository'
import { D1ExecutionRepository } from './repositories/D1ExecutionRepository'
import { D1PipelineRepository } from './repositories/D1PipelineRepository'
import { D1ServiceRepository } from './repositories/D1ServiceRepository'
import { D1WorkspaceMountRepository } from './repositories/D1WorkspaceMountRepository'
import { D1TokenUsageRepository } from './repositories/D1TokenUsageRepository'
import { D1LlmCallMetricRepository } from './repositories/D1LlmCallMetricRepository'
import { D1WorkspaceRepository } from './repositories/D1WorkspaceRepository'
import {
  D1SlackConnectionRepository,
  D1SlackMemberMappingRepository,
  D1SlackSettingsRepository,
} from './repositories/D1SlackRepositories'
import { D1AccountRepository } from './repositories/D1AccountRepository'
import { D1MembershipRepository } from './repositories/D1MembershipRepository'
import { D1UserRepository } from './repositories/D1UserRepository'
import { D1AccountInvitationRepository } from './repositories/D1AccountInvitationRepository'
import { D1EmailConnectionRepository } from './repositories/D1EmailConnectionRepository'
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
import { D1AgentRunRepository } from './repositories/D1AgentRunRepository'
import { D1RequirementReviewRepository } from './repositories/D1RequirementReviewRepository'
import { D1ConsensusSessionRepository } from './repositories/D1ConsensusSessionRepository'
import { ConsensusAgentExecutor, registerConsensusTraits } from '@cat-factory/consensus'
import { D1ClarityReviewRepository } from './repositories/D1ClarityReviewRepository'
import { D1NotificationRepository } from './repositories/D1NotificationRepository'
import { D1MergePresetRepository } from './repositories/D1MergePresetRepository'
import { D1WorkspaceSettingsRepository } from './repositories/D1WorkspaceSettingsRepository'
import { D1DatadogConnectionRepository } from './repositories/D1DatadogConnectionRepository'
import { D1ReleaseHealthConfigRepository } from './repositories/D1ReleaseHealthConfigRepository'
import { D1PipelineScheduleRepository } from './repositories/D1PipelineScheduleRepository'
import { D1TrackerSettingsRepository } from './repositories/D1TrackerSettingsRepository'
import { D1ModelDefaultsRepository } from './repositories/D1ModelDefaultsRepository'
import { D1ServiceFragmentDefaultsRepository } from './repositories/D1ServiceFragmentDefaultsRepository'
import { GitHubCiStatusProvider } from './github/GitHubCiStatusProvider'
import { GitHubMergeabilityProvider } from './github/GitHubMergeabilityProvider'
import { GitHubPullRequestMerger } from './github/GitHubPullRequestMerger'
import { WebCryptoSecretCipher } from './environments/WebCryptoSecretCipher'
import { GitHubAppAuth } from './github/GitHubAppAuth'
import { GitHubAppRegistry } from './github/GitHubAppRegistry'
import { FetchGitHubClient } from './github/FetchGitHubClient'
import { FetchGitHubProvisioningClient } from './github/FetchGitHubProvisioningClient'
import { WebCryptoWebhookVerifier } from './github/WebCryptoWebhookVerifier'
import { D1TaskConnectionRepository } from './repositories/D1TaskConnectionRepository'
import { D1TaskRepository } from './repositories/D1TaskRepository'
import { D1PromptFragmentRepository } from './repositories/D1PromptFragmentRepository'
import { D1FragmentSourceRepository } from './repositories/D1FragmentSourceRepository'
import { LlmFragmentSelector } from './ai/LlmFragmentSelector'
import { CryptoIdGenerator, SystemClock } from './runtime'
import type { D1Database } from '@cloudflare/workers-types'

// The infrastructure composition root: turn a Worker `env` into the concrete
// ports (D1 repositories, runtime, the chosen agent executor) and assemble the
// domain core. Built once per request — instantiation is cheap and each request
// gets its own D1 handle from `env`.

// The Worker's container shape is exactly the shared one (domain Core + resolved
// config + the kind-spanning agent-run repository); the type lives in the shared
// package so the cross-runtime controllers can reference it.
export type Container = ServerContainer

/**
 * The Worker's {@link ModelProvider}: the base registry plus any extra provider
 * registries an installation registered (see ./ai/registries). Used everywhere a
 * model provider is needed so every path — agent executor, requirements reviewer,
 * doc planner, fragment selector — sees the same provider set. When Langfuse is
 * configured the provider is wrapped so those INLINE (non-proxied) calls surface on
 * the same trace sink the LLM proxy fans container calls out to.
 */
// Memoised per `(Env, db)`: every inline consumer (agent executor, requirements
// reviewer, doc planner, fragment selector) shares ONE resolver — and so ONE Langfuse
// sink — for a container build. The resolver builds a per-scope provider from the
// DB-backed API-key pool plus the opt-in Cloudflare binding + Bedrock registries.
const modelResolverCache = new WeakMap<Env, ModelProviderResolver>()

function buildModelProviderResolver(env: Env, db: D1Database): ModelProviderResolver {
  const cached = modelResolverCache.get(env)
  if (cached) return cached
  // Opt-in provider registries that need no per-scope DB key: the Cloudflare Workers
  // AI binding (when bound) and any extra registries (e.g. Bedrock). NOT assumed —
  // `workers-ai` resolves only when the `AI` binding is present.
  const extraRegistries = [
    ...(env.AI ? [cloudflareBindingRegistry({ binding: env.AI })] : []),
    ...resolveExtraRegistries(env),
  ]
  const langfuse = loadLangfuseConfig(env)
  const instrument =
    langfuse.enabled && langfuse.publicKey && langfuse.secretKey
      ? {
          traceSink: createLangfuseSink({
            publicKey: langfuse.publicKey,
            secretKey: langfuse.secretKey,
            baseUrl: langfuse.baseUrl,
            logger,
          }),
          recordPrompts: loadObservabilityConfig(env).recordPrompts,
        }
      : undefined
  const localModelEndpoints = buildLocalModelEndpointService(env, db, { now: () => Date.now() })
  const resolver = createScopedModelProviderResolver({
    apiKeys: buildApiKeyService(env, db, { now: () => Date.now() }),
    baseUrlFor: (provider) => baseUrlFor(provider, env) ?? undefined,
    extraRegistries,
    localEndpointsFor: localModelEndpoints
      ? (userId) => localModelEndpoints.listResolved(userId)
      : undefined,
    instrument,
  })
  modelResolverCache.set(env, resolver)
  return resolver
}

/**
 * The resolver every executor consults for a workspace's per-agent-kind default
 * model (block-pinned > workspace per-kind default > env routing > env default).
 * Backed by the D1 model-defaults repo; shared by the inline LLM executor and the
 * container executor so both honour the workspace defaults identically.
 */
function buildResolveWorkspaceModelDefault(
  db: D1Database,
): (workspaceId: string, agentKind: string) => Promise<string | undefined> {
  const repo = new D1ModelDefaultsRepository({ db })
  return (workspaceId, agentKind) =>
    repo.getForKind(workspaceId, agentKind).then((v) => v ?? undefined)
}

/**
 * Pick the agent that performs pipeline steps: real LLM work via the Vercel AI
 * SDK, composed with a per-run sandbox for the repo-operating steps (`coder`,
 * `mocker`, `playwright`, …). Container-based implementation is ALWAYS on — the
 * sandbox is a hard requirement, so this throws at startup if it can't be built.
 * Tests bypass this entirely by overriding `agentExecutor` with a fake.
 *
 * There is intentionally NO inline fallback for the sandbox kinds — a one-shot
 * LLM call cannot clone/edit/commit/open a PR, so a degraded inline implementer is
 * silently broken rather than usefully degraded. If the sandbox prerequisites are
 * missing we fail the deploy loudly here rather than starting with a half-wired
 * implementer that would only fault the moment a repo-operating step is dispatched.
 */
function selectAgentExecutor(
  env: Env,
  config: AppConfig,
  db: D1Database,
  clock: Clock,
  resolveTransport: ResolveRunnerTransport | null,
  subscriptions?: ProviderSubscriptionService,
  personalSubscriptions?: PersonalSubscriptionService,
): AgentExecutor {
  const inline = new AiAgentExecutor({
    modelProviderResolver: buildModelProviderResolver(env, db),
    agentRouting: config.agents.routing,
    resolveBlockModel: config.agents.resolveBlockModel,
    // Inline (non-sandbox) kinds honour the workspace's per-kind defaults too, so
    // the resolution precedence is uniform across every agent kind, not just the
    // container kinds.
    resolveWorkspaceModelDefault: buildResolveWorkspaceModelDefault(db),
    // Opt-in provider web search for the inline design/research kinds (no-op unless
    // INLINE_WEB_SEARCH_ENABLED and an Anthropic/OpenAI model).
    webSearch: inlineWebSearchOptionsFromEnv(env),
  })

  // The sandbox MUST build — a null here means a prerequisite (GitHub App private
  // key, WORKER_PUBLIC_URL, AUTH_SESSION_SECRET, or a runner backend: the
  // EXEC_CONTAINER binding or a registered runner pool) is missing. We refuse to
  // start with a half-configured implementer rather than quietly running the
  // repo-operating steps as useless one-shot LLM calls.
  const container = buildContainerExecutor(
    env,
    config,
    db,
    clock,
    resolveTransport,
    subscriptions,
    personalSubscriptions,
  )
  if (!container) {
    throw new Error(
      'Container-based implementation is required but its prerequisites are missing. ' +
        'Required: a configured GitHub App (GITHUB_APP_PRIVATE_KEY), WORKER_PUBLIC_URL, ' +
        'AUTH_SESSION_SECRET, and a runner backend (the EXEC_CONTAINER binding or a ' +
        'registered runner pool with RUNNERS_ENABLED). Refusing to start with a broken ' +
        'executor instead of silently degrading to one-shot LLM calls.',
    )
  }

  // Always the composite: non-sandbox kinds run inline; sandbox kinds run in the
  // container.
  return new CompositeAgentExecutor(inline, container)
}

/** Truthy env flag (`true`/`1`/`yes`). */
function isTruthy(value: string | undefined): boolean {
  return value === 'true' || value === '1' || value === 'yes'
}

/**
 * Wrap the standard executor with the optional consensus mechanism when
 * `CONSENSUS_ENABLED` is set: register the consensus capability traits (so the builder
 * offers "Enable Consensus" on eligible steps) and route consensus-enabled steps through
 * a multi-model process, persisting + pushing the transcript. Off ⇒ returns `standard`
 * unchanged (no traits, no wrapping), so behaviour is identical to before.
 */
function maybeWrapConsensus(
  standard: AgentExecutor,
  env: Env,
  config: AppConfig,
  db: D1Database,
  eventPublisher: ExecutionEventPublisher | undefined,
): AgentExecutor {
  if (!isTruthy(env.CONSENSUS_ENABLED)) return standard
  registerConsensusTraits()
  return new ConsensusAgentExecutor({
    standard,
    modelProviderResolver: buildModelProviderResolver(env, db),
    agentRouting: config.agents.routing,
    resolveBlockModel: config.agents.resolveBlockModel,
    resolveWorkspaceModelDefault: buildResolveWorkspaceModelDefault(db),
    sessionRepository: new D1ConsensusSessionRepository({ db }),
    ...(eventPublisher ? { eventPublisher } : {}),
  })
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
  // The Cloudflare backend folds in instance-level reaping: the registry records
  // each dispatched container in the live inventory and clears it on release, so the
  // cron reaper (index.ts) can kill anything that outlived its lifetime — covering
  // run/blueprint/bootstrap through this one transport with no per-flow wiring.
  const cloudflare = env.EXEC_CONTAINER
    ? new CloudflareContainerTransport(
        env.EXEC_CONTAINER,
        new ContainerInstanceRegistry(
          env.EXEC_CONTAINER,
          new D1LiveContainerRepository({ db }),
          clock,
        ),
      )
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
    const urlPolicy = resolveUrlSafetyPolicy(config.runners)
    poolProvider = new HttpRunnerPoolProvider(urlPolicy ? { urlPolicy } : {})
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
/**
 * Build the multi-App registry (ADR 0005): the default App always, plus the
 * privileged App when configured. It resolves which App's key to use per
 * installation (from the binding's recorded appId), so every token mint / app-JWT
 * call routes correctly. Callers guard on `config.github.enabled`, which requires
 * GITHUB_APP_PRIVATE_KEY, so the default key is present.
 */
function buildAppRegistry(
  env: Env,
  config: AppConfig,
  db: D1Database,
  clock: Clock,
): GitHubAppRegistry {
  const installationRepository = new D1GitHubInstallationRepository({ db })
  const makeAuth = (appId: string, privateKeyPem: string) =>
    new GitHubAppAuth({
      appId,
      privateKeyPem,
      installationRepository,
      clock,
      apiBase: config.github.apiBase,
    })
  const privileged =
    config.github.privilegedApp && env.GITHUB_PRIVILEGED_APP_PRIVATE_KEY
      ? {
          appId: config.github.privilegedApp.appId,
          auth: makeAuth(config.github.privilegedApp.appId, env.GITHUB_PRIVILEGED_APP_PRIVATE_KEY),
        }
      : undefined
  return new GitHubAppRegistry({
    default: {
      appId: config.github.appId,
      auth: makeAuth(config.github.appId, env.GITHUB_APP_PRIVATE_KEY!),
    },
    privileged,
    installationRepository,
  })
}

/**
 * Resolve the repo linked to a running block's enclosing service, via the shared
 * runtime-neutral `buildResolveRepoTarget` (the ancestry walk + no-fallback policy
 * live in `@cat-factory/server` so the Worker and Node service can't drift). This
 * wrapper just binds the D1 repositories. Shared by the container executor, the CI
 * status provider and the PR merger.
 */
function buildResolveRepoTarget(db: D1Database): ResolveRepoTarget {
  return buildSharedResolveRepoTarget({
    installationRepository: new D1GitHubInstallationRepository({ db }),
    repoProjectionRepository: new D1RepoProjectionRepository({ db }),
    blockRepository: new D1BlockRepository({ db }),
    serviceRepository: new D1ServiceRepository({ db }),
  })
}

/**
 * Build the merge-lifecycle ports. The notification repository + merge-preset
 * repository are wired unconditionally (the inbox + presets are always available);
 * the in-app delivery channel is wired only when the events binding is present
 * (else rows persist but nothing is pushed). The CI status provider + PR merger
 * need GitHub, so they're wired only when the App is configured — without them the
 * `ci` gate passes through and `done` is a board-only flip (graceful degradation).
 */
function selectMergeLifecycleDeps(
  env: Env,
  config: AppConfig,
  db: D1Database,
  clock: Clock,
  idGenerator: IdGenerator,
): Partial<CoreDependencies> {
  const deps: Partial<CoreDependencies> = {
    notificationRepository: new D1NotificationRepository({ db }),
    mergePresetRepository: new D1MergePresetRepository({ db }),
    workspaceSettingsRepository: new D1WorkspaceSettingsRepository({ db }),
    modelDefaultsRepository: new D1ModelDefaultsRepository({ db }),
    serviceFragmentDefaultsRepository: new D1ServiceFragmentDefaultsRepository({ db }),
  }
  // Compose the delivery channels: in-app push (when the events binding is present)
  // and Slack (when the integration is enabled) implement the same NotificationChannel
  // port and fan out via CompositeNotificationChannel — realizing the seam the kernel
  // port documents, with no change to the engine call sites that raise notifications.
  const channels: NotificationChannel[] = []
  const publisher = selectEventPublisher(env, db)
  if (publisher) channels.push(new InAppNotificationChannel(publisher))
  const slackChannel = buildSlackChannel(config, db)
  if (slackChannel) channels.push(slackChannel)
  if (channels.length === 1) deps.notificationChannel = channels[0]
  else if (channels.length > 1)
    deps.notificationChannel = new CompositeNotificationChannel(channels)

  if (config.github.enabled && env.GITHUB_APP_PRIVATE_KEY) {
    const registry = buildAppRegistry(env, config, db, clock)
    const githubClient = new FetchGitHubClient({
      registry,
      rateLimitRepository: new D1RateLimitRepository({ db, idGenerator }),
      idGenerator,
      clock,
      apiBase: config.github.apiBase,
    })
    const resolveRepoTarget = buildResolveRepoTarget(db)
    const blockRepository = new D1BlockRepository({ db })
    deps.ciStatusProvider = new GitHubCiStatusProvider({
      githubClient,
      resolveRepoTarget,
      blockRepository,
    })
    deps.mergeabilityProvider = new GitHubMergeabilityProvider({
      githubClient,
      resolveRepoTarget,
      blockRepository,
    })
    deps.pullRequestMerger = new GitHubPullRequestMerger({
      githubClient,
      resolveRepoTarget,
      blockRepository,
    })
  }
  return deps
}

/**
 * Wire the Datadog post-release-health gate when enabled (+ ENCRYPTION_KEY): the
 * connection + per-block config repos, the cipher that seals the keys, the release-health
 * provider the gate probes, and (optionally) the PagerDuty / incident.io enrichment
 * providers. Off → the gate is a pass-through and the release-health module isn't built.
 */
function selectReleaseHealthDeps(
  env: Env,
  config: AppConfig,
  db: D1Database,
): Partial<CoreDependencies> {
  if (!config.datadog.enabled || !config.datadog.encryptionKey) return {}
  const datadogConnectionRepository = new D1DatadogConnectionRepository({ db })
  const releaseHealthConfigRepository = new D1ReleaseHealthConfigRepository({ db })
  const datadogSecretCipher = new WebCryptoSecretCipher({
    masterKeyBase64: config.datadog.encryptionKey,
    info: DATADOG_CIPHER_INFO,
  })
  const deps: Partial<CoreDependencies> = {
    datadogConnectionRepository,
    releaseHealthConfigRepository,
    datadogSecretCipher,
    releaseHealthProvider: new DatadogReleaseHealthProvider({
      datadogConnectionRepository,
      releaseHealthConfigRepository,
      blockRepository: new D1BlockRepository({ db }),
      secretCipher: datadogSecretCipher,
    }),
  }
  const enrichers: IncidentEnrichmentProvider[] = []
  if (config.incidentEnrichment.pagerDuty) {
    enrichers.push(new PagerDutyEnrichmentProvider(config.incidentEnrichment.pagerDuty))
  }
  if (config.incidentEnrichment.incidentIo) {
    enrichers.push(new IncidentIoEnrichmentProvider(config.incidentEnrichment.incidentIo))
  }
  if (enrichers.length > 0) {
    deps.incidentEnrichment = new CompositeIncidentEnrichmentProvider(enrichers)
  }
  return deps
}

/**
 * Construct the Slack repositories + bot-token cipher once, when the integration is
 * enabled — the single source of truth shared by both the delivery channel and the
 * management module so neither duplicates the wiring. Null when Slack is off.
 */
function buildSlackInfra(config: AppConfig, db: D1Database) {
  if (!config.slack.enabled || !config.slack.encryptionKey) return null
  return {
    connectionRepository: new D1SlackConnectionRepository({ db }),
    settingsRepository: new D1SlackSettingsRepository({ db }),
    memberMappingRepository: new D1SlackMemberMappingRepository({ db }),
    cipher: new WebCryptoSecretCipher({
      masterKeyBase64: config.slack.encryptionKey,
      info: SLACK_CIPHER_INFO,
    }),
  }
}

/**
 * Build the Slack notification channel when the integration is enabled — a
 * runtime-neutral transport (fetch + decrypt + D1 reads) composed alongside the
 * in-app channel. Null when Slack is off (then nothing Slack-related is wired).
 */
function buildSlackChannel(config: AppConfig, db: D1Database): SlackNotificationChannel | null {
  const infra = buildSlackInfra(config, db)
  if (!infra) return null
  return new SlackNotificationChannel({
    workspaceRepository: new D1WorkspaceRepository({ db }),
    slackConnectionRepository: infra.connectionRepository,
    slackSettingsRepository: infra.settingsRepository,
    slackMemberMappingRepository: infra.memberMappingRepository,
    blockRepository: new D1BlockRepository({ db }),
    secretCipher: infra.cipher,
    // Best-effort delivery still surfaces failures (revoked token, missing channel
    // invite) through the structured logger so a broken route is diagnosable.
    onError: (error, ctx) =>
      logger.warn(
        { err: error instanceof Error ? error.message : String(error), ...ctx },
        'slack notification delivery failed',
      ),
  })
}

/**
 * Wire the Slack management module (per-account connect + per-workspace routing +
 * member map). Wired only when the integration is enabled; the actual delivery is
 * the channel composed in by {@link selectMergeLifecycleDeps}. OAuth credentials
 * are optional — manual bot-token onboarding works without them.
 */
function selectSlackDeps(config: AppConfig, db: D1Database): Partial<CoreDependencies> {
  const infra = buildSlackInfra(config, db)
  if (!infra) return {}
  return {
    slackConnectionRepository: infra.connectionRepository,
    slackSettingsRepository: infra.settingsRepository,
    slackMemberMappingRepository: infra.memberMappingRepository,
    slackSecretCipher: infra.cipher,
    ...(config.slack.oauth ? { slackOAuth: config.slack.oauth } : {}),
  }
}

/**
 * Wire account invitations + per-account email senders. Invitations are always
 * available (an invite link works without email); the email-connection store + its
 * cipher are wired only when EMAIL is enabled (an encryption key is mandatory), so
 * an account can onboard a SendGrid/Resend key in the UI and have invites emailed.
 */
function selectEmailInvitationDeps(config: AppConfig, db: D1Database): Partial<CoreDependencies> {
  const deps: Partial<CoreDependencies> = {
    invitationRepository: new D1AccountInvitationRepository({ db }),
    appBaseUrl: config.email.appBaseUrl || undefined,
  }
  if (config.email.enabled && config.email.encryptionKey) {
    deps.emailConnectionRepository = new D1EmailConnectionRepository({ db })
    deps.emailSecretCipher = new WebCryptoSecretCipher({
      masterKeyBase64: config.email.encryptionKey,
      info: EMAIL_CIPHER_INFO,
    })
  }
  return deps
}

/**
 * Wire the opt-in Langfuse trace sink. Built only when `LANGFUSE_ENABLED=true` and both
 * keys are set; the observability service then fans every recorded LLM call out to it.
 * A fetch-based sink, so it runs unchanged on the Worker runtime.
 */
function buildLangfuseSink(config: AppConfig): CoreDependencies['llmTraceSink'] {
  if (!config.langfuse.enabled || !config.langfuse.publicKey || !config.langfuse.secretKey) {
    return undefined
  }
  return createLangfuseSink({
    publicKey: config.langfuse.publicKey,
    secretKey: config.langfuse.secretKey,
    baseUrl: config.langfuse.baseUrl,
    logger,
  })
}

function selectLangfuseSink(config: AppConfig): Partial<CoreDependencies> {
  const sink = buildLangfuseSink(config)
  return sink ? { llmTraceSink: sink } : {}
}

/**
 * Wire the recurring-pipeline + issue-tracker ports. The schedule + tracker-setting
 * repositories are always available (the feature is workspace-scoped CRUD); the
 * `ticketTrackerProvider` files the tech-debt pipeline's issue and degrades
 * gracefully — it files GitHub issues only when the App is configured (so it can
 * resolve the service's repo + mint a token) and Jira only when the tasks
 * integration's encryption key is set (so it can read the workspace's stored Jira
 * credentials). With neither, the `tracker` step passes through.
 */
function selectRecurringDeps(
  env: Env,
  config: AppConfig,
  db: D1Database,
  clock: Clock,
  idGenerator: IdGenerator,
): Partial<CoreDependencies> {
  const trackerDeps: ConstructorParameters<typeof TicketTrackerService>[0] = {
    trackerSettingsRepository: new D1TrackerSettingsRepository({ db }),
    // workerd exposes a global fetch; the Jira create call uses it.
    fetchImpl: fetch,
  }
  // GitHub issues: file through the App-authenticated client against the service's
  // linked repo (resolved from the github_repos projection). Only when the App is configured.
  if (config.github.enabled && env.GITHUB_APP_PRIVATE_KEY) {
    const registry = buildAppRegistry(env, config, db, clock)
    const githubClient = new FetchGitHubClient({
      registry,
      rateLimitRepository: new D1RateLimitRepository({ db, idGenerator }),
      idGenerator,
      clock,
      apiBase: config.github.apiBase,
    })
    const resolveRepoTarget = buildResolveRepoTarget(db)
    trackerDeps.fileGitHubIssue = async (request) => {
      const repo = await resolveRepoTarget(request.workspaceId, request.frameId)
      if (!repo) return null
      const issue = await githubClient.createIssue(
        repo.installationId,
        { owner: repo.owner, repo: repo.name },
        { title: request.title, body: request.body },
      )
      return { externalId: `${repo.owner}/${repo.name}#${issue.number}`, url: issue.url }
    }
  }
  // Jira: read the workspace's stored connection credentials (when the tasks
  // integration's encryption key is configured).
  if (config.tasks.encryptionKey) {
    const taskConnectionRepository = new D1TaskConnectionRepository({
      db,
      cipher: new WebCryptoSecretCipher({
        masterKeyBase64: config.tasks.encryptionKey,
        info: 'cat-factory:tasks',
      }),
    })
    trackerDeps.resolveJiraConnection = async (workspaceId) => {
      const connection = await taskConnectionRepository.getByWorkspace(workspaceId, 'jira')
      const { baseUrl, accountEmail, apiToken } = connection?.credentials ?? {}
      if (!baseUrl || !accountEmail || !apiToken) return null
      return { baseUrl, accountEmail, apiToken }
    }
  }
  return {
    pipelineScheduleRepository: new D1PipelineScheduleRepository({ db }),
    trackerSettingsRepository: new D1TrackerSettingsRepository({ db }),
    ticketTrackerProvider: new TicketTrackerService(trackerDeps),
  }
}

/**
 * Build the workspace subscription-token pool service (Claude Code / Codex
 * credentials), or undefined when the shared ENCRYPTION_KEY is absent. Tokens are
 * sealed under a subscriptions-scoped HKDF info of the shared master key.
 */
function buildSubscriptionService(
  env: Env,
  db: D1Database,
  clock: Clock,
): ProviderSubscriptionService | undefined {
  const masterKeyBase64 = env.ENCRYPTION_KEY?.trim()
  if (!masterKeyBase64) return undefined
  return new ProviderSubscriptionService({
    providerSubscriptionTokenRepository: new D1ProviderSubscriptionTokenRepository({ db }),
    workspaceRepository: new D1WorkspaceRepository({ db }),
    secretCipher: new WebCryptoSecretCipher({
      masterKeyBase64,
      info: 'cat-factory:provider-subscriptions',
    }),
    idGenerator: new CryptoIdGenerator(),
    clock,
  })
}

/**
 * Build the direct-provider API-key pool service (account/workspace/user-scoped),
 * or undefined when no ENCRYPTION_KEY is configured. Keys are sealed under an
 * api-keys-scoped HKDF info of the shared master key. Shared by the API-key
 * controller, the model-provider resolver, and the LLM proxy's key lease.
 */
function buildApiKeyService(env: Env, db: D1Database, clock: Clock): ApiKeyService | undefined {
  const masterKeyBase64 = env.ENCRYPTION_KEY?.trim()
  if (!masterKeyBase64) return undefined
  return new ApiKeyService({
    providerApiKeyRepository: new D1ProviderApiKeyRepository({ db }),
    workspaceRepository: new D1WorkspaceRepository({ db }),
    secretCipher: new WebCryptoSecretCipher({
      masterKeyBase64,
      info: 'cat-factory:provider-api-keys',
    }),
    idGenerator: new CryptoIdGenerator(),
    clock,
  })
}

/**
 * Build the per-USER individual-usage subscription service (Claude), or undefined when
 * no ENCRYPTION_KEY is configured. Uses the system SecretCipher (master key, scoped
 * info) for the outer layer and the password-derived PersonalSecretCipher for the inner
 * layer of the double-encrypted credential. Shared by the personal-subscription
 * controller and the container executor's personal lease.
 */
function buildPersonalSubscriptionService(
  env: Env,
  db: D1Database,
  clock: Clock,
): PersonalSubscriptionService | undefined {
  const masterKeyBase64 = env.ENCRYPTION_KEY?.trim()
  if (!masterKeyBase64) return undefined
  return new PersonalSubscriptionService({
    personalSubscriptionRepository: new D1PersonalSubscriptionRepository({ db }),
    subscriptionActivationRepository: new D1SubscriptionActivationRepository({ db }),
    secretCipher: new WebCryptoSecretCipher({
      masterKeyBase64,
      info: 'cat-factory:personal-subscriptions',
    }),
    personalCipher: new WebCryptoPersonalSecretCipher(),
    idGenerator: new CryptoIdGenerator(),
    clock,
  })
}

/**
 * The per-USER locally-run model endpoints store (Ollama / LM Studio / …), or undefined
 * when no ENCRYPTION_KEY is configured (the optional bearer key is sealed with the system
 * cipher). Shared by the local-runner controller, the per-user model catalog, and the LLM
 * proxy's base-URL/key resolution for a locally-run model.
 */
function buildLocalModelEndpointService(
  env: Env,
  db: D1Database,
  clock: Clock,
): LocalModelEndpointService | undefined {
  const masterKeyBase64 = env.ENCRYPTION_KEY?.trim()
  if (!masterKeyBase64) return undefined
  return new LocalModelEndpointService({
    localModelEndpointRepository: new D1LocalModelEndpointRepository({ db }),
    secretCipher: new WebCryptoSecretCipher({
      masterKeyBase64,
      info: 'cat-factory:local-model-endpoints',
    }),
    clock,
  })
}

function buildContainerExecutor(
  env: Env,
  config: AppConfig,
  db: D1Database,
  clock: Clock,
  resolveTransport: ResolveRunnerTransport | null,
  subscriptions?: ProviderSubscriptionService,
  personalSubscriptions?: PersonalSubscriptionService,
): AgentExecutor | null {
  if (
    !config.github.enabled ||
    !env.GITHUB_APP_PRIVATE_KEY ||
    !env.WORKER_PUBLIC_URL ||
    !env.AUTH_SESSION_SECRET
  ) {
    return null
  }

  if (!resolveTransport) return null

  const registry = buildAppRegistry(env, config, db, clock)
  const resolveRepoTarget = buildResolveRepoTarget(db)

  return new ContainerAgentExecutor({
    resolveTransport,
    agentRouting: config.agents.routing,
    resolveBlockModel: config.agents.resolveBlockModel,
    // The workspace's per-agent-kind default model, consulted when a block pins none
    // (block-pinned > workspace per-kind default > env routing > env default).
    resolveWorkspaceModelDefault: buildResolveWorkspaceModelDefault(db),
    resolveRepoTarget,
    // Resolve the workspace's owning account so the proxy can lease account-scoped keys.
    resolveAccountId: (workspaceId) => new D1WorkspaceRepository({ db }).accountOf(workspaceId),
    mintInstallationToken: (id) => registry.installationToken(id),
    // Ensure the shared per-task work branch up front so every agent (including the
    // read-only architect) operates on the same branch — idempotent, best-effort. Writers
    // create it from base; read-only agents only probe (`options.create`).
    ensureWorkBranch: async (repo, branch, options) =>
      ensureWorkBranchViaRest({
        ...(config.github.apiBase ? { apiBase: config.github.apiBase } : {}),
        token: await registry.installationToken(repo.installationId),
        owner: repo.owner,
        name: repo.name,
        baseBranch: repo.baseBranch,
        branch,
        create: options.create,
      }),
    sessionService: new ContainerSessionService({ secret: env.AUTH_SESSION_SECRET }),
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
    proxyBaseUrl: `${env.WORKER_PUBLIC_URL.replace(/\/+$/, '')}/v1`,
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
function selectEventPublisher(env: Env, db: D1Database): ExecutionEventPublisher | undefined {
  if (!env.WORKSPACE_EVENTS) return undefined
  // Fan a shared service's live events out to EVERY workspace that mounts it, not just the
  // one the engine addressed (in-org real-time sharing).
  return new FanOutEventPublisher(new DurableObjectEventPublisher(env.WORKSPACE_EVENTS), {
    workspaceMountRepository: new D1WorkspaceMountRepository({ db }),
  })
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
  const registry = buildAppRegistry(env, config, db, clock)
  const githubClient = new FetchGitHubClient({
    registry,
    rateLimitRepository: new D1RateLimitRepository({ db, idGenerator }),
    idGenerator,
    clock,
    apiBase: config.github.apiBase,
  })
  // Privileged App tier (ADR 0005): when configured, its client backs the
  // create-repo endpoint; `canCreateRepos` flags a connection whose installation
  // is owned by the privileged App. Absent → repo creation stays the manual flow.
  const repoProvisioningClient = config.github.privilegedApp
    ? new FetchGitHubProvisioningClient({ registry, apiBase: config.github.apiBase })
    : undefined
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
    repoProvisioningClient,
    canCreateRepos: (installation) => registry.canCreateRepos(installation),
    // Advisory: does the install actually grant `workflows: write`? Read from the
    // owning App's installation-token permission set (cached), so the UI can warn
    // when agent pushes touching `.github/workflows/*` would be rejected.
    workflowsGranted: async (installation) => {
      const perms = await registry.installationPermissions(installation.installationId)
      return perms.workflows === 'write'
    },
  }
}

/**
 * Build the document-source integration's concrete ports: the configured source
 * providers (Confluence, Notion, …) plus the two D1 repositories. The integration is
 * always on (config load fails loudly without the encryption key), so this is wired
 * on every deployment. The model provider is wired only in 'llm' planner mode (it
 * just needs a provider credential); the planner degrades to its deterministic parser
 * if no model is usable.
 */
function selectDocumentsDeps(
  env: Env,
  config: AppConfig,
  db: D1Database,
  clock: Clock,
  idGenerator: IdGenerator,
): Partial<CoreDependencies> {
  const providers: DocumentSourceProvider[] = []
  if (config.documents.sources.includes('confluence')) providers.push(new ConfluenceProvider())
  if (config.documents.sources.includes('notion')) providers.push(new NotionProvider())
  // GitHub repo docs reuse the workspace's installed GitHub App, so this provider
  // is wired only when the GitHub integration is also configured — it has no
  // credentials of its own and resolves the installation per file (mirrors the
  // GitHub-issues task source).
  if (config.documents.sources.includes('github') && config.github.enabled) {
    const registry = buildAppRegistry(env, config, db, clock)
    providers.push(
      new GitHubDocsProvider({
        githubClient: new FetchGitHubClient({
          registry,
          rateLimitRepository: new D1RateLimitRepository({ db, idGenerator }),
          idGenerator,
          clock,
          apiBase: config.github.apiBase,
        }),
        installations: new D1GitHubInstallationRepository({ db }),
      }),
    )
  }
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
          modelProviderResolver: buildModelProviderResolver(env, db),
          documentPlannerModel: config.agents.routing.default.ref,
        }
      : {}),
  }
}

/**
 * Build the task-source integration's concrete ports. Mirrors `selectDocumentsDeps`
 * but with no planner — issues are linked for context, not expanded into board
 * structure. Always on (config load fails loudly without the encryption key), so this
 * is wired on every deployment.
 */
function selectTasksDeps(
  env: Env,
  config: AppConfig,
  db: D1Database,
  clock: Clock,
  idGenerator: IdGenerator,
): Partial<CoreDependencies> {
  const providers: TaskSourceProvider[] = []
  if (config.tasks.sources.includes('jira')) providers.push(new JiraProvider())
  // GitHub issues reuse the workspace's installed GitHub App, so this provider
  // is wired only when the GitHub integration is also configured — it has no
  // credentials of its own and resolves the installation per issue.
  if (config.tasks.sources.includes('github') && config.github.enabled) {
    const registry = buildAppRegistry(env, config, db, clock)
    providers.push(
      new GitHubIssuesProvider({
        githubClient: new FetchGitHubClient({
          registry,
          rateLimitRepository: new D1RateLimitRepository({ db, idGenerator }),
          idGenerator,
          clock,
          apiBase: config.github.apiBase,
        }),
        installations: new D1GitHubInstallationRepository({ db }),
      }),
    )
  }
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
 * Wire the requirements-review feature. The repository is always available, and a
 * model provider + the agents' default ref are supplied so the stateless reviewer
 * works whenever an LLM is configured — independent of the documents integration.
 * (Supplying the provider here is harmless when documents are off or set to the
 * heading-based planner: that planner only engages when `documentPlannerModel` is
 * also set, which this does not touch.)
 */
function selectRequirementsDeps(
  env: Env,
  config: AppConfig,
  db: D1Database,
): Partial<CoreDependencies> {
  return {
    requirementReviewRepository: new D1RequirementReviewRepository({ db }),
    clarityReviewRepository: new D1ClarityReviewRepository({ db }),
    modelProviderResolver: buildModelProviderResolver(env, db),
    // The routing default already resolves to Cloudflare Workers AI unless a
    // direct provider key is set, so the reviewer runs on Cloudflare by default.
    requirementReviewModel: config.agents.routing.default.ref,
    // Honour a block's pinned model with the same direct/Cloudflare fallback the
    // agent executor (and the Pi container path) use.
    requirementReviewResolveModel: config.agents.resolveBlockModel,
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
  // The default manifest-driven provider; a trusted in-house adapter (implementing the
  // EnvironmentProvider port) is injected by replacing `environmentProvider` via the
  // `overrides` argument to `buildContainer` (spread last), the same seam tests use.
  const urlPolicy = resolveUrlSafetyPolicy(config.environments)
  return {
    environmentProvider: new HttpEnvironmentProvider(urlPolicy ? { urlPolicy } : {}),
    environmentConnectionRepository: new D1EnvironmentConnectionRepository({ db }),
    environmentRegistryRepository: new D1EnvironmentRegistryRepository({ db }),
    secretCipher: new WebCryptoSecretCipher({
      masterKeyBase64: config.environments.encryptionKey!,
    }),
    ...(urlPolicy ? { environmentUrlSafetyPolicy: urlPolicy } : {}),
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
  const urlPolicy = resolveUrlSafetyPolicy(config.runners)
  return {
    runnerPoolConnectionRepository: new D1RunnerPoolConnectionRepository({ db }),
    runnerSecretCipher: new WebCryptoSecretCipher({
      masterKeyBase64: config.runners.encryptionKey!,
      info: 'cat-factory:runners',
    }),
    ...(urlPolicy ? { runnerUrlSafetyPolicy: urlPolicy } : {}),
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
  resolveTransport: ResolveRunnerTransport | null,
): ContainerRepoBootstrapper | undefined {
  if (
    !resolveTransport ||
    !config.github.enabled ||
    !env.GITHUB_APP_PRIVATE_KEY ||
    !env.WORKER_PUBLIC_URL ||
    !env.AUTH_SESSION_SECRET
  ) {
    return undefined
  }

  const installationRepository = new D1GitHubInstallationRepository({ db })
  const registry = buildAppRegistry(env, config, db, clock)
  const githubClient = new FetchGitHubClient({
    registry,
    rateLimitRepository: new D1RateLimitRepository({ db, idGenerator }),
    idGenerator,
    clock,
    apiBase: config.github.apiBase,
  })

  return new ContainerRepoBootstrapper({
    resolveTransport,
    installationRepository,
    bootstrapJobRepository: new D1BootstrapJobRepository({ db }),
    repoRepository: new D1RepoProjectionRepository({ db }),
    githubClient,
    mintInstallationToken: (id) => registry.installationToken(id),
    sessionService: new ContainerSessionService({ secret: env.AUTH_SESSION_SECRET }),
    // Bootstrap is an `architect`-kind run, so it follows that kind's routing
    // (GLM-5.2 by default) rather than the global default.
    model: resolveAgentConfig(config.agents.routing, 'architect').ref,
    proxyBaseUrl: `${env.WORKER_PUBLIC_URL.replace(/\/+$/, '')}/v1`,
    githubApiBase: config.github.apiBase,
  })
}

/**
 * Build the prompt-fragment library's concrete ports when opted in (ADR 0006):
 * the two D1 repositories, the relevance selector (LLM when configured, else the
 * core deterministic matcher via `fragmentSelector: undefined`), and the
 * installation resolver repo-source sync uses to read guideline repos through the
 * tier's GitHub installation. Returns `{}` when disabled, so `createCore` leaves
 * the `fragmentLibrary` module unassembled and the engine uses manual fragmentIds.
 */
function selectFragmentLibraryDeps(
  env: Env,
  config: AppConfig,
  db: D1Database,
): Partial<CoreDependencies> {
  if (!config.fragmentLibrary.enabled) return {}
  const installationRepository = new D1GitHubInstallationRepository({ db })
  const resolveFragmentInstallationId = async (
    ownerKind: FragmentOwnerKind,
    ownerId: string,
  ): Promise<number | null> => {
    if (ownerKind === 'workspace') {
      return (await installationRepository.getByWorkspace(ownerId))?.installationId ?? null
    }
    // Account scope: the installation bound to this account (migration 0017).
    const active = await installationRepository.listActive()
    return active.find((i) => i.accountId === ownerId)?.installationId ?? null
  }
  return {
    promptFragmentRepository: new D1PromptFragmentRepository({ db }),
    fragmentSourceRepository: new D1FragmentSourceRepository({ db }),
    resolveFragmentInstallationId,
    ...(config.fragmentLibrary.selector === 'llm'
      ? {
          fragmentSelector: new LlmFragmentSelector({
            modelProviderResolver: buildModelProviderResolver(env, db),
            modelRef: config.agents.routing.default.ref,
          }),
        }
      : {}),
  }
}

export function buildContainer(
  env: Env,
  overrides: Partial<CoreDependencies> = {},
  opts: { cloudflareModelsEnabled?: boolean } = {},
): Container {
  const config = loadConfig(env)
  const db = env.DB
  const clock = new SystemClock()
  const idGenerator = new CryptoIdGenerator()

  // The runner-backend factory is shared by every container-backed flow (the
  // implementation executor and the repo bootstrapper), so both dispatch through the
  // same Cloudflare/self-hosted seam — and the bootstrapper rides the reaping-aware
  // Cloudflare transport for free. Null when no backend is configured.
  const resolveTransport = buildResolveTransport(env, config, db, clock)

  // The subscription-token pool (Claude Code / Codex credentials) — built once and
  // shared by the container executor (lease + usage feedback) and the
  // vendor-credential controller, so both read the same pool.
  const subscriptions = buildSubscriptionService(env, db, clock)

  // The per-user individual-usage subscription store (Claude) — shared by the
  // personal-subscription controller and the container executor's personal lease.
  const personalSubscriptions = buildPersonalSubscriptionService(env, db, clock)

  // The direct-provider API-key pool (account/workspace/user) — shared by the
  // API-key controller, the model-provider resolver, and the LLM proxy key lease.
  const apiKeys = buildApiKeyService(env, db, clock)

  // The per-user locally-run model endpoints store (Ollama / LM Studio / …) — shared by
  // the local-runner controller, the per-user model catalog, and the LLM proxy.
  const localModelEndpoints = buildLocalModelEndpointService(env, db, clock)

  // Cloudflare Workers AI is opt-in: enabled when the `AI` binding is present. A caller
  // (the cross-runtime conformance suite) may force it off to assert key-driven
  // selectability + the provider guard uniformly across runtimes.
  const cloudflareModelsEnabled = opts.cloudflareModelsEnabled ?? !!env.AI

  // Built once so the consensus executor and the engine share the same publisher (live
  // consensus transcript pushes ride the same hub as run/board events).
  const eventPublisher = selectEventPublisher(env, db)

  const dependencies: CoreDependencies = {
    workspaceRepository: new D1WorkspaceRepository({ db }),
    accountRepository: new D1AccountRepository({ db }),
    membershipRepository: new D1MembershipRepository({ db }),
    userRepository: new D1UserRepository({ db }),
    passwordHasher: new WebCryptoPasswordHasher(),
    blockRepository: new D1BlockRepository({ db }),
    pipelineRepository: new D1PipelineRepository({ db }),
    executionRepository: new D1ExecutionRepository({ db, clock }),
    // Clear a finished run's personal-credential activation promptly (TTL sweep is the backstop).
    subscriptionActivationRepository: new D1SubscriptionActivationRepository({ db }),
    serviceRepository: new D1ServiceRepository({ db }),
    workspaceMountRepository: new D1WorkspaceMountRepository({ db }),
    tokenUsageRepository: new D1TokenUsageRepository({ db }),
    llmCallMetricRepository: new D1LlmCallMetricRepository({ db }),
    recordLlmPrompts: config.observability.recordPrompts,
    idGenerator,
    clock,
    // When a caller injects its own agentExecutor (tests pass a FakeAgentExecutor)
    // skip selection entirely — selectAgentExecutor throws when a sandbox is opted
    // in but its prerequisites are missing, which is the desired loud failure in
    // production but must not fire for tests that never reach the real executor.
    agentExecutor:
      overrides.agentExecutor ??
      maybeWrapConsensus(
        selectAgentExecutor(
          env,
          config,
          db,
          clock,
          resolveTransport,
          subscriptions,
          personalSubscriptions,
        ),
        env,
        config,
        db,
        eventPublisher,
      ),
    workRunner: selectWorkRunner(env),
    executionEventPublisher: eventPublisher,
    spendPricing: config.spend,
    // Repo-bootstrap repositories are wired unconditionally (reference-architecture
    // CRUD is always available); the run path additionally needs the bootstrapper.
    referenceArchitectureRepository: new D1ReferenceArchitectureRepository({ db }),
    bootstrapJobRepository: new D1BootstrapJobRepository({ db }),
    repoBootstrapper: selectRepoBootstrapper(env, config, db, clock, idGenerator, resolveTransport),
    // Durably drive each bootstrap run's poll loop when the Workflows binding is
    // present (mirrors the execution driver); without it a run still dispatches.
    bootstrapRunner: env.BOOTSTRAP_WORKFLOW
      ? new WorkflowsBootstrapRunner(env.BOOTSTRAP_WORKFLOW)
      : undefined,
    ...selectGitHubDeps(env, config, db, clock, idGenerator),
    ...selectMergeLifecycleDeps(env, config, db, clock, idGenerator),
    ...selectReleaseHealthDeps(env, config, db),
    ...selectSlackDeps(config, db),
    ...selectEmailInvitationDeps(config, db),
    ...selectLangfuseSink(config),
    ...selectRecurringDeps(env, config, db, clock, idGenerator),
    ...selectDocumentsDeps(env, config, db, clock, idGenerator),
    ...selectTasksDeps(env, config, db, clock, idGenerator),
    ...selectRequirementsDeps(env, config, db),
    ...selectEnvironmentsDeps(env, config, db),
    ...selectRunnersDeps(env, config, db),
    ...selectFragmentLibraryDeps(env, config, db),
    // The pipeline-start guard resolves what's configured for a workspace + initiator.
    resolveProviderCapabilities: (workspaceId, initiatedBy) =>
      resolveWorkspaceCapabilities(
        {
          apiKeys,
          subscriptions,
          personalSubscriptions,
          cloudflareModelsEnabled,
          baseUrlFor: (provider) => baseUrlFor(provider, env),
          localModelEndpoints,
        },
        workspaceId,
        initiatedBy,
      ),
    ...overrides,
  }

  return {
    ...createCore(dependencies),
    config,
    agentRunRepository: new D1AgentRunRepository({ db }),
    // The consensus transcript store, for the read endpoint (the SPA window's initial
    // load / reload). Always wired; live updates ride the `consensus` workspace event.
    consensusSessionRepository: new D1ConsensusSessionRepository({ db }),
    // The vendor-credential (subscription token pool) service the shared controller
    // reads; present when the shared ENCRYPTION_KEY is configured.
    subscriptions,
    // The per-user individual-usage subscription store (Claude); present when the
    // shared ENCRYPTION_KEY is configured.
    personalSubscriptions,
    // The direct-provider API-key pool (account/workspace/user); present when the
    // shared ENCRYPTION_KEY is configured.
    apiKeys,
    // Whether the opt-in Cloudflare Workers AI lib is enabled (the `AI` binding).
    cloudflareModelsEnabled,
    // The direct-provider base-URL resolver the catalog uses to gate selectability on a
    // resolvable endpoint (e.g. LiteLLM stays unselectable until LITELLM_BASE_URL is set).
    baseUrlFor: (provider) => baseUrlFor(provider, env),
    // The per-user locally-run model endpoints store; present when ENCRYPTION_KEY is set.
    localModelEndpoints,
    gateways: {
      // Real-time event delivery via the per-workspace WorkspaceEventsHub DO (when
      // the WORKSPACE_EVENTS namespace is bound; absent → the events route 501s).
      realtime: new DoRealtimeGateway(env.WORKSPACE_EVENTS),
      // GitHub backfill via Workflows; webhook/resync ingest via the sync Queue. Both
      // fall back to inline handling when their binding is absent (local/dev/tests).
      githubBackfill: new WorkflowsBackfillScheduler(env.GITHUB_BACKFILL_WORKFLOW),
      githubWebhook: new CfGitHubWebhookIngest(env.GITHUB_SYNC_QUEUE),
      // LLM proxy upstream: OpenAI-compatible providers from env keys + the in-process
      // Workers AI binding path (the `workers-ai` provider).
      llmUpstream: new WorkersAiLlmUpstream(env),
      // Container web-search proxy upstream (Brave, or a self-hosted SearXNG). Absent
      // ⇒ the `/v1/web-search` route 503s and container web search stays off.
      webSearch: createWebSearchUpstreamFromEnv(env),
    },
  }
}
