import {
  AiAgentExecutor,
  LlmFragmentSelector,
  inlineWebSearchOptionsFromEnv,
  resolveAgentConfig,
  isProxyableProvider,
} from '@cat-factory/agents'
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
  type BackendRegistries,
  type EnvironmentBackendRegistry,
  type RunnerBackendRegistry,
  HttpRunnerPoolProvider,
  NotionProvider,
  ApiKeyService,
  LocalModelEndpointService,
  OpenRouterCatalogService,
  usdRateForSpendCurrency,
  PersonalSubscriptionService,
  UserSecretService,
  ProviderSubscriptionService,
  RunnerPoolConnectionService,
  ProvisioningLogRecorder,
  LoggingRunnerTransport,
  EMAIL_CIPHER_INFO,
  createEmailSender,
  SLACK_CIPHER_INFO,
  SlackNotificationChannel,
  TicketTrackerService,
  IssueWritebackService,
  githubIssuesLogic,
  createGitHubIssueViaToken,
  OBSERVABILITY_CIPHER_INFO,
  RegistryReleaseHealthProvider,
  defaultObservabilityRegistry,
  WorkspaceIncidentEnrichmentProvider,
  INCIDENT_ENRICHMENT_CIPHER_INFO,
  AccountSettingsService,
  ACCOUNT_SETTINGS_CIPHER_INFO,
  type DeployJobClient,
} from '@cat-factory/integrations'
import {
  type AgentExecutor,
  type Clock,
  type DocumentSourceProvider,
  type FragmentOwnerKind,
  type EmailSender,
  type DeployCloneTarget,
  type GitHubClient,
  type GitHubInstallationRepository,
  type LocalModelEndpointRepository,
  type ModelProviderResolver,
  type NotificationChannel,
  type ProviderApiKeyRepository,
  type ProvisioningSubsystem,
  type RateLimitRepository,
  type RateLimitSnapshot,
  type ResolveUserGitHubToken,
  type RunnerPoolConnectionRepository,
  type RunnerPoolProvider,
  type TaskConnectionRepository,
  type TaskSourceProvider,
  CompositeNotificationChannel,
  SUBSCRIPTION_VENDORS,
  isAmbientNativeVendor,
} from '@cat-factory/kernel'
import {
  AgentContextObservabilityService,
  type CoreDependencies,
  createCore,
  resolvePresetModelForKind,
} from '@cat-factory/orchestration'
import { createLangfuseSink } from '@cat-factory/observability-langfuse'
import {
  type AppConfig,
  type MintInstallationToken,
  type ResolveRepoOrigin,
  type ResolveRepoTarget,
  type ResolveRunnerTransport,
  type ServerContainer,
  CompositeAgentExecutor,
  ContainerAgentExecutor,
  ContainerEnvConfigRepairer,
  ContainerRepoBootstrapper,
  ContainerSessionService,
  FanOutEventPublisher,
  FetchGitHubClient,
  FetchGitHubProvisioningClient,
  GitHubAppAuth,
  GitHubAppRegistry,
  GitHubIdentityResolver,
  GitHubCiStatusProvider,
  GitHubMergeabilityProvider,
  GitHubPullRequestReviewProvider,
  GitHubBranchUpdater,
  GitHubPullRequestMerger,
  InAppNotificationChannel,
  PatPreferringAppRegistry,
  runWithInitiator,
  WebCryptoPasswordHasher,
  WebCryptoPersonalSecretCipher,
  WebCryptoSecretCipher,
  WebCryptoWebhookVerifier,
  buildInfrastructureCapabilities,
  buildResolveRepoTarget,
  makeResolveDeployCloneTarget,
  makeResolveRunRepoContext,
  makeResolveRepoFilesForCoords,
  makeResolveBinaryArtifactStore,
  RunnerJobClient,
  type BuildBlobBackend,
  type PersistenceRegistry,
  ensureWorkBranchViaRest,
  logger,
  resolveUrlSafetyPolicy,
  resolveWorkspaceCapabilities,
} from '@cat-factory/server'
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
  GitLabIdentityResolver,
  registerGitLab,
  StaticGitLabTokenSource,
} from '@cat-factory/gitlab'
import type { VcsIdentityRegistry } from '@cat-factory/kernel'
import type { PgBoss } from 'pg-boss'
import { loadNodeConfig } from './config.js'
import type { DrizzleDb } from './db/client.js'
import { executionRuntime } from './execution/config.js'
import { PgBossBootstrapRunner } from './execution/bootstrapRunner.js'
import { PgBossEnvConfigRepairRunner } from './execution/envConfigRepairRunner.js'
import { PgBossWorkRunner } from './execution/pgBossRunner.js'
import { createNodeGateways } from './gateways.js'
import { baseUrlForNode, createNodeModelProviderResolver } from './modelProvider.js'
import { ConsensusAgentExecutor, registerConsensusTraits } from '@cat-factory/consensus'
import { NodeEventPublisher, type NodeRealtimeHub } from './realtime.js'
import {
  DrizzleGitHubInstallationRepository,
  DrizzleRunnerPoolConnectionRepository,
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
import { DrizzleProviderApiKeyRepository } from './repositories/providerApiKey.js'
import {
  DrizzlePersonalSubscriptionRepository,
  DrizzleSubscriptionActivationRepository,
} from './repositories/personalSubscription.js'
import { DrizzleLocalModelEndpointRepository } from './repositories/localModelEndpoint.js'
import { DrizzleUserSecretRepository } from './repositories/userSecret.js'
import { DrizzleProviderModelCatalogRepository } from './repositories/providerModelCatalog.js'
import { createDrizzleRepositories, createDrizzleSandboxDeps } from './repositories/drizzle.js'
import { PostgresBinaryBlobBackend } from './storage/PostgresBinaryBlobBackend.js'
import { FilesystemBinaryBlobBackend } from './storage/FilesystemBinaryBlobBackend.js'
import { S3BinaryBlobBackend } from '@cat-factory/provider-s3'
import type { ContentStorageBackend, ContentStorageCapability } from '@cat-factory/contracts'
import {
  DrizzleBootstrapJobRepository,
  DrizzleReferenceArchitectureRepository,
} from './repositories/bootstrap.js'
import { DrizzleEnvConfigRepairJobRepository } from './repositories/envConfigRepair.js'
import {
  DrizzleDocumentConnectionRepository,
  DrizzleDocumentRepository,
} from './repositories/documents.js'
import {
  DrizzleEnvironmentConnectionRepository,
  DrizzleEnvironmentRegistryRepository,
} from './repositories/environments.js'
import { DrizzleCustomManifestTypeRepository } from './repositories/customManifestType.js'
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
import {
  DrizzleTaskConnectionRepository,
  DrizzleTaskRepository,
  DrizzleTaskSourceSettingsRepository,
} from './repositories/tasks.js'
import { CryptoIdGenerator, SystemClock } from './runtime.js'

// HKDF domain tag separating runner-pool scheduler secrets from any other use of
// the same master key (mirrors the Worker's `cat-factory:runners`).
const RUNNERS_CIPHER_INFO = 'cat-factory:runners'

/**
 * Source one org/durable repository that a standard build constructs directly from the Drizzle
 * `db`. In mothership mode (no Postgres) `remote` is the full-surface remote registry — a
 * `Proxy` (`createRemoteRepositoryRegistry`) that forwards any repo name to the hosted
 * mothership over the `/internal/persistence` RPC — so the repo comes from THERE instead of the
 * absent db; otherwise `build()` constructs the Drizzle repo over `db` as before. This is the
 * Phase-3 `db: undefined` audit seam: every direct-db store on the board-load + run path routes
 * through it. Routing is orthogonal to the server-side allow-list — an un-allow-listed remote
 * method still returns a clean `unknown_method`, never a `db`-undefined `TypeError`. Mirrors the
 * credential-repo override seam (`providerApiKeyRepository`), which keeps credentials local while
 * org state goes remote. See docs/initiatives/mothership-mode.md (Phase 3, part 1).
 */
export function pickRepoSource<T>(
  remote: Record<string, unknown> | undefined,
  name: string,
  build: () => T,
): T {
  return remote ? (remote[name] as T) : build()
}

// Memoised per object so a container build shares ONE model provider (hence one inline
// Langfuse sink) across the agent executor, requirements reviewer, doc planner and
// fragment selector, and ONE core trace sink — instead of each call constructing its
// own. Mirrors the Worker's `buildModelProvider` memoisation.
const langfuseSinkCache = new WeakMap<AppConfig, CoreDependencies['llmTraceSink']>()

/** Truthy env flag (`true`/`1`/`yes`). */
function isTruthy(value: string | undefined): boolean {
  return value === 'true' || value === '1' || value === 'yes'
}

/**
 * The Node model-provider RESOLVER (instrumented when Langfuse is on), shared per
 * `(env, db)`. Builds a per-scope provider from the DB-backed API-key pool plus opt-in
 * Cloudflare-REST / Bedrock registries. Mirrors the Worker's buildModelProviderResolver.
 */
const modelResolverCache = new WeakMap<DrizzleDb, ModelProviderResolver>()
function buildModelProviderResolver(
  env: NodeJS.ProcessEnv,
  db: DrizzleDb | undefined,
  apiKeys: ApiKeyService | undefined,
  localModelEndpoints: LocalModelEndpointService | undefined,
): ModelProviderResolver {
  // The cache keys on the db handle (one resolver per Drizzle client). Mothership mode has no
  // db, so skip the cache entirely (WeakMap keys must be objects) and build a fresh resolver —
  // a mothership node builds one container, so there is nothing to share it with anyway.
  if (!db) return createNodeModelProviderResolver(env, apiKeys, localModelEndpoints)
  const cached = modelResolverCache.get(db)
  if (cached) return cached
  const resolver = createNodeModelProviderResolver(env, apiKeys, localModelEndpoints)
  modelResolverCache.set(db, resolver)
  return resolver
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
    // Password reset works without email (the link is logged in dev); the system sender
    // below upgrades it to real delivery when configured.
    passwordResetTokenRepository: repos.passwordResetTokenRepository,
    resolveSystemEmailSender: buildSystemEmailSender(config),
    appBaseUrl: config.email.appBaseUrl || undefined,
    logger,
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
 * Build the deployment-level system email sender (auth emails like password reset) from
 * the env-driven `email.system` config, or undefined when not configured.
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
  const makeAuth = (appId: string, key: string) =>
    new GitHubAppAuth({
      appId,
      privateKeyPem: key,
      installationRepository,
      clock,
      apiBase: config.github.apiBase,
    })
  // Privileged App tier (ADR 0005): the second App carries `Administration: write`
  // for repo provisioning. Activates only when both its config id and key are
  // present, mirroring the Worker's `buildAppRegistry`.
  const privilegedKey = env.GITHUB_PRIVILEGED_APP_PRIVATE_KEY?.trim()
  const privileged =
    config.github.privilegedApp && privilegedKey
      ? {
          appId: config.github.privilegedApp.appId,
          auth: makeAuth(config.github.privilegedApp.appId, privilegedKey),
        }
      : undefined
  return new GitHubAppRegistry({
    default: {
      appId: config.github.appId,
      auth: makeAuth(config.github.appId, privateKeyPem),
    },
    privileged,
    installationRepository,
  })
}

/**
 * The hosted PAT-login registry: lets a user sign in by pasting their OWN source-control PAT,
 * which the shared `/auth/pat` flow resolves to the account it belongs to (and holds to the
 * server's login/org/domain allowlist — see `AuthController`). GitHub is always available;
 * GitLab is added when a GitLab connection is configured. Unlike local mode there is NO
 * `configuredToken` — a remote deployment is multi-user, so there's no shared one-click env
 * token; each user supplies their own PAT.
 */
function buildNodeVcsIdentityRegistry(config: AppConfig): VcsIdentityRegistry {
  const registry: VcsIdentityRegistry = {
    github: { resolver: new GitHubIdentityResolver({ apiBase: config.github.apiBase }) },
  }
  if (config.gitlab?.enabled) {
    registry.gitlab = {
      resolver: new GitLabIdentityResolver({ apiBase: config.gitlab.apiBase }),
    }
  }
  return registry
}

export interface NodeContainerOptions {
  /**
   * The Drizzle/Postgres client (the single persistence layer). OPTIONAL: a mothership-mode
   * local node runs with NO Postgres (`db` undefined) and supplies {@link repos} (org/durable
   * state served remotely) plus the credential-repo seams below instead. When `db` is
   * undefined, `repos` is REQUIRED.
   *
   * Mothership-mode service matrix (what `db: undefined` turns off vs. routes remotely):
   *   - Org/durable stores that were built directly from `db` (notifications, bootstrap,
   *     env-config-repair, subscription-activation, GitHub projections, …) are routed through the
   *     {@link pickRepoSource} seam, so they come from the remote registry ({@link repos}) instead
   *     of the absent db — the board-load + run paths are covered (the Phase-3 merge gate, MET; see
   *     docs/initiatives/mothership-mode.md). An org method the server-side allow-list does not yet
   *     expose returns a clean `unknown_method`, never an undefined-db `TypeError`.
   *   - The per-user Postgres-only services turn themselves OFF (no local-sqlite bucket yet, PR 3):
   *     subscriptions, user secrets, OpenRouter catalog, personal subscriptions. See
   *     {@link buildNodeSubscriptionService} et al.
   *   - The credential pool + local-model endpoints stay ON via the local `node:sqlite` override
   *     seams below ({@link providerApiKeyRepository}/{@link localModelEndpointRepository}) — they
   *     are db-independent by design, so they are NOT in the "off without db" set above.
   */
  db?: DrizzleDb
  /**
   * Pre-built repositories; defaults to building them from {@link db}. Lets the caller
   * (e.g. {@link start}) share one set with the retention sweeper rather than rebuild.
   * REQUIRED when {@link db} is undefined (mothership mode), where it is the composite of
   * the remote (RPC-backed) org repos + the local credential repos.
   */
  repos?: ReturnType<typeof createDrizzleRepositories>
  /**
   * Override the direct-vendor API-key pool's repository. When provided it REPLACES the
   * default Drizzle one, so a sibling facade can back the key pool with a different store
   * (mothership mode injects the local `node:sqlite` credential store, since agent/model
   * credentials stay on the laptop). Undefined → the Drizzle repo over {@link db} (and the
   * whole API-key service turns off when neither a db nor this override is present).
   */
  providerApiKeyRepository?: ProviderApiKeyRepository
  /**
   * Override the per-user locally-run model-endpoint repository (the symmetric local-sqlite
   * credential seam to {@link providerApiKeyRepository}). Undefined → the Drizzle repo over
   * {@link db}.
   */
  localModelEndpointRepository?: LocalModelEndpointRepository
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
   * Override the DEPLOY job transport client (the async, container-backed Kubernetes
   * render lifecycle — slice 9's `deployJobClient` seam). When provided it REPLACES the
   * default (`new RunnerJobClient(resolveTransport)` — Node deploys on the workspace's
   * self-hosted pool, which pulls the `imageDeploy` variant). The local facade injects a
   * deploy-dedicated transport (the native CLI / a per-run deploy container) instead.
   * Undefined → the default pool-backed client when a runner transport is wired.
   */
  deployJobClient?: DeployJobClient
  /**
   * Suppress the DEFAULT pool-backed deploy client (`new RunnerJobClient(resolveTransport)`).
   * The local facade sets this: its agent transport runs the executor-harness image (or a host
   * agent process), which lacks `kubectl`/`kustomize`/`helm`, so it must NOT back deploy jobs.
   * Local injects its own deploy-dedicated `deployJobClient` when configured, else leaves deploy
   * unwired (a render-needing config then fails loudly). Undefined → the default applies (Node's
   * self-hosted pool, which pulls the `imageDeploy` variant, legitimately serves deploy).
   */
  disableDefaultDeployJobClient?: boolean
  /**
   * Override how the manifests-repo clone target is resolved for a deploy job (slice 9's
   * `resolveDeployCloneTarget` seam). When provided it REPLACES the default
   * (`makeResolveDeployCloneTarget` over the App token mint + a `github.com` origin), so the
   * local PAT / GitLab facade can emit the right host + a PAT clone token. Undefined → the
   * default GitHub-App-backed resolver when the App is configured.
   */
  resolveDeployCloneTarget?: (
    workspaceId: string,
    blockId: string,
    ref?: string,
  ) => Promise<DeployCloneTarget | null>
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
  /**
   * Override the git origin (clone URL + provider) for a run's repo. The default builds a
   * `github.com` URL; the local GitLab facade injects a builder emitting the configured
   * GitLab host + `gitlab`, so agent containers clone the right host and open merge requests
   * (without it the clone URL is always github.com, so a GitLab repo can't be cloned).
   * Undefined → the default GitHub origin.
   */
  resolveRepoOrigin?: ResolveRepoOrigin
  /**
   * Override the GitHub installation repository. When provided it REPLACES the default
   * Drizzle one, so a sibling facade can wrap it — e.g. local mode decorates it to
   * auto-provision a synthetic per-workspace installation for its PAT, since there is no
   * GitHub-App connect flow. Undefined → the default Drizzle repository over {@link db}.
   */
  githubInstallationRepository?: GitHubInstallationRepository
  /**
   * Force the Cloudflare-AI opt-in flag (the cross-runtime conformance suite forces it
   * off for parity). Undefined → derived from the REST credentials being present.
   */
  cloudflareModelsEnabled?: boolean
  /**
   * Explicit built-in gate providers, re-wired AFTER the build's `clearGateProviders()`
   * reset. The cross-runtime conformance suite uses this to drive the externalized
   * `@cat-factory/gates` CI gate over a faked verdict; production leaves it undefined and
   * the config branches below wire the real providers.
   */
  gateProviders?: GateProviderOverrides
  /**
   * The real-time subscriber registry. When provided, the container wires a
   * {@link NodeEventPublisher} (so the engine pushes execution/board/notification events
   * to subscribed browsers) and composes an in-app notification channel. `start()`
   * creates the hub and attaches it to the HTTP server via {@link attachRealtime};
   * `createServer`/tests leave it unset and the engine falls back to the no-op publisher
   * (no live push), exactly as before.
   */
  realtimeHub?: NodeRealtimeHub
  /**
   * Override the shared HTTP provider the built-in `manifest` runner backend dispatches/tests
   * through (its OAuth cache reused), e.g. for tests. This is NOT the custom-kind seam: a
   * bespoke runner backend is registered by reference into the injected
   * {@link backendRegistries} and selected per-workspace by its `kind`, exactly like a custom
   * environment backend. The per-workspace runner-pool connection (manifest + secrets) still
   * configures it. Undefined → the default HTTP provider.
   */
  runnerPoolProvider?: RunnerPoolProvider
  /**
   * The app-owned backend registries (environment + runner kind → provider). Defaults to
   * `createBackendRegistries()` (just the built-in `manifest` + `kubernetes` kinds). A
   * deployment registers a custom backend by reference here; the cross-runtime conformance
   * suite injects a registry pre-loaded with a fake custom backend to assert the seam behaves
   * identically on both runtimes.
   */
  backendRegistries?: BackendRegistries
  /**
   * Skip wrapping the resolved transport with the provisioning-log decorator. A sibling
   * facade that pre-wraps each transport branch with its OWN subsystem tag (local mode
   * tags the per-run container vs the runner pool separately) sets this so
   * {@link buildNodeContainer} doesn't double-wrap. Undefined/false → the default
   * single-subsystem wrap below.
   */
  skipProvisioningLogWrap?: boolean
  /**
   * The content-storage backend used when an account has configured none. The Node facade
   * defaults to `off` (storage requires explicit per-account configuration); the local facade
   * passes `fs` so on-disk screenshot storage works out of the box. Always overridable
   * per-account in the UI.
   */
  contentStorageDefaultBackend?: ContentStorageBackend
}

/**
 * Resolve which runner backend a workspace's container jobs dispatch to. The Node
 * facade has no built-in per-run container runtime (unlike the Worker's Cloudflare
 * Containers), so it serves a workspace's self-hosted runner pool when one is
 * registered and throws a clear error otherwise. Returns null (no transport at all)
 * when runner pools are not enabled. Mirrors the Worker's `buildResolveTransport`,
 * minus the Cloudflare-container path.
 */
export function buildNodeResolveTransport(
  config: AppConfig,
  // The port, not the Drizzle concrete: in mothership mode the local facade passes a remote
  // (RPC-backed) connection repo, and the service layer only ever uses the port methods.
  runnerPoolConnectionRepository: RunnerPoolConnectionRepository,
  workspaceRepository: CoreDependencies['workspaceRepository'],
  clock: Clock,
  // The app-owned runner-backend registry the service resolves a stored `kind` through.
  runnerBackendRegistry: RunnerBackendRegistry,
  // The shared HTTP provider the built-in `manifest` backend reuses when supplied (e.g.
  // tests). NOT the custom-kind seam — a bespoke runner backend is registered by reference
  // into `runnerBackendRegistry`. Absent → the generic manifest-driven HTTP provider.
  injectedPoolProvider?: RunnerPoolProvider,
): ResolveRunnerTransport | null {
  if (!config.runners.enabled || !config.runners.encryptionKey) return null
  const urlPolicy = resolveUrlSafetyPolicy(config.runners)
  const runnerService = new RunnerPoolConnectionService({
    runnerPoolConnectionRepository,
    workspaceRepository,
    secretCipher: new WebCryptoSecretCipher({
      masterKeyBase64: config.runners.encryptionKey,
      info: RUNNERS_CIPHER_INFO,
    }),
    clock,
    runnerBackendRegistry,
    ...(urlPolicy ? { urlPolicy } : {}),
    runnerPoolProvider:
      injectedPoolProvider ?? new HttpRunnerPoolProvider(urlPolicy ? { urlPolicy } : {}),
  })
  return async (workspaceId) => {
    if (workspaceId) {
      const resolved = await runnerService.resolve(workspaceId)
      if (resolved) return resolved.transport
    }
    throw new Error(
      `No runner backend available for workspace '${workspaceId ?? '(unknown)'}': the Node ` +
        `service runs repo-operating agents on a self-hosted runner backend — register a ` +
        `runner pool or Kubernetes cluster for this workspace (POST ` +
        `/workspaces/:id/runner-pool/connection).`,
    )
  }
}

/**
 * Wrap a transport resolver so every dispatch/release/poll-failure appends a
 * provisioning-log event. A no-op when there's no resolver. `subsystem` tags the
 * rows (a self-hosted pool vs a per-run container) so the logs drawer can filter.
 */
export function withProvisioningLog(
  resolve: ResolveRunnerTransport | null,
  recorder: ProvisioningLogRecorder,
  subsystem: ProvisioningSubsystem,
): ResolveRunnerTransport | null {
  if (!resolve) return null
  // Closure-owned so it survives each (per-resolution) wrapper: a terminal `failed`
  // job re-polled by a replay/re-drive logs its poll-failure only once.
  const loggedPollFailures = new Set<string>()
  return async (workspaceId) => {
    const inner = await resolve(workspaceId)
    return new LoggingRunnerTransport({
      inner,
      recorder,
      workspaceId: workspaceId ?? '',
      subsystem,
      loggedPollFailures,
    })
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
    modelPresetId?: string,
  ) => Promise<string | undefined>,
  mintInstallationTokenOverride?: (installationId: number) => Promise<string>,
  subscriptions?: ProviderSubscriptionService,
  personalSubscriptions?: PersonalSubscriptionService,
  resolveAccountId?: (workspaceId: string) => Promise<string | null | undefined>,
  resolveUserGitHubToken?: ResolveUserGitHubToken,
  agentContextObservability?: AgentContextObservabilityService,
  resolveWebSearchEnabled?: (workspaceId: string) => Promise<boolean>,
  resolveRepoOrigin?: ResolveRepoOrigin,
): AgentExecutor | null {
  // The harness reaches models only through this service's LLM proxy; `PUBLIC_URL`
  // is this service's externally reachable base (the runner pool / local container
  // must be able to reach it). Pi posts to `${PUBLIC_URL}/v1/chat/completions`.
  const publicUrl = env.PUBLIC_URL?.trim()
  const sessionSecret = config.auth.sessionSecret

  if (!publicUrl || !sessionSecret || !resolveTransport) return null

  // Token source: an explicit override (e.g. a static PAT in local mode) wins; else
  // the GitHub App registry mints a per-installation token (when the App is configured).
  const baseMint =
    mintInstallationTokenOverride ??
    (appRegistry ? (id: number) => appRegistry.installationToken(id) : undefined)
  if (!baseMint) return null
  // Prefer the run initiator's per-user PAT (when stored) over the App/env token, so
  // pushes/PRs are attributed to them. Falls back to the base mint otherwise.
  const mintInstallationToken: MintInstallationToken = async (installationId, ctx) => {
    if (resolveUserGitHubToken && ctx?.initiatedBy) {
      const pat = await resolveUserGitHubToken(ctx.initiatedBy)
      if (pat) return pat
    }
    return baseMint(installationId)
  }

  return new ContainerAgentExecutor({
    resolveTransport,
    agentRouting: config.agents.routing,
    resolveBlockModel: config.agents.resolveBlockModel,
    resolveWorkspaceModelDefault,
    resolveRepoTarget,
    ...(resolveAccountId ? { resolveAccountId } : {}),
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
    // Native local execution (local facade, opt-in): run subscription-harness agents with
    // the developer's OWN installed CLI + ambient login instead of leasing a credential.
    // Ambient auth applies ONLY when the resolved harness is in the allow-list AND the
    // vendor is that CLI's NATIVE vendor (no Anthropic-compatible base URL of its own:
    // `claude` / `codex`). A non-native vendor reusing the `claude-code` harness
    // (GLM/Kimi/DeepSeek carries its own `baseUrl`) is leased normally — otherwise ambient
    // auth would silently drop that base URL and run the step on the developer's own
    // Anthropic login instead of the pinned vendor.
    ...(config.nativeAmbientAuth && config.nativeAmbientAuth.length > 0
      ? {
          // The allow-list + no-`baseUrl` check is the shared `isAmbientNativeVendor`
          // predicate (so this can't drift from the personal-credential gate); the extra
          // `harness === h` guard ensures the RESOLVED harness matches the vendor's own.
          nativeAmbientAuth: (h, vendor) =>
            vendor !== undefined &&
            SUBSCRIPTION_VENDORS[vendor].harness === h &&
            isAmbientNativeVendor(config.nativeAmbientAuth, vendor),
        }
      : {}),
    proxyBaseUrl: `${publicUrl.replace(/\/+$/, '')}/v1`,
    // Point container agents' web search at the backend search proxy (no provider key in
    // the sandbox), but only for a run whose account has keys (resolved per run — see the
    // call site), so the tool is never advertised to a run where it would just fail.
    ...(resolveWebSearchEnabled ? { resolveWebSearchEnabled } : {}),
    githubApiBase: config.github.apiBase,
    // Resolve the clone URL + provider per repo. The local GitLab facade injects a GitLab
    // origin so containers clone gitlab.com (or a self-managed host) and open MRs; absent ⇒
    // the default github.com origin.
    ...(resolveRepoOrigin ? { resolveRepoOrigin } : {}),
    // Forward container tool spans to Langfuse (when configured) as child spans under
    // the run trace — the same sink the LLM proxy fans generations out to.
    llmTraceSink: buildLangfuseSink(config),
    // Record the complete provided context per dispatch (best-effort, gated in the sink).
    ...(agentContextObservability ? { agentContextObservability } : {}),
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
 * Build the live ENVIRONMENT-PROVIDER CONFIG REPAIR agent (PR #416 increment 2) when its
 * prerequisites are met — the same container prerequisites as the bootstrapper PLUS a
 * registered backend that supports agent repair (`describeRepairAgent`). The stock manifest
 * provider has no repair support, so this stays undefined there; it wires only when a custom
 * backend registered into the env-backend registry implements repair (so local inherits it
 * too). NOT the repo bootstrapper: an ordinary clone→edit→push coding job, no history reset.
 */
function selectNodeEnvConfigRepairer(deps: {
  env: NodeJS.ProcessEnv
  config: AppConfig
  resolveTransport: ResolveRunnerTransport | null
  installationRepository: GitHubInstallationRepository
  mintInstallationToken: ((installationId: number) => Promise<string>) | undefined
  override: CoreDependencies['environmentProvider']
  environmentBackendRegistry: EnvironmentBackendRegistry
}): ContainerEnvConfigRepairer | undefined {
  const publicUrl = deps.env.PUBLIC_URL?.trim()
  const sessionSecret = deps.config.auth.sessionSecret
  // Prefer the internal override (the conformance suite's fake repair provider), else scan
  // the env-backend registry for the first repair-capable backend. Built-ins don't support
  // repair, so this is undefined on a stock deployment; a third-party backend wires it.
  const repairUrlPolicy = resolveUrlSafetyPolicy(deps.config.environments)
  const environmentProvider = !deps.resolveTransport
    ? undefined
    : (deps.override ??
      deps.environmentBackendRegistry.findRepairCapable(
        repairUrlPolicy ? { urlPolicy: repairUrlPolicy } : {},
      ))
  if (
    !deps.resolveTransport ||
    !publicUrl ||
    !sessionSecret ||
    !deps.mintInstallationToken ||
    !environmentProvider ||
    typeof environmentProvider.describeRepairAgent !== 'function'
  ) {
    return undefined
  }
  // A config fix is coding work, so it follows the `coder` kind's routing. The repair runs on
  // the Pi harness over the LLM proxy, so the routed model MUST be proxyable. Surface a
  // misconfiguration HERE (at wiring) rather than letting every repair dispatch throw deep in a
  // request: if `coder` is routed to a non-proxyable model (e.g. an individual subscription
  // vendor), leave the fallback unwired — bootstrap then returns the validation issues, exactly
  // as it does when no provider supports repair.
  const model = resolveAgentConfig(deps.config.agents.routing, 'coder').ref
  if (!isProxyableProvider(model.provider)) {
    logger.warn(
      { provider: model.provider },
      'env-config repair: the coder routing model is not proxyable by the LLM proxy; ' +
        'the agent config-repair fallback is disabled.',
    )
    return undefined
  }
  return new ContainerEnvConfigRepairer({
    resolveTransport: deps.resolveTransport,
    installationRepository: deps.installationRepository,
    mintInstallationToken: deps.mintInstallationToken,
    sessionService: new ContainerSessionService({ secret: sessionSecret }),
    environmentProvider,
    model,
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
  db: DrizzleDb | undefined,
  workspaceRepository: CoreDependencies['workspaceRepository'],
  idGenerator: CoreDependencies['idGenerator'],
  clock: Clock,
): ProviderSubscriptionService | undefined {
  const masterKeyBase64 = env.ENCRYPTION_KEY?.trim()
  // No Postgres (mothership mode): the pooled subscription-token store is not yet a
  // local-sqlite bucket (PR 3), so the service is off — capability resolution treats it absent.
  if (!masterKeyBase64 || !db) return undefined
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
 * Build the direct-provider API-key pool (account/workspace/user) for the Node/local
 * facade (Postgres-backed), or undefined when the shared ENCRYPTION_KEY is absent.
 * Keys are sealed under an api-keys-scoped HKDF info of the shared master key. Mirrors
 * the Worker's buildApiKeyService.
 */
function buildNodeApiKeyService(
  env: NodeJS.ProcessEnv,
  db: DrizzleDb | undefined,
  workspaceRepository: CoreDependencies['workspaceRepository'],
  idGenerator: CoreDependencies['idGenerator'],
  clock: Clock,
  // Mothership mode injects the local `node:sqlite` credential store here, so the key pool
  // stays on the laptop (the mothership's key never reaches it). Else the Drizzle repo over `db`.
  repositoryOverride?: ProviderApiKeyRepository,
): ApiKeyService | undefined {
  const masterKeyBase64 = env.ENCRYPTION_KEY?.trim()
  if (!masterKeyBase64) return undefined
  const providerApiKeyRepository =
    repositoryOverride ?? (db ? new DrizzleProviderApiKeyRepository(db) : undefined)
  if (!providerApiKeyRepository) return undefined
  return new ApiKeyService({
    providerApiKeyRepository,
    workspaceRepository,
    secretCipher: new WebCryptoSecretCipher({
      masterKeyBase64,
      info: 'cat-factory:provider-api-keys',
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
function buildNodeLocalModelEndpointService(
  env: NodeJS.ProcessEnv,
  db: DrizzleDb | undefined,
  clock: Clock,
  // The symmetric local-sqlite credential seam (mothership mode); else Drizzle over `db`.
  repositoryOverride?: LocalModelEndpointRepository,
): LocalModelEndpointService | undefined {
  const masterKeyBase64 = env.ENCRYPTION_KEY?.trim()
  if (!masterKeyBase64) return undefined
  const localModelEndpointRepository =
    repositoryOverride ?? (db ? new DrizzleLocalModelEndpointRepository(db) : undefined)
  if (!localModelEndpointRepository) return undefined
  return new LocalModelEndpointService({
    localModelEndpointRepository,
    secretCipher: new WebCryptoSecretCipher({
      masterKeyBase64,
      info: 'cat-factory:local-model-endpoints',
    }),
    clock,
  })
}

/**
 * Build the per-USER generic secret service (a GitHub PAT today), or undefined when the
 * shared ENCRYPTION_KEY is absent. Single system-cipher (no password layer); also backs
 * `ResolveUserGitHubToken`. Mirror of the Worker's `buildUserSecretService`.
 */
function buildNodeUserSecretService(
  env: NodeJS.ProcessEnv,
  db: DrizzleDb | undefined,
  clock: Clock,
): UserSecretService | undefined {
  const masterKeyBase64 = env.ENCRYPTION_KEY?.trim()
  // No Postgres (mothership mode): the per-user secret store is not yet a local-sqlite
  // bucket (PR 3), so it is off.
  if (!masterKeyBase64 || !db) return undefined
  return new UserSecretService({
    userSecretRepository: new DrizzleUserSecretRepository(db),
    secretCipher: new WebCryptoSecretCipher({ masterKeyBase64, info: 'cat-factory:user-secret' }),
    clock,
  })
}

/**
 * The per-WORKSPACE OpenRouter dynamic-catalog service, or undefined when the API-key pool
 * isn't wired (no ENCRYPTION_KEY) — refresh leases the workspace's pooled OpenRouter key.
 * Mirror of the Worker's `buildOpenRouterCatalogService`.
 */
function buildNodeOpenRouterCatalogService(
  env: NodeJS.ProcessEnv,
  db: DrizzleDb | undefined,
  clock: Clock,
  apiKeys: ApiKeyService | undefined,
  spendCurrency: string,
): OpenRouterCatalogService | undefined {
  // The dynamic-catalog projection is Postgres-only for now (PR 3), so it is off without a db
  // even though the API-key pool (which it leases through) may be local-sqlite-backed.
  if (!apiKeys || !db) return undefined
  return new OpenRouterCatalogService({
    providerModelCatalogRepository: new DrizzleProviderModelCatalogRepository(db),
    apiKeys,
    clock,
    baseUrl: baseUrlForNode('openrouter', env),
    // OpenRouter quotes USD; convert to the deployment's spend currency so persisted prices
    // (and the spend overlay) match the rest of the budget table.
    usdToCurrencyRate: usdRateForSpendCurrency(spendCurrency),
  })
}

function buildNodePersonalSubscriptionService(
  env: NodeJS.ProcessEnv,
  db: DrizzleDb | undefined,
  idGenerator: CoreDependencies['idGenerator'],
  clock: Clock,
): PersonalSubscriptionService | undefined {
  const masterKeyBase64 = env.ENCRYPTION_KEY?.trim()
  // No Postgres (mothership mode): the personal-subscription + activation stores are not yet
  // local-sqlite buckets (PR 3), so the service is off.
  if (!masterKeyBase64 || !db) return undefined
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
  // The Node service has no built-in per-run container runtime: repo-operating agents run on
  // a self-hosted runner pool, and Tester environments via the environment provider. Surface
  // that so the SPA's infrastructure selector reads accurately. Local mode pre-sets its own
  // descriptor (host Docker + pool) before calling in, so only fill it when absent.
  config.infrastructure ??= buildInfrastructureCapabilities({
    execution: { available: ['runner-pool'], active: 'runner-pool' },
    testEnv: { available: ['environment-provider'], active: 'environment-provider' },
  })
  const clock = new SystemClock()
  const idGenerator = new CryptoIdGenerator()
  // Mothership mode runs with NO Postgres (`options.db` undefined): org/durable state is served
  // remotely via `options.repos`, so that set is REQUIRED there. (A standard Node/local build
  // passes `db` and we build the Drizzle set from it.)
  if (!options.repos && !options.db) {
    throw new Error(
      'buildNodeContainer requires `repos` when `db` is undefined (mothership mode supplies the ' +
        'composite remote + local-credential repositories).',
    )
  }
  const repos = options.repos ?? createDrizzleRepositories(options.db as DrizzleDb, clock)
  // The Drizzle constructors only stash the handle — no build-time work (audited) — so BUILDING
  // the stores below over an `undefined` db is safe; `db` carries the non-null type for those
  // constructions, and the per-user credential services take the OPTIONAL `options.db` and turn
  // themselves off when it is absent.
  const db = options.db as DrizzleDb
  // Mothership mode (`options.db` undefined): the org/durable stores a standard build constructs
  // directly from the db — the GitHub installation + projections, runner-pool connection,
  // bootstrap + env-config-repair job stores, notifications, reference-architecture library,
  // task + subscription-activation stores — are sourced from the REMOTE registry instead (here
  // `options.repos` is the full-surface remote `Proxy` from `composeMothership`, which forwards
  // any repo name to the mothership over RPC). `pickRepoSource(remoteRepos, name, build)` picks
  // the remote entry when there is no db, else builds the Drizzle repo — see the Phase-3 audit in
  // docs/initiatives/mothership-mode.md. The feature-flagged integration repos owned by the
  // sub-helpers (tasks/documents/environments/fragments/slack) are opt-in and off by default, so
  // they are NOT on the default board-load + run path and remain a follow-up sub-slice.
  const remoteRepos = options.db ? undefined : (repos as unknown as Record<string, unknown>)
  // `remoteRepos` + `db` are fixed for this build, so bind them once: `sourced('name', (d) => …)`
  // picks the remote registry entry in mothership mode, else builds the Drizzle repo over `db`.
  const sourced = <T>(name: string, build: (d: DrizzleDb) => T): T =>
    pickRepoSource(remoteRepos, name, () => build(db))

  // The app-owned backend registries (env + runner kind → provider), built once here and
  // injected into the engine + surfaced on the container for the snapshot's backend-kind
  // selectors. A deployment registers a custom backend by reference; the conformance suite
  // injects a pre-loaded registry. Defaults to just the built-in `manifest`/`kubernetes` kinds.
  const { environmentBackendRegistry, runnerBackendRegistry, customManifestTypeRegistry } =
    options.backendRegistries ?? createBackendRegistries()

  // Binary-artifact storage (UI screenshots + reference design images) for the
  // visual-confirmation gate. The backend is configured PER ACCOUNT in the UI (no env vars):
  // the metadata always lives in Postgres; the bytes go to the account's chosen blob backend
  // (`fs` → the local filesystem; `db` → a Postgres `bytea` table; `s3` → an S3 bucket). The
  // composed store is resolved per request/run from the account settings (see
  // `resolveBinaryArtifactStore`, built below once `accountSettings` exists).
  const contentStorageCapability: ContentStorageCapability = {
    supportedBackends: ['off', 'fs', 's3', 'db'],
    defaultBackend: options.contentStorageDefaultBackend ?? 'off',
  }
  const buildNodeBlobBackend: BuildBlobBackend = (kind, opts) => {
    switch (kind) {
      case 'fs':
        // NOTE: the filesystem backend is local-disk only. It is correct for the local facade
        // and a single-instance Node deployment with a persistent volume, but NOT for a scaled
        // (multi-replica) or ephemeral-disk deployment — bytes written on one replica are
        // invisible to the others and lost on redeploy. Scaled deployments should pick `s3`.
        return new FilesystemBinaryBlobBackend({ basePath: opts.fs?.basePath })
      case 'db':
        return new PostgresBinaryBlobBackend(db)
      case 's3':
        if (!opts.s3) return null
        // Omitting credentials is intentional: the S3 client then falls back to the ambient AWS
        // credential chain (instance role / `AWS_*` env), which is the right behaviour for a
        // deployment running on AWS with an attached role. The UI requires explicit keys, so this
        // path is only reached by a config written through another channel.
        return new S3BinaryBlobBackend({
          ...opts.s3,
          ...(opts.s3Credentials ? { credentials: opts.s3Credentials } : {}),
        })
      default:
        // `r2`/`memory` are not served on Node/local — null ⇒ storage unavailable.
        return null
    }
  }

  // The built-in gates' providers are deployment-global module handles (in `@cat-factory/gates`),
  // not per-container DI. Reset them up-front so each build re-wires from a clean slate and only
  // the gates this deployment actually configures stay wired: the GitHub + release-health wiring
  // below runs only inside its `enabled`/`githubClient` branches and never clears, so without this
  // reset a provider wired by an earlier (configured) build in the same process would leak into a
  // later (unconfigured) build and make its gate probe a stale handle instead of passing through.
  // Mirrors the Worker facade (keep the runtimes symmetric). Any test-injected gate providers
  // (`options.gateProviders`) are applied at the END of this build so they OVERRIDE the config
  // wiring below (local mode wires a PAT-backed CI provider here that would otherwise clobber a
  // faked one) — gates read their provider lazily at probe time, so the last write wins.
  clearGateProviders()

  // Opt-in GitLab VCS provider (single-token model, mirroring local-mode's PAT). Registered
  // in the process-wide VCS registry so the neutral webhook route + any VcsConnectionRef
  // holder resolves it. A no-op unless GITLAB_TOKEN is set; symmetric with the Worker facade
  // (and inherited by local) per "keep the runtimes symmetric".
  let gitlabEngineClient: GitHubClient | undefined
  if (config.gitlab?.enabled && env.GITLAB_TOKEN) {
    registerGitLab({
      tokenSource: new StaticGitLabTokenSource(env.GITLAB_TOKEN, config.gitlab.apiBase),
      clock,
      webhookSecret: config.gitlab.webhookSecret || undefined,
    })
    // Bridge the GitLab VcsClient onto the legacy GitHubClient port the engine's gate / merge /
    // RepoFiles paths consume, so a GitLab-only deployment (no GitHub App) gates on real CI and
    // merges the MR for real — the SAME wiring local mode already does, now on the Node facade
    // too (keep the runtimes symmetric). The GitHub App client wins when both are configured.
    gitlabEngineClient = buildGitLabEngineClient({
      token: env.GITLAB_TOKEN,
      apiBase: config.gitlab.apiBase,
      clock,
    })
  }

  // Honour the workspace's model presets at run time (block-pinned > the task's
  // selected/default model preset > env routing), uniformly for inline and container
  // kinds. The built-in default preset points every agent kind at Kimi K2.7.
  const resolveWorkspaceModelDefault = (
    workspaceId: string,
    agentKind: string,
    modelPresetId?: string,
  ) => resolvePresetModelForKind(repos.modelPresetRepository, workspaceId, agentKind, modelPresetId)

  // The direct-provider API-key pool + the per-scope model-provider resolver, shared by
  // the inline executor, the inline modules (planner/reviewer/fragment selector), the
  // API-key controller, and the LLM proxy key lease.
  const apiKeys = buildNodeApiKeyService(
    env,
    db,
    repos.workspaceRepository,
    idGenerator,
    clock,
    options.providerApiKeyRepository,
  )
  // The per-user locally-run model endpoints store (Ollama / LM Studio / …), shared by
  // the local-runner controller, the per-user model catalog, the inline model provider,
  // and the LLM proxy.
  const localModelEndpoints = buildNodeLocalModelEndpointService(
    env,
    db,
    clock,
    options.localModelEndpointRepository,
  )
  // The per-user generic secret store (a GitHub PAT today), shared by the user-secret
  // controller and the run-initiator PAT resolver below.
  const userSecrets = buildNodeUserSecretService(env, db, clock)
  // Resolve the run initiator's stored GitHub PAT (when set) — preferred over the
  // App/env token by the container push-token mint + the engine GitHub client.
  const resolveUserGitHubToken: ResolveUserGitHubToken | undefined = userSecrets
    ? (userId) => userSecrets.resolve(userId, 'github_pat')
    : undefined
  // The per-workspace OpenRouter dynamic-catalog store — shared by the catalog controller,
  // the per-workspace model catalog's dynamic OpenRouter entries, and the spend overlay.
  const openRouterCatalog = buildNodeOpenRouterCatalogService(
    env,
    db,
    clock,
    apiKeys,
    config.spend.currency,
  )
  const modelProviderResolver = buildModelProviderResolver(env, db, apiKeys, localModelEndpoints)
  // Cloudflare Workers AI is opt-in on Node: enabled when the REST creds are present.
  const cloudflareModelsEnabled =
    options.cloudflareModelsEnabled ?? !!(env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN)

  const inline = new AiAgentExecutor({
    modelProviderResolver,
    agentRouting: config.agents.routing,
    resolveBlockModel: config.agents.resolveBlockModel,
    resolveWorkspaceModelDefault,
    // Opt-in provider web search for the inline design/research kinds (no-op unless
    // INLINE_WEB_SEARCH_ENABLED and an Anthropic/OpenAI model).
    webSearch: inlineWebSearchOptionsFromEnv(env),
  })

  // Persistence the container-execution path needs (built from the same db). The
  // runner-pool repo also backs the `runners` Core module so a pool is registrable
  // via the API; the installation repo backs both token minting and repo resolution.
  const runnerPoolConnectionRepository = sourced(
    'runnerPoolConnectionRepository',
    (d) => new DrizzleRunnerPoolConnectionRepository(d),
  )
  const githubInstallationRepository =
    options.githubInstallationRepository ??
    sourced('githubInstallationRepository', (d) => new DrizzleGitHubInstallationRepository(d))
  // The repositories projection (+ sync cursors), shared by `buildResolveRepoTarget`
  // (block→repo resolution) and the GitHub sync/webhook module below.
  const repoProjectionRepository = sourced(
    'repoProjectionRepository',
    (d) => new DrizzleRepoProjectionRepository(d),
  )

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
    // The org service repo (its `getByFrameBlock` is all `buildResolveRepoTarget` needs); already
    // in `repos`, so it is the Drizzle repo over `db` in a standard build and the remote proxy in
    // mothership mode — no separate direct-db `DrizzleServiceFrameRepository` construction.
    serviceRepository: repos.serviceRepository,
  })

  // Best-effort recorder for the provisioning event log (its own Postgres schema).
  // Shared by the env services (via createCore) and the runner/container transport
  // decorator below, so every spin-up/down attempt is logged.
  const provisioningLogRecorder = new ProvisioningLogRecorder({
    repository: repos.provisioningLogRepository,
    idGenerator,
    clock,
  })

  // A sibling facade (local mode) may inject its own transport — even `null` — which
  // replaces the default self-hosted-pool resolution; undefined keeps Node's default
  // (a self-hosted pool, optionally driven by an injected native `runnerPoolProvider`).
  // The injected transport is a per-run container (local mode), the default is a
  // self-hosted pool — tag each accordingly so the logs drawer can filter by subsystem.
  // A facade that pre-wraps its branches with their own subsystem tags (local mode) sets
  // `skipProvisioningLogWrap` so we don't double-wrap.
  const baseResolveTransport =
    options.resolveTransport !== undefined
      ? options.resolveTransport
      : buildNodeResolveTransport(
          config,
          runnerPoolConnectionRepository,
          repos.workspaceRepository,
          clock,
          runnerBackendRegistry,
          options.runnerPoolProvider,
        )
  const resolveTransport = options.skipProvisioningLogWrap
    ? baseResolveTransport
    : withProvisioningLog(
        baseResolveTransport,
        provisioningLogRecorder,
        options.resolveTransport !== undefined ? 'container' : 'runner-pool',
      )

  // The async, container-backed Kubernetes deploy lifecycle (slice 9's `deployJobClient` +
  // `resolveDeployCloneTarget` seams). Node deploys on the workspace's self-hosted runner pool
  // (which pulls the `imageDeploy` variant), so the default deploy client wraps the SAME
  // `resolveTransport` the agent executor uses — the pool is Node's analogue of the Worker's
  // DeployContainer. The clone-target resolver mints a short-lived install token + a github.com
  // origin from the App registry. The local facade injects BOTH (a deploy-dedicated native/
  // container transport + a PAT/GitLab clone target) via `options`, which win here. Absent any
  // backend ⇒ unwired, so a render-needing config fails loudly (the raw REST path is unaffected).
  const baseDeployMint =
    options.mintInstallationToken ??
    (appRegistry ? (id: number) => appRegistry.installationToken(id) : undefined)
  const deployJobClient: DeployJobClient | undefined =
    options.deployJobClient ??
    (options.disableDefaultDeployJobClient || !resolveTransport
      ? undefined
      : new RunnerJobClient(resolveTransport))
  const resolveDeployCloneTarget =
    options.resolveDeployCloneTarget ??
    (baseDeployMint
      ? makeResolveDeployCloneTarget(
          resolveRepoTarget,
          (id) => baseDeployMint(id),
          options.resolveRepoOrigin
            ? { resolveCloneUrl: (t) => options.resolveRepoOrigin!(t).cloneUrl }
            : {},
        )
      : undefined)
  const deployDeps: Partial<CoreDependencies> = config.environments.enabled
    ? {
        ...(deployJobClient ? { deployJobClient } : {}),
        ...(resolveDeployCloneTarget ? { resolveDeployCloneTarget } : {}),
      }
    : {}
  // The subscription-token pool (Claude Code / Codex credentials), shared by the
  // container executor (lease + usage feedback) and the vendor-credential controller.
  const subscriptions = buildNodeSubscriptionService(
    env,
    db,
    repos.workspaceRepository,
    idGenerator,
    clock,
  )
  // The per-user individual-usage subscription store (Claude), shared by the
  // container executor's personal lease and the personal-subscription controller.
  const personalSubscriptions = buildNodePersonalSubscriptionService(env, db, idGenerator, clock)
  // Agent-context observability sink: records the complete, redacted context provided
  // to each container agent (composed prompts + folded-in fragments + injected files).
  // Gated by the deployment prompt-recording switch + the workspace storeAgentContext
  // setting. Wired into the executor (write) AND createCore (read). The telemetry rows
  // live in the `telemetry` Postgres schema (see schema.ts).
  const agentContextObservability = new AgentContextObservabilityService({
    agentContextSnapshotRepository: repos.agentContextSnapshotRepository,
    workspaceSettingsRepository: repos.workspaceSettingsRepository,
    idGenerator,
    clock,
    recordPrompts: config.observability.recordPrompts,
  })
  // Web-search keys live per-account; advertise Pi's `web_search` tool to a run only when
  // its account actually has a usable upstream (else the tool would just fail/return
  // nothing). Resolved per run off a dedicated account-settings instance (short-TTL cache).
  const webSearchAccountKey = env.ENCRYPTION_KEY?.trim()
  const webSearchAccountSettings = webSearchAccountKey
    ? new AccountSettingsService({
        accountSettingsRepository: repos.accountSettingsRepository,
        secretCipher: new WebCryptoSecretCipher({
          masterKeyBase64: webSearchAccountKey,
          info: ACCOUNT_SETTINGS_CIPHER_INFO,
        }),
        clock,
      })
    : undefined
  const resolveWebSearchEnabled = webSearchAccountSettings
    ? async (workspaceId: string): Promise<boolean> => {
        const accountId = await repos.workspaceRepository.accountOf(workspaceId)
        if (!accountId) return false
        return Boolean((await webSearchAccountSettings.resolve(accountId)).webSearch)
      }
    : undefined
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
    (workspaceId) => repos.workspaceRepository.accountOf(workspaceId),
    resolveUserGitHubToken,
    agentContextObservability,
    resolveWebSearchEnabled,
    options.resolveRepoOrigin,
  )

  // Always a composite: inline kinds run as one-shot LLM calls; repo-operating kinds
  // route to the container (and fail loudly when its prerequisites are unconfigured).
  // Optionally wrapped with the consensus mechanism below (after the event publisher
  // is built, so live consensus pushes ride the same hub).
  const standardAgentExecutor = new CompositeAgentExecutor(inline, container)

  // GitHub-issue tracker: file the tech-debt pipeline's issue through the workspace's
  // own GitHub App installation (per-tenant), resolving the service's repo from the
  // github_repos projection — the same per-tenant infra the container executor uses.
  const fileGitHubIssue = buildNodeGitHubIssueFiler(config, appRegistry, resolveRepoTarget)

  // The GitHub client backing the CI gate + merge / mergeability providers: an injected
  // one wins (the local facade supplies a PAT-backed client), else — when the GitHub App
  // is configured — one minted from the shared App registry, so a stock Node deployment
  // with an App ALSO gates on real GitHub Actions CI and merges the PR for real (parity
  // with the Worker). Undefined → these stay unwired and the gates pass through.
  // Prefer the run initiator's per-user PAT (when stored) over the App token for the
  // engine's CI gate + merge reads, so those are attributed to them too. The engine
  // sets the initiator in ambient context around the gate-probe / merge boundaries.
  const engineRegistry =
    appRegistry && resolveUserGitHubToken
      ? new PatPreferringAppRegistry(appRegistry, resolveUserGitHubToken)
      : appRegistry
  const githubClient: GitHubClient | undefined =
    options.githubClient ??
    (engineRegistry
      ? new FetchGitHubClient({
          registry: engineRegistry,
          rateLimitRepository: new NoopRateLimitRepository(),
          idGenerator,
          clock,
          apiBase: config.github.apiBase,
        })
      : undefined)

  // The client the engine's gate / merge / RepoFiles seams read through: the real GitHub client
  // when present, else the GitLab-backed fallback so a GitLab-only deployment still gates on real
  // CI and merges for real (the GitHub App wins when both are configured). Kept SEPARATE from
  // `githubClient` on purpose — the GitHub-issue-specific consumers below (the GitHub Issues task
  // source, issue writeback, the App projection module) must NOT be fed the GitLab client, or a
  // GitLab-only deployment would offer a non-functional "GitHub Issues" source (it resolves the
  // empty github_installations projection). Parity with the Worker, which keeps the App client
  // distinct from its GitLab engine fallback.
  const engineVcsClient: GitHubClient | undefined = githubClient ?? gitlabEngineClient

  // Task-source integration (Jira + GitHub issues). Tenants connect their own Jira
  // site through the UI (credentials stored per-workspace, encrypted at rest); the
  // tracker resolves each workspace's own credentials from this same store. GitHub
  // issues reuse the workspace's installed App, so they wire only when `githubClient`
  // is available — kept here, after the client is built, for parity with the Worker.
  const tasks = selectNodeTasksDeps(config, db, githubClient, githubInstallationRepository)

  // Issue-tracker writeback (comment-on-PR-open + close-on-merge of a task's linked
  // issue), gated per workspace + per task inside the provider. GitHub uses the same
  // per-tenant client + installation lookup as the tracker/CI/merge providers; Jira
  // reuses the workspace's encrypted connection. Wired whenever the tracker-settings
  // repo exists (always on Node) so the engine can write back when a tracker is set.
  const resolveWritebackIssue = githubClient
    ? async (workspaceId: string, externalId: string) => {
        const parsed = githubIssuesLogic.parseGitHubIssueExternalId(externalId)
        if (!parsed) return null
        const installation = await githubInstallationRepository.getByWorkspace(workspaceId)
        if (!installation) return null
        return { installationId: installation.installationId, parsed }
      }
    : undefined
  const issueWritebackProvider = new IssueWritebackService({
    trackerSettingsRepository: repos.trackerSettingsRepository,
    taskRepository: sourced('taskRepository', (d) => new DrizzleTaskRepository(d)),
    fetchImpl: fetch,
    ...(githubClient && resolveWritebackIssue
      ? {
          commentOnGitHubIssue: async (workspaceId, externalId, body) => {
            const target = await resolveWritebackIssue(workspaceId, externalId)
            if (!target) return
            await githubClient.comment(
              target.installationId,
              { owner: target.parsed.owner, repo: target.parsed.repo },
              target.parsed.number,
              body,
            )
          },
          closeGitHubIssue: async (workspaceId, externalId) => {
            const target = await resolveWritebackIssue(workspaceId, externalId)
            if (!target) return
            await githubClient.closeIssue(
              target.installationId,
              { owner: target.parsed.owner, repo: target.parsed.repo },
              target.parsed.number,
            )
          },
        }
      : {}),
    ...(tasks.taskConnectionRepository
      ? {
          resolveJiraConnection: async (workspaceId: string) => {
            const connection = await tasks.taskConnectionRepository!.getByWorkspace(
              workspaceId,
              'jira',
            )
            const { baseUrl, accountEmail, apiToken } = connection?.credentials ?? {}
            if (!baseUrl || !accountEmail || !apiToken) return null
            return { baseUrl, accountEmail, apiToken }
          },
          resolveLinearConnection: async (workspaceId: string) => {
            const connection = await tasks.taskConnectionRepository!.getByWorkspace(
              workspaceId,
              'linear',
            )
            const { apiKey, token } = connection?.credentials ?? {}
            return apiKey || token ? { apiKey, token } : null
          },
        }
      : {}),
  })

  let githubGateDeps: Partial<CoreDependencies> = {}
  if (engineVcsClient) {
    // The `ci` / `conflicts` gates now live in `@cat-factory/gates`; wire their providers into
    // the gate suite instead of onto the engine's CoreDependencies (single-process startup, so
    // the deployment-global handles are set once here). Parity with the Worker's selectGitHubDeps.
    // These read through `engineVcsClient` (GitHub App or the GitLab fallback), so a GitLab-only
    // deployment gates + merges for real too.
    wireCiStatusProvider(
      new GitHubCiStatusProvider({
        githubClient: engineVcsClient,
        resolveRepoTarget,
        blockRepository: repos.blockRepository,
      }),
    )
    wireMergeabilityProvider(
      new GitHubMergeabilityProvider({
        githubClient: engineVcsClient,
        resolveRepoTarget,
        blockRepository: repos.blockRepository,
      }),
    )
    wirePullRequestReviewProvider(
      new GitHubPullRequestReviewProvider({
        githubClient: engineVcsClient,
        resolveRepoTarget,
        blockRepository: repos.blockRepository,
      }),
    )
    githubGateDeps = {
      // The engine binds a registered custom kind's pre/post-op hooks to a run's repo
      // via this checkout-free RepoFiles resolver, composed from the same client +
      // repo-target walk the gates/merger use — parity with the Worker.
      resolveRunRepoContext: makeResolveRunRepoContext(engineVcsClient, resolveRepoTarget),
      // Block-less repo resolver for the environments module's on-demand repo
      // validation / config bootstrap (operator names owner+repo).
      resolveRepoFilesForCoords: makeResolveRepoFilesForCoords(
        engineVcsClient,
        githubInstallationRepository,
        repoProjectionRepository,
      ),
      branchUpdater: new GitHubBranchUpdater({
        githubClient: engineVcsClient,
        resolveRepoTarget,
        blockRepository: repos.blockRepository,
      }),
      pullRequestMerger: new GitHubPullRequestMerger({
        githubClient: engineVcsClient,
        resolveRepoTarget,
        blockRepository: repos.blockRepository,
      }),
    }
  }

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
          // The five GitHub projection repos share one shape (remote in mothership mode, else
          // Drizzle over `db`), routed through the shared `sourced` helper.
          branchProjectionRepository: sourced(
            'branchProjectionRepository',
            (d) => new DrizzleBranchProjectionRepository(d),
          ),
          pullRequestProjectionRepository: sourced(
            'pullRequestProjectionRepository',
            (d) => new DrizzlePullRequestProjectionRepository(d),
          ),
          issueProjectionRepository: sourced(
            'issueProjectionRepository',
            (d) => new DrizzleIssueProjectionRepository(d),
          ),
          commitProjectionRepository: sourced(
            'commitProjectionRepository',
            (d) => new DrizzleCommitProjectionRepository(d),
          ),
          checkRunProjectionRepository: sourced(
            'checkRunProjectionRepository',
            (d) => new DrizzleCheckRunProjectionRepository(d),
          ),
          webhookVerifier: new WebCryptoWebhookVerifier(config.github.webhookSecret),
          // Bound the initial backfill to the commit retention horizon (0 = full).
          commitBackfillHorizonMs: config.retention.commitMs || undefined,
          ...(appRegistry
            ? {
                // Privileged App tier (ADR 0005): when configured, its client backs the
                // create-repo endpoint; `canCreateRepos` flags a connection whose
                // installation is owned by the privileged App. Absent → repo creation
                // stays the manual flow (parity with the Worker's selectGitHubDeps).
                repoProvisioningClient: config.github.privilegedApp
                  ? new FetchGitHubProvisioningClient({
                      registry: appRegistry,
                      apiBase: config.github.apiBase,
                    })
                  : undefined,
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
  const bootstrapJobRepository = sourced(
    'bootstrapJobRepository',
    (d) => new DrizzleBootstrapJobRepository(d),
  )
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

  // Real-time push + notification delivery. When a realtime hub is wired (start()), the
  // engine pushes execution/board/notification events to subscribed browsers via the
  // NodeEventPublisher, decorated with FanOutEventPublisher so a shared service's live
  // events reach EVERY board that mounts it (parity with the Worker's selectEventPublisher).
  // The in-app push is also a notification channel, composed alongside Slack (when
  // enabled) so a raised notification both lands in the inbox live AND fans to Slack.
  const slackDeps = selectNodeSlackDeps(config, db, repos)
  const executionEventPublisher = options.realtimeHub
    ? new FanOutEventPublisher(new NodeEventPublisher(options.realtimeHub), {
        workspaceMountRepository: repos.workspaceMountRepository,
      })
    : undefined
  // Optionally wrap the executor with the consensus mechanism (CONSENSUS_ENABLED). Off ⇒
  // the standard composite, unchanged. Registers the capability traits + routes
  // consensus-enabled steps through a multi-model process, persisting + pushing the
  // transcript (same hub as run/board events).
  const agentExecutor = isTruthy(env.CONSENSUS_ENABLED)
    ? (registerConsensusTraits(),
      new ConsensusAgentExecutor({
        standard: standardAgentExecutor,
        modelProviderResolver,
        agentRouting: config.agents.routing,
        resolveBlockModel: config.agents.resolveBlockModel,
        resolveWorkspaceModelDefault,
        sessionRepository: repos.consensusSessionRepository,
        ...(executionEventPublisher ? { eventPublisher: executionEventPublisher } : {}),
      }))
    : standardAgentExecutor

  const notificationChannels: NotificationChannel[] = []
  if (executionEventPublisher)
    notificationChannels.push(new InAppNotificationChannel(executionEventPublisher))
  if (slackDeps.notificationChannel) notificationChannels.push(slackDeps.notificationChannel)
  const notificationChannel =
    notificationChannels.length === 0
      ? undefined
      : notificationChannels.length === 1
        ? notificationChannels[0]
        : new CompositeNotificationChannel(notificationChannels)

  // Observability post-release-health: wire the gate + the release-health settings module
  // when enabled (+ ENCRYPTION_KEY), mirroring the Worker's `selectReleaseHealthDeps`. Off →
  // the `post-release-health` gate is a pass-through and the module isn't assembled.
  const releaseHealthDeps: Partial<CoreDependencies> = {}
  if (config.releaseHealth.enabled && config.releaseHealth.encryptionKey) {
    const observabilitySecretCipher = new WebCryptoSecretCipher({
      masterKeyBase64: config.releaseHealth.encryptionKey,
      info: OBSERVABILITY_CIPHER_INFO,
    })
    releaseHealthDeps.observabilityConnectionRepository = repos.observabilityConnectionRepository
    releaseHealthDeps.releaseHealthConfigRepository = repos.releaseHealthConfigRepository
    releaseHealthDeps.observabilitySecretCipher = observabilitySecretCipher
    // The post-release-health gate + on-call escalation now live in `@cat-factory/gates`; wire
    // their providers into the gate suite. The observability repos/cipher above stay on
    // CoreDependencies — they power the management API (ReleaseHealthService), not the gate.
    wireReleaseHealthProvider(
      new RegistryReleaseHealthProvider({
        observabilityConnectionRepository: repos.observabilityConnectionRepository,
        releaseHealthConfigRepository: repos.releaseHealthConfigRepository,
        blockRepository: repos.blockRepository,
        secretCipher: observabilitySecretCipher,
        registry: defaultObservabilityRegistry,
      }),
    )
  }

  // Per-workspace incident-enrichment (PagerDuty + incident.io): credentials moved out of
  // env into a sealed per-workspace row, resolved + decrypted at enrichment time. Wired
  // whenever the shared ENCRYPTION_KEY is present (independent of the release-health gate).
  const encryptionKey = env.ENCRYPTION_KEY?.trim()
  const incidentEnrichmentDeps: Partial<CoreDependencies> = {}
  if (encryptionKey) {
    const incidentEnrichmentSecretCipher = new WebCryptoSecretCipher({
      masterKeyBase64: encryptionKey,
      info: INCIDENT_ENRICHMENT_CIPHER_INFO,
    })
    incidentEnrichmentDeps.incidentEnrichmentConnectionRepository =
      repos.incidentEnrichmentConnectionRepository
    incidentEnrichmentDeps.incidentEnrichmentSecretCipher = incidentEnrichmentSecretCipher
    // The on-call enrichment provider now lives in `@cat-factory/gates`; wire the
    // workspace-backed provider into the gate suite. The connection repo + cipher above
    // stay on CoreDependencies to power the management API.
    wireIncidentEnrichment(
      new WorkspaceIncidentEnrichmentProvider({
        incidentEnrichmentConnectionRepository: repos.incidentEnrichmentConnectionRepository,
        secretCipher: incidentEnrichmentSecretCipher,
      }),
    )
  }

  // Per-account deployment settings (Slack OAuth + web-search keys + content-storage), built
  // once so the service's short-TTL cache spans requests; the Slack OAuth + content-storage
  // resolvers derive from it.
  const accountSettings = encryptionKey
    ? new AccountSettingsService({
        accountSettingsRepository: repos.accountSettingsRepository,
        secretCipher: new WebCryptoSecretCipher({
          masterKeyBase64: encryptionKey,
          info: ACCOUNT_SETTINGS_CIPHER_INFO,
        }),
        clock,
        contentStorageCapability,
      })
    : undefined

  // Resolve the binary-artifact store for a workspace's account from its content-storage
  // settings (the blob backend is per-account; the metadata is the shared Postgres store).
  // Without `accountSettings` (no encryption key) there is no per-account override, so every
  // workspace falls back to the runtime default — which on Node is `off`, so the resolver then
  // returns null and the controllers 503 / the gate passes through. Caches per account, so a
  // backend switch rebuilds and the many workspaces under one account share a store.
  const resolveBinaryArtifactStore = makeResolveBinaryArtifactStore({
    accountSettings,
    accountOf: (workspaceId) => repos.workspaceRepository.accountOf(workspaceId),
    metadata: repos.binaryArtifactMetadataStore,
    idGenerator,
    clock,
    buildBlobBackend: buildNodeBlobBackend,
    defaultBackend: contentStorageCapability.defaultBackend,
  })

  // Runner-pool URL/host guard, scoped to its own config (independent of the environment
  // allow-list); absent => strict public-https.
  const runnerUrlPolicy = resolveUrlSafetyPolicy(config.runners)

  // Apply any test-injected gate providers LAST, so they override the config wiring above (the
  // cross-runtime conformance suite drives the externalized CI gate over a faked verdict; in
  // local mode a PAT-backed CI provider is wired above and would otherwise win). Production
  // leaves `gateProviders` undefined, so this is a no-op outside tests.
  applyGateProviders(options.gateProviders)
  // Surface any gate left as a silent pass-through (no provider wired) so a misconfigured
  // deployment is visible in the logs instead of quietly auto-merging without checking CI.
  warnUnwiredGates(logger)

  const dependencies: CoreDependencies = {
    ...releaseHealthDeps,
    ...incidentEnrichmentDeps,
    // App-owned backend registries (kind → provider) the connection services resolve through.
    environmentBackendRegistry,
    runnerBackendRegistry,
    // The code-defined custom provision-type catalog, merged with the workspace rows by
    // `listCustomTypes` so a programmatically-registered type surfaces in the infra editor + the
    // per-service provisioning picker.
    customManifestTypeRegistry,
    ...(accountSettings ? { accountSettings } : {}),
    // Resolves the per-account binary-artifact store (screenshots) for the visual-confirmation
    // gate; resolving to null (no storage configured) ⇒ the gate passes through.
    resolveBinaryArtifactStore,
    workspaceRepository: repos.workspaceRepository,
    accountRepository: repos.accountRepository,
    membershipRepository: repos.membershipRepository,
    userRepository: repos.userRepository,
    passwordHasher: new WebCryptoPasswordHasher(),
    blockRepository: repos.blockRepository,
    pipelineRepository: repos.pipelineRepository,
    executionRepository: repos.executionRepository,
    // Clear a finished run's personal-credential activation promptly (TTL sweep is the backstop).
    // Its eventual mothership-mode home is the local-sqlite credential bucket (the activation
    // re-seals the token for the run); until that lands it routes to the remote registry like the
    // other org stores, so a no-db build doesn't `TypeError` — `deleteByExecution` is not yet
    // allow-listed, so it returns a clean `unknown_method` there (see the per-repo checklist).
    subscriptionActivationRepository: sourced(
      'subscriptionActivationRepository',
      (d) => new DrizzleSubscriptionActivationRepository(d),
    ),
    // In-org shared services. When a realtime hub is wired (start()), the engine's
    // event publisher (composed above) is a `FanOutEventPublisher` over these two repos,
    // so a shared service's live events reach every board that mounts it — parity with
    // the Cloudflare facade. Without a hub (createServer/tests) the engine uses its
    // NoopEventPublisher and nothing is pushed.
    serviceRepository: repos.serviceRepository,
    workspaceMountRepository: repos.workspaceMountRepository,
    tokenUsageRepository: repos.tokenUsageRepository,
    llmCallMetricRepository: repos.llmCallMetricRepository,
    // Unified provisioning event log (its own Postgres schema). Threads the recorder
    // into the env services and exposes the read service for the logs controller.
    provisioningLogRepository: repos.provisioningLogRepository,
    recordLlmPrompts: config.observability.recordPrompts,
    // Re-exposed on the core for the agent-context read endpoint; the same instance
    // is injected into the container executor above for the write path.
    agentContextObservability,
    // Opt-in Langfuse trace sink (fans every recorded LLM call out as a generation).
    // Built only when configured; otherwise undefined and there is no external emission.
    llmTraceSink: buildLangfuseSink(config),
    modelPresetRepository: repos.modelPresetRepository,
    serviceFragmentDefaultsRepository: repos.serviceFragmentDefaultsRepository,
    // Requirements-review feature (stateless reviewer + the requirements-rework
    // step). Wired identically to the Cloudflare facade's `selectRequirementsDeps`
    // so both runtimes serve the review/rework API AND substitute a block's reworked
    // requirements into the agent context (the cross-runtime conformance suite asserts
    // the substitution against both stores). The reviewer's model resolves exactly
    // like a pipeline step: block-pin > workspace per-kind default > routing default
    // (which falls back to Cloudflare Workers AI unless a direct key is set).
    requirementReviewRepository: repos.requirementReviewRepository,
    // Kaizen agent (post-run grading). Wired unconditionally, mirroring the Cloudflare
    // facade, so the engine schedules gradings at run completion and the background sweep
    // runs them. The grader resolves its model for the `kaizen` kind exactly like a step.
    kaizenGradingRepository: repos.kaizenGradingRepository,
    kaizenVerifiedComboRepository: repos.kaizenVerifiedComboRepository,
    clarityReviewRepository: repos.clarityReviewRepository,
    brainstormSessionRepository: repos.brainstormSessionRepository,
    // Merge threshold presets: the per-workspace auto-merge ceiling library a task's
    // merge gate resolves (block-pinned preset > workspace default). Wired
    // unconditionally, exactly like the Worker's `selectMergeLifecycleDeps`, so the
    // preset CRUD API + the merger step's threshold resolution work identically.
    mergePresetRepository: repos.mergePresetRepository,
    // Sandbox (parallel prompt/model testing) — contributed as one sandbox-owned mixin,
    // symmetric with the Worker's `...selectSandboxDeps(db)`; the run-driver reuses the
    // reviewer model config below. The container body never enumerates the five repos.
    ...createDrizzleSandboxDeps(db),
    // Per-workspace runtime settings (human-wait escalation threshold + per-service task
    // limit). Wired unconditionally so the settings API + the limit enforcement + the
    // escalation sweep work identically to the Worker.
    workspaceSettingsRepository: repos.workspaceSettingsRepository,
    modelProviderResolver,
    requirementReviewModel: config.agents.routing.default.ref,
    requirementReviewResolveModel: config.agents.resolveBlockModel,
    // Notifications subsystem (parity with the Worker, which wires it unconditionally):
    // the inbox + the human-action surfaces. Node has no real-time push, so the rows
    // persist (inbox + snapshot) and any channel composed below — e.g. Slack — delivers.
    notificationRepository: sourced(
      'notificationRepository',
      (d) => new DrizzleNotificationRepository(d),
    ),
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
            resolveLinearConnection: async (workspaceId) => {
              const connection = await tasks.taskConnectionRepository!.getByWorkspace(
                workspaceId,
                'linear',
              )
              const { apiKey, token } = connection?.credentials ?? {}
              return apiKey || token ? { apiKey, token } : null
            },
          }
        : {}),
    }),
    issueWritebackProvider,
    idGenerator,
    clock,
    agentExecutor,
    spendPricing: config.spend,
    // Price metered dynamic OpenRouter models at their real per-model rate (not the
    // bare-`openrouter` fallback) using this workspace's enabled catalog.
    dynamicModelPricesFor: openRouterCatalog
      ? (ws) => openRouterCatalog.capabilitiesFor(ws)
      : undefined,
    // The runner-pool integration assembles when enabled, so a workspace can
    // register the self-hosted pool its container agents dispatch to.
    ...(config.runners.enabled && config.runners.encryptionKey
      ? {
          runnerPoolConnectionRepository,
          runnerSecretCipher: new WebCryptoSecretCipher({
            masterKeyBase64: config.runners.encryptionKey,
            info: RUNNERS_CIPHER_INFO,
          }),
          // The pool provider instance backs the connection service's describeProvider +
          // testConnection (the manifest editor's secret-key form + a pre-save probe). An
          // injected native adapter wins here too (same instance that drives dispatch), so
          // its describeConfig/testConnection render — else the generic manifest provider
          // (same SSRF policy as the dispatch transport).
          runnerPoolProvider:
            options.runnerPoolProvider ??
            new HttpRunnerPoolProvider(runnerUrlPolicy ? { urlPolicy: runnerUrlPolicy } : {}),
          // Node (and local) has undici, so it can verify a private CA / skip TLS for a
          // Kubernetes apiserver — accept such a config at registration.
          runnerCustomTlsSupported: true,
          ...(runnerUrlPolicy ? { runnerUrlSafetyPolicy: runnerUrlPolicy } : {}),
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
          // The durable env-config-repair driver (analogue of the Worker's
          // EnvConfigRepairWorkflow): start enqueues a drive job that polls the run to terminal.
          envConfigRepairRunner: new PgBossEnvConfigRepairRunner(
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
    referenceArchitectureRepository: sourced(
      'referenceArchitectureRepository',
      (d) => new DrizzleReferenceArchitectureRepository(d),
    ),
    bootstrapJobRepository,
    ...(repoBootstrapper ? { repoBootstrapper } : {}),
    // Env-config-repair runs share the unified agent_runs table (kind-scoped). The job
    // repository is wired unconditionally; the repairer (agent fallback) is wired
    // post-overrides below over the FINAL provider, and the durable runner in the
    // `options.boss` block above — parity with the Worker's EnvConfigRepairWorkflow.
    envConfigRepairJobRepository: sourced(
      'envConfigRepairJobRepository',
      (d) => new DrizzleEnvConfigRepairJobRepository(d),
    ),
    // Document sources (Confluence / Notion / GitHub docs): wired from the shared
    // integration providers exactly like the Worker, so a workspace can connect a
    // source and import requirement/PRD/RFC pages as agent context.
    ...selectNodeDocumentsDeps(config, db, githubClient, githubInstallationRepository),
    // Ephemeral environments (opt-in): a workspace registers its own environment
    // management API; the tester provisions/destroys per-run environments from it. A
    // trusted in-house adapter can replace the default HTTP provider via the seam.
    // The environment integration scopes its own URL/host policy from
    // `config.environments` inside this selector (separate from the runner pool's).
    ...selectNodeEnvironmentsDeps(config, db),
    // The async container-backed Kubernetes deploy lifecycle (deployJobClient +
    // resolveDeployCloneTarget) — pool-backed by default, overridable by the local facade.
    ...deployDeps,
    // Prompt-fragment library (ADR 0006; opt-in): the managed tenant-scoped catalog
    // of best-practice fragments feeding every agent run, wired exactly like the
    // Worker's selectFragmentLibraryDeps (repos + installation resolver + selector).
    ...selectNodeFragmentLibraryDeps(
      config,
      env,
      db,
      githubClient,
      githubInstallationRepository,
      modelProviderResolver,
    ),
    // Slack: an extra notification transport (the channel) + its management module.
    // Default-off; when enabled its channel is composed into `notificationChannel` below
    // alongside the in-app push, identically to the Worker.
    ...slackDeps,
    // Account invitations + per-account email senders (UI-onboarded, DB-stored).
    ...selectNodeEmailInvitationDeps(config, repos),
    // The pipeline-start guard resolves what's configured for a workspace + initiator.
    resolveProviderCapabilities: (workspaceId, initiatedBy) =>
      resolveWorkspaceCapabilities(
        {
          apiKeys,
          subscriptions,
          personalSubscriptions,
          cloudflareModelsEnabled,
          baseUrlFor: (provider) => baseUrlForNode(provider, env),
          localModelEndpoints,
          openRouterCatalog,
        },
        workspaceId,
        initiatedBy,
      ),
    // Real-time push (when a hub is wired) + the composed notification channel (in-app
    // push + Slack). These come AFTER the spreads so the composite replaces the bare
    // Slack channel `slackDeps` set; both are absent (no override) when nothing is wired.
    ...(executionEventPublisher ? { executionEventPublisher } : {}),
    ...(notificationChannel ? { notificationChannel } : {}),
    // Run the engine's gate-probe / merge GitHub reads under the run initiator's ambient
    // context, so a per-user PAT (when set) is preferred over the App/env token.
    runInitiatorScope: runWithInitiator,
    ...options.overrides,
  }

  // Wire the live env-config repair agent over the FINAL environment provider (after the
  // `...options.overrides` above), so an injected native adapter — not the default manifest
  // provider — is what the repair dispatcher uses. Unwired on a stock deployment (the
  // generic provider has no `describeRepairAgent`), exactly like the service guard. Local
  // inherits this through `buildNodeContainer` with no extra wiring.
  const envConfigRepairer = selectNodeEnvConfigRepairer({
    env,
    config,
    resolveTransport,
    installationRepository: githubInstallationRepository,
    mintInstallationToken: bootstrapMintInstallationToken,
    override: dependencies.environmentProvider,
    environmentBackendRegistry,
  })
  // Don't clobber an override-provided repairer (e.g. the conformance suite's fake): an
  // explicit `overrides.envConfigRepairer` wins, exactly like `repoBootstrapper`.
  if (envConfigRepairer && !dependencies.envConfigRepairer) {
    dependencies.envConfigRepairer = envConfigRepairer
  }

  // Mothership mode (`db` undefined): `AgentContextBuilder` reads a block's linked docs/tasks
  // (`documentRepository`/`taskRepository`.listByBlock/get) on EVERY container agent dispatch, so
  // these are on the board-load + run path even though the document/task INTEGRATIONS are opt-in.
  // The sub-helpers above (`selectNodeDocumentsDeps`/`selectNodeTasksDeps`) build them directly
  // over the absent `db`, so re-source the context-builder run-path repos from the remote registry —
  // the connection/provider surfaces they also build stay db-direct (off the run path; a later
  // integration slice remotes them). Routing is orthogonal to the allow-list: an un-allow-listed
  // remote method returns a clean `unknown_method`, never a `db`-undefined `TypeError`.
  if (remoteRepos) {
    dependencies.documentRepository =
      remoteRepos.documentRepository as CoreDependencies['documentRepository']
    dependencies.taskRepository = remoteRepos.taskRepository as CoreDependencies['taskRepository']
    // The context builder also resolves the block's live environment per step
    // (`environmentProvisioning.resolveForBlock` → `environmentRegistryRepository.getByBlock`,
    // null when no env is provisioned — the common path). Route both environment repos so the
    // service `createCore` builds reads org state remotely. NOTE: a remotely-stored env access
    // cipher is sealed with the mothership's key, which never reaches the laptop, so actually
    // DECRYPTING a provisioned env's creds locally is a later (secrets-delegation) slice — only
    // the non-secret block→env mapping read is on the basic run path here.
    dependencies.environmentRegistryRepository =
      remoteRepos.environmentRegistryRepository as CoreDependencies['environmentRegistryRepository']
    dependencies.environmentConnectionRepository =
      remoteRepos.environmentConnectionRepository as CoreDependencies['environmentConnectionRepository']
  }

  return {
    ...createCore(dependencies),
    config,
    // The same checkout-free repo resolver the engine binds pre/post-ops with, surfaced so
    // the shared service-spec read controller can read the `spec/` artifact off main.
    resolveRunRepoContext: dependencies.resolveRunRepoContext,
    // The block→service→repo resolver, surfaced so the task-search controller can scope a
    // GitHub-issue search to the originating service's repo (and refuse it when unlinked).
    resolveRepoTarget,
    agentRunRepository: repos.agentRunRepository,
    // Execution-scoped repo, surfaced for the conformance suite's compareAndSwap parity check.
    executionRepository: repos.executionRepository,
    // The repository registry the mothership-mode machine API (`/internal/persistence`) reflects
    // over, so a Node deployment can act as a mothership for mothership-mode local nodes. The
    // controller gates which repo+method is callable (allow-list) and account-scopes each call;
    // exposing the whole `dependencies` (which carries every repo under its canonical name) is
    // safe. `agentRunRepository` is the one repo NOT part of `CoreDependencies` (the engine's
    // Core never reads it — it's surfaced separately above for `AgentRunController`), so fold it
    // in explicitly, else the board's retry/stop `getRef` call comes back `... is not wired`.
    // Sourced identically on both facades so they attach the same registry surface.
    repositories: {
      ...dependencies,
      agentRunRepository: repos.agentRunRepository,
    } as unknown as PersistenceRegistry,
    // App-owned backend registries, surfaced so the workspace snapshot's backend-kind
    // selectors (`environmentBackendKinds` / `runnerBackendKinds`) read the registered kinds.
    environmentBackendRegistry,
    runnerBackendRegistry,
    // The consensus transcript store, for the read endpoint (window load / reload).
    consensusSessionRepository: repos.consensusSessionRepository,
    // Resolves the per-account binary-artifact store (screenshots) for the artifact
    // controllers + the visual-confirmation gate (configured per-account in the UI).
    resolveBinaryArtifactStore,
    // Stock/remote Node has NO built-in container runtime, so container agents run ONLY on a
    // self-hosted runner pool — an unregistered pool means no agent can run, which the infra-setup
    // banner should surface. Local mode injects its own per-run-host-container `resolveTransport`
    // (so the pool is optional there); detect that by the absence of the default pool transport.
    agentExecutorRequiresRunnerPool: options.resolveTransport === undefined,
    gateways: createNodeGateways(env),
    // Source-control PAT login: lets a user sign in with their own GitHub/GitLab PAT via
    // `/auth/pat`, held to the server's login/org/domain allowlist. Local mode overrides this
    // (via its container spread) with a configured-token, allowlist-exempt registry.
    vcsIdentity: buildNodeVcsIdentityRegistry(config),
    // The vendor-credential (subscription token pool) service the shared controller
    // reads; present when the shared ENCRYPTION_KEY is configured.
    subscriptions,
    // The per-user individual-usage subscription store (Claude); present when the
    // shared ENCRYPTION_KEY is configured.
    personalSubscriptions,
    // The direct-provider API-key pool (account/workspace/user); present when the
    // shared ENCRYPTION_KEY is configured.
    apiKeys,
    // Whether the opt-in Cloudflare Workers AI lib is enabled (REST creds present).
    cloudflareModelsEnabled,
    // The direct-provider base-URL resolver the catalog uses to gate selectability on a
    // resolvable endpoint (e.g. LiteLLM stays unselectable until LITELLM_BASE_URL is set).
    baseUrlFor: (provider) => baseUrlForNode(provider, env),
    // The per-user locally-run model endpoints store; present when ENCRYPTION_KEY is set.
    localModelEndpoints,
    // The per-user generic secret store (GitHub PAT, …); present when ENCRYPTION_KEY is set.
    userSecrets,
    // The per-workspace OpenRouter dynamic-catalog store; present when the API-key pool is.
    openRouterCatalog,
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
  githubClient: GitHubClient | undefined,
  installations: GitHubInstallationRepository,
): { deps: Partial<CoreDependencies>; taskConnectionRepository?: TaskConnectionRepository } {
  if (!config.tasks.enabled || !config.tasks.encryptionKey) return { deps: {} }
  // Jira and Linear are always registered (their credentials are per-workspace, entered in the UI).
  const providers: TaskSourceProvider[] = [new JiraProvider(), new LinearTaskProvider()]
  // GitHub Issues reuse the workspace's installed GitHub App, so this provider is
  // wired whenever a GitHub client is available (the App is configured) — it has no
  // credentials of its own and resolves the installation per issue. Mirrors the
  // Cloudflare facade's `config.github.enabled` gate (see CLAUDE.md parity rule).
  // Whether a workspace OFFERS a source is the per-workspace toggle
  // (task_source_settings), not a deployment env gate.
  if (githubClient) {
    providers.push(new GitHubIssuesProvider({ githubClient, installations }))
  }

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
      taskSourceSettingsRepository: new DrizzleTaskSourceSettingsRepository(db),
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
  // Figma + Zeplin authenticate with a per-workspace PAT (no GitHub client needed), like
  // Notion/Confluence.
  if (config.documents.sources.includes('figma')) providers.push(new FigmaProvider())
  if (config.documents.sources.includes('zeplin')) providers.push(new ZeplinProvider())
  if (config.documents.sources.includes('linear')) providers.push(new LinearDocumentProvider())
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
 * mirroring the Worker's `selectEnvironmentsDeps`: the Drizzle connection + registry repos
 * and the environment-scoped `SecretCipher`. The provider itself is resolved per-workspace
 * from the env-backend registry by the stored `kind` (built-in `manifest`/`kubernetes`, or a
 * deployment's programmatically-registered custom kind), so nothing is injected here.
 * Per-tenant management-API secrets are encrypted at rest with the shared ENCRYPTION_KEY.
 * Disabled → `{}` and the module stays off.
 */
function selectNodeEnvironmentsDeps(config: AppConfig, db: DrizzleDb): Partial<CoreDependencies> {
  if (!config.environments.enabled || !config.environments.encryptionKey) return {}
  // The provider is resolved per-workspace from the env-backend registry by the stored
  // `kind`. Node honors custom-CA / insecure-skip TLS (undici), so a Kubernetes env config
  // with a CA is allowed (environmentCustomTlsSupported defaults to supported).
  const urlPolicy = resolveUrlSafetyPolicy(config.environments)
  return {
    environmentConnectionRepository: new DrizzleEnvironmentConnectionRepository(db),
    environmentRegistryRepository: new DrizzleEnvironmentRegistryRepository(db),
    // The workspace-defined custom-manifest-type catalog is a workspace feature on every facade.
    customManifestTypeRepository: new DrizzleCustomManifestTypeRepository(db),
    secretCipher: new WebCryptoSecretCipher({
      masterKeyBase64: config.environments.encryptionKey,
    }),
    ...(urlPolicy ? { environmentUrlSafetyPolicy: urlPolicy } : {}),
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
  modelProviderResolver: ModelProviderResolver,
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
            modelProviderResolver,
            modelRef: config.agents.routing.default.ref,
          }),
        }
      : {}),
  }
}
