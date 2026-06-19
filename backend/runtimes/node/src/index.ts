// @cat-factory/node-server — the Node.js runtime facade. Serves the shared
// @cat-factory/server Hono app via @hono/node-server, wiring Node implementations of
// the runtime ports. `start()` boots an HTTP server; `createServer()` returns the app
// (for embedding/tests); `buildNodeContainer()` is the composition root.
export { createServer, start, type CreateServerOptions } from './server.js'
export { buildNodeContainer, type NodeContainerOptions } from './container.js'
export { loadNodeConfig } from './config.js'
export { createNodeGateways } from './gateways.js'
export { createNodeModelProvider } from './modelProvider.js'
export { createInMemoryRepositories, type InMemoryRepositories } from './repositories/inMemory.js'
