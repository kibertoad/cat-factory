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
} from './runtime/gateways.js'
export { StateSigner, type InstallState } from './github/state.js'
export { GitHubOAuth, type GitHubOAuthDependencies } from './auth/GitHubOAuth.js'
export { authController, pickPostLoginRedirect } from './modules/auth/AuthController.js'
export {
  ContainerSessionService,
  DEFAULT_SESSION_TTL_MS,
  type ContainerSession,
  type MintInput,
} from './containers/ContainerSessionService.js'
export { bearerToken, requireAuth, verifySession } from './auth/middleware.js'
export { registerCoreControllers } from './app.js'
export { param } from './http/params.js'
export { jsonBody } from './http/validation.js'
export { handleError } from './http/errorHandler.js'
export { parseAllowedOrigins, resolveCorsOrigin } from './http/cors.js'
export { base64url, base64urlToBytes, pkcs8PemToDer, timingSafeEqual } from './crypto/encoding.js'
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
