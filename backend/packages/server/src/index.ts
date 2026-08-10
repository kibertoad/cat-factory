// @cat-factory/server — the runtime-neutral HTTP layer shared by every deployment
// facade. This first slice hosts the cross-cutting primitives (logging, request
// helpers, validation envelope, error mapping, CORS policy); the controllers,
// middleware and the Hono app factory move here in subsequent steps.
export {
  createPinoLogger,
  logger,
  noopLogger,
  getLogLevel,
  getLogSink,
  parseLogLevel,
  setLogLevel,
  setLogSink,
  type LogFields,
  type LogLevel,
  type LogSink,
  type LogThreshold,
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
export { SPEND_ALERT_INTERVAL_MS, sweepSpendAlerts } from './runtime/spendAlerts.js'
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
export { authController } from './modules/auth/AuthController.js'
// The shared browser-login mechanics (the allow-listed post-login redirect, the session mint),
// used by every redirecting provider and by the local mothership-connect controller.
export { mintSession, pickPostLoginRedirect } from './modules/auth/loginFlow.js'
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
  jobTokenRepoIds,
} from './agents/ContainerAgentExecutor.js'
// The one place a facade decides WHOSE token a dispatch carries and HOW WIDE it is minted.
export {
  buildDispatchTokenMint,
  type DispatchTokenMintDependencies,
} from './agents/dispatchTokenMint.js'
export { ensureWorkBranchViaRest, type EnsureWorkBranchInput } from './github/ensureWorkBranch.js'
// The clone origin a dispatch falls back to when a facade wires no `resolveRepoOrigin`. Exported
// so a facade whose OWN resolver handles only the non-GitHub case can delegate the GitHub half
// here instead of restating the URL, which would drift the moment this default learns anything.
export { githubRepoOrigin } from './agents/containerAgentBody.js'
// The backend half of the harness filesystem contract, exported so the harness's conformity
// suite can pin it against the harness's own independently-computed copy.
export {
  HARNESS_SENTINEL_PATHS,
  checkoutDirDigest,
  safeDirSegment,
  siblingCheckoutDir,
} from './agents/harnessContract.js'
export { RunnerJobClient, type ResolveRunnerTransport } from './agents/RunnerJobClient.js'
// Tool servers (MCP) for a container dispatch: the resolution the executor runs, plus the
// deployment-environment credential resolver every facade wires as the FALLBACK behind the
// per-workspace store.
export {
  type EnvToolSecretResolverOptions,
  type McpServerJobSpec,
  type ResolvedToolServers,
  createEnvToolSecretResolver,
  resolveToolServers,
  stepToolServerRecord,
} from './agents/toolServers.js'
// The per-workspace capability-credential resolver and the per-KEY composition that puts it in
// front of the environment one. See `capabilityCredentialResolver.ts` for why an environment
// variable is a single-tenant answer, and why the fallback is a real mechanism rather than a shim.
// `buildToolSecretChain` is the ONE composition site: a facade calls it and gets both the resolver
// its dispatch path asks and the description its credential checklist renders, so the two cannot
// disagree about whether an unstored key still resolves.
export {
  buildToolSecretChain,
  createWorkspaceToolSecretResolver,
  composeToolSecretResolvers,
  toolSecretContainerFields,
  type ToolSecretChain,
  type ToolSecretChainInput,
  type ToolSecretContainerFields,
  type WorkspaceToolSecretResolverOptions,
} from './agents/capabilityCredentialResolver.js'
// The OAuth half of the same seam: the kernel `McpOAuthTokenSource` a facade wires, joining the
// sealed per-workspace grant store to the credential chain above (which resolves the OAuth client
// secret). Every facade builds it beside `buildToolSecretChain`, so a deployment with a grant
// store dispatches with a live token and one without states the server as `oauth_not_connected`.
// The SERVING side of MCP authorization: this deployment as the authorization server for its own
// hosted MCP endpoint. Projected as a container field by both facades, present only where a
// deployment can actually complete the flow (an ENCRYPTION_KEY to seal what it carries, and the
// public-API key store, which is what a completed flow issues).
export {
  mcpAuthServerContainerFields,
  type McpAuthServerContainerFields,
} from './modules/mcpAuthServer/containerFields.js'
export {
  createMcpOAuthTokenSource,
  mcpOAuthContainerFields,
  mcpOAuthExecutorDeps,
  type McpOAuthContainerFields,
  type McpOAuthTokenSourceOptions,
} from './agents/mcpOAuthTokenSource.js'
export {
  resolveOAuthClientSecret,
  type OAuthClientSecretResolution,
  type ResolveOAuthClientSecretInput,
} from './agents/mcpOAuthClientSecret.js'
export {
  MCP_OAUTH_CALLBACK_PATH,
  requireMcpOAuthRedirectUrl,
} from './modules/toolServers/mcpOAuthRedirect.js'
export {
  buildCapabilityCredentialsView,
  collectDeclaredCapabilityCredentials,
  type DeclaredCapabilityCredential,
  type DeclaredCapabilityCredentials,
} from './modules/capabilityCredentials/declaredCredentials.js'
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
export { bedrockAllowListFromEnv, bedrockRegionFromEnv, type BedrockEnv } from './agents/bedrock.js'
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
  buildListWorkspaceRunRepos,
  type ResolveRepoTargetDependencies,
  type ResolveRepoTargetsDependencies,
  type ResolveRepoTargets,
  type ResolvedRepoTargets,
  type RepoCheckout,
  type ListWorkspaceRunRepos,
  type ListWorkspaceRunReposDependencies,
  type WorkspaceRunRepo,
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
// The routed half of delivery (the notification manager + the per-channel gate + the email
// channel), built once here so both facades wire it identically.
export {
  buildNotificationDelivery,
  type NotificationDeliveryInput,
  type NotificationDeliverySupport,
} from './notifications/notificationDelivery.js'
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
  MACHINE_SUBSCRIBE_ERROR_CODE,
  type MachineSubscribeRefusalStatus,
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
export {
  MAX_TELEMETRY_READ_CHARS,
  MAX_TELEMETRY_READ_ROW_CHARS,
  TELEMETRY_READ_METHODS,
  TELEMETRY_READ_PAGE_SIZES,
  TELEMETRY_READ_TOO_LARGE_CODE,
  type HttpMachineTelemetryReadClientOptions,
  type MachineTelemetryReadClient,
  type TelemetryReadBound,
  type TelemetryReadRepository,
  type TelemetryReadRequest,
  type TelemetryReadResponse,
  type TelemetryReadResults,
  HttpMachineTelemetryReadClient,
  MachineTokenUnavailableForReadError,
  TelemetryReadTooLargeError,
  telemetryReadBodyCap,
} from './telemetry/machineTelemetryRead.js'
export { mountAuthGate } from './http/authGate.js'
export {
  REQUEST_ID_HEADER,
  mountRequestLogging,
  requestIdOf,
  requestLogger,
  resolveRequestId,
} from './http/requestLogging.js'
export { param } from './http/params.js'
// Client-address resolution for the password throttle. Each facade owns WHICH header is
// authentic on its topology; this is the shared parse/normalisation half (SEC-4).
export {
  forwardedClientAddress,
  normalizeClientAddress,
  resolveTrustedProxyHops,
} from './http/clientAddress.js'
export { assertCapability, assertUser, requireCapability, requireUser } from './http/guards.js'
export { handleError } from './http/errorHandler.js'
export {
  CORS_ALLOWED_HEADERS,
  CORS_EXPOSED_HEADERS,
  corsOriginFor,
  corsReflectsWhenUnset,
  isPubliclyReadablePath,
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
export { DOCS, ENV_VARS_ANCHORS, SITE_DOCS, repoDocUrl } from './config/docs.js'
export {
  parseNumericEnv,
  describeRejectedNumericEnv,
  parseTimerEnvMs,
  MAX_TIMER_DELAY_MS,
  type TimerEnvParse,
} from './config/numeric.js'
export {
  parseConfigDuration,
  resolveDurationEnv,
  type ConfigDuration,
  type DurationParse,
} from './config/duration.js'
export {
  DEFAULT_ADVANCE_TIMEOUT,
  DEFAULT_CI_POLL_INTERVAL,
  DEFAULT_DECISION_TIMEOUT,
  DEFAULT_JOB_POLL_INTERVAL,
} from './config/executionDurations.js'
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
  providerRoutingGitHubClient,
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
  OtelLogsConfig,
  InfraReachabilityConfig,
  PlatformAlertConfig,
  PrivilegedAppConfig,
  RetentionConfig,
  RunnerPoolConfig,
  SlackConfig,
  SsoConfig,
  TasksConfig,
} from './config/types.js'
// Enterprise SSO (generic OIDC): the shared env resolver both facades call, and the pieces a
// facade or a test needs to reach the flow without going through the HTTP routes.
export { resolveSsoConfig, type SsoEnv } from './config/sso.js'
export { OidcProviderDirectory, readProviderMetadata } from './auth/oidc/discovery.js'
export { OidcClient, OidcFlowError, createPkcePair, type PkcePair } from './auth/oidc/OidcClient.js'
export {
  judgeSsoAdmission,
  needsUserinfo,
  readGroupClaim,
  readSsoIdentity,
  type SsoAdmission,
  type SsoIdentity,
} from './auth/oidc/claims.js'
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
// The browser-facing host of each provider's configured instance, stamped onto every VCS
// connection + connect option so the SPA links to the instance a workspace is actually bound to.
export { resolveVcsWebUrls } from './config/vcsWebUrls.js'
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
export { HttpPromptFragmentSource } from './persistence/promptFragments.js'
// The mothership-mode reader for DEPLOYMENT-scoped documents: the credentials stay on the
// mothership, so a node reads the resolved BODY.
export { HttpDeploymentDocumentResolver } from './persistence/deploymentDocuments.js'
export { documentBodyRefKey } from './modules/promptFragments/PromptFragmentsInternalController.js'
// The deployment's generative binary integrations, read from the mothership for the same reason:
// the set a run resolves against must be the set the picker offered, and a node's own build can
// only hold a second copy of it.
export { HttpBinaryGeneratorSource } from './persistence/binaryGenerators.js'
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

