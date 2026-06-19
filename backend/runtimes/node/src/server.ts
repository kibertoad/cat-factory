import { serve } from '@hono/node-server'
import {
  type AppEnv,
  type ServerContainer,
  handleError,
  logger,
  registerCoreControllers,
  requireAuth,
  resolveCorsOrigin,
} from '@cat-factory/server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { PgBoss } from 'pg-boss'
import { type NodeContainerOptions, buildNodeContainer } from './container.js'
import { createDbClient } from './db/client.js'
import { migrate } from './db/migrate.js'
import type { DriveConfig } from './execution/drive.js'
import { startExecutionWorker } from './execution/pgBossRunner.js'

// The Node facade: the SAME shared Hono app (controllers + middleware) the Cloudflare
// Worker mounts, served over `@hono/node-server`. The middleware order mirrors the
// Worker exactly so auth/authz behave identically across runtimes.

export interface CreateServerOptions extends NodeContainerOptions {}

/** Build the Hono app around a ready container (shared by `createServer` + `start`). */
export function createApp(
  container: ServerContainer,
  env: NodeJS.ProcessEnv = process.env,
): Hono<AppEnv> {
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

/** Build the app from container options (convenience; no durable execution worker). */
export function createServer(options: CreateServerOptions): Hono<AppEnv> {
  return createApp(buildNodeContainer(options), options.env)
}

/** Parse a Workflows-style duration ("15 seconds", "5 minutes", "24 hours") to ms. */
function durationMs(value: string, fallback: number): number {
  const m = /^(\d+)\s*(second|minute|hour)s?$/.exec(value.trim())
  if (!m) return fallback
  const n = Number(m[1])
  const unit = m[2]
  return n * (unit === 'second' ? 1000 : unit === 'minute' ? 60_000 : 3_600_000)
}

/**
 * Boot the Node HTTP server: connect to Postgres (`DATABASE_URL`), ensure the schema,
 * start pg-boss + the durable execution worker, build the app, and listen.
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

  const boss = new PgBoss(databaseUrl)
  await boss.start()

  const container = buildNodeContainer({ db, boss, env })

  const exec = container.config.execution
  const driveConfig: DriveConfig = {
    jobPollIntervalMs: durationMs(exec.jobPollInterval, 15_000),
    jobMaxPolls: exec.jobMaxPolls,
    jobPollFailureTolerance: exec.jobPollFailureTolerance,
    ciPollIntervalMs: durationMs(exec.ciPollInterval, 30_000),
    ciMaxPolls: exec.ciMaxPolls,
  }
  await startExecutionWorker(boss, container, driveConfig, logger)

  const app = createApp(container, env)
  const port = Number(env.PORT ?? 8787)
  const server = serve({ fetch: app.fetch, port })
  logger.info({ port }, 'cat-factory node server listening')

  const shutdown = () => {
    void boss.stop()
    void pool.end()
  }
  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)

  return server
}
