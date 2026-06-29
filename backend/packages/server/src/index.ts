// @cat-factory/server — the runtime-neutral HTTP layer shared by every deployment
// facade. This first slice hosts the cross-cutting primitives (logging, request
// helpers, validation envelope, error mapping, CORS policy); the controllers,
// middleware and the Hono app factory move here in subsequent steps.
export { logger, type Logger } from './observability/logger.js'
export { type AppEnv, type ServerContainer } from './http/env.js'
export {
  type GitHubBackfillScheduler,
  type GitHubWebhookIngest,
  type LlmInProcessRequest,
  type LlmTokenUsage,
  type LlmUpstream,
  type LlmUpstreamEndpoint,
  type RealtimeGateway,
  type RuntimeGateways,
  type WebSearchResponse,
  type WebSearchResult,
  type WebSearchUpstream,
} from './runtime/gateways.js'
export {
  BraveWebSearchUpstream,
  SearxngWebSearchUpstream,
  createWebSearchUpstream,
  DEFAULT_WEB_SEARCH_COUNT,
} from './modules/webSearch/upstreams.js'
export { escalateStaleNotifications } from './runtime/escalateNotifications.js'
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
} from './agents/ContainerAgentExecutor.js'
export { ensureWorkBranchViaRest, type EnsureWorkBranchInput } from './github/ensureWorkBranch.js'
export { RunnerJobClient, type ResolveRunnerTransport } from './agents/RunnerJobClient.js'
export {
  createScopedModelProviderResolver,
  type ScopedModelProviderOptions,
} from './agents/modelProviderResolver.js'
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
  type ResolveRepoTargetDependencies,
} from './agents/resolveRepoTarget.js'
// The checkout-free RepoFiles facade over the wired GitHubClient + the engine-facing
// run-repo resolver each facade threads into the core for a registered kind's pre/post-ops.
export {
  makeRepoFiles,
  makeResolveRepoFiles,
  makeResolveRepoFilesForCoords,
  makeResolveRunRepoContext,
  runRepoOps,
} from './agents/repoFiles.js'
export { bearerToken, requireAuth, verifySession } from './auth/middleware.js'
export { registerCoreControllers } from './app.js'
export {
  FanOutEventPublisher,
  type FanOutEventPublisherDependencies,
} from './events/FanOutEventPublisher.js'
export { InAppNotificationChannel } from './events/InAppNotificationChannel.js'
export { mountAuthGate } from './http/authGate.js'
export { param } from './http/params.js'
export { handleError } from './http/errorHandler.js'
export { CORS_ALLOWED_HEADERS, parseAllowedOrigins, resolveCorsOrigin } from './http/cors.js'
export { base64url, base64urlToBytes, pkcs8PemToDer, timingSafeEqual } from './crypto/encoding.js'
// Runtime-neutral (Web Crypto) credential encryption + GitHub-App authentication,
// shared by both facades so the Node service can mint installation tokens and
// encrypt runner-pool secrets at rest exactly as the Worker does.
export {
  WebCryptoSecretCipher,
  type WebCryptoSecretCipherOptions,
} from './crypto/WebCryptoSecretCipher.js'
export { WebCryptoPersonalSecretCipher } from './crypto/WebCryptoPersonalSecretCipher.js'
export { GitHubAppAuth, type GitHubAppAuthDependencies } from './github/GitHubAppAuth.js'
export {
  GitHubAppRegistry,
  type GitHubAppRegistryDependencies,
  type RegisteredApp,
  type AppTokenSource,
} from './github/GitHubAppRegistry.js'
export { PatPreferringAppRegistry } from './github/PatPreferringAppRegistry.js'
export { runWithInitiator, currentInitiator } from './github/runInitiatorContext.js'
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
  HmacSigner,
  TOKEN_AUDIENCE,
  type SessionPayload,
  type SessionUser,
  type TokenAudience,
} from './auth/signing.js'
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
  PrivilegedAppConfig,
  RetentionConfig,
  RunnerPoolConfig,
  SlackConfig,
  TasksConfig,
} from './config/types.js'
export { resolveUrlSafetyPolicy } from './config/url-safety.js'
export { buildInfrastructureCapabilities } from './config/infrastructure.js'

// Row <-> domain mappers for the SQL persistence layer (shared by the D1 repos and
// the Drizzle/Postgres repos — both use the same column shapes).
export * from './persistence/mappers.js'
export * from './persistence/sandbox-mappers.js'

// Per-account binary-artifact store resolution (the blob backend is configured per-account
// in the UI; each facade supplies its own backend factory + default).
export {
  makeResolveBinaryArtifactStore,
  type MakeResolveBinaryArtifactStoreDeps,
  type BuildBlobBackend,
  type BuildBlobBackendOptions,
  type ContentStorageSettingsResolver,
} from './persistence/binaryArtifactStore.js'
