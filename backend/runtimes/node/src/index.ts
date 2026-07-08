// @cat-factory/node-server — the Node.js runtime facade. Serves the shared
// @cat-factory/server Hono app via @hono/node-server, wiring Node implementations of
// the runtime ports over a Drizzle/Postgres persistence layer (the single store used
// in dev, test and prod). `start()` boots an HTTP server; `createServer()` returns the
// app (for embedding/tests); `buildNodeContainer()` is the composition root.
export {
  createApp,
  createServer,
  serveAppWithRealtime,
  serveMisconfigured,
  start,
  type CreateServerOptions,
} from './server.js'
// Real-time WebSocket transport pieces, re-exported so the local facade's mothership boot
// (which does NOT call `start()`, since there is no Postgres/pg-boss) can stand up the same
// per-workspace hub + `ws` upgrade listener the standard Node boot does.
export {
  NodeRealtimeHub,
  NodeEventPublisher,
  attachRealtime,
  type LocalEventSink,
} from './realtime.js'
// The layered cross-node real-time propagator (Redis today; more adapters later). A multi-node
// Node deployment sets REDIS_URL and every browser sees every event regardless of which node
// produced it; single-node / local mode wires none of this.
export {
  LayeredEventPropagator,
  buildRealtimePropagator,
  type RealtimeMessage,
  type WebSocketPropagator,
  type PropagatorLogger,
} from './propagator.js'
export {
  RedisWebSocketPropagator,
  DEFAULT_REALTIME_CHANNEL,
  type RedisWebSocketPropagatorOptions,
} from './redisPropagator.js'
export {
  buildNodeContainer,
  buildNodeResolveTransport,
  withProvisioningLog,
  type NodeContainerOptions,
} from './container.js'
export { loadNodeConfig } from './config.js'
// Re-exported so the local facade can pass a `cachesProfile` override to `start()` (it makes
// the repo projection pass-through — its `link-repo` CLI writes the projection out-of-process
// with no invalidation bus). It imports only from `@cat-factory/node-server`.
export { DEFAULT_APP_CACHES_PROFILE, type AppCachesProfile } from '@cat-factory/caching'
export { createNodeGateways } from './gateways.js'
export { createNodeModelProviderResolver } from './modelProvider.js'

// Installation-level extension point (mirroring the Worker facade): a deployment news a
// `defaultAgentKindRegistry()`, registers its own kinds on it by reference, and injects it
// through `buildNodeContainer`/`start()`'s `agentKindRegistry` option — the app-owned DI seam
// that replaces the old module-global `registerAgentKind` side effect. Bedrock-style model
// providers mix in via createNodeModelProvider.
export {
  AgentKindRegistry,
  defaultAgentKindRegistry,
  type AgentKindDefinition,
} from '@cat-factory/agents'
// Installation-level extension point for custom initiative presets (the same DI seam as agent
// kinds): a deployment news a `defaultInitiativePresetRegistry()`, registers its own presets on it
// by reference, and injects it through `buildNodeContainer`/`start()`'s `initiativePresetRegistry`
// option — replacing the old module-global `registerInitiativePreset` side effect.
export { defaultInitiativePresetRegistry } from '@cat-factory/agents'
export { InitiativePresetRegistry, type InitiativePresetRegistration } from '@cat-factory/kernel'
export { registerPipeline, registerPipelines, clearRegisteredPipelines } from '@cat-factory/kernel'
// The built-in model-preset ids + the catalog fallback default, re-exported so a deploy-app
// wrapper can name a preset when passing `start({ defaultModelPresetId })` without a direct
// `@cat-factory/kernel` import.
export { DEFAULT_MODEL_PRESET_ID, MODEL_PRESET_SEED_IDS } from '@cat-factory/kernel'
export { SystemClock, CryptoIdGenerator } from './runtime.js'
// Re-exported so the local facade can build its own provisioning-log recorder for the
// per-workspace transport chooser without taking a direct @cat-factory/integrations dep.
export { ProvisioningLogRecorder } from '@cat-factory/integrations'
export { createDbClient, type DbClient, type DrizzleDb } from './db/client.js'
export { migrate } from './db/migrate.js'
// Execution driver pieces, re-exported so the local facade's mothership boot (no pg-boss)
// can run the SAME advance/poll loop in-process with real timer-backed sleeps.
export { executionRuntime, type ExecutionRuntime } from './execution/config.js'
export { driveExecution, type DriveConfig, type DriveOutcome } from './execution/drive.js'
export {
  createDrizzleRepositories,
  type CoreRepositories,
  DrizzleLocalSettingsRepository,
  DrizzleWorkspaceSettingsRepository,
} from './repositories/drizzle.js'
export {
  DrizzleGitHubInstallationRepository,
  DrizzleRunnerPoolConnectionRepository,
} from './repositories/containerExecution.js'
export { DrizzleNotificationRepository } from './repositories/notifications.js'
export { DrizzleDocumentRepository } from './repositories/documents.js'
export { DrizzleDocInterviewRepository } from './repositories/drizzle.js'
export { DrizzleEnvironmentUserHandlerRepository } from './repositories/environmentUserHandler.js'
export * as schema from './db/schema.js'
export {
  FilesystemBinaryBlobBackend,
  DEFAULT_FILE_STORAGE_PATH,
} from './storage/FilesystemBinaryBlobBackend.js'
export { PostgresBinaryBlobBackend } from './storage/PostgresBinaryBlobBackend.js'
