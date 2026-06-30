import {
  type AgentContextRecorder,
  type AgentExecutor,
  type Clock,
  CompositeNotificationChannel,
  type DocumentSourceProvider,
  type EmailSender,
  type ExecutionEventPublisher,
  type FragmentOwnerKind,
  type GitHubClient,
  type IdGenerator,
  type ModelProviderResolver,
  type NotificationChannel,
  NoopWorkRunner,
  type ProvisioningSubsystem,
  type ResolveBinaryArtifactStore,
  type ResolveUserGitHubToken,
  type RunnerPoolProvider,
  type RunnerTransport,
  type TaskSourceProvider,
  type WorkRunner,
} from '@cat-factory/kernel'
import {
  AiAgentExecutor,
  inlineWebSearchOptionsFromEnv,
  resolveAgentConfig,
  isProxyableProvider,
} from '@cat-factory/agents'
import { cloudflareBindingRegistry } from '@cat-factory/provider-cloudflare'
import {
  ConfluenceProvider,
  FigmaProvider,
  ZeplinProvider,
  GitHubDocsProvider,
  GitHubIssuesProvider,
  JiraProvider,
  LinearDocumentProvider,
  LinearTaskProvider,
  createBackendRegistries,
  type EnvironmentBackendRegistry,
  type RunnerBackendRegistry,
  NotionProvider,
  EMAIL_CIPHER_INFO,
  ApiKeyService,
  LocalModelEndpointService,
  UserSecretService,
  OpenRouterCatalogService,
  usdRateForSpendCurrency,
  PersonalSubscriptionService,
  ProviderSubscriptionService,
  RunnerPoolConnectionService,
  ProvisioningLogRecorder,
  LoggingRunnerTransport,
  SLACK_CIPHER_INFO,
  SlackNotificationChannel,
  TicketTrackerService,
  IssueWritebackService,
  githubIssuesLogic,
  OBSERVABILITY_CIPHER_INFO,
  RegistryReleaseHealthProvider,
  defaultObservabilityRegistry,
  WorkspaceIncidentEnrichmentProvider,
  INCIDENT_ENRICHMENT_CIPHER_INFO,
  AccountSettingsService,
  ACCOUNT_SETTINGS_CIPHER_INFO,
  createEmailSender,
} from '@cat-factory/integrations'
import {
  AgentContextObservabilityService,
  type CoreDependencies,
  createCore,
  resolvePresetModelForKind,
} from '@cat-factory/orchestration'
import { createLangfuseSink } from '@cat-factory/observability-langfuse'
import {
  buildResolveRepoTarget as buildSharedResolveRepoTarget,
  ContainerEnvConfigRepairer,
  makeResolveRunRepoContext,
  makeResolveRepoFilesForCoords,
  makeResolveBinaryArtifactStore,
  type BuildBlobBackend,
  ensureWorkBranchViaRest,
  FanOutEventPublisher,
  InAppNotificationChannel,
  PatPreferringAppRegistry,
  runWithInitiator,
  WebCryptoPasswordHasher,
  WebCryptoPersonalSecretCipher,
  logger,
  buildInfrastructureCapabilities,
  createScopedModelProviderResolver,
  resolveUrlSafetyPolicy,
  resolveWorkspaceCapabilities,
  type MintInstallationToken,
  type ServerContainer,
} from '@cat-factory/server'
import { type AppConfig, loadConfig } from './config'
import { loadLangfuseConfig } from './config/langfuse'
import { loadObservabilityConfig } from './config/observability'
import type { Env } from './env'
import { requireTelemetryDb } from './env'
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
import { D1RunnerPoolConnectionRepository } from './repositories/D1RunnerPoolConnectionRepository'
import { D1ProviderSubscriptionTokenRepository } from './repositories/D1ProviderSubscriptionTokenRepository'
import { D1ProviderApiKeyRepository } from './repositories/D1ProviderApiKeyRepository'
import {
  D1PersonalSubscriptionRepository,
  D1SubscriptionActivationRepository,
} from './repositories/D1PersonalSubscriptionRepository'
import { D1LocalModelEndpointRepository } from './repositories/D1LocalModelEndpointRepository'
import { D1UserSecretRepository } from './repositories/D1UserSecretRepository'
import { D1ProviderModelCatalogRepository } from './repositories/D1ProviderModelCatalogRepository'
import { ContainerRepoBootstrapper } from './ai/ContainerRepoBootstrapper'
import { CompositeAgentExecutor } from './ai/CompositeAgentExecutor'
import { ContainerSessionService } from './containers/ContainerSessionService'
import { DurableObjectEventPublisher } from './events/DurableObjectEventPublisher'
import { WorkflowsWorkRunner } from './workflows/WorkflowsWorkRunner'
import { WorkflowsBootstrapRunner } from './workflows/WorkflowsBootstrapRunner'
import { WorkflowsEnvConfigRepairRunner } from './workflows/WorkflowsEnvConfigRepairRunner'
import { D1BlockRepository } from './repositories/D1BlockRepository'
import { D1ExecutionRepository } from './repositories/D1ExecutionRepository'
import { D1PipelineRepository } from './repositories/D1PipelineRepository'
import { D1ServiceRepository } from './repositories/D1ServiceRepository'
import { D1WorkspaceMountRepository } from './repositories/D1WorkspaceMountRepository'
import { D1TokenUsageRepository } from './repositories/D1TokenUsageRepository'
import { D1LlmCallMetricRepository } from './repositories/D1LlmCallMetricRepository'
import { D1AgentContextSnapshotRepository } from './repositories/D1AgentContextSnapshotRepository'
import { D1ProvisioningLogRepository } from './repositories/D1ProvisioningLogRepository'
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
import { D1PasswordResetTokenRepository } from './repositories/D1PasswordResetTokenRepository'
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
import { D1EnvConfigRepairJobRepository } from './repositories/D1EnvConfigRepairJobRepository'
import { D1AgentRunRepository } from './repositories/D1AgentRunRepository'
import { D1BinaryArtifactMetadataStore } from './repositories/D1BinaryArtifactMetadataStore'
import { R2BinaryBlobBackend } from './storage/R2BinaryBlobBackend'
import type { ContentStorageCapability } from '@cat-factory/contracts'
import { D1RequirementReviewRepository } from './repositories/D1RequirementReviewRepository'
import { D1KaizenGradingRepository } from './repositories/D1KaizenGradingRepository'
import { D1KaizenVerifiedComboRepository } from './repositories/D1KaizenVerifiedComboRepository'
import { D1ConsensusSessionRepository } from './repositories/D1ConsensusSessionRepository'
import { ConsensusAgentExecutor, registerConsensusTraits } from '@cat-factory/consensus'
import { D1ClarityReviewRepository } from './repositories/D1ClarityReviewRepository'
import { D1BrainstormSessionRepository } from './repositories/D1BrainstormSessionRepository'
import { D1NotificationRepository } from './repositories/D1NotificationRepository'
import { D1MergePresetRepository } from './repositories/D1MergePresetRepository'
import {
  D1SandboxPromptVersionRepository,
  D1SandboxFixtureRepository,
  D1SandboxExperimentRepository,
  D1SandboxRunRepository,
  D1SandboxGradeRepository,
} from './repositories/D1SandboxRepositories'
import { D1WorkspaceSettingsRepository } from './repositories/D1WorkspaceSettingsRepository'
import { D1ObservabilityConnectionRepository } from './repositories/D1ObservabilityConnectionRepository'
import { D1IncidentEnrichmentConnectionRepository } from './repositories/D1IncidentEnrichmentConnectionRepository'
import { D1AccountSettingsRepository } from './repositories/D1AccountSettingsRepository'
import { D1ReleaseHealthConfigRepository } from './repositories/D1ReleaseHealthConfigRepository'
import { D1PipelineScheduleRepository } from './repositories/D1PipelineScheduleRepository'
import { D1TrackerSettingsRepository } from './repositories/D1TrackerSettingsRepository'
import { D1ModelPresetRepository } from './repositories/D1ModelPresetRepository'
import { D1ServiceFragmentDefaultsRepository } from './repositories/D1ServiceFragmentDefaultsRepository'
// The built-in polling-gate suite (ci / conflicts / post-release-health + on-call). Importing
// it registers the gates via the public seam; the facade wires each gate's provider below.
import {
  type GateProviderOverrides,
  applyGateProviders,
  clearGateProviders,
  wireCiStatusProvider,
  wireMergeabilityProvider,
  wireReleaseHealthProvider,
  wireIncidentEnrichment,
  wirePullRequestReviewProvider,
  warnUnwiredGates,
} from '@cat-factory/gates'
import {
  buildGitLabEngineClient,
  registerGitLab,
  StaticGitLabTokenSource,
} from '@cat-factory/gitlab'
import { GitHubPullRequestReviewProvider } from '@cat-factory/server'
import { GitHubCiStatusProvider } from './github/GitHubCiStatusProvider'
import { GitHubMergeabilityProvider } from './github/GitHubMergeabilityProvider'
import { GitHubBranchUpdater } from './github/GitHubBranchUpdater'
import { GitHubPullRequestMerger } from './github/GitHubPullRequestMerger'
import { WebCryptoSecretCipher } from './environments/WebCryptoSecretCipher'
import { GitHubAppAuth } from './github/GitHubAppAuth'
import { GitHubAppRegistry } from './github/GitHubAppRegistry'
import { FetchGitHubClient } from './github/FetchGitHubClient'
import { FetchGitHubProvisioningClient } from './github/FetchGitHubProvisioningClient'
import { WebCryptoWebhookVerifier } from './github/WebCryptoWebhookVerifier'
import { D1TaskConnectionRepository } from './repositories/D1TaskConnectionRepository'
import { D1TaskSourceSettingsRepository } from './repositories/D1TaskSourceSettingsRepository'
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
 * The resolver every executor consults for a step's default model (block-pinned >
 * the task's selected/default model preset > env routing). Backed by the D1
 * model-preset repo; shared by the inline LLM executor and the container executor so
 * both honour the workspace presets identically. The built-in default preset points
 * every agent kind at Kimi K2.7, so an unpinned step resolves to it even before the
 * preset library is materialised.
 */
