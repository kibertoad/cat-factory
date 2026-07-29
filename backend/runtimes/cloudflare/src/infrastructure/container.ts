import {
  type AgentContextRecorder,
  type AgentExecutor,
  type Clock,
  CompositeNotificationChannel,
  type DocumentSourceProvider,
  type EmailSender,
  type ExecutionEventPublisher,
  type GitHubClient,
  type GroupCacheHandle,
  type IdGenerator,
  type ModelProviderResolver,
  type NotificationChannel,
  composeTraceSinks,
  NoopWorkRunner,
  type ProvisioningSubsystem,
  type ResolveBinaryArtifactStore,
  type ResolvedAccountSettings,
  type RunnerPoolProvider,
  type RunnerTransport,
  type TaskSourceProvider,
  type VcsIdentityRegistry,
  type WebSearchAvailability,
  type WorkRunner,
  type ProviderRegistry,
  createStoreAgentContextGate,
} from '@cat-factory/kernel'
import {
  AiAgentExecutor,
  type AgentKindRegistry,
  createTierInstallationResolvers,
  inlineWebSearchOptionsFromEnv,
  resolveAgentConfig,
  isProxyableProvider,
  vendorConcurrencyLimiterFromEnv,
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
  type EnvironmentBackendRegistry,
  type RunnerBackendRegistry,
  NotionProvider,
  EMAIL_CIPHER_INFO,
  PersonalSubscriptionService,
  ProviderSubscriptionService,
  RunnerPoolConnectionService,
  ProvisioningLogRecorder,
  LoggingRunnerTransport,
  SLACK_CIPHER_INFO,
  NOTIFICATION_WEBHOOK_CIPHER_INFO,
  SlackNotificationChannel,
  buildNotificationWebhookSupport,
  OBSERVABILITY_CIPHER_INFO,
  RegistryReleaseHealthProvider,
  defaultObservabilityRegistry,
  RegistrySubscriptionQuotaProvider,
  defaultSubscriptionQuotaRegistry,
  WorkspaceIncidentEnrichmentProvider,
  INCIDENT_ENRICHMENT_CIPHER_INFO,
  AccountSettingsService,
  ACCOUNT_SETTINGS_CIPHER_INFO,
  createEmailSender,
} from '@cat-factory/integrations'
// Opt-in AWS EKS backends (runner + environment), registered by reference on BOTH facades so
// the runtimes stay symmetric with the native `kubernetes` backend they extend (which likewise
// rides both). They are pass-throughs until a workspace connects an `eks` backend, and carry NO
// runtime AWS SDK dependency (the IAM token is minted with WebCrypto, which workerd supports).
// A real EKS cluster's private-CA apiserver is only reachable from a runtime that can pin a
// custom CA (Node/local) — exactly like a private-CA `kubernetes` connection — so on the Worker
// the kind is offered but a connection to such a cluster fails TLS at run time, not silently.
import { resolveWorkerRegistries } from './container-registries.js'
import {
  buildLangfuseSink,
  buildOtelSink,
  buildTraceSink,
  selectTraceSink,
} from './container-trace-sinks.js'
export { selectTraceSink }
import { assembleWorkerContainer } from './container-assembly.js'
import {
  AgentContextObservabilityService,
  SearchQueryObservabilityService,
  type CoreDependencies,
  PACKAGE_REGISTRY_CIPHER_INFO,
  resolvePackageRegistriesForDispatch,
  LlmObservabilityService,
  makeHarnessCallRecorder,
  resolvePresetModelForKind,
} from '@cat-factory/orchestration'
import { ISOLATE_SAFE_APP_CACHES_PROFILE, createAppCaches } from '@cat-factory/caching'
import {
  buildResolveRepoTarget as buildSharedResolveRepoTarget,
  buildResolveRepoTargets as buildSharedResolveRepoTargets,
  ContainerEnvConfigRepairer,
  makeResolveDeployCloneTarget,
  RunnerJobClient,
  makeResolveBinaryArtifactStore,
  type BuildBlobBackend,
  ensureWorkBranchViaRest,
  FanOutEventPublisher,
  InAppNotificationChannel,
  PatPreferringAppRegistry,
  logger,
  buildInfrastructureCapabilities,
  createDefaultWebSearchUpstream,
  createWebSearchUpstream,
  createScopedModelProviderResolver,
  wrapResolverWithLimiter,
  ENV_HELP,
  configProblem,
  GitHubIdentityResolver,
  resolveUrlSafetyPolicy,
  noRunnerBackendAvailableError,
  type JobPackageRegistrySpec,
  type MintInstallationToken,
  type ServerContainer,
  type WebSearchUpstream,
} from '@cat-factory/server'
import { type AppConfig, loadConfig } from './config'
import { loadLangfuseConfig } from './config/langfuse'
import { loadObservabilityConfig } from './config/observability'
import { loadOtelConfig } from './config/otel'
import type { Env } from './env'
import { requireDb, requireTelemetryDb } from './env'
import { baseUrlFor } from './ai/providerEndpoints'
import { resolveExtraRegistries } from './ai/registries'
import { CfGitHubWebhookIngest } from './gateways/GitHubGateways'
import {
  ContainerAgentExecutor,
  type ResolveRepoTarget,
  type ResolveRepoTargets,
  type ResolveRunnerTransport,
} from './ai/ContainerAgentExecutor'
import { CloudflareContainerTransport } from './containers/CloudflareContainerTransport'
import { ContainerInstanceRegistry } from './containers/ContainerInstanceRegistry'
import { D1LiveContainerRepository } from './repositories/D1LiveContainerRepository'
import { HttpRunnerPoolProvider } from './runners/HttpRunnerPoolProvider'
import { D1RunnerPoolConnectionRepository } from './repositories/D1RunnerPoolConnectionRepository'
import { ContainerRepoBootstrapper } from './ai/ContainerRepoBootstrapper'
import { CompositeAgentExecutor } from './ai/CompositeAgentExecutor'
import { ContainerSessionService } from './containers/ContainerSessionService'
import { DurableObjectEventPublisher } from './events/DurableObjectEventPublisher'
import { WorkflowsWorkRunner } from './workflows/WorkflowsWorkRunner'
import { D1BlockRepository } from './repositories/D1BlockRepository'
import { D1ServiceRepository } from './repositories/D1ServiceRepository'
import { D1WorkspaceMountRepository } from './repositories/D1WorkspaceMountRepository'
import { D1LlmCallMetricRepository } from './repositories/D1LlmCallMetricRepository'
import { D1AgentContextSnapshotRepository } from './repositories/D1AgentContextSnapshotRepository'
import { D1AgentSearchQueryRepository } from './repositories/D1AgentSearchQueryRepository'
import { D1ProvisioningLogRepository } from './repositories/D1ProvisioningLogRepository'
import { D1WorkspaceRepository } from './repositories/D1WorkspaceRepository'
import {
  D1SlackConnectionRepository,
  D1SlackMemberMappingRepository,
  D1SlackSettingsRepository,
} from './repositories/D1SlackRepositories'
import { D1AccountInvitationRepository } from './repositories/D1AccountInvitationRepository'
import { D1PasswordResetTokenRepository } from './repositories/D1PasswordResetTokenRepository'
import { D1EmailConnectionRepository } from './repositories/D1EmailConnectionRepository'
import { D1GitHubInstallationRepository } from './repositories/D1GitHubInstallationRepository'
import { D1RepoProjectionRepository } from './repositories/D1RepoProjectionRepository'
import { D1RateLimitRepository } from './repositories/D1RateLimitRepository'
import { D1DocumentConnectionRepository } from './repositories/D1DocumentConnectionRepository'
import { D1DocumentRepository } from './repositories/D1DocumentRepository'
import { D1EnvironmentConnectionRepository } from './repositories/D1EnvironmentConnectionRepository'
import { D1CustomManifestTypeRepository } from './repositories/D1CustomManifestTypeRepository'
import { D1EnvironmentRegistryRepository } from './repositories/D1EnvironmentRegistryRepository'
import { D1BootstrapJobRepository } from './repositories/D1BootstrapJobRepository'
import { D1BinaryArtifactMetadataStore } from './repositories/D1BinaryArtifactMetadataStore'
import { R2BinaryBlobBackend } from './storage/R2BinaryBlobBackend'
import type { ContentStorageCapability } from '@cat-factory/contracts'
import { D1RequirementReviewRepository } from './repositories/D1RequirementReviewRepository'
import { D1DocInterviewRepository } from './repositories/D1DocInterviewRepository'
import { D1KaizenGradingRepository } from './repositories/D1KaizenGradingRepository'
import { D1KaizenVerifiedComboRepository } from './repositories/D1KaizenVerifiedComboRepository'
import { D1ConsensusSessionRepository } from './repositories/D1ConsensusSessionRepository'
import { ConsensusAgentExecutor, registerConsensusTraits } from '@cat-factory/consensus'
import { D1ConsensusGroupRepository } from './repositories/D1ConsensusGroupRepository'
import { D1ClarityReviewRepository } from './repositories/D1ClarityReviewRepository'
import { D1BrainstormSessionRepository } from './repositories/D1BrainstormSessionRepository'
import { D1NotificationRepository } from './repositories/D1NotificationRepository'
import { D1InitiativeRepository } from './repositories/D1InitiativeRepository'
import { D1MergeTrackRecordRepository } from './repositories/D1MergeTrackRecordRepository'
import { D1RiskPolicyRepository } from './repositories/D1RiskPolicyRepository'
import { D1SharedStackRepository } from './repositories/D1SharedStackRepository'
import {
  D1SandboxPromptVersionRepository,
  D1SandboxFixtureRepository,
  D1SandboxExperimentRepository,
  D1SandboxRunRepository,
  D1SandboxGradeRepository,
} from './repositories/D1SandboxRepositories'
import { D1WorkspaceSettingsRepository } from './repositories/D1WorkspaceSettingsRepository'
import { D1UserSettingsRepository } from './repositories/D1UserSettingsRepository'
import { D1ObservabilityConnectionRepository } from './repositories/D1ObservabilityConnectionRepository'
import { D1SubscriptionQuotaCycleRepository } from './repositories/D1SubscriptionQuotaCycleRepository'
import { D1PackageRegistryConnectionRepository } from './repositories/D1PackageRegistryConnectionRepository'

