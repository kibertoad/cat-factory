import { serve } from '@hono/node-server'
import {
  type AppEnv,
  handleError,
  logger,
  registerCoreControllers,
  requireAuth,
  resolveCorsOrigin,
} from '@cat-factory/server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { type NodeContainerOptions, buildNodeContainer } from './container.js'
import { createDbClient } from './db/client.js'
import { migrate } from './db/migrate.js'

// The Node facade: the SAME shared Hono app (controllers + middleware) the Cloudflare
// Worker mounts, served over `@hono/node-server`. The Node-specific wiring is the
// container factory (built once, around the Drizzle/Postgres client) and reading
// CORS / port from process env. The middleware order mirrors the Worker exactly so
// auth/authz behave identically across runtimes.

export interface CreateServerOptions extends NodeContainerOptions {}

/** Build the Hono app around a (already-migrated) Drizzle client. */
export function createServer(options: CreateServerOptions): Hono<AppEnv> {
  const env = options.env ?? process.env
  // Built once and reused across requests (the DB connection pool lives here).
  const container = buildNodeContainer(options)

  const app = new Hono<AppEnv>()

  app.use('*', cors({ origin: (origin) => resolveCorsOrigin(origin, env.CORS_ALLOWED_ORIGINS) }))
  app.use('*', async (c, next) => {
    c.set('container', container)
    await next()
  })

  app.get('/health', (c) => c.json({ status: 'ok' }))

  // Default-deny gate, matching the Worker: only the public prefixes (and the exact
  // WS upgrade) bypass it; everything else requires a valid session.
  const PUBLIC_PREFIXES = ['/health', '/auth', '/v1', '/github']
  const gate = requireAuth<AppEnv>()
  app.use('*', (c, next) => {
    if (c.req.method === 'OPTIONS') return next()
    const path = c.req.path
    if (
      c.req.method === 'GET' &&
      c.req.header('Upgrade')?.toLowerCase() === 'websocket' &&
      /^\/workspaces\/[^/]+\/events$/.test(path)
    ) {
      return next()
    }
    if (PUBLIC_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))) return next()
    return gate(c, next)
  })

  // Per-workspace authorization (404-not-403 to avoid leaking existence), matching the Worker.
  app.use('*', async (c, next) => {
    if (c.req.method === 'OPTIONS') return next()
    const user = c.get('user')
    if (!user) return next()
    const match = /^\/workspaces\/([^/]+)(?:\/.*)?$/.exec(c.req.path)
    if (!match) return next()
    const workspaceId = decodeURIComponent(match[1]!)
    const accountId = await container.workspaceService.accountOf(workspaceId)
    if (accountId === undefined) return next()
    const notFound = () =>
      c.json({ error: { code: 'not_found', message: 'Workspace not found' } }, 404)
    if (accountId === null) {
      const owner = await container.workspaceService.ownerOf(workspaceId)
      return owner === user.id ? next() : notFound()
    }
    if (await container.accountService.isMember(accountId, user.id)) return next()
    return notFound()
  })

  registerCoreControllers(app)
  app.onError(handleError)
  return app
}

/**
 * Boot the Node HTTP server: connect to Postgres (`DATABASE_URL`), ensure the schema,
 * build the app, and listen. Returns the `serve` handle.
 */
export async function start(
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<ReturnType<typeof serve>> {
  const env = options.env ?? process.env
  const databaseUrl = env.DATABASE_URL
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required to start the Node server')
  }
  const { db, pool } = createDbClient(databaseUrl)
  await migrate(db)

  const app = createServer({ db, env })
  const port = Number(env.PORT ?? 8787)
  const server = serve({ fetch: app.fetch, port })
  logger.info({ port }, 'cat-factory node server listening')

  // Close the pool on shutdown so the process exits cleanly.
  const shutdown = () => {
    void pool.end()
  }
  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)

  return server
}
