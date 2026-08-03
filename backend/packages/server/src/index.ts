// @cat-factory/server — the runtime-neutral HTTP layer shared by every deployment
// facade. This first slice hosts the cross-cutting primitives (logging, request
// helpers, validation envelope, error mapping, CORS policy); the controllers,
// middleware and the Hono app factory move here in subsequent steps.
export {
  createPinoLogger,
  logger,
  noopLogger,
  getLogLevel,
  parseLogLevel,
  setLogLevel,
  type LogFields,
  type LogLevel,
  type Logger,
} from './observability/logger.js'
export { operationalMetrics } from './observability/operationalMetrics.js'
export {
  createSweepHealthTracker,
  sweepHealth,
  type SweepFailureStreak,
  type SweepHealthTracker,
} from './observability/sweepHealth.js'
export {
  type AppEnv,
  type GitHubTokenDelegation,
  type MothershipConnector,
  type ServerContainer,
} from './http/env.js'
export {
  type GitHubBackfillScheduler,
  type GitHubWebhookIngest,
  type LlmInProcessRequest,
  type LlmTokenUsage,
  type LlmUpstream,
  type LlmUpstreamEndpoint,
  type RealtimeGateway,
  type RuntimeGateways,
  type TrackerWebhookIngest,
  type WebSearchResponse,
  type WebSearchResult,
  type WebSearchUpstream,
} from './runtime/gateways.js'
export { InlineTrackerWebhookIngest } from './runtime/inlineTrackerWebhook.js'
export {
  BraveWebSearchUpstream,
  SearxngWebSearchUpstream,
  createWebSearchUpstream,
  createDefaultWebSearchUpstream,
  DEFAULT_WEB_SEARCH_COUNT,
} from './modules/webSearch/upstreams.js'
export { escalateStaleNotifications } from './runtime/escalateNotifications.js'
export { sweepPlatformHealth } from './runtime/platformHealth.js'
export { sweepInfraReachability } from './runtime/infraReachability.js'
export { sweepKeyDriftAndRaise } from './runtime/keyDrift.js'
// The shared autorefresh pass for repo-linked foundational-service sources — one implementation
// both facades drive (a Cloudflare cron tick, a Node interval sweeper).
export {
  FOUNDATIONAL_SOURCE_STALE_MS,
  FOUNDATIONAL_SOURCE_SWEEP_BATCH,
  sweepFoundationalSources,
} from './modules/foundationalServices/sweepFoundationalSources.js'
export { noRunnerBackendAvailableError } from './runtime/runnerBackendError.js'
export {
  GITHUB_RECONCILE_STALE_MS,
  reconcileStaleRepos,
  type GitHubReconcileDeps,
} from './runtime/reconcileStaleRepos.js'
export { StateSigner, type InstallState } from './github/state.js'
export {
  GitHubOAuth,
  type GitHubOAuthDependencies,
  type GitHubIdentity,
} from './auth/GitHubOAuth.js'
export {
  GoogleOAuth,
  type GoogleOAuthDependencies,
  type GoogleIdentity,
} from './auth/GoogleOAuth.js'
export { LinearOAuth, type LinearOAuthDependencies } from './auth/LinearOAuth.js'
export { WebCryptoPasswordHasher } from './crypto/WebCryptoPasswordHasher.js'
export { authController, pickPostLoginRedirect } from './modules/auth/AuthController.js'
export { llmProxyController } from './modules/llmProxy/LlmProxyController.js'
export {
  ContainerSessionService,
  DEFAULT_SESSION_TTL_MS,
  type ContainerSession,
  type MintInput,
} from './containers/ContainerSessionService.js'
// Runtime-neutral container-agent execution machinery, shared by both facades: the
// composite that routes repo-operating kinds to a sandbox, the container executor
// that builds + dispatches the harness job, and the backend-polymorphic job client.
export { CompositeAgentExecutor } from './agents/CompositeAgentExecutor.js'
export {
  ContainerAgentExecutor,
  type ContainerAgentExecutorDependencies,
  type RepoTarget,
  type ResolveRepoTarget,
  type RepoOrigin,
  type ResolveRepoOrigin,
  type MintInstallationToken,
  type EnsureWorkBranch,
  type JobPackageRegistrySpec,
} from './agents/ContainerAgentExecutor.js'
export { ensureWorkBranchViaRest, type EnsureWorkBranchInput } from './github/ensureWorkBranch.js'
export { RunnerJobClient, type ResolveRunnerTransport } from './agents/RunnerJobClient.js'
// Tool servers (MCP) for a container dispatch: the resolution the executor runs, plus the
// deployment-environment credential resolver both facades wire by default.
export {
  type EnvToolSecretResolverOptions,
  type McpServerJobSpec,
  type ResolvedToolServers,
  createEnvToolSecretResolver,
  resolveToolServers,
} from './agents/toolServers.js'
export {
  createScopedModelProviderResolver,
  // The individual instrumentation / limiter wraps are deliberately NOT exported: their
  // relative order is load-bearing and this composer is what fixes it.
  wrapResolverWithTelemetry,
  type InlineInstrumentation,
  type ResolverTelemetryWraps,
  type ScopedModelProviderOptions,
} from './agents/modelProviderResolver.js'
export {
  createInlineInstrumentation,
  type InlineInstrumentationOptions,
} from './agents/inlineInstrumentation.js'
export {
  resolveWorkspaceCapabilities,
  type CapabilityServices,
} from './agents/providerCapabilities.js'
export {
  ContainerRepoBootstrapper,
  type ContainerRepoBootstrapperDependencies,
} from './agents/ContainerRepoBootstrapper.js'
export {
  ContainerEnvConfigRepairer,
  type ContainerEnvConfigRepairerDependencies,
} from './agents/ContainerEnvConfigRepairer.js'
export {
  buildResolveRepoTarget,
  buildResolveRepoTargets,
  type ResolveRepoTargetDependencies,
  type ResolveRepoTargetsDependencies,
  type ResolveRepoTargets,
  type ResolvedRepoTargets,
  type RepoCheckout,
} from './agents/resolveRepoTarget.js'
// The checkout-free RepoFiles facade over the wired GitHubClient + the engine-facing
// run-repo resolver each facade threads into the core for a registered kind's pre/post-ops.
export {
  makeRepoFiles,
  makeResolveDeployCloneTarget,
  makeResolveRepoFiles,
  makeResolveRepoFilesForCoords,
  makeResolveRunRepoContext,
  runRepoOps,
} from './agents/repoFiles.js'
export {
  makePreviewJobBuilder,
  type PreviewJobBuilderDependencies,
} from './preview/previewJobBuilder.js'
export { bearerToken, requireAuth, verifySession } from './auth/middleware.js'
export { registerCoreControllers } from './app.js'
export {
  FanOutEventPublisher,
  type FanOutEventPublisherDependencies,
} from './events/FanOutEventPublisher.js'
export { InAppNotificationChannel } from './events/InAppNotificationChannel.js'
export {
  type MachineEventRelay,
  type MachineEventClient,
  type RelayedRealtimeEvent,
  HttpMachineEventClient,
} from './events/machineEvents.js'
// The INBOUND half of mothership real-time: the shared authorisation for a node's long-lived
// subscription to a workspace's stream. Exported because BOTH facades reach the handshake — the
// Worker through the shared controller, Node from its HTTP-server `upgrade` listener.
export {
  type AccountOfWorkspace,
  type MachineSubscribeAuth,
  MACHINE_EVENTS_SUBSCRIBE_PATH,
  MACHINE_EVENTS_SUBSCRIBE_PATTERN,
  authorizeMachineSubscribe,
  stripBearer,
} from './events/machineSubscribe.js'
// Mothership-mode notification DELIVERY delegation: the mothership re-reads a laptop-raised
// notification row and delivers it through the org's external channels (its Slack token never
// reaches the laptop); a mothership-mode local node plugs `RemoteNotificationChannel` into the
// engine's existing fan-out to ask for it.
export {
  type DelegatedNotificationRequest,
  type MachineNotificationClient,
  type HttpMachineNotificationClientOptions,
  type RemoteNotificationChannelOptions,
  HttpMachineNotificationClient,
  RemoteNotificationChannel,
} from './notifications/machineNotifications.js'
export {
  MAX_TELEMETRY_INGEST_CHARS,
  TELEMETRY_INGEST_LIMITS,
  type HttpMachineTelemetryClientOptions,
  type MachineTelemetryClient,
  type TelemetryIngestRequest,
  type TelemetryIngestResult,
  HttpMachineTelemetryClient,
  MachineTokenUnavailableError,
} from './telemetry/machineTelemetry.js'
export { mountAuthGate } from './http/authGate.js'
export {
  REQUEST_ID_HEADER,
  mountRequestLogging,
  requestIdOf,
  requestLogger,
  resolveRequestId,
} from './http/requestLogging.js'
export { param } from './http/params.js'
export { assertCapability, assertUser, requireCapability, requireUser } from './http/guards.js'
export { handleError } from './http/errorHandler.js'
export {
  CORS_ALLOWED_HEADERS,
  CORS_EXPOSED_HEADERS,
  corsReflectsWhenUnset,
  parseAllowedOrigins,
  resolveCorsOrigin,
} from './http/cors.js'
export {
  ConfigValidationError,
  isConfigValidationError,
  configProblem,
  missingIoredisProblem,
  formatConfigProblems,
  requireEnv,
  requireEncryptionKey,
  requireGitHubAppPrivateKey,
  MIN_ENCRYPTION_KEY_BYTES,
  ENV_HELP,
  type ConfigProblem,
} from './config/problems.js'
export { createMisconfiguredApp, buildMisconfiguredResponse } from './config/misconfiguredApp.js'
export { DOCS, ENV_VARS_ANCHORS, repoDocUrl } from './config/docs.js'
export {
  parseNumericEnv,
  describeRejectedNumericEnv,
  parseTimerEnvMs,
  MAX_TIMER_DELAY_MS,
  type TimerEnvParse,
} from './config/numeric.js'
export { base64url, base64urlToBytes, pkcs8PemToDer, timingSafeEqual } from './crypto/encoding.js'
// Runtime-neutral (Web Crypto) credential encryption + GitHub-App authentication,
// shared by both facades so the Node service can mint installation tokens and
// encrypt runner-pool secrets at rest exactly as the Worker does.
export {
  WebCryptoSecretCipher,
  type WebCryptoSecretCipherOptions,
} from './crypto/WebCryptoSecretCipher.js'
export { WebCryptoPersonalSecretCipher } from './crypto/WebCryptoPersonalSecretCipher.js'
// ADR 0026 D6.1 — master-key fingerprint + the boot-time drift check built on it.
export {
  computeKeyFingerprint,
  checkKeyFingerprint,
  type KeyFingerprintCheck,
} from './crypto/keyFingerprint.js'
// ADR 0026 D6.2 — the runtime-neutral drift sweep over the sealed-secret inventory.
export { sweepKeyDrift, hasKeyDrift, type KeyDriftReport } from './crypto/keyDriftSweep.js'
export {
  GitHubAppAuth,
  type GitHubAppAuthDependencies,
  explainInstallationTokenMintFailure,
} from './github/GitHubAppAuth.js'
export {
  GitHubAppRegistry,
  type GitHubAppRegistryDependencies,
  type RegisteredApp,
  type AppTokenSource,
} from './github/GitHubAppRegistry.js'
export {
  PatPreferringAppRegistry,
  type ResolveRunInitiatorToken,
} from './github/PatPreferringAppRegistry.js'
export { runWithInitiator, currentCredentialScope } from './github/runInitiatorContext.js'
export {
  createResolveRunInitiatorToken,
  type RunInitiatorTokenDependencies,
} from './github/runInitiatorToken.js'
// The runtime-neutral fetch-based GitHub client + the CI / merge / mergeability
// providers (shared by every facade so a facade can gate on real CI and merge for
// real). The client authenticates via the App registry or any AppTokenSource (e.g. a
// static PAT in local mode).
export {
  FetchGitHubClient,
  GitHubApiError,
  type FetchGitHubClientDependencies,
} from './github/FetchGitHubClient.js'
export {
  ProviderRoutingGitHubClient,
  type ProviderRoutingGitHubClientDependencies,
} from './github/ProviderRoutingGitHubClient.js'
export {
  GitHubIdentityResolver,
  type GitHubIdentityResolverOptions,
} from './github/GitHubIdentityResolver.js'
// The privileged provisioning slice (ADR 0005): runtime-neutral so every facade can
// back the create-repo endpoint when a privileged App is configured.
export {
  FetchGitHubProvisioningClient,
  type FetchGitHubProvisioningClientDependencies,
} from './github/FetchGitHubProvisioningClient.js'
export { WebCryptoWebhookVerifier } from './github/WebCryptoWebhookVerifier.js'
export {
  GitHubCiStatusProvider,
  type GitHubCiStatusProviderDependencies,
} from './github/GitHubCiStatusProvider.js'
export {
  GitHubDocQualityProvider,
  type GitHubDocQualityProviderDependencies,
} from './github/GitHubDocQualityProvider.js'
export {
  GitHubPullRequestReviewProvider,
  type GitHubPullRequestReviewProviderDependencies,
} from './github/GitHubPullRequestReviewProvider.js'
export {
  GitHubMergeabilityProvider,
  classifyMergeability,
  type GitHubMergeabilityProviderDependencies,
} from './github/GitHubMergeabilityProvider.js'
export {
  GitHubBranchUpdater,
  type GitHubBranchUpdaterDependencies,
} from './github/GitHubBranchUpdater.js'
export {
  GitHubPullRequestMerger,
  type GitHubPullRequestMergerDependencies,
} from './github/GitHubPullRequestMerger.js'
export {
  GitHubPrReportPublisher,
  type GitHubPrReportPublisherDependencies,
} from './github/GitHubPrReportPublisher.js'
export {
  HmacSigner,
  TOKEN_AUDIENCE,
  type MachinePayload,
  type SessionPayload,
  type SessionUser,
  type TokenAudience,
} from './auth/signing.js'
export {
  DEFAULT_MACHINE_TOKEN_TTL_MS,
  mintMachineToken,
  resolveMachineTokenTtlMs,
} from './auth/machineToken.js'
export {
  WS_TICKET_TTL_MS,
  authorizeWsUpgrade,
  mintWsTicket,
  type WsTicket,
  type WsUpgradeAuth,
} from './auth/wsTicket.js'
export type {
  AgentsConfig,
  AppConfig,
  AuthConfig,
  ReleaseHealthConfig,
  DocumentsConfig,
  EmailConfig,
  EnvironmentsConfig,
  ExecutionConfig,
  FragmentLibraryConfig,
  GitHubConfig,
  GitLabConfig,
  GoogleOAuthConfig,
  LangfuseConfig,
  ObservabilityConfig,
  NotificationWebhookConfig,
  OtelConfig,
  InfraReachabilityConfig,
  PlatformAlertConfig,
  PrivilegedAppConfig,
  RetentionConfig,
  RunnerPoolConfig,
  SlackConfig,
  TasksConfig,
} from './config/types.js'
export {
  parsePlatformObservabilityWindow,
  resolvePlatformAlertConfig,
  type PlatformAlertEnvInput,
} from './config/platformAlerts.js'
export {
  resolveInfraReachabilityConfig,
  shouldRunReachabilityPass,
  type InfraReachabilityEnvInput,
} from './config/infraReachability.js'
export { resolveUrlSafetyPolicy } from './config/url-safety.js'
export {
  parseDetectionConventions,
  type DetectionConventionsConfig,
} from './config/detection-conventions.js'
export {
  buildInfrastructureCapabilities,
  testEnvHasZeroConfigDefault,
} from './config/infrastructure.js'