import { D1IncidentEnrichmentConnectionRepository } from './repositories/D1IncidentEnrichmentConnectionRepository'
import { D1AccountSettingsRepository } from './repositories/D1AccountSettingsRepository'
import { D1ReleaseHealthConfigRepository } from './repositories/D1ReleaseHealthConfigRepository'
import { D1AgentPromptRepository } from './repositories/D1AgentPromptRepository'
import { D1ModelPresetRepository } from './repositories/D1ModelPresetRepository'
import { D1ServiceFragmentDefaultsRepository } from './repositories/D1ServiceFragmentDefaultsRepository'
// The built-in polling-gate suite (ci / conflicts / post-release-health + on-call). The facade
// builds an app-owned `GateRegistry` pre-loaded with the suite via `gateRegistryWithBuiltins()`,
// then wires each gate's provider below.
import {
  type GateProviderOverrides,
  wireCiStatusProvider,
  wireMergeabilityProvider,
  wireReleaseHealthProvider,
  wireIncidentEnrichment,
  wirePullRequestReviewProvider,
  wireDocQualityProvider,
} from '@cat-factory/gates'
import {
  buildGitLabEngineClient,
  GitLabIdentityResolver,
  registerGitLab,
  StaticGitLabTokenSource,
} from '@cat-factory/gitlab'
import {
  GitHubDocQualityProvider,
  GitHubPrReportPublisher,
  GitHubPullRequestReviewProvider,
  createEnvToolSecretResolver,
} from '@cat-factory/server'
import { GitHubCiStatusProvider } from './github/GitHubCiStatusProvider'
import { GitHubMergeabilityProvider } from './github/GitHubMergeabilityProvider'
import { GitHubBranchUpdater } from './github/GitHubBranchUpdater'
import { GitHubPullRequestMerger } from './github/GitHubPullRequestMerger'
import { WebCryptoSecretCipher } from './environments/WebCryptoSecretCipher'
import { D1NotificationWebhookRepository } from './repositories/D1NotificationWebhookRepository'
import { GitHubAppAuth } from './github/GitHubAppAuth'
import { GitHubAppRegistry } from './github/GitHubAppRegistry'
import { FetchGitHubClient } from './github/FetchGitHubClient'
import { D1TaskConnectionRepository } from './repositories/D1TaskConnectionRepository'
import { D1TaskSourceSettingsRepository } from './repositories/D1TaskSourceSettingsRepository'
import { D1TaskRepository } from './repositories/D1TaskRepository'
import { D1TrackerCommentIngestRepository } from './repositories/D1TrackerCommentIngestRepository'
import { D1FragmentBriefRepository } from './repositories/D1FragmentBriefRepository'
import { D1PromptFragmentRepository } from './repositories/D1PromptFragmentRepository'
import { D1FragmentSourceRepository } from './repositories/D1FragmentSourceRepository'
import { D1AccountSkillRepository } from './repositories/D1AccountSkillRepository'
import { D1SkillSourceRepository } from './repositories/D1SkillSourceRepository'
import { LlmFragmentSelector } from './ai/LlmFragmentSelector'
import {
  buildApiKeyService,
  buildLocalModelEndpointService,
  buildOpenRouterCatalogService,
  buildPersonalSubscriptionService,
  buildPublicApiKeyService,
  buildResolveUserGitHubToken,
  buildSubscriptionService,
  buildTestSecretsService,
  buildUserSecretService,
  buildValidationConfigService,
} from './wireCredentialServices'
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
  // Instrument inline (non-proxied) calls with the SAME composed trace sink the proxied
  // path uses — Langfuse and/or the OTLP exporter, whichever are enabled.
  const traceSink = composeTraceSinks([
    buildLangfuseSink(loadLangfuseConfig(env)),
    buildOtelSink(loadOtelConfig(env)),
  ])
  const instrument = traceSink
    ? {
        traceSink,
        recordPrompts: loadObservabilityConfig(env).recordPrompts,
        // The second half of the body gate: the workspace's own `storeAgentContext`
        // opt-out, the same one the proxied path honours. No cache handle is passed
        // because `workspaceSettings` is a pass-through in the isolate-safe profile.
        workspaceBodiesEnabled: createStoreAgentContextGate({
          repository: new D1WorkspaceSettingsRepository({ db }),
        }),
      }
    : undefined
  const localModelEndpoints = buildLocalModelEndpointService(env, db, { now: () => Date.now() })
  const scoped = createScopedModelProviderResolver({
    apiKeys: buildApiKeyService(env, db, { now: () => Date.now() }),
    baseUrlFor: (provider) => baseUrlFor(provider, env) ?? undefined,
    extraRegistries,
    localEndpointsFor: localModelEndpoints
      ? (userId) => localModelEndpoints.listResolved(userId)
      : undefined,
    instrument,
  })
  // Cap concurrent inline calls to a subscription vendor. On the Worker the inline path
  // degrades subscription refs before resolve, so this is a wired pass-through in practice;
  // it bounds concurrency within one isolate (no cross-isolate/global limiting — see
  // backend/docs/concurrency-and-redis.md), symmetric with the Node facade's wrap.
  const resolver = wrapResolverWithLimiter(
    scoped,
    vendorConcurrencyLimiterFromEnv(
      (key) => (env as unknown as Record<string, string | undefined>)[key],
    ),
  )
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
/**
 * The shared prerequisites both the composite executor selection and its container leg
 * need — the Worker's infra handles (`env`/`config`/`db`/`clock`), the resolved runner
 * transport, the agent-kind registry, and the optional subscription / observability seams.
 * Bundled so the two builders take one dependency object rather than nine positional args.
 */