function buildResolveWorkspaceModelDefault(
  db: D1Database,
): (workspaceId: string, agentKind: string, modelPresetId?: string) => Promise<string | undefined> {
  const repo = new D1ModelPresetRepository({ db })
  return (workspaceId, agentKind, modelPresetId) =>
    resolvePresetModelForKind(repo, workspaceId, agentKind, modelPresetId)
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
  agentContextObservability?: AgentContextRecorder,
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
    agentContextObservability,
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
  provisioningLog: ProvisioningLogRecorder | undefined,
  // The app-owned runner-backend registry the service resolves a stored `kind` through.
  runnerBackendRegistry: RunnerBackendRegistry,
  // The shared HTTP provider the built-in `manifest` backend reuses when supplied (its OAuth
  // cache reused). NOT the custom-kind seam — a bespoke runner backend is registered by
  // reference into `runnerBackendRegistry`. Absent → the generic manifest-driven HTTP provider.
  injectedPoolProvider?: RunnerPoolProvider,
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
        env.HARNESS_SHARED_SECRET?.trim() || undefined,
      )
    : null

  // The self-hosted backend path: a connection service that resolves each workspace's
  // runner-backend config (manifest pool OR native Kubernetes) to a live transport via
  // the runner-backend provider registry. The shared manifest HTTP provider (its OAuth
  // cache reused) is threaded in for the `manifest` kind.
  let runnerService: RunnerPoolConnectionService | undefined
  if (config.runners.enabled) {
    const urlPolicy = resolveUrlSafetyPolicy(config.runners)
    runnerService = new RunnerPoolConnectionService({
      runnerPoolConnectionRepository: new D1RunnerPoolConnectionRepository({ db }),
      workspaceRepository: new D1WorkspaceRepository({ db }),
      secretCipher: new WebCryptoSecretCipher({
        masterKeyBase64: config.runners.encryptionKey!,
        info: 'cat-factory:runners',
      }),
      clock,
      runnerBackendRegistry,
      ...(urlPolicy ? { urlPolicy } : {}),
      runnerPoolProvider:
        injectedPoolProvider ?? new HttpRunnerPoolProvider(urlPolicy ? { urlPolicy } : {}),
    })
  }

  if (!cloudflare && !runnerService) return null

  // Wrap a resolved transport so every dispatch/release/poll-failure appends a
  // provisioning-log event tagged with the right subsystem (a self-hosted pool vs a
  // per-run Cloudflare container). No-op when the separate log store isn't wired.
  // The dedup set is closure-owned so it outlives each (per-resolution) wrapper.
  const loggedPollFailures = new Set<string>()
  const log = (
    inner: RunnerTransport,
    subsystem: ProvisioningSubsystem,
    workspaceId: string | undefined,
    providerId?: string | null,
  ): RunnerTransport =>
    provisioningLog
      ? new LoggingRunnerTransport({
          inner,
          recorder: provisioningLog,
          workspaceId: workspaceId ?? '',
          subsystem,
          providerId,
          loggedPollFailures,
        })
      : inner

  return async (workspaceId) => {
    if (runnerService && workspaceId) {
      const resolved = await runnerService.resolve(workspaceId)
      if (resolved) {
        return log(resolved.transport, 'runner-pool', workspaceId, resolved.providerId)
      }
    }
    if (cloudflare) return log(cloudflare, 'container', workspaceId)
    throw new Error(
      `No runner backend available for workspace '${workspaceId ?? '(unknown)'}': ` +
        `register a runner backend (a pool or Kubernetes) or enable Cloudflare Containers`,
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
/**
 * The GitHubClient the engine's gate / merge / RepoFiles paths read through: the GitHub App
 * (preferring the run initiator's per-user PAT when stored), else a GitLab-backed single-token
 * client (bridged onto the GitHubClient port). Undefined when neither is configured — the gates
 * then pass through. Shared by the merge-lifecycle and RepoFiles wiring so they resolve the SAME
 * provider, and so the GitLab fallback can't drift from the App path.
 */
function selectEngineVcsClient(
  env: Env,
  config: AppConfig,
  db: D1Database,
  clock: Clock,
  idGenerator: IdGenerator,
): GitHubClient | undefined {
  if (config.github.enabled && env.GITHUB_APP_PRIVATE_KEY) {
    const baseRegistry = buildAppRegistry(env, config, db, clock)
    // Prefer the run initiator's per-user PAT (when stored) over the App token for the CI gate +
    // merge reads; the engine sets the initiator in ambient context around those boundaries
    // (runWithInitiator). Falls back to the App token otherwise.
    const resolveUserGitHubToken = buildResolveUserGitHubToken(env, db, clock)
    const registry = resolveUserGitHubToken
      ? new PatPreferringAppRegistry(baseRegistry, resolveUserGitHubToken)
      : baseRegistry
    return new FetchGitHubClient({
      registry,
      rateLimitRepository: new D1RateLimitRepository({ db, idGenerator }),
      idGenerator,
      clock,
      apiBase: config.github.apiBase,
    })
  }
  if (config.gitlab?.enabled && env.GITLAB_TOKEN) {
    return buildGitLabEngineClient({
      token: env.GITLAB_TOKEN,
      apiBase: config.gitlab.apiBase,
      clock,
    })
  }
  return undefined
}

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
    modelPresetRepository: new D1ModelPresetRepository({ db }),
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

  // The engine's CI gate + merge / mergeability / review providers read through a single
  // GitHubClient. Prefer the GitHub App; else fall back to a GitLab-backed client (single-token,
  // bridged onto the GitHubClient port) so a GitLab-only deployment gates on real CI and merges
  // for real — parity with the App path and with local mode (keep the runtimes symmetric).
  const githubClient = selectEngineVcsClient(env, config, db, clock, idGenerator)
  if (githubClient) {
    const resolveRepoTarget = buildResolveRepoTarget(db)
    const blockRepository = new D1BlockRepository({ db })
    // The `ci` / `conflicts` gates now live in `@cat-factory/gates`; wire their providers into
    // the gate suite (deployment-global handles) instead of onto the engine's CoreDependencies.
    wireCiStatusProvider(
      new GitHubCiStatusProvider({ githubClient, resolveRepoTarget, blockRepository }),
    )
    wireMergeabilityProvider(
      new GitHubMergeabilityProvider({ githubClient, resolveRepoTarget, blockRepository }),
    )
    wirePullRequestReviewProvider(
      new GitHubPullRequestReviewProvider({ githubClient, resolveRepoTarget, blockRepository }),
    )
    deps.branchUpdater = new GitHubBranchUpdater({
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
 * Wire the observability post-release-health gate when enabled (+ ENCRYPTION_KEY): the
 * connection + per-block config repos, the cipher that seals the credentials, the pluggable
 * release-health provider the gate probes (a registry of vendor adapters — Datadog today),
 * and (optionally) the PagerDuty / incident.io enrichment providers. Off → the gate is a
 * pass-through and the release-health module isn't built.
 */
function selectReleaseHealthDeps(
  env: Env,
  config: AppConfig,
  db: D1Database,
): Partial<CoreDependencies> {
  if (!config.releaseHealth.enabled || !config.releaseHealth.encryptionKey) return {}
  const observabilityConnectionRepository = new D1ObservabilityConnectionRepository({ db })
  const releaseHealthConfigRepository = new D1ReleaseHealthConfigRepository({ db })
  const observabilitySecretCipher = new WebCryptoSecretCipher({
    masterKeyBase64: config.releaseHealth.encryptionKey,
    info: OBSERVABILITY_CIPHER_INFO,
  })
  // The post-release-health gate + its on-call escalation now live in `@cat-factory/gates`;
  // wire their providers into the gate suite (deployment-global handles). The observability
  // connection/config repos + cipher stay on CoreDependencies — they power the management API
  // (ReleaseHealthService), not the gate.
  wireReleaseHealthProvider(
    new RegistryReleaseHealthProvider({
      observabilityConnectionRepository,
      releaseHealthConfigRepository,
      blockRepository: new D1BlockRepository({ db }),
      secretCipher: observabilitySecretCipher,
      registry: defaultObservabilityRegistry,
    }),
  )
  return {
    observabilityConnectionRepository,
    releaseHealthConfigRepository,
    observabilitySecretCipher,
  }
}

/**
 * Wire the per-workspace incident-enrichment integration (PagerDuty + incident.io). The
 * credentials moved out of env into a sealed per-workspace row; the provider resolves +
 * decrypts them at enrichment time. Wired whenever the shared encryption key is present
 * (the cipher must exist to unseal); a workspace with no connection is a no-op. The
 * on-call enrichment provider itself now lives in `@cat-factory/gates`, so the
 * workspace-backed provider is wired into the gate suite via `wireIncidentEnrichment`;
 * the connection repo + cipher stay on CoreDependencies to power the management API.
 */
function selectIncidentEnrichmentDeps(env: Env, db: D1Database): Partial<CoreDependencies> {
  const encryptionKey = env.ENCRYPTION_KEY?.trim()
  if (!encryptionKey) return {}
  const incidentEnrichmentConnectionRepository = new D1IncidentEnrichmentConnectionRepository({
    db,
  })
  const incidentEnrichmentSecretCipher = new WebCryptoSecretCipher({
    masterKeyBase64: encryptionKey,
    info: INCIDENT_ENRICHMENT_CIPHER_INFO,
  })
  wireIncidentEnrichment(
    new WorkspaceIncidentEnrichmentProvider({
      incidentEnrichmentConnectionRepository,
      secretCipher: incidentEnrichmentSecretCipher,
    }),
  )
  return {
    incidentEnrichmentConnectionRepository,
    incidentEnrichmentSecretCipher,
  }
}

/**
 * Build the per-account deployment-settings service (Slack OAuth + web-search keys,
 * sealed) when the shared encryption key is present. A single instance is shared so its
 * short-TTL cache spans requests; the facade also derives the Slack OAuth resolver +
 * web-search proxy resolution from it.
 */
function buildAccountSettings(
  env: Env,
  db: D1Database,
  clock: Clock,
  contentStorageCapability?: ContentStorageCapability,
): AccountSettingsService | undefined {
  const encryptionKey = env.ENCRYPTION_KEY?.trim()
  if (!encryptionKey) return undefined
  return new AccountSettingsService({
    accountSettingsRepository: new D1AccountSettingsRepository({ db }),
    secretCipher: new WebCryptoSecretCipher({
      masterKeyBase64: encryptionKey,
      info: ACCOUNT_SETTINGS_CIPHER_INFO,
    }),
    clock,
    ...(contentStorageCapability ? { contentStorageCapability } : {}),
  })
}

/**
 * The Worker's content-storage capability + blob-backend factory: on Cloudflare the bytes
 * always go to the deployment's R2 bucket (the only blob store that makes sense on the
 * Worker). `fs`/`db` cannot exist on the Worker, and S3 is intentionally NOT offered here —
 * the AWS SDK does not belong in the Worker bundle, and an account that wants S3 should run
 * the Node/local facade. Shared by the container wiring and the retention cron so both build
 * the same backend.
 */
export function cloudflareContentStorage(env: Env): {
  capability: ContentStorageCapability
  buildBlobBackend: BuildBlobBackend
} {
  const capability: ContentStorageCapability = {
    supportedBackends: env.ARTIFACT_BUCKET ? ['off', 'r2'] : ['off'],
    defaultBackend: env.ARTIFACT_BUCKET ? 'r2' : 'off',
  }
  const buildBlobBackend: BuildBlobBackend = (kind) => {
    // R2 is the only blob backend the Worker serves; anything else ⇒ storage unavailable.
    return kind === 'r2' && env.ARTIFACT_BUCKET
      ? new R2BinaryBlobBackend({ bucket: env.ARTIFACT_BUCKET })
      : null
  }
  return { capability, buildBlobBackend }
}

/**
 * Build the per-account binary-artifact store resolver outside the full container (the
 * retention cron runs in its own context). Mirrors the container wiring, with its own
 * account-settings instance (a separate short-TTL cache is fine for a periodic sweep).
 */
export function buildCloudflareArtifactStoreResolver(
  env: Env,
  db: D1Database,
  clock: Clock,
  idGenerator: IdGenerator,
): ResolveBinaryArtifactStore {
  const { capability, buildBlobBackend } = cloudflareContentStorage(env)
  return makeResolveBinaryArtifactStore({
    accountSettings: buildAccountSettings(env, db, clock, capability),
    accountOf: (workspaceId) => new D1WorkspaceRepository({ db }).accountOf(workspaceId),
    metadata: new D1BinaryArtifactMetadataStore({ db }),
    idGenerator,
    clock,
    buildBlobBackend,
    defaultBackend: capability.defaultBackend,
  })
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
    // Password reset works without email (the link is logged in dev); the system
    // sender below upgrades it to real delivery when configured.
    passwordResetTokenRepository: new D1PasswordResetTokenRepository({ db }),
    resolveSystemEmailSender: buildSystemEmailSender(config),
    appBaseUrl: config.email.appBaseUrl || undefined,
    logger,
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
 * Build the deployment-level system email sender (auth emails like password reset) from
 * the env-driven `email.system` config, or undefined when not configured. Runtime-neutral
 * (`createEmailSender` is fetch-based), so the Node facade reuses the identical helper.
 */
function buildSystemEmailSender(
  config: AppConfig,
): (() => Promise<EmailSender | null>) | undefined {
  const system = config.email.system
  if (!system) return undefined
  const sender = createEmailSender({
    provider: system.provider,
    from: system.from,
    sendgrid: system.provider === 'sendgrid' ? { apiKey: system.apiKey } : undefined,
    resend: system.provider === 'resend' ? { apiKey: system.apiKey } : undefined,
  })
  if (!sender) return undefined
  return async () => sender
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
  // Writeback (comment-on-PR-open + close-on-merge of a task's linked issue) shares
  // the same GitHub client + Jira connection seams as the filing tracker above.
  const writebackDeps: ConstructorParameters<typeof IssueWritebackService>[0] = {
    trackerSettingsRepository: new D1TrackerSettingsRepository({ db }),
    taskRepository: new D1TaskRepository({ db }),
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
    // Writeback resolves the workspace's single installation, then comments/closes the
    // issue named by its `owner/repo#number` external id.
    const installationRepository = new D1GitHubInstallationRepository({ db })
    const resolveIssue = async (workspaceId: string, externalId: string) => {
      const parsed = githubIssuesLogic.parseGitHubIssueExternalId(externalId)
      if (!parsed) return null
      const installation = await installationRepository.getByWorkspace(workspaceId)
      if (!installation) return null
      return { installationId: installation.installationId, parsed }
    }
    writebackDeps.commentOnGitHubIssue = async (workspaceId, externalId, body) => {
      const target = await resolveIssue(workspaceId, externalId)
      if (!target) return
      await githubClient.comment(
        target.installationId,
        { owner: target.parsed.owner, repo: target.parsed.repo },
        target.parsed.number,
        body,
      )
    }
    writebackDeps.closeGitHubIssue = async (workspaceId, externalId) => {
      const target = await resolveIssue(workspaceId, externalId)
      if (!target) return
      await githubClient.closeIssue(
        target.installationId,
        { owner: target.parsed.owner, repo: target.parsed.repo },
        target.parsed.number,
      )
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
    const resolveJiraConnection = async (workspaceId: string) => {
      const connection = await taskConnectionRepository.getByWorkspace(workspaceId, 'jira')
      const { baseUrl, accountEmail, apiToken } = connection?.credentials ?? {}
      if (!baseUrl || !accountEmail || !apiToken) return null
      return { baseUrl, accountEmail, apiToken }
    }
    trackerDeps.resolveJiraConnection = resolveJiraConnection
    writebackDeps.resolveJiraConnection = resolveJiraConnection
    const resolveLinearConnection = async (workspaceId: string) => {
      const connection = await taskConnectionRepository.getByWorkspace(workspaceId, 'linear')
      const { apiKey, token } = connection?.credentials ?? {}
      return apiKey || token ? { apiKey, token } : null
    }
    trackerDeps.resolveLinearConnection = resolveLinearConnection
    writebackDeps.resolveLinearConnection = resolveLinearConnection
  }
  return {
    pipelineScheduleRepository: new D1PipelineScheduleRepository({ db }),
    trackerSettingsRepository: new D1TrackerSettingsRepository({ db }),
    ticketTrackerProvider: new TicketTrackerService(trackerDeps),
    issueWritebackProvider: new IssueWritebackService(writebackDeps),
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

/**
 * The per-USER generic secret store (a GitHub PAT today), or undefined when no
 * ENCRYPTION_KEY is configured. Single system-cipher; also backs `ResolveUserGitHubToken`.
 */
function buildUserSecretService(
  env: Env,
  db: D1Database,
  clock: Clock,
): UserSecretService | undefined {
  const masterKeyBase64 = env.ENCRYPTION_KEY?.trim()
  if (!masterKeyBase64) return undefined
  return new UserSecretService({
    userSecretRepository: new D1UserSecretRepository({ db }),
    secretCipher: new WebCryptoSecretCipher({ masterKeyBase64, info: 'cat-factory:user-secret' }),
    clock,
  })
}

/**
 * Resolve the run initiator's stored GitHub PAT (when set), or undefined when the secret
 * store isn't configured. Preferred over the App token by the container push-token mint +
 * the engine GitHub client (CI gate / merge), so runs are attributed to the initiator.
 */
function buildResolveUserGitHubToken(
  env: Env,
  db: D1Database,
  clock: Clock,
): ResolveUserGitHubToken | undefined {
  const userSecrets = buildUserSecretService(env, db, clock)
  return userSecrets ? (userId) => userSecrets.resolve(userId, 'github_pat') : undefined
}

/**
 * The per-WORKSPACE OpenRouter dynamic-catalog service (browse/enable gateway models), or
 * undefined when the API-key pool isn't wired (no ENCRYPTION_KEY) — refresh leases the
 * workspace's pooled OpenRouter key. Shared by the catalog controller, the per-workspace
 * model catalog, and the spend price overlay.
 */
function buildOpenRouterCatalogService(
  env: Env,
  db: D1Database,
  clock: Clock,
  apiKeys: ApiKeyService | undefined,
  spendCurrency: string,
): OpenRouterCatalogService | undefined {
  if (!apiKeys) return undefined
  return new OpenRouterCatalogService({
    providerModelCatalogRepository: new D1ProviderModelCatalogRepository({ db }),
    apiKeys,
    clock,
    baseUrl: baseUrlFor('openrouter', env) ?? undefined,
    // OpenRouter quotes USD; convert to the deployment's spend currency so persisted prices
    // (and the spend overlay) match the rest of the budget table.
    usdToCurrencyRate: usdRateForSpendCurrency(spendCurrency),
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
  agentContextObservability?: AgentContextRecorder,
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
  // Prefer the run initiator's per-user PAT (when stored) over the App token, so the
  // container's clone/push/PR is attributed to them. Falls back to the App token.
  const resolveUserGitHubToken = buildResolveUserGitHubToken(env, db, clock)
  const mintInstallationToken: MintInstallationToken = async (installationId, ctx) => {
    if (resolveUserGitHubToken && ctx?.initiatedBy) {
      const pat = await resolveUserGitHubToken(ctx.initiatedBy)
      if (pat) return pat
    }
    return registry.installationToken(installationId)
  }

  // Web-search keys live per-account; advertise Pi's `web_search` tool to a run only when
  // its account actually has a usable upstream (else the tool would just fail/return
  // nothing). Resolved per run off the account-settings store (its own short-TTL cache).
  const webSearchSettings = buildAccountSettings(env, db, clock)
  const resolveWebSearchEnabled = webSearchSettings
    ? async (workspaceId: string): Promise<boolean> => {
        const accountId = await new D1WorkspaceRepository({ db }).accountOf(workspaceId)
        if (!accountId) return false
        return Boolean((await webSearchSettings.resolve(accountId)).webSearch)
      }
    : undefined

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
    mintInstallationToken,
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
    // Point container agents' web search at the backend search proxy (no provider key in
    // the sandbox), but only for a run whose account has keys (see resolver above).
    ...(resolveWebSearchEnabled ? { resolveWebSearchEnabled } : {}),
    githubApiBase: config.github.apiBase,
    // Forward container tool spans to Langfuse (when configured) as child spans under
    // the run trace — the same sink the LLM proxy fans generations out to.
    llmTraceSink: buildLangfuseSink(config),
    // Record the complete provided context per dispatch (best-effort, gated in the sink).
    ...(agentContextObservability ? { agentContextObservability } : {}),
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
  if (!config.github.enabled) {
    // GitLab-only deployment: the App-shaped connect / projection / provisioning wiring stays
    // off (GitLab ingests via the neutral `/vcs/:provider/webhooks` route), but the checkout-free
    // RepoFiles seams — a registered custom kind's pre/post-op hooks + the environments module's
    // on-demand repo validation — must still work, so wire them from the GitLab-backed client.
    if (config.gitlab?.enabled && env.GITLAB_TOKEN) {
      const githubClient = buildGitLabEngineClient({
        token: env.GITLAB_TOKEN,
        apiBase: config.gitlab.apiBase,
        clock,
      })
      return {
        resolveRunRepoContext: makeResolveRunRepoContext(githubClient, buildResolveRepoTarget(db)),
        resolveRepoFilesForCoords: makeResolveRepoFilesForCoords(
          githubClient,
          new D1GitHubInstallationRepository({ db }),
          new D1RepoProjectionRepository({ db }),
        ),
      }
    }
    return {}
  }

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
    // The engine binds a registered custom kind's pre/post-op hooks to a run's repo via
    // this checkout-free RepoFiles resolver (installation + repo + default branch),
    // composed from the same client + repo-target walk the container executor uses.
    resolveRunRepoContext: makeResolveRunRepoContext(githubClient, buildResolveRepoTarget(db)),
    // Block-less repo resolver for the environments module's on-demand repo validation /
    // config bootstrap (operator names owner+repo).
    resolveRepoFilesForCoords: makeResolveRepoFilesForCoords(
      githubClient,
      githubInstallationRepository,
      new D1RepoProjectionRepository({ db }),
    ),
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
  // Figma + Zeplin authenticate with a per-workspace PAT (no GitHub client needed), like
  // Notion/Confluence.
  if (config.documents.sources.includes('figma')) providers.push(new FigmaProvider())
  if (config.documents.sources.includes('zeplin')) providers.push(new ZeplinProvider())
  if (config.documents.sources.includes('linear')) providers.push(new LinearDocumentProvider())
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
  // Jira and Linear are always registered (their credentials are per-workspace, entered in the UI).
  const providers: TaskSourceProvider[] = [new JiraProvider(), new LinearTaskProvider()]
  // GitHub Issues reuse the workspace's installed GitHub App, so this provider is
  // wired whenever the GitHub integration is configured — it has no credentials of
  // its own and resolves the installation per issue. Whether a workspace OFFERS it
  // is the per-workspace toggle (task_source_settings), not a deployment env gate.
  if (config.github.enabled) {
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
    taskSourceSettingsRepository: new D1TaskSourceSettingsRepository({ db }),
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
    kaizenGradingRepository: new D1KaizenGradingRepository({ db }),
    kaizenVerifiedComboRepository: new D1KaizenVerifiedComboRepository({ db }),
    clarityReviewRepository: new D1ClarityReviewRepository({ db }),
    brainstormSessionRepository: new D1BrainstormSessionRepository({ db }),
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
 * The Sandbox (parallel prompt/model testing) persistence — five repos over the
 * DEDICATED `SANDBOX_DB` D1 database. Opt-in: absent binding ⇒ `{}` (the module isn't
 * assembled and the API answers 503), so a deployment that hasn't provisioned the
 * sandbox database is unaffected. The inline reviewer model config from
 * {@link selectRequirementsDeps} is reused by the run-driver (cells resolve their catalog
 * id like a pipeline step). Mirrored by the Node facade's `createDrizzleSandboxDeps`
 * (a Postgres `sandbox` schema).
 */
function selectSandboxDeps(sandboxDb: D1Database | undefined): Partial<CoreDependencies> {
  if (!sandboxDb) return {}
  return {
    sandboxPromptVersionRepository: new D1SandboxPromptVersionRepository(sandboxDb),
    sandboxFixtureRepository: new D1SandboxFixtureRepository(sandboxDb),
    sandboxExperimentRepository: new D1SandboxExperimentRepository(sandboxDb),
    sandboxRunRepository: new D1SandboxRunRepository(sandboxDb),
    sandboxGradeRepository: new D1SandboxGradeRepository(sandboxDb),
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
  // The provider is resolved per-workspace from the env-backend registry by the stored
  // `kind` (`manifest` | `kubernetes` | a third-party kind imported for side effect); a
  // workspace picks its backend at connect time. The Worker can't honor a custom CA /
  // insecure-skip TLS for a Kubernetes apiserver (no undici), so such a config is rejected
  // at registration here.
  const urlPolicy = resolveUrlSafetyPolicy(config.environments)
  return {
    environmentConnectionRepository: new D1EnvironmentConnectionRepository({ db }),
    environmentRegistryRepository: new D1EnvironmentRegistryRepository({ db }),
    secretCipher: new WebCryptoSecretCipher({
      masterKeyBase64: config.environments.encryptionKey!,
    }),
    environmentCustomTlsSupported: false,
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
    // The generic pool provider backs the connection service's describeProvider +
    // testConnection (the manifest editor's secret-key form + a pre-save probe).
    runnerPoolProvider: new HttpRunnerPoolProvider(urlPolicy ? { urlPolicy } : {}),
    // The Worker fetch can't verify a private CA / skip TLS (no undici), so reject a
    // Kubernetes backend that needs custom TLS at registration instead of at dispatch.
    runnerCustomTlsSupported: false,
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
 * Build the live ENVIRONMENT-PROVIDER CONFIG REPAIR agent (PR #416 increment 2) when its
 * prerequisites are met — the same container prerequisites as the bootstrapper PLUS an
 * injected provider that actually supports agent repair (`describeRepairAgent`). A stock
 * deployment runs the generic manifest provider (no repair support), so this stays
 * undefined there; it wires only when a native adapter (e.g. Kargo) is injected. Built
 * over the FINAL provider (post-overrides), so the dispatcher repairs through the same
 * provider the engine validates with. NOT to be confused with the repo bootstrapper: this
 * is an ordinary clone→edit→push coding job (no history reset / force-push).
 */
function selectEnvConfigRepairer(
  env: Env,
  config: AppConfig,
  db: D1Database,
  clock: Clock,
  resolveTransport: ResolveRunnerTransport | null,
  override: CoreDependencies['environmentProvider'],
  environmentBackendRegistry: EnvironmentBackendRegistry,
): ContainerEnvConfigRepairer | undefined {
  const repairUrlPolicy = resolveUrlSafetyPolicy(config.environments)
  // Prefer the internal override (the conformance suite's fake repair provider) else scan
  // the env-backend registry for the first repair-capable backend.
  const environmentProvider = !resolveTransport
    ? undefined
    : (override ??
      environmentBackendRegistry.findRepairCapable(
        repairUrlPolicy ? { urlPolicy: repairUrlPolicy } : {},
      ))
  if (
    !resolveTransport ||
    !environmentProvider ||
    typeof environmentProvider.describeRepairAgent !== 'function' ||
    !config.github.enabled ||
    !env.GITHUB_APP_PRIVATE_KEY ||
    !env.WORKER_PUBLIC_URL ||
    !env.AUTH_SESSION_SECRET
  ) {
    return undefined
  }
  // A config fix is coding work, so it follows the `coder` kind's routing. The repair runs on
  // the Pi harness over the LLM proxy, so the routed model MUST be proxyable. Surface a
  // misconfiguration HERE (at wiring) rather than letting every repair dispatch throw deep in a
  // request: if `coder` is routed to a non-proxyable model (e.g. an individual subscription
  // vendor), leave the fallback unwired — bootstrap then returns the validation issues, exactly
  // as it does when no provider supports repair.
  const model = resolveAgentConfig(config.agents.routing, 'coder').ref
  if (!isProxyableProvider(model.provider)) {
    logger.warn(
      { provider: model.provider },
      'env-config repair: the coder routing model is not proxyable by the LLM proxy; ' +
        'the agent config-repair fallback is disabled.',
    )
    return undefined
  }
  const registry = buildAppRegistry(env, config, db, clock)
  return new ContainerEnvConfigRepairer({
    resolveTransport,
    installationRepository: new D1GitHubInstallationRepository({ db }),
    mintInstallationToken: (id) => registry.installationToken(id),
    sessionService: new ContainerSessionService({ secret: env.AUTH_SESSION_SECRET }),
    environmentProvider,
    model,
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
  opts: { cloudflareModelsEnabled?: boolean; gateProviders?: GateProviderOverrides } = {},
): Container {
  const config = loadConfig(env)
  // The Worker runs repo-operating agents on per-run Cloudflare Containers (always available),
  // and can additionally delegate to a self-hosted runner pool when one is configured. Tester
  // environments run via the environment provider. Surface this so the SPA's infrastructure
  // selector reads accurately for a Worker deployment.
  config.infrastructure = buildInfrastructureCapabilities({
    execution: {
      available: config.runners.enabled
        ? ['cloudflare-containers', 'runner-pool']
        : ['cloudflare-containers'],
      active: 'cloudflare-containers',
    },
    testEnv: { available: ['environment-provider'], active: 'environment-provider' },
  })
  const db = env.DB
  // Telemetry (llm_call_metrics + agent_context_snapshots) lives in its own D1 database
  // — append-heavy/high-volume/short-retention, unlike the transactional domain. The
  // binding is required: fail fast here rather than NPE deep in a repo on first write.
  const telemetryDb = requireTelemetryDb(env)
  const clock = new SystemClock()
  const idGenerator = new CryptoIdGenerator()

  // The app-owned backend registries (env + runner kind → provider), built once and injected
  // into the engine + surfaced on the container for the snapshot's backend-kind selectors. A
  // deployment registers a custom backend by reference; the conformance suite injects a
  // pre-loaded registry via `overrides`. Defaults to the built-in `manifest`/`kubernetes` kinds.
  const defaultRegistries = createBackendRegistries()
  const environmentBackendRegistry =
    overrides.environmentBackendRegistry ?? defaultRegistries.environmentBackendRegistry
  const runnerBackendRegistry =
    overrides.runnerBackendRegistry ?? defaultRegistries.runnerBackendRegistry

  // Binary-artifact storage (UI screenshots + reference design images) for the
  // visual-confirmation gate. The backend is configured PER ACCOUNT in the UI: an account can
  // keep the deployment's R2 bucket (the default when the ARTIFACT_BUCKET binding is present)
  // or switch to its own S3 bucket. The metadata always lives in D1; only the bytes' backend
  // changes. The store is resolved per request/run from the account settings
  // (`resolveBinaryArtifactStore`, built below once `accountSettings` exists).
  const { capability: contentStorageCapability, buildBlobBackend: buildCfBlobBackend } =
    cloudflareContentStorage(env)

  // The built-in gates' providers are deployment-global module handles (in `@cat-factory/gates`),
  // not per-container DI. Reset them up-front so each build re-wires from a clean slate and only
  // the gates this env actually configures stay wired: `selectMergeLifecycleDeps` /
  // `selectReleaseHealthDeps` wire their providers only inside their `enabled` branches and never
  // clear, so without this reset a provider wired by an earlier (configured) build would leak into
  // a later (unconfigured) build and make its gate probe a stale handle instead of passing through.
  // Any test-injected gate providers (`opts.gateProviders`) are applied at the END of this build
  // (after the config wiring below) so they OVERRIDE it — the only way an externally-supplied
  // provider survives the per-request rebuild, and so a deployment that ALSO wires a real provider
  // can't clobber the test's. Gates read their provider lazily at probe time, so the last write wins.
  clearGateProviders()

  // Opt-in GitLab VCS provider (single-token model, mirroring local-mode's PAT). Registered
  // in the process-wide VCS registry — like a gate provider, a deployment-global handle reset
  // each build — so the neutral webhook route + any VcsConnectionRef holder resolves it. A
  // no-op unless GITLAB_TOKEN is set; symmetric with the Node facade (local inherits it) per
  // "keep the runtimes symmetric".
  if (config.gitlab?.enabled && env.GITLAB_TOKEN) {
    registerGitLab({
      tokenSource: new StaticGitLabTokenSource(env.GITLAB_TOKEN, config.gitlab.apiBase),
      clock,
      webhookSecret: config.gitlab.webhookSecret || undefined,
    })
  }

  // The unified provisioning event log lives in a SEPARATE D1 database (its own
  // binding + migrations) to isolate its high write churn. When wired, build the
  // repo + a best-effort recorder shared by the env services (via createCore) and
  // the runner/container transport decorator below.
  const provisioningLogRepository = env.PROVISIONING_DB
    ? new D1ProvisioningLogRepository({ db: env.PROVISIONING_DB })
    : undefined
  const provisioningLogRecorder = provisioningLogRepository
    ? new ProvisioningLogRecorder({ repository: provisioningLogRepository, idGenerator, clock })
    : undefined

  // The runner-backend factory is shared by every container-backed flow (the
  // implementation executor and the repo bootstrapper), so both dispatch through the
  // same Cloudflare/self-hosted seam — and the bootstrapper rides the reaping-aware
  // Cloudflare transport for free. Null when no backend is configured.
  // `overrides.runnerPoolProvider` swaps the shared HTTP provider the built-in `manifest` pool
  // reuses (its OAuth cache); the `...overrides` spread (last, below) already routes it to the
  // connection-management UI, so thread it here too so it ALSO drives the manifest backend's
  // dispatch transport. (A bespoke runner backend is registered by reference into
  // `runnerBackendRegistry`, NOT this provider override.)
  const resolveTransport = buildResolveTransport(
    env,
    config,
    db,
    clock,
    provisioningLogRecorder,
    runnerBackendRegistry,
    overrides.runnerPoolProvider,
  )

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

  // The per-user generic secret store (a GitHub PAT today) — shared by the user-secret
  // controller; also backs the run-initiator PAT resolver used by the executor + gates.
  const userSecrets = buildUserSecretService(env, db, clock)

  // The per-workspace OpenRouter dynamic-catalog store — shared by the catalog controller,
  // the per-workspace model catalog's dynamic OpenRouter entries, and the spend overlay.
  const openRouterCatalog = buildOpenRouterCatalogService(
    env,
    db,
    clock,
    apiKeys,
    config.spend.currency,
  )

  // Cloudflare Workers AI is opt-in: enabled when the `AI` binding is present. A caller
  // (the cross-runtime conformance suite) may force it off to assert key-driven
  // selectability + the provider guard uniformly across runtimes.
  const cloudflareModelsEnabled = opts.cloudflareModelsEnabled ?? !!env.AI

  // Built once so the consensus executor and the engine share the same publisher (live
  // consensus transcript pushes ride the same hub as run/board events).
  const eventPublisher = selectEventPublisher(env, db)

  // Agent-context observability sink: records the complete, redacted context provided
  // to each container agent (composed prompts + folded-in fragments + injected files).
  // Gated by the deployment prompt-recording switch + the workspace storeAgentContext
  // setting. Wired into the executor (write) AND createCore (read). Telemetry rows live
  // in the dedicated TELEMETRY_DB database.
  const agentContextObservability = new AgentContextObservabilityService({
    agentContextSnapshotRepository: new D1AgentContextSnapshotRepository({ db: telemetryDb }),
    workspaceSettingsRepository: new D1WorkspaceSettingsRepository({ db }),
    idGenerator,
    clock,
    recordPrompts: config.observability.recordPrompts,
  })

  // Per-account deployment settings (Slack OAuth + web-search keys + content-storage). Built
  // once so the service's short-TTL cache is shared across requests; the Slack OAuth +
  // content-storage resolvers are derived from it in the domain composition root.
  const accountSettings = buildAccountSettings(env, db, clock, contentStorageCapability)

  // Resolve the binary-artifact store for a workspace's account from its content-storage
  // settings (the blob backend is per-account; the metadata is the shared D1 store). Without
  // `accountSettings` (no encryption key) every workspace falls back to the runtime default
  // (R2 when bound), with no per-account override. Caches per account, so an R2→S3 switch
  // rebuilds and the many workspaces under one account share a store.
  const resolveBinaryArtifactStore = makeResolveBinaryArtifactStore({
    accountSettings,
    accountOf: (workspaceId) => new D1WorkspaceRepository({ db }).accountOf(workspaceId),
    metadata: new D1BinaryArtifactMetadataStore({ db }),
    idGenerator,
    clock,
    buildBlobBackend: buildCfBlobBackend,
    defaultBackend: contentStorageCapability.defaultBackend,
  })

  const dependencies: CoreDependencies = {
    // App-owned backend registries (kind → provider) the connection services resolve through.
    environmentBackendRegistry,
    runnerBackendRegistry,
    // Resolves the per-account binary-artifact store (screenshots) for the
    // visual-confirmation gate; resolving to null ⇒ the gate passes through.
    resolveBinaryArtifactStore,
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
    // Telemetry lives in the dedicated TELEMETRY_DB database.
    llmCallMetricRepository: new D1LlmCallMetricRepository({ db: telemetryDb }),
    // Unified provisioning event log (separate D1 binding). Threads the recorder into
    // the env services and exposes the read service for the logs controller; undefined
    // when PROVISIONING_DB isn't bound.
    ...(provisioningLogRepository ? { provisioningLogRepository } : {}),
    recordLlmPrompts: config.observability.recordPrompts,
    // Re-exposed on the core for the agent-context read endpoint; the same instance is
    // injected into the container executor below for the write path.
    agentContextObservability,
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
          agentContextObservability,
        ),
        env,
        config,
        db,
        eventPublisher,
      ),
    workRunner: selectWorkRunner(env),
    executionEventPublisher: eventPublisher,
    spendPricing: config.spend,
    // Price metered dynamic OpenRouter models at their real per-model rate (not the
    // bare-`openrouter` fallback) using this workspace's enabled catalog.
    dynamicModelPricesFor: openRouterCatalog
      ? (ws) => openRouterCatalog.capabilitiesFor(ws)
      : undefined,
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
    // Env-config-repair runs share the unified `agent_runs` table (kind-scoped). The
    // job repository is wired unconditionally; the repairer (the agent fallback) is wired
    // post-overrides below over the FINAL provider, and the durable runner when its
    // Workflows binding is present (else the cron sweep re-drives a run left running).
    envConfigRepairJobRepository: new D1EnvConfigRepairJobRepository({ db }),
    envConfigRepairRunner: env.ENV_CONFIG_REPAIR_WORKFLOW
      ? new WorkflowsEnvConfigRepairRunner(env.ENV_CONFIG_REPAIR_WORKFLOW)
      : undefined,
    ...selectGitHubDeps(env, config, db, clock, idGenerator),
    ...selectMergeLifecycleDeps(env, config, db, clock, idGenerator),
    ...selectReleaseHealthDeps(env, config, db),
    ...selectIncidentEnrichmentDeps(env, db),
    ...(accountSettings ? { accountSettings } : {}),
    ...selectSlackDeps(config, db),
    ...selectEmailInvitationDeps(config, db),
    ...selectLangfuseSink(config),
    ...selectRecurringDeps(env, config, db, clock, idGenerator),
    ...selectDocumentsDeps(env, config, db, clock, idGenerator),
    ...selectTasksDeps(env, config, db, clock, idGenerator),
    ...selectRequirementsDeps(env, config, db),
    ...selectSandboxDeps(env.SANDBOX_DB),
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
          openRouterCatalog,
        },
        workspaceId,
        initiatedBy,
      ),
    // Run the engine's gate-probe / merge GitHub reads under the run initiator's ambient
    // context, so a per-user PAT (when set) is preferred over the App token.
    runInitiatorScope: runWithInitiator,
    ...overrides,
  }

  // Wire the live env-config repair agent over the FINAL environment provider (after the
  // `...overrides` above), so a native adapter injected via overrides — not the default
  // manifest provider — is the one the repair dispatcher uses. Unwired on a stock deployment
  // (the generic provider has no `describeRepairAgent`), exactly like the service guard.
  const envConfigRepairer = selectEnvConfigRepairer(
    env,
    config,
    db,
    clock,
    resolveTransport,
    dependencies.environmentProvider,
    environmentBackendRegistry,
  )
  // Don't clobber an override-provided repairer (e.g. the conformance suite's fake): an
  // explicit `overrides.envConfigRepairer` wins, exactly like `repoBootstrapper`.
  if (envConfigRepairer && !dependencies.envConfigRepairer) {
    dependencies.envConfigRepairer = envConfigRepairer
  }

  // Apply any test-injected gate providers LAST, so they override the config wiring done by the
  // `select*Deps` spreads above (the conformance suite drives the externalized CI gate over a
  // faked verdict). Production leaves `gateProviders` undefined, so this is a no-op outside tests.
  applyGateProviders(opts.gateProviders)
  // Surface any gate left as a silent pass-through (no provider wired) so a misconfigured
  // deployment is visible in the logs instead of quietly auto-merging without checking CI.
  warnUnwiredGates(logger)

  return {
    ...createCore(dependencies),
    config,
    // The same checkout-free repo resolver the engine binds pre/post-ops with, surfaced so
    // the shared service-spec read controller can read the `spec/` artifact off main.
    resolveRunRepoContext: dependencies.resolveRunRepoContext,
    // The block→service→repo resolver, surfaced so the task-search controller can scope a
    // GitHub-issue search to the originating service's repo (and refuse it when unlinked).
    resolveRepoTarget: buildResolveRepoTarget(db),
    agentRunRepository: new D1AgentRunRepository({ db }),
    // Execution-scoped repo, surfaced for the conformance suite's compareAndSwap parity check.
    executionRepository: dependencies.executionRepository,
    // App-owned backend registries, surfaced so the workspace snapshot's backend-kind
    // selectors (`environmentBackendKinds` / `runnerBackendKinds`) read the registered kinds.
    environmentBackendRegistry,
    runnerBackendRegistry,
    // The consensus transcript store, for the read endpoint (the SPA window's initial
    // load / reload). Always wired; live updates ride the `consensus` workspace event.
    consensusSessionRepository: new D1ConsensusSessionRepository({ db }),
    // Resolves the per-account binary-artifact store (screenshots) for the artifact
    // controllers + the visual-confirmation gate (configured per-account in the UI).
    resolveBinaryArtifactStore,
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
    // The per-user generic secret store (GitHub PAT, …); present when ENCRYPTION_KEY is set.
    userSecrets,
    // The per-workspace OpenRouter dynamic-catalog store; present when the API-key pool is.
    openRouterCatalog,
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
      // Container web-search upstream is resolved per-account by the proxy controller
      // (keys moved out of env into the per-account settings store), so no boot-time
      // gateway upstream is wired here.
    },
  }
}
