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
import { type NodeContainerOptions, buildNodeContainer } from './container'

// The Node facade: the SAME shared Hono app (controllers + middleware) the Cloudflare
// Worker mounts, served over `@hono/node-server`. The only Node-specific wiring is the
// container factory (built once — see buildNodeContainer) and reading CORS / port from
// process env. The middleware order mirrors the Worker exactly so auth/authz behave
// identically across runtimes.

export interface CreateServerOptions extends NodeContainerOptions {}

export function createServer(options: CreateServerOptions = {}): Hono<AppEnv> {
  const env = options.env ?? process.env
  // Built once and reused across requests (the in-memory store lives here).
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

/** Start the Node HTTP server. Returns the underlying `serve` handle. */
export function start(options: CreateServerOptions = {}): ReturnType<typeof serve> {
  const app = createServer(options)
  const port = Number((options.env ?? process.env).PORT ?? 8787)
  const server = serve({ fetch: app.fetch, port })
  logger.info({ port }, 'cat-factory node server listening')
  return server
}