interface WorkerExecutorDeps {
  env: Env
  config: AppConfig
  db: D1Database
  clock: Clock
  resolveTransport: ResolveRunnerTransport | null
  agentKindRegistry: AgentKindRegistry
  subscriptions?: ProviderSubscriptionService
  personalSubscriptions?: PersonalSubscriptionService
  agentContextObservability?: AgentContextRecorder
}

export function selectAgentExecutor(deps: WorkerExecutorDeps): AgentExecutor {
  const { env, config, db, agentKindRegistry } = deps
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
    agentKindRegistry,
  })

  // The sandbox MUST build — a null here means a prerequisite (GitHub App private
  // key, WORKER_PUBLIC_URL, AUTH_SESSION_SECRET, or a runner backend: the
  // EXEC_CONTAINER binding or a registered runner pool) is missing. We refuse to
  // start with a half-configured implementer rather than quietly running the
  // repo-operating steps as useless one-shot LLM calls.
  const container = buildContainerExecutor(deps)
  if (!container) {
    throw configProblem({ key: 'CONTAINER_EXECUTOR', ...ENV_HELP.CONTAINER_EXECUTOR })
  }

  // Always the composite: non-sandbox kinds run inline; sandbox kinds run in the
  // container.
  return new CompositeAgentExecutor(inline, container, agentKindRegistry)
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
export function maybeWrapConsensus(
  standard: AgentExecutor,
  env: Env,
  config: AppConfig,
  db: D1Database,
  eventPublisher: ExecutionEventPublisher | undefined,
  agentKindRegistry: AgentKindRegistry,
): AgentExecutor {
  if (!isTruthy(env.CONSENSUS_ENABLED)) return standard
  registerConsensusTraits(agentKindRegistry)
  return new ConsensusAgentExecutor({
    standard,
    modelProviderResolver: buildModelProviderResolver(env, db),
    agentRouting: config.agents.routing,
    resolveBlockModel: config.agents.resolveBlockModel,
    resolveWorkspaceModelDefault: buildResolveWorkspaceModelDefault(db),
    sessionRepository: new D1ConsensusSessionRepository({ db }),
    ...(eventPublisher ? { eventPublisher } : {}),
    agentKindRegistry,
  })
}

/**
 * Build the factory that picks a job's runner backend: a workspace's own
 * self-hosted runner pool when one is registered (and runner pools are enabled),
 * otherwise the per-run Cloudflare Container. Returns null when neither backend is
 * available, so {@link buildContainerExecutor} falls back to inline work.
 */
