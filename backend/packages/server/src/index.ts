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
  createWebSearchUpstreamFromEnv,
  DEFAULT_WEB_SEARCH_COUNT,
} from './modules/webSearch/upstreams.js'
export { StateSigner, type InstallState } from './github/state.js'
export { GitHubOAuth, type GitHubOAuthDependencies } from './auth/GitHubOAuth.js'
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
  type MintInstallationToken,
} from './agents/ContainerAgentExecutor.js'
export { RunnerJobClient, type ResolveRunnerTransport } from './agents/RunnerJobClient.js'
export {
  buildResolveRepoTarget,
  type ResolveRepoTargetDependencies,
} from './agents/resolveRepoTarget.js'
export { bearerToken, requireAuth, verifySession } from './auth/middleware.js'
export { registerCoreControllers } from './app.js'
export { mountAuthGate } from './http/authGate.js'
export { param } from './http/params.js'
export { jsonBody } from './http/validation.js'
export { handleError } from './http/errorHandler.js'
export { parseAllowedOrigins, resolveCorsOrigin } from './http/cors.js'
export { base64url, base64urlToBytes, pkcs8PemToDer, timingSafeEqual } from './crypto/encoding.js'
// Runtime-neutral (Web Crypto) credential encryption + GitHub-App authentication,
// shared by both facades so the Node service can mint installation tokens and
// encrypt runner-pool secrets at rest exactly as the Worker does.
export {
  WebCryptoSecretCipher,
  type WebCryptoSecretCipherOptions,
} from './crypto/WebCryptoSecretCipher.js'
export { GitHubAppAuth, type GitHubAppAuthDependencies } from './github/GitHubAppAuth.js'
export {
  GitHubAppRegistry,
  type GitHubAppRegistryDependencies,
  type RegisteredApp,
} from './github/GitHubAppRegistry.js'
export {
  HmacSigner,
  TOKEN_AUDIENCE,
  type SessionPayload,
  type SessionUser,
  type TokenAudience,
} from './auth/signing.js'
export type {
  AgentsConfig,
  AppConfig,
  AuthConfig,
  DocumentsConfig,
  EnvironmentsConfig,
  ExecutionConfig,
  FragmentLibraryConfig,
  GitHubConfig,
  PrivilegedAppConfig,
  RetentionConfig,
  RunnerPoolConfig,
  TasksConfig,
} from './config/types.js'

// Row <-> domain mappers for the SQL persistence layer (shared by the D1 repos and
// the Drizzle/Postgres repos — both use the same column shapes).
export * from './persistence/mappers.js'