// Row <-> domain mappers for the SQL persistence layer (shared by the D1 repos and
// the Drizzle/Postgres repos — both use the same column shapes).
export * from './persistence/mappers.js'
export * from './persistence/sandbox-mappers.js'
// Validate-on-read guards (enum/JSON) for the persistence boundary, shared by both facades'
// repositories so a corrupt stored value surfaces loudly instead of via an erased `as` cast.
export * from './persistence/decode.js'

// Mothership-mode persistence RPC: the wire protocol + method table + server dispatcher, and
// the client-side remote-repository proxy. A facade attaches its repository registry as
// `ServerContainer.repositories` to act as a mothership; a mothership-mode local node builds
// `createRemoteRepositoryRegistry` instead of a database-backed repo set.
export {
  type PersistenceRpcRequest,
  type PersistenceRpcResponse,
  type PersistenceRpcError,
  type PersistenceErrorCode,
  type PersistenceRegistry,
  type PersistenceMethodTable,
  type MethodSpec,
  type ScopeRule,
  type DispatchOptions,
  type DispatchResult,
  REMOTE_PERSISTENCE_METHODS,
  dispatchPersistenceCall,
  persistenceErrorToThrowable,
  statusForPersistenceError,
} from './persistence/rpc.js'
export {
  type PersistenceRpcClient,
  createRemoteRepositoryRegistry,
  HttpPersistenceRpcClient,
} from './persistence/remoteRepositories.js'
// The catalog's `builtin` tier, read from the mothership rather than from the node's own
// registry — the estate is org state, and a second copy in a node's build is only ever a
// drifting one. Its dedicated `/internal/*` endpoint is the server half.
export { HttpFoundationalBuiltinSource } from './persistence/foundationalBuiltins.js'
// The complement of the allow-list: the repositories a mothership-mode node serves from its OWN
// local store (the local-first telemetry bucket) rather than over the RPC. The local facade types
// its composition by this list so the bucket can never be half-wired.
export {
  LOCAL_FIRST_PERSISTENCE_REPOSITORIES,
  type LocalFirstPersistenceRepository,
} from './persistence/rpc-allowlist.js'
// Mothership-mode GitHub token delegation: the mothership mints short-lived installation
// tokens for a machine-authed node (`ServerContainer.githubTokenDelegation` serves it),
// and a mothership-mode local node consumes them through this AppTokenSource so the shared
// FetchGitHubClient (and the executor's push-token mint) run without a PAT or App key.
export {
  DelegatedAppTokenSource,
  type GitHubDelegationClientOptions,
} from './github/DelegatedAppTokenSource.js'

// Per-account binary-artifact store resolution (the blob backend is configured per-account
// in the UI; each facade supplies its own backend factory + default).
export {
  makeResolveBinaryArtifactStore,
  type MakeResolveBinaryArtifactStoreDeps,
  type BuildBlobBackend,
  type BuildBlobBackendOptions,
  type ContentStorageSettingsResolver,
} from './persistence/binaryArtifactStore.js'