function buildResolveTransport(deps: {
  env: Env
  config: AppConfig
  db: D1Database
  clock: Clock
  provisioningLog: ProvisioningLogRecorder | undefined
  // The app-owned runner-backend registry the service resolves a stored `kind` through.
  runnerBackendRegistry: RunnerBackendRegistry
  // The shared HTTP provider the built-in `manifest` backend reuses when supplied (its OAuth
  // cache reused). NOT the custom-kind seam — a bespoke runner backend is registered by
  // reference into `runnerBackendRegistry`. Absent → the generic manifest-driven HTTP provider.
  injectedPoolProvider?: RunnerPoolProvider
}): ResolveRunnerTransport | null {
  const { env, config, db, clock, provisioningLog, runnerBackendRegistry, injectedPoolProvider } =
    deps
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
      logger,
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
    // The shared factory throws a ConflictError carrying the machine reason (see its doc): a clean
    // 409 synchronously, and classifyDispatchFailure lifts the reason onto the run's AgentFailure on
    // the async dispatch path (SPA shows "Agent backend not configured", not "container failed to
    // start"). The Cloudflare facade also offers "enable Cloudflare Containers" in the remedy.
    throw noRunnerBackendAvailableError(workspaceId, { cloudflareContainers: true })
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
export function buildAppRegistry(
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
 *
 * No `repoProjectionCache` is threaded here (unlike the Node facade, which caches the
 * whole-projection re-list per workspace — caching-layer slice 3): the repo projection
 * is our own mutable D1 state, and the Worker's isolate-safe profile makes that cache
 * pass-through (no cross-isolate invalidation bus), so an in-isolate TTL would serve
 * stale repos after a write on another isolate. Reading live IS the isolate-safe
 * behaviour. The shared GitHub sync/webhook services still receive the (pass-through)
 * handle via `createGitHubModule`, so their invalidation code path stays symmetric.
 */
export function buildResolveRepoTarget(db: D1Database): ResolveRepoTarget {
  return buildSharedResolveRepoTarget({
    installationRepository: new D1GitHubInstallationRepository({ db }),
    repoProjectionRepository: new D1RepoProjectionRepository({ db }),
    blockRepository: new D1BlockRepository({ db }),
    serviceRepository: new D1ServiceRepository({ db }),
  })
}

/**
 * The MULTI-REPO resolver (service-connections phase 3): the task's own repo plus each
 * connected involved-service repo, deduped. Wired from the SAME D1 repos as the singular
 * resolver (the D1 service repo's batched `listByFrameBlocks` resolves the involved frames'
 * repos in one query). Fed to the container executor so the implementer can fan a
 * cross-service change out across sibling checkouts.
 */
function buildResolveRepoTargets(db: D1Database): ResolveRepoTargets {
  return buildSharedResolveRepoTargets({
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

/** What {@link selectMergeLifecycleDeps} needs. An options object rather than a positional tail:
 *  it already carried six parameters, and the notification channels it composes will keep
 *  growing (in-app, Slack, the outbound webhook, …) — a named bag stays readable and keeps the
 *  call site honest about which of the several same-typed handles is which. */
export interface MergeLifecycleDepsInput {
  env: Env
  config: AppConfig
  db: D1Database
  clock: Clock
  idGenerator: IdGenerator
  providerRegistry: ProviderRegistry
  /**
   * The outbound notification-webhook delivery channel, when the deployment configured one. Built
   * by the caller (alongside its management service, from ONE builder) so both halves are
   * guaranteed to read the same rows through the same cipher.
   */
  webhookChannel?: NotificationChannel
}

export function selectMergeLifecycleDeps(
  input: MergeLifecycleDepsInput,
): Partial<CoreDependencies> {
  const { env, config, db, clock, idGenerator, providerRegistry, webhookChannel } = input
  const deps: Partial<CoreDependencies> = {
    notificationRepository: new D1NotificationRepository({ db }),
    riskPolicyRepository: new D1RiskPolicyRepository({ db }),
    mergeTrackRecordRepository: new D1MergeTrackRecordRepository({ db }),
    // Shared stacks (long-lived compose infra a consumer environment attaches to). CRUD +
    // persistence are runtime-symmetric; the Worker never brings a stack UP (no host daemon),
    // so no `composeRuntime` is wired here — the lifecycle endpoints report "not supported".
    sharedStackRepository: new D1SharedStackRepository({ db }),
    workspaceSettingsRepository: new D1WorkspaceSettingsRepository({ db }),
    userSettingsRepository: new D1UserSettingsRepository({ db }),
    modelPresetRepository: new D1ModelPresetRepository({ db }),
    // The consensus-GROUP library: the estimate-gated panels a pipeline step escalates to.
    // Always wired (no secret material) — the panels only run when the optional consensus
    // executor is enabled, but the library is editable and snapshot-visible regardless.
    consensusGroupRepository: new D1ConsensusGroupRepository({ db }),
    agentPromptRepository: new D1AgentPromptRepository({ db }),
    serviceFragmentDefaultsRepository: new D1ServiceFragmentDefaultsRepository({ db }),
    initiativeRepository: new D1InitiativeRepository({ db }),
  }
  // Compose the delivery channels: in-app push (when the events binding is present), Slack (when
  // the integration is enabled) and the outbound webhook (when a workspace registered one) all
  // implement the same NotificationChannel port and fan out via CompositeNotificationChannel —
  // realizing the seam the kernel port documents, with no change to the engine call sites that
  // raise notifications. The webhook channel is what a HEADLESS caller relies on: it has no
  // in-app inbox and no browser WebSocket, so a parked run would otherwise reach it only by
  // polling (see docs/initiatives/headless-clarification-loop.md).
  const channels: NotificationChannel[] = []
  const publisher = selectEventPublisher(env, db)
  if (publisher) channels.push(new InAppNotificationChannel(publisher))
  const externalChannel = buildExternalNotificationChannel(config, db, webhookChannel)
  if (externalChannel) channels.push(externalChannel)
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
      providerRegistry,
      new GitHubCiStatusProvider({ githubClient, resolveRepoTarget, blockRepository }),
    )
    wireMergeabilityProvider(
      providerRegistry,
      new GitHubMergeabilityProvider({ githubClient, resolveRepoTarget, blockRepository }),
    )
    wirePullRequestReviewProvider(
      providerRegistry,
      new GitHubPullRequestReviewProvider({ githubClient, resolveRepoTarget, blockRepository }),
    )
    wireDocQualityProvider(
      providerRegistry,
      new GitHubDocQualityProvider({
        githubClient,
        resolveRepoTarget,
        blockRepository,
        // The gate resolves a workspace-linked template (WS1) for the block's kind, so it checks
        // against the SAME sections the doc-writer followed. Cheap query wrapper over the same D1.
        documentRepository: new D1DocumentRepository({ db }),
      }),
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
    // Keeps the engine-maintained verification report current on each run's PR. Reads through
    // the same engine VCS client, so a GitLab-only deployment gets it too (runtime symmetry
    // with the Node facade's `githubGateDeps`).
    deps.prVerificationReportPublisher = new GitHubPrReportPublisher({
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
export function selectReleaseHealthDeps(
  env: Env,
  config: AppConfig,
  db: D1Database,
  providerRegistry: ProviderRegistry,
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
    providerRegistry,
    new RegistryReleaseHealthProvider({
      observabilityConnectionRepository,
      releaseHealthConfigRepository,
      blockRepository: new D1BlockRepository({ db }),
      secretCipher: observabilitySecretCipher,
      registry: defaultObservabilityRegistry(),
    }),
  )
  return {
    observabilityConnectionRepository,
    releaseHealthConfigRepository,
    observabilitySecretCipher,
  }
}

/**
 * Wire the per-workspace private package-registry integration (npm private orgs, GitHub
 * Packages). Wired whenever the shared encryption key is present (the cipher must exist
 * to seal/unseal); a workspace with no entries is a no-op. The decrypted entries reach
 * agent containers via the executor's `resolvePackageRegistries` seam.
 */
export function selectPackageRegistryDeps(env: Env, db: D1Database): Partial<CoreDependencies> {
  const encryptionKey = env.ENCRYPTION_KEY?.trim()
  if (!encryptionKey) return {}
  return {
    packageRegistryConnectionRepository: new D1PackageRegistryConnectionRepository({ db }),
    packageRegistrySecretCipher: new WebCryptoSecretCipher({
      masterKeyBase64: encryptionKey,
      info: PACKAGE_REGISTRY_CIPHER_INFO,
    }),
  }
}

/**
 * The agent executor / bootstrapper `resolvePackageRegistries` seam: decrypt the
 * workspace's private-registry entries onto the job body at dispatch. Built over the
 * same repo + cipher the management API uses; undefined when the encryption key is
 * absent (no registry auth is forwarded).
 */
function buildResolvePackageRegistries(
  env: Env,
  db: D1Database,
): ((workspaceId: string) => Promise<JobPackageRegistrySpec[]>) | undefined {
  const encryptionKey = env.ENCRYPTION_KEY?.trim()
  if (!encryptionKey) return undefined
  const repository = new D1PackageRegistryConnectionRepository({ db })
  const cipher = new WebCryptoSecretCipher({
    masterKeyBase64: encryptionKey,
    info: PACKAGE_REGISTRY_CIPHER_INFO,
  })
  return (workspaceId) => resolvePackageRegistriesForDispatch(repository, cipher, workspaceId)
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
export function selectIncidentEnrichmentDeps(
  env: Env,
  db: D1Database,
  providerRegistry: ProviderRegistry,
): Partial<CoreDependencies> {
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
    providerRegistry,
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
  settingsCache?: GroupCacheHandle<ResolvedAccountSettings>,
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
    ...(settingsCache ? { settingsCache } : {}),
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
function cloudflareContentStorage(env: Env): {
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
      logger.warn('slack notification delivery failed', {
        err: error instanceof Error ? error.message : String(error),
        ...ctx,
      }),
  })
}

/**
 * Build the outbound notification-webhook feature (management service + delivery channel) when the
 * shared encryption key is present — the signing secret must be sealable. Both halves come from
 * one builder so they can't drift onto different repositories/ciphers. Null when no key is set;
 * then the management surface 503s and no deliveries are attempted.
 */
function buildNotificationWebhookSupportForWorker(
  env: Env,
  config: AppConfig,
  db: D1Database,
  clock: Clock,
): ReturnType<typeof buildNotificationWebhookSupport> | null {
  const encryptionKey = env.ENCRYPTION_KEY?.trim()
  if (!encryptionKey) return null
  // The endpoint guard, resolved from the webhook's OWN config slice (undefined ⇒ the strict
  // public-https default). Handed to the builder, which gives it to both the write boundary and
  // the delivery path so they can't admit/reject different endpoints.
  const urlSafetyPolicy = resolveUrlSafetyPolicy(config.notificationWebhooks)
  return buildNotificationWebhookSupport({
    notificationWebhookRepository: new D1NotificationWebhookRepository({ db }),
    secretCipher: new WebCryptoSecretCipher({
      masterKeyBase64: encryptionKey,
      info: NOTIFICATION_WEBHOOK_CIPHER_INFO,
    }),
    clock,
    ...(urlSafetyPolicy ? { urlSafetyPolicy } : {}),
    // Best-effort delivery still surfaces failures (a dead endpoint, a rejected signature)
    // through the structured logger so a broken receiver is diagnosable.
    onError: (error, ctx) =>
      logger.warn('notification webhook delivery failed', {
        err: error instanceof Error ? error.message : String(error),
        ...ctx,
      }),
  })
}

/**
 * This deployment's EXTERNAL notification channels — everything that is NOT the in-app push
 * (Slack, plus a workspace's outbound notification webhook). Two consumers:
 * {@link selectMergeLifecycleDeps} composes it into the engine's own fan-out, and the
 * ServerContainer attaches it as `machineNotificationDelivery`, the seam the mothership-mode
 * `POST /internal/notifications/deliver` endpoint delivers a laptop-raised notification through
 * (its credentials never leave this deployment). In-app is excluded there on purpose: a laptop's
 * in-app frame already arrives over the real-time upstream relay.
 *
 * The webhook belongs in this set for the same reason Slack does — its signing secret is sealed
 * with THIS deployment's key, so this is the only side that can decrypt and deliver it. Keeping it
 * out would leave a mothership-mode laptop failing every delivery on a decrypt it cannot perform
 * while the mothership never attempted one. Symmetric with the Node facade.
 *
 * Called once per consumer (so the seam gets its own instance), exactly like `buildAppRegistry`,
 * which the `githubTokenDelegation` seam also re-builds — the channel is a stateless adapter over
 * D1 reads plus a cipher, so a second instance costs nothing.
 */
export function buildExternalNotificationChannel(
  config: AppConfig,
  db: D1Database,
  webhookChannel?: NotificationChannel,
): NotificationChannel | null {
  const channels: NotificationChannel[] = []
  const slackChannel = buildSlackChannel(config, db)
  if (slackChannel) channels.push(slackChannel)
  if (webhookChannel) channels.push(webhookChannel)
  if (channels.length === 0) return null
  return channels.length === 1 ? channels[0]! : new CompositeNotificationChannel(channels)
}

/**
 * Wire the Slack management module (per-account connect + per-workspace routing +
 * member map). Wired only when the integration is enabled; the actual delivery is
 * the channel composed in by {@link selectMergeLifecycleDeps}. OAuth credentials
 * are optional — manual bot-token onboarding works without them.
 */
export function selectSlackDeps(config: AppConfig, db: D1Database): Partial<CoreDependencies> {
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
export function selectEmailInvitationDeps(
  config: AppConfig,
  db: D1Database,
): Partial<CoreDependencies> {
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

// The deployment-wide trusted web-search upstream for CONTAINER agents, built from this
// facade's own `WEB_SEARCH_*` env — the fallback the search proxy uses when a run's account
// configured none of its own (see `createDefaultWebSearchUpstream` in @cat-factory/server).
// Public endpoints only on workerd (no loopback-SearXNG story); kept symmetric with the Node
// facade so a stock Cloudflare deployment can also set a deployment-wide default.
function buildDefaultWebSearchUpstream(env: Env): WebSearchUpstream | undefined {
  return createDefaultWebSearchUpstream({
    braveApiKey: env.WEB_SEARCH_BRAVE_API_KEY,
    searxngUrl: env.WEB_SEARCH_SEARXNG_URL,
    searxngApiKey: env.WEB_SEARCH_SEARXNG_API_KEY,
  })
}

function buildContainerExecutor(deps: WorkerExecutorDeps): AgentExecutor | null {
  const {
    env,
    config,
    db,
    clock,
    resolveTransport,
    agentKindRegistry,
    subscriptions,
    personalSubscriptions,
    agentContextObservability,
  } = deps
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
  // Record a subscription harness's (Claude Code / Codex) per-call telemetry into the
  // SAME `llm_call_metrics` store the LLM proxy writes for Pi — those harnesses bypass
  // the proxy, so the executor lifts the metrics off the CLI stream and feeds them here.
  // A standalone service over the required telemetry DB (the proxy path builds its own
  // from the same table; both are stateless writers).
  const recordHarnessCalls = makeHarnessCallRecorder(
    new LlmObservabilityService({
      llmCallMetricRepository: new D1LlmCallMetricRepository({ db: requireTelemetryDb(env) }),
      idGenerator: new CryptoIdGenerator(),
      clock,
      recordPrompts: config.observability.recordPrompts,
    }),
  )
  // Modeled subscription quota-cycle provider (usage-and-quota-tracking, Part B): folds a
  // finished subscription run's tokens into rolling windows (real vendor reads land in B2,
  // so its adapter registry is empty today — every vendor reports modeled).
  const subscriptionQuotaProvider = new RegistrySubscriptionQuotaProvider({
    subscriptionQuotaCycleRepository: new D1SubscriptionQuotaCycleRepository({ db }),
    idGenerator: new CryptoIdGenerator(),
    clock,
    registry: defaultSubscriptionQuotaRegistry,
  })
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

  // Advertise Pi's `web_search` tool to a run only when a usable upstream exists — either the
  // deployment-wide default below (⇒ always on) or the run's account has its own keys (else the
  // tool would just fail/return nothing). The per-account check runs off the account-settings
  // store (its own short-TTL cache).
  const resolvePackageRegistries = buildResolvePackageRegistries(env, db)
  // Decrypt the service frame's sensitive test credentials onto the tester job body (out of band).
  const testSecretsForDispatch = buildTestSecretsService(env, db, clock)
  const resolveTestSecrets = testSecretsForDispatch
    ? (workspaceId: string, blockId: string) =>
        testSecretsForDispatch.resolveValuesForBlock(workspaceId, blockId)
    : undefined
  const defaultWebSearchUpstream = buildDefaultWebSearchUpstream(env)
  // No `settingsCache` threaded to this dedicated web-search-availability instance: the
  // `accountSettings` slice is pass-through on the Worker's isolate-safe profile, so caching it
  // here is a no-op (the primary `accountSettings` instance in `buildContainer` — the one whose
  // decrypted view drives the runtime resolvers — gets the shared slice). The Node facade, where
  // the slice is enabled, wires its web-search instance from `options.caches` directly.
  const webSearchSettings = buildAccountSettings(env, db, clock)
  const resolveWebSearchAvailability =
    defaultWebSearchUpstream || webSearchSettings
      ? async (workspaceId: string): Promise<WebSearchAvailability> => {
          // Mirror the proxy's own resolution (`accountUpstream ?? defaultWebSearchUpstream`):
          // the run's account keys WIN and the deployment default is only the fallback, so the
          // surfaced provider matches the one that will actually serve the run's searches. Build
          // the account upstream the SAME way the proxy does before falling back to the default.
          if (webSearchSettings) {
            const accountId = await new D1WorkspaceRepository({ db }).accountOf(workspaceId)
            if (accountId) {
              const accountUpstream = createWebSearchUpstream(
                (await webSearchSettings.resolve(accountId)).webSearch ?? {},
              )
              if (accountUpstream) return { available: true, provider: accountUpstream.provider }
            }
          }
          if (defaultWebSearchUpstream)
            return { available: true, provider: defaultWebSearchUpstream.provider }
          return { available: false, provider: null }
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
    // Multi-repo coding (service-connections phase 3): the implementer fans a cross-service
    // change out across the task's own repo + each connected involved-service repo.
    resolveRepoTargets: buildResolveRepoTargets(db),
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
    // Per-call telemetry for the subscription harnesses (proxy-bypassing), recorded
    // into `llm_call_metrics` alongside the proxy-metered Pi rows.
    recordHarnessCalls,
    // Modeled subscription quota-cycle tracking (Part B): fold a finished subscription
    // run's tokens into the rolling windows, for BOTH pooled and personal runs.
    recordSubscriptionQuotaUsage: (target, usage) =>
      subscriptionQuotaProvider.recordUsage(target, usage),
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
    ...(resolveWebSearchAvailability ? { resolveWebSearchAvailability } : {}),
    // Decrypt the workspace's private-registry entries onto the job body (rendered by
    // the harness into ~/.npmrc), so private dependencies resolve on install.
    ...(resolvePackageRegistries ? { resolvePackageRegistries } : {}),
    // Decrypt the service frame's SENSITIVE test credentials onto the tester job body (out of
    // band — injected as container env vars by the harness, never in the prompt/telemetry).
    ...(resolveTestSecrets ? { resolveTestSecrets } : {}),
    // Resolve the credentials a registered kind's TOOL SERVER (MCP) declared, off the Worker's own
    // configured vars. A deployment needing per-workspace credentials replaces this with its own
    // `ToolSecretResolver`; the rest of the dispatch path is unchanged either way.
    resolveToolSecrets: createEnvToolSecretResolver(env as unknown as Record<string, unknown>),
    logger,
    githubApiBase: config.github.apiBase,
    // Forward container tool spans to the external trace sink(s) (Langfuse and/or OTLP)
    // grouped under the run trace — the same sink the LLM proxy fans generations to.
    // (Langfuse nests them as children; the OTLP exporter groups them by shared trace id.)
    llmTraceSink: buildTraceSink(config),
    // Record the complete provided context per dispatch (best-effort, gated in the sink).
    ...(agentContextObservability ? { agentContextObservability } : {}),
    agentKindRegistry,
  })
}

/**
 * Pick how runs are driven:
 *   - a Workflows binding present → durable, server-driven execution
 *   - otherwise                   → no-op (e.g. tests, which override this anyway)
 * Tests override `workRunner` with a fake and drive the engine via advanceInstance.
 */
export function selectWorkRunner(env: Env): WorkRunner {
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
 * Build the document-source integration's concrete ports: the configured source
 * providers (Confluence, Notion, …) plus the two D1 repositories. The integration is
 * always on (config load fails loudly without the encryption key), so this is wired
 * on every deployment. The model provider is wired only in 'llm' planner mode (it
 * just needs a provider credential); the planner degrades to its deterministic parser
 * if no model is usable.
 */
export function selectDocumentsDeps(
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
        logger,
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
export function selectTasksDeps(
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
    // Idempotency markers for INBOUND tracker comments. Wired alongside the task module rather
    // than the writeback, because it guards the INGEST half (a redelivered comment applying its
    // answers twice), which exists only when the task projection does.
    trackerCommentIngestRepository: new D1TrackerCommentIngestRepository({ db }),
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
export function selectRequirementsDeps(
  env: Env,
  config: AppConfig,
  db: D1Database,
): Partial<CoreDependencies> {
  return {
    requirementReviewRepository: new D1RequirementReviewRepository({ db }),
    docInterviewRepository: new D1DocInterviewRepository({ db }),
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
export function selectSandboxDeps(sandboxDb: D1Database | undefined): Partial<CoreDependencies> {
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
 * Build the ephemeral environment integration's concrete ports. It assembles
 * whenever the encryption key is set (the shared master key that seals per-tenant
 * credentials), so the generic HTTP provider, the D1 repositories and the Web Crypto
 * cipher are wired together. Returns `{}` only when no key is configured, so
 * `createCore` leaves the `environments` module unassembled. There is no separate
 * enable flag: whether a workspace provisions anything is decided by its registered
 * connection + whether its pipeline runs a `deployer`/`tester` step.
 */
export function selectEnvironmentsDeps(
  env: Env,
  config: AppConfig,
  db: D1Database,
): Partial<CoreDependencies> {
  if (!config.environments.encryptionKey) return {}
  // The provider is resolved per-workspace from the env-backend registry by the stored
  // `kind` (`manifest` | `kubernetes` | a third-party kind imported for side effect); a
  // workspace picks its backend at connect time. The Worker can't honor a custom CA /
  // insecure-skip TLS for a Kubernetes apiserver (no undici), so such a config is rejected
  // at registration here.
  const urlPolicy = resolveUrlSafetyPolicy(config.environments)
  return {
    environmentConnectionRepository: new D1EnvironmentConnectionRepository({ db }),
    environmentRegistryRepository: new D1EnvironmentRegistryRepository({ db }),
    // The workspace-defined custom-manifest-type catalog (the UI-editable half of the
    // `custom` provision-type catalog) is a workspace feature on every facade.
    customManifestTypeRepository: new D1CustomManifestTypeRepository({ db }),
    secretCipher: new WebCryptoSecretCipher({
      masterKeyBase64: config.environments.encryptionKey,
    }),
    environmentCustomTlsSupported: false,
    ...(urlPolicy ? { environmentUrlSafetyPolicy: urlPolicy } : {}),
    // Deployment-level, additive extensions to the built-in provisioning-detection conventions.
    ...(config.environments.detectionConventions
      ? { detectionConventions: config.environments.detectionConventions }
      : {}),
  }
}

/**
 * Wire the async, container-backed Kubernetes deploy lifecycle (slice 9's
 * `EnvironmentProvisioningService` seams) onto the Worker facade: a `deployJobClient` that
 * dispatches/polls/releases a `deploy`-kind job on the per-run `DeployContainer` (the separate
 * deploy-harness image — real `kubectl`/`kustomize`/`helm`), plus `resolveDeployCloneTarget` to
 * hand the container concrete manifests-repo clone coords + a short-lived install token.
 *
 * Gated on the environments module, the `DEPLOY_CONTAINER` binding AND the GitHub App
 * (the clone-target seam needs to mint install tokens + resolve a block's repo). Absent any
 * prerequisite ⇒ `{}` — a render-needing config then fails loudly (the synchronous raw-manifest
 * REST path is unaffected), exactly the unwired behaviour slice 9 shipped. Mirrors Node's pool
 * deploy wiring; the deploy container is the Worker's analogue of Node's self-hosted pool.
 */
export function selectDeployDeps(
  env: Env,
  config: AppConfig,
  db: D1Database,
  clock: Clock,
): Partial<CoreDependencies> {
  if (
    !config.environments.encryptionKey ||
    !env.DEPLOY_CONTAINER ||
    !config.github.enabled ||
    !env.GITHUB_APP_PRIVATE_KEY
  ) {
    return {}
  }
  // A deploy-DEDICATED transport: the deploy job's `ref.runId` addresses a `DeployContainer`
  // instance in its own DO namespace (no collision with the agent `EXEC_CONTAINER`), and the
  // harness keys the job by `ref.jobId`. No instance registry is wired (the `sleepAfter` idle
  // timer + explicit `release` reclaim it), so cross-namespace reaping stays the exec
  // container's concern. The client is deploy-only, so `poll`/`release` need no per-ref routing.
  const deployTransport = new CloudflareContainerTransport(
    env.DEPLOY_CONTAINER,
    undefined,
    env.HARNESS_SHARED_SECRET?.trim() || undefined,
  )
  const registry = buildAppRegistry(env, config, db, clock)
  return {
    deployJobClient: new RunnerJobClient(async () => deployTransport),
    resolveDeployCloneTarget: makeResolveDeployCloneTarget(buildResolveRepoTarget(db), (id) =>
      registry.installationToken(id),
    ),
  }
}

/**
 * Build the self-hosted runner-pool integration's concrete ports when opted in:
 * the D1 connection repository and a dedicated Web Crypto cipher (its own master
 * key + HKDF domain, separate from the environment module's). This assembles
 * `Core.runners` (the connection-management API); the per-job transport selection
 * lives in `buildResolveTransport` above. Returns `{}` when disabled.
 */
export function selectRunnersDeps(
  env: Env,
  config: AppConfig,
  db: D1Database,
): Partial<CoreDependencies> {
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
export function selectRepoBootstrapper(
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

  // The scaffolder installs dependencies too — forward the workspace's
  // private-registry entries exactly as the implementation executor does.
  const resolvePackageRegistries = buildResolvePackageRegistries(env, db)

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
    ...(resolvePackageRegistries ? { resolvePackageRegistries } : {}),
  })
}

/**
 * Build the live ENVIRONMENT-PROVIDER CONFIG REPAIR agent (PR #416 increment 2) when its
 * prerequisites are met — the same container prerequisites as the bootstrapper PLUS an
 * injected provider that actually supports agent repair (`describeRepairAgent`). A stock
 * deployment runs the generic manifest provider (no repair support), so this stays
 * undefined there; it wires only when a native adapter is injected. Built
 * over the FINAL provider (post-overrides), so the dispatcher repairs through the same
 * provider the engine validates with. NOT to be confused with the repo bootstrapper: this
 * is an ordinary clone→edit→push coding job (no history reset / force-push).
 */
export function selectEnvConfigRepairer(deps: {
  env: Env
  config: AppConfig
  db: D1Database
  clock: Clock
  resolveTransport: ResolveRunnerTransport | null
  override: CoreDependencies['environmentProvider']
  environmentBackendRegistry: EnvironmentBackendRegistry
}): ContainerEnvConfigRepairer | undefined {
  const { env, config, db, clock, resolveTransport, override, environmentBackendRegistry } = deps
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
      'env-config repair: the coder routing model is not proxyable by the LLM proxy; ' +
        'the agent config-repair fallback is disabled.',
      { provider: model.provider },
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
export function selectFragmentLibraryDeps(
  env: Env,
  config: AppConfig,
  db: D1Database,
): Partial<CoreDependencies> {
  if (!config.fragmentLibrary.enabled) return {}
  // The shared tier resolver: workspace tier by direct binding, account tier bound directly
  // (migration 0017) with a fallback through the account's own boards (a per-workspace PAT
  // connect stores no accountId on its installation row).
  const resolvers = createTierInstallationResolvers({
    installations: new D1GitHubInstallationRepository({ db }),
    workspaces: new D1WorkspaceRepository({ db }),
  })
  return {
    promptFragmentRepository: new D1PromptFragmentRepository({ db }),
    fragmentBriefRepository: new D1FragmentBriefRepository({ db }),
    fragmentSourceRepository: new D1FragmentSourceRepository({ db }),
    resolveFragmentInstallationId: resolvers.forOwner,
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

/**
 * Build the repo-sourced Claude Skills library's concrete ports when opted in
 * (docs/initiatives/repo-skills.md). Skills live in ONE tier (the account), so the
 * installation resolver is account-only. Gated on the same `fragmentLibrary.enabled`
 * flag as the fragment library (both are the repo-sourced prompt library). Returns
 * `{}` when disabled, so `createCore` leaves the skill module unassembled.
 */
export function selectSkillLibraryDeps(
  _env: Env,
  config: AppConfig,
  db: D1Database,
): Partial<CoreDependencies> {
  if (!config.fragmentLibrary.enabled) return {}
  const resolvers = createTierInstallationResolvers({
    installations: new D1GitHubInstallationRepository({ db }),
    workspaces: new D1WorkspaceRepository({ db }),
  })
  return {
    accountSkillRepository: new D1AccountSkillRepository({ db }),
    skillSourceRepository: new D1SkillSourceRepository({ db }),
    resolveSkillInstallationId: resolvers.forAccount,
  }
}

/**
 * The hosted PAT-login registry: lets a user sign in by pasting their OWN source-control PAT,
 * which the shared `/auth/pat` flow resolves to the account it belongs to (and holds to the
 * server's login/org/domain allowlist — see `AuthController`). GitHub is always available;
 * GitLab is added when a GitLab connection is configured. A remote deployment is multi-user, so
 * there is NO `configuredToken` — each user supplies their own PAT. Symmetric with the Node
 * facade's `buildNodeVcsIdentityRegistry` per "keep the runtimes symmetric": a GitLab-only Worker
 * deployment must let a GitLab user sign in, not just gate/merge on GitLab under the hood.
 */
export function buildWorkerVcsIdentityRegistry(config: AppConfig): VcsIdentityRegistry {
  const registry: VcsIdentityRegistry = {
    github: { resolver: new GitHubIdentityResolver({ apiBase: config.github.apiBase, logger }) },
  }
  if (config.gitlab?.enabled) {
    registry.gitlab = {
      resolver: new GitLabIdentityResolver({ apiBase: config.gitlab.apiBase, logger }),
    }
  }
  return registry
}

/**
 * The Worker facade's infrastructure capabilities, as the SPA's infrastructure selector reads
 * them: repo-operating agents run on per-run Cloudflare Containers (always available) and can
 * additionally delegate to a self-hosted runner pool when one is configured; tester environments
 * run via the environment provider. Extracted from {@link buildContainer} to keep that (budgeted)
 * function inside its per-function line ceiling — the budget is a split trigger, never a number
 * to raise.
 */
function workerInfrastructureCapabilities(
  config: AppConfig,
): ReturnType<typeof buildInfrastructureCapabilities> {
  return buildInfrastructureCapabilities({
    execution: {
      available: config.runners.enabled
        ? ['cloudflare-containers', 'runner-pool']
        : ['cloudflare-containers'],
      active: 'cloudflare-containers',
    },
    testEnv: { available: ['environment-provider'], active: 'environment-provider' },
    // The Worker only runs the self-contained UI-test container (torn down with the run); it
    // has no long-lived host serve, so a browsable frontend preview is unsupported here.
    frontendPreview: { supported: false },
    // The hosted Worker facade has account admins to govern the account-wide model policy.
    modelPolicy: { supported: true },
  })
}

export function buildContainer(
  env: Env,
  overrides: Partial<CoreDependencies> = {},
  opts: { cloudflareModelsEnabled?: boolean; gateProviders?: GateProviderOverrides } = {},
): Container {
  const config = loadConfig(env)
  config.infrastructure = workerInfrastructureCapabilities(config)
  // The primary transactional store. Required: fail fast here with a fixable message rather than
  // NPE deep in the first repository call when the `DB` binding is unbound/misnamed.
  const db = requireDb(env)
  // Telemetry (llm_call_metrics + agent_context_snapshots) lives in its own D1 database
  // — append-heavy/high-volume/short-retention, unlike the transactional domain. The
  // binding is required: fail fast here rather than NPE deep in a repo on first write.
  const telemetryDb = requireTelemetryDb(env)
  const clock = new SystemClock()
  const idGenerator = new CryptoIdGenerator()

  // The app-owned cache bag, on the ISOLATE-SAFE profile: a Worker isolate has no
  // cross-isolate invalidation bus (and no Redis), so caches of mutable cross-instance
  // state (the fragment catalog / repo projection / account policy / account settings) are
  // configured pass-through rather than TTL'd — a stale-serving cache would be a correctness
  // bug, not an optimization (see @cat-factory/caching's README). Self-verifying caches (the
  // document body + the head-sha-probed `repoFiles` reads) stay enabled — safe to keep on
  // because the probe bounds their staleness even without a bus. Note the bag is rebuilt per
  // invocation (this runs per request / per Workflow wake), so on the Worker these caches
  // mainly dedupe reads WITHIN one wake (e.g. a post-op's batch); the cross-run refresh-window
  // probe is chiefly the Node (process-lived cache) path. Built once here and SHARED: threaded
  // into the GitHub repo-files resolver (slice 4), the account-settings service, AND the
  // account-policy read the capability resolver runs, AND handed to `createCore`.
  const caches = createAppCaches({ profile: ISOLATE_SAFE_APP_CACHES_PROFILE })

  // The app-owned backend registries (env + runner kind → provider, agent-kind, gate,
  // step-resolver, initiative-preset, VCS, gate-provider): the injected instance via `overrides`
  // (a deployment's custom backend by reference, or the conformance suite's pre-loaded one), else
  // the built-in default. The SAME instances are threaded into the executors / createCore / the
  // boot-time `validateRegistrationsOnce` / the ServerContainer snapshot projection. The GitLab
  // VCS provider + the gate providers are wired onto `vcsRegistry` / `providerRegistry` below when
  // configured (fresh-per-build, so no module-global reset is needed).
  const {
    environmentBackendRegistry,
    runnerBackendRegistry,
    customManifestTypeRegistry,
    userSecretKindRegistry,
    agentKindRegistry,
    gateRegistry,
    judgeRegistry,
    stepResolverRegistry,
    initiativePresetRegistry,
    vcsRegistry,
    providerRegistry,
  } = resolveWorkerRegistries(overrides)

  // Binary-artifact storage (UI screenshots + reference design images) for the
  // visual-confirmation gate. The backend is configured PER ACCOUNT in the UI: an account can
  // keep the deployment's R2 bucket (the default when the ARTIFACT_BUCKET binding is present)
  // or switch to its own S3 bucket. The metadata always lives in D1; only the bytes' backend
  // changes. The store is resolved per request/run from the account settings
  // (`resolveBinaryArtifactStore`, built below once `accountSettings` exists).
  const { capability: contentStorageCapability, buildBlobBackend: buildCfBlobBackend } =
    cloudflareContentStorage(env)

  // The built-in gates' providers are wired onto the app-owned `providerRegistry` (news'd above,
  // fresh per build unless injected via `overrides`). `selectMergeLifecycleDeps` /
  // `selectReleaseHealthDeps` / `selectIncidentEnrichmentDeps` wire theirs only inside their
  // `enabled` branches; a fresh registry starts empty, so an unconfigured gate simply stays
  // unwired (pass-through) — no reset needed (the former `clearGateProviders()` guarded a
  // module-global that no longer exists). Any test-injected gate providers (`opts.gateProviders`)
  // are applied at the END of this build (after the config wiring) so they OVERRIDE it, and — when
  // the test injects its own `providerRegistry` via `overrides` — survive the per-request rebuild.

  // Opt-in GitLab VCS provider (single-token model, mirroring local-mode's PAT). Registered on
  // the app-owned `vcsRegistry` above so the neutral webhook route + any VcsConnectionRef holder
  // resolves it. A no-op unless GITLAB_TOKEN is set; symmetric with the Node facade (local
  // inherits it) per "keep the runtimes symmetric".
  if (config.gitlab?.enabled && env.GITLAB_TOKEN) {
    registerGitLab(vcsRegistry, {
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
  const resolveTransport = buildResolveTransport({
    env,
    config,
    db,
    clock,
    provisioningLog: provisioningLogRecorder,
    runnerBackendRegistry,
    injectedPoolProvider: overrides.runnerPoolProvider,
  })

  // The subscription-token pool (Claude Code / Codex credentials) — built once and
  // shared by the container executor (lease + usage feedback) and the
  // vendor-credential controller, so both read the same pool.
  const subscriptions = buildSubscriptionService(env, db, clock)

  // The sensitive per-service test-credential store (sealed) — shared by the test-secrets
  // CRUD controller and the engine's prompt refs (the executor builds its own value resolver).
  const testSecretsService = buildTestSecretsService(env, db, clock)

  const validationConfigService = buildValidationConfigService(db, clock)

  // The per-user individual-usage subscription store (Claude) — shared by the
  // personal-subscription controller and the container executor's personal lease.
  const personalSubscriptions = buildPersonalSubscriptionService(env, db, clock)

  // The direct-provider API-key pool (account/workspace/user) — shared by the
  // API-key controller, the model-provider resolver, and the LLM proxy key lease.
  const apiKeys = buildApiKeyService(env, db, clock)

  // The inbound public-API key store — drives the public `/api/v1` surface's authentication.
  const publicApiKeys = buildPublicApiKeyService(env, db, clock)

  // The per-user locally-run model endpoints store (Ollama / LM Studio / …) — shared by
  // the local-runner controller, the per-user model catalog, and the LLM proxy.
  const localModelEndpoints = buildLocalModelEndpointService(env, db, clock)

  // The per-user generic secret store (a GitHub PAT today) — shared by the user-secret
  // controller; also backs the run-initiator PAT resolver used by the executor + gates.
  const userSecrets = buildUserSecretService(
    env,
    db,
    clock,
    userSecretKindRegistry,
    caches.viewerRepos,
  )

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

  // Agent-search-query observability sink: records each web search a container agent
  // performed through the search proxy. Same double gate + retention window as the
  // agent-context sink. Wired into the search proxy (write, via the container) AND
  // createCore (read). Telemetry rows live in the dedicated TELEMETRY_DB database.
  const searchQueryObservability = new SearchQueryObservabilityService({
    agentSearchQueryRepository: new D1AgentSearchQueryRepository({ db: telemetryDb }),
    workspaceSettingsRepository: new D1WorkspaceSettingsRepository({ db }),
    idGenerator,
    clock,
    recordPrompts: config.observability.recordPrompts,
  })

  // Per-account deployment settings (Slack OAuth + web-search keys + content-storage). Built
  // once so the service's short-TTL cache is shared across requests; the Slack OAuth +
  // content-storage resolvers are derived from it in the domain composition root.
  const accountSettings = buildAccountSettings(
    env,
    db,
    clock,
    contentStorageCapability,
    caches.accountSettings,
  )

  // The deployment-wide trusted web-search upstream (built from this facade's own `WEB_SEARCH_*`
  // env), read by `WebSearchProxyController` as the fallback when a run's account has no keys.
  // Kept symmetric with the Node facade; absent unless the operator sets a `WEB_SEARCH_*` var.
  const defaultWebSearchUpstream = buildDefaultWebSearchUpstream(env)

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
    logger,
  })

  // GitHub webhook/resync/backfill ingest via the sync Queue (absent → inline handling). Built
  // once so the engine's skill-freshness fan-out (slice 4) enqueues through the SAME seam the
  // gateway exposes, rather than reaching for the queue binding a second time.
  const githubWebhookIngest = new CfGitHubWebhookIngest(env.GITHUB_SYNC_QUEUE)

  // The outbound notification webhook: management service + delivery channel from ONE builder, so
  // the surface that reports an endpoint as configured and the channel that delivers to it can
  // never end up on different repositories/ciphers.
  const notificationWebhookSupport = buildNotificationWebhookSupportForWorker(
    env,
    config,
    db,
    clock,
  )

  return assembleWorkerContainer({
    env,
    config,
    db,
    telemetryDb,
    clock,
    idGenerator,
    caches,
    overrides,
    gateProviders: opts.gateProviders,
    cloudflareModelsEnabled,
    registries: {
      environmentBackendRegistry,
      runnerBackendRegistry,
      customManifestTypeRegistry,
      userSecretKindRegistry,
      agentKindRegistry,
      gateRegistry,
      judgeRegistry,
      stepResolverRegistry,
      initiativePresetRegistry,
      vcsRegistry,
      providerRegistry,
    },
    provisioningLogRepository,
    resolveTransport,
    subscriptions,
    testSecretsService,
    validationConfigService,
    personalSubscriptions,
    apiKeys,
    publicApiKeys,
    localModelEndpoints,
    userSecrets,
    openRouterCatalog,
    eventPublisher,
    agentContextObservability,
    searchQueryObservability,
    accountSettings,
    defaultWebSearchUpstream,
    resolveBinaryArtifactStore,
    githubWebhookIngest,
    notificationWebhookSupport,
  })
}
