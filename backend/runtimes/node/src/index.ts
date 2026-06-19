// @cat-factory/node-server — the Node.js runtime facade. Serves the shared
// @cat-factory/server Hono app via @hono/node-server, wiring Node implementations of
// the runtime ports over a Drizzle/Postgres persistence layer (the single store used
// in dev, test and prod). `start()` boots an HTTP server; `createServer()` returns the
// app (for embedding/tests); `buildNodeContainer()` is the composition root.
export { createServer, start, type CreateServerOptions } from './server.js'
export { buildNodeContainer, type NodeContainerOptions } from './container.js'
export { loadNodeConfig } from './config.js'
export { createNodeGateways } from './gateways.js'
export { createNodeModelProvider } from './modelProvider.js'
export { createDbClient, type DbClient, type DrizzleDb } from './db/client.js'
export { migrate } from './db/migrate.js'
export { createDrizzleRepositories, type CoreRepositories } from './repositories/drizzle.js'
export * as schema from './db/schema.js'