// Mothership-mode SECRET DELEGATION: the mothership opens (and seals) an ORG-owned credential a
// laptop holds no key for, addressed by ROW rather than by ciphertext. The closed source table is
// the server-side binding of kernel's `OrgSecretSource` vocabulary; the client is what a local
// facade composes into `createOrgSecretCipher`.
export {
  SEALED_SECRET_SOURCES,
  SEALED_SECRET_SOURCE_NAMES,
  sealedSecretSourceSpec,
  type SealedSecretSourceBinding,
  type SealedSecretSourceSpec,
} from './secrets/sealedSecretSources.js'
export {
  HttpSecretDelegate,
  MachineSecretDelegationUnavailableError,
  type HttpSecretDelegateOptions,
  type DelegatedSealRequest,
  type DelegatedSealResponse,
  type DelegatedUnsealRequest,
  type DelegatedUnsealResponse,
} from './persistence/secretDelegation.js'

// Per-account binary-artifact store resolution (the blob backend is configured per-account
// in the UI; each facade supplies its own backend factory + default).
export {
  makeResolveBinaryArtifactStore,
  withRegisteredBinaryStores,
  type MakeResolveBinaryArtifactStoreDeps,
  type BuildBlobBackend,
  type BuildBlobBackendOptions,
  type ContentStorageSettingsResolver,
} from './persistence/binaryArtifactStore.js'
