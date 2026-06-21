import { serve } from '@hono/node-server'
import {
  type AppEnv,
  type ServerContainer,
  handleError,
  logger,
  mountAuthGate,
  registerCoreControllers,
  resolveCorsOrigin,
} from '@cat-factory/server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { PgBoss } from 'pg-boss'
import { type NodeContainerOptions, buildNodeContainer } from './container.js'
import { createDbClient } from './db/client.js'
import { migrate } from './db/migrate.js'
import { executionRuntime } from './execution/config.js'
import {
  startDecisionTimeoutWorker,
  startExecutionWorker,
  startStaleRunSweeper,
} from './execution/pgBossRunner.js'
import { startScheduleSweeper } from './recurring.js'
import { createDrizzleRepositories } from './repositories/drizzle.js'
import { startRetentionSweeper } from './retention.js'
import { SystemClock } from './runtime.js'

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

  // Default-deny session gate + per-workspace authz, shared verbatim with the Worker
  // (one implementation in @cat-factory/server so the runtimes can't drift).
  mountAuthGate(app)

  registerCoreControllers(app)
  app.onError(handleError)
  return app
}

/**
 * Build the app from container options (convenience, e.g. embedding / tests).
 *
 * WARNING: unless a started `boss` is passed in `options`, the container wires the
 * engine's NoopWorkRunner — a started execution then returns `running` but is never
 * driven to completion. Use {@link start} for a fully-wired service (durable pg-boss
 * worker + stale-run sweeper); pass `boss` here only if you drive runs yourself.
 */
export function createServer(options: CreateServerOptions): Hono<AppEnv> {
  return createApp(buildNodeContainer(options), options.env)
}

/**
 * Boot the Node HTTP server: connect to Postgres (`DATABASE_URL`), ensure the schema,
 * start pg-boss + the durable execution worker + the stale-run sweeper, build the app,
 * and listen. Registers SIGTERM/SIGINT handlers for a clean, ordered shutdown.
 */
export async function start(
  options: {
    env?: NodeJS.ProcessEnv
    /**
     * The composition root to build. Defaults to {@link buildNodeContainer}; a sibling
     * facade (local mode) passes its own builder (same signature) so it reuses this
     * whole boot sequence — Postgres + pg-boss + sweepers — while supplying only its
     * differentiators (e.g. the local Docker transport + PAT token source).
     */
    buildContainer?: (options: NodeContainerOptions) => ServerContainer
    /**
     * The address to bind the HTTP listener to. Defaults to `HOST` from the env, else
     * all interfaces. A facade or operator can pass `127.0.0.1` to keep the service off
     * the LAN — but note repo-operating agent containers reach this service's LLM proxy
     * via `PUBLIC_URL`, so on native Linux Docker (where that resolves to the bridge
     * gateway, not loopback) a loopback-only bind makes the proxy unreachable to them.
     */
    host?: string
  } = {},
): Promise<ReturnType<typeof serve>> {
  const env = options.env ?? process.env
  const databaseUrl = env.DATABASE_URL
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required to start the Node server')
  }
  const { db, pool } = createDbClient(databaseUrl)
  await migrate(db, pool)

  const boss = new PgBoss(databaseUrl)
  await boss.start()

  // Build the repositories once and share them with both the container and the
  // retention sweeper (so the sweeper prunes the very stores the app writes to).
  const clock = new SystemClock()
  const repos = createDrizzleRepositories(db, clock)
  const buildContainer = options.buildContainer ?? buildNodeContainer
  const container = buildContainer({ db, boss, env, repos })

  const runtime = executionRuntime(container.config, env)
  // The decision-timeout worker creates its queue first so the advance worker's send to
  // it (when a run parks on a decision) always has a target.
  await startDecisionTimeoutWorker(boss, container, logger)
  await startExecutionWorker(boss, container, runtime.drive, logger, {
    concurrency: runtime.concurrency,
    decisionTimeoutSeconds: runtime.decisionTimeoutSeconds,
  })
  const stopSweeper = startStaleRunSweeper(boss, container, runtime.sweeper, runtime.queue, logger)
  // Bound the unbounded tables (`token_usage`, the heavy `llm_call_metrics`): the Worker
  // prunes these from cron, Node has none, so a timer mirrors it. Without this the
  // observability sink — full per-call prompt/response — grows forever on Postgres.
  const stopRetention = startRetentionSweeper(repos, container.config.retention, clock, logger)
  // Fire due recurring pipelines on a one-minute timer (the Worker uses cron).
  const stopScheduleSweeper = startScheduleSweeper(container, clock, logger)

  const app = createApp(container, env)
  const port = Number(env.PORT ?? 8787)
  const host = options.host ?? env.HOST?.trim() ?? undefined
  const server = serve({ fetch: app.fetch, port, ...(host ? { hostname: host } : {}) })
  logger.info({ port, host: host ?? '0.0.0.0' }, 'cat-factory node server listening')

  // Ordered graceful shutdown: stop accepting connections, halt the sweeper + pg-boss
  // worker, release the pool, then exit. Without closing the HTTP server the process
  // would keep the event loop alive and hang until the orchestrator SIGKILLs it.
  let shuttingDown = false
  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info({ signal }, 'shutting down cat-factory node server')
    stopSweeper()
    stopRetention()
    stopScheduleSweeper()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    try {
      await boss.stop()
      await pool.end()
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'shutdown error')
    }
    process.exit(0)
  }
  process.once('SIGTERM', () => void shutdown('SIGTERM'))
  process.once('SIGINT', () => void shutdown('SIGINT'))

  return server
}
