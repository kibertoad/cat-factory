// @cat-factory/node-server — the Node.js runtime facade. Serves the shared
// @cat-factory/server Hono app via @hono/node-server, wiring Node implementations of
// the runtime ports over a Drizzle/Postgres persistence layer (the single store used
// in dev, test and prod). `start()` boots an HTTP server; `createServer()` returns the
// app (for embedding/tests); `buildNodeContainer()` is the composition root.
export { createApp, createServer, start, type CreateServerOptions } from './server.js'
export {
  buildNodeContainer,
  buildNodeResolveTransport,
  withProvisioningLog,
  type NodeContainerOptions,
} from './container.js'
export { loadNodeConfig } from './config.js'
export { createNodeGateways } from './gateways.js'
export { createNodeModelProviderResolver } from './modelProvider.js'

// Installation-level extension points (mirroring the Worker facade): a deployment —
// typically a proprietary org package — registers custom agent kinds and predefined
// pipelines at startup (before `start()`), and the shared prompt catalog / workspace
// seeding pick them up. Bedrock-style model providers mix in via createNodeModelProvider.
export {
  registerAgentKind,
  registerAgentKinds,
  clearRegisteredAgentKinds,
  type AgentKindDefinition,
} from '@cat-factory/agents'
export { registerPipeline, registerPipelines, clearRegisteredPipelines } from '@cat-factory/kernel'
export { SystemClock, CryptoIdGenerator } from './runtime.js'
// Re-exported so the local facade can build its own provisioning-log recorder for the
// per-workspace transport chooser without taking a direct @cat-factory/integrations dep.
export { ProvisioningLogRecorder } from '@cat-factory/integrations'
export { createDbClient, type DbClient, type DrizzleDb } from './db/client.js'
export { migrate } from './db/migrate.js'
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
export { DrizzleEnvironmentUserHandlerRepository } from './repositories/environmentUserHandler.js'
export * as schema from './db/schema.js'
export {
  FilesystemBinaryBlobBackend,
  DEFAULT_FILE_STORAGE_PATH,
} from './storage/FilesystemBinaryBlobBackend.js'
export { PostgresBinaryBlobBackend } from './storage/PostgresBinaryBlobBackend.js'
