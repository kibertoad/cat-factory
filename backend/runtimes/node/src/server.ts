import { serve } from '@hono/node-server'
import {
  type AppEnv,
  CORS_ALLOWED_HEADERS,
  type ServerContainer,
  corsReflectsWhenUnset,
  handleError,
  logger,
  mountAuthGate,
  registerCoreControllers,
  resolveCorsOrigin,
} from '@cat-factory/server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { validateRegistrationsOnce } from '@cat-factory/orchestration'
import { PgBoss } from 'pg-boss'
import { type NodeContainerOptions, buildNodeContainer } from './container.js'
import { createDbClient } from './db/client.js'
import { migrate } from './db/migrate.js'
import { executionRuntime } from './execution/config.js'
import { startExecutionWorker, startStaleRunSweeper } from './execution/pgBossRunner.js'
import { startBootstrapWorker } from './execution/bootstrapRunner.js'
import { startEnvConfigRepairWorker } from './execution/envConfigRepairRunner.js'
import { startEnvironmentSweeper } from './environments.js'
import { startScheduleSweeper } from './recurring.js'
import { startKaizenSweeper } from './kaizen.js'
import { startNotificationEscalationSweeper } from './notifications.js'
import { NodeRealtimeHub, attachRealtime } from './realtime.js'
import { DrizzleGitHubInstallationRepository } from './repositories/containerExecution.js'
import { createDrizzleRepositories } from './repositories/drizzle.js'
import { startGitHubReconcileSweeper } from './githubReconcile.js'
import {
  DrizzleCommitProjectionRepository,
  DrizzleRepoProjectionRepository,
} from './repositories/github.js'
import { DrizzleSubscriptionActivationRepository } from './repositories/personalSubscription.js'
import { startArtifactRetentionSweeper, startRetentionSweeper } from './retention.js'
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

  app.use(
    '*',
    cors({
      origin: (origin) =>
        resolveCorsOrigin(origin, env.CORS_ALLOWED_ORIGINS, corsReflectsWhenUnset(env.ENVIRONMENT)),
      // Same shared allow-list the Worker uses, so the facades stay symmetric (Hono
      // would otherwise echo the requested headers, masking a drift like the missing
      // X-Connection-Id the Worker hit).
      allowHeaders: [...CORS_ALLOWED_HEADERS],
    }),
  )
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
 * Serve a Hono app over `@hono/node-server` and attach the SPA's WebSocket event-stream upgrade
 * to the same listener. Shared by {@link start} and the local facade's mothership boot (which
 * can't call `start()` — it has no Postgres/pg-boss), so the port/host resolution + the realtime
 * upgrade can never drift between them. The caller owns the rest of its shutdown sequence (which
 * legitimately differs: pg-boss + sweepers vs the local credential store), so this returns the
 * server + the realtime stop fn rather than registering signal handlers itself.
 */
export function serveAppWithRealtime(opts: {
  app: Hono<AppEnv>
  realtimeHub: NodeRealtimeHub
  auth: Parameters<typeof attachRealtime>[2]
  env: NodeJS.ProcessEnv
  host?: string
  label: string
}): { server: ReturnType<typeof serve>; stopRealtime: ReturnType<typeof attachRealtime> } {
  const port = Number(opts.env.PORT ?? 8787)
  const host = opts.host ?? opts.env.HOST?.trim() ?? undefined
  const server = serve({ fetch: opts.app.fetch, port, ...(host ? { hostname: host } : {}) })
  // Accept the SPA's WebSocket event-stream upgrades on the same listener (the Worker uses a
  // per-workspace Durable Object; `@hono/node-server` doesn't upgrade on its own, so attach a
  // `ws` server here).
  const stopRealtime = attachRealtime(server, opts.realtimeHub, opts.auth, logger)
  logger.info({ port, host: host ?? '0.0.0.0' }, `${opts.label} listening`)
  return { server, stopRealtime }
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
  const boss = new PgBoss(databaseUrl)
  // Migrations (Drizzle, app schema) and pg-boss's own schema provisioning are
  // independent — neither reads the other's tables — so run them concurrently and
  // overlap the two heaviest blocking boot steps instead of serializing them.
  await Promise.all([migrate(db, pool), boss.start()])

  // Build the repositories once and share them with both the container and the
  // retention sweeper (so the sweeper prunes the very stores the app writes to).
  const clock = new SystemClock()
  const repos = createDrizzleRepositories(db, clock)
  const buildContainer = options.buildContainer ?? buildNodeContainer
  // The per-workspace real-time subscriber registry. Created here (not in the container
  // builder) because it must be shared between the engine's event publisher — wired
  // inside the container — and the HTTP server's WebSocket upgrade listener attached
  // below. The local facade's builder forwards this option to buildNodeContainer
  // unchanged, so local mode gets live updates too.
  const realtimeHub = new NodeRealtimeHub()
  const container = buildContainer({ db, boss, env, repos, realtimeHub })

  // Validate the registered extensions (gates / agent kinds) once, before serving — every
  // `register*` import side effect has run by now. A typo'd gate helperKind or an unknown
  // resultView fails loudly here instead of mid-run. Mirrors the Worker's first-request guard.
  validateRegistrationsOnce({
    onWarn: (problem) => logger.warn({ code: problem.code }, problem.message),
  })

  const runtime = executionRuntime(container.config, env)
  // A parked run waits for a human indefinitely (no decision timeout); the escalating
  // notification — not a killed run — signals that a human is overdue.
  await startExecutionWorker(boss, container, runtime.drive, logger, {
    concurrency: runtime.concurrency,
  })
  // Durably drive bootstrap runs too (the Worker uses a per-run BootstrapWorkflow);
  // a no-op queue when the bootstrap module isn't wired.
  await startBootstrapWorker(boss, container, runtime.drive, logger, {
    concurrency: runtime.concurrency,
  })
  // Durably drive env-config-repair runs (the Worker uses a per-run EnvConfigRepairWorkflow);
  // a no-op queue when the repair module isn't wired.
  await startEnvConfigRepairWorker(boss, container, runtime.drive, logger, {
    concurrency: runtime.concurrency,
  })
  const app = createApp(container, env)
  const { server, stopRealtime } = serveAppWithRealtime({
    app,
    realtimeHub,
    auth: container.config.auth,
    env,
    host: options.host,
    label: 'cat-factory node server',
  })

  // The background sweepers below only schedule `setInterval`s (no work runs until a
  // timer fires), so start them AFTER the listener binds — the server accepts requests a
  // few ms sooner. The pg-boss workers above stay before listen so an enqueued job always
  // has a consumer.
  const stopSweeper = startStaleRunSweeper(
    boss,
    pool,
    container,
    runtime.sweeper,
    runtime.queue,
    logger,
  )
  // Bound the unbounded tables (`token_usage`, the heavy `llm_call_metrics`): the Worker
  // prunes these from cron, Node has none, so a timer mirrors it. Without this the
  // observability sink — full per-call prompt/response — grows forever on Postgres.
  const stopRetention = startRetentionSweeper(
    {
      tokenUsageRepository: repos.tokenUsageRepository,
      llmCallMetricRepository: repos.llmCallMetricRepository,
      agentContextSnapshotRepository: repos.agentContextSnapshotRepository,
      pipelineScheduleRepository: repos.pipelineScheduleRepository,
      subscriptionActivationRepository: new DrizzleSubscriptionActivationRepository(db),
      provisioningLogRepository: repos.provisioningLogRepository,
      passwordResetTokenRepository: repos.passwordResetTokenRepository,
      commitRepository: new DrizzleCommitProjectionRepository(db),
    },
    container.config.retention,
    clock,
    logger,
  )
  // Per-workspace binary-artifact (screenshot) retention; only when content storage is wired
  // (the resolver is present once an encryption key is configured). The sweep resolves each
  // workspace's per-account store itself.
  const stopArtifactRetention = container.resolveBinaryArtifactStore
    ? startArtifactRetentionSweeper(
        container.resolveBinaryArtifactStore,
        repos.workspaceRepository,
        repos.workspaceSettingsRepository,
        clock,
        logger,
      )
    : () => {}
  // Fire due recurring pipelines on a one-minute timer (the Worker uses cron).
  const stopScheduleSweeper = startScheduleSweeper(container, clock, logger)
  // Tear down expired ephemeral environments (the Worker uses cron); no-op unless the
  // environments integration is wired.
  const stopEnvironmentSweeper = startEnvironmentSweeper(container, clock, logger)
  // Escalate long-waiting notifications yellow → red (the Worker uses cron); the
  // overdue-human signal now that runs never time out waiting for input.
  const stopNotificationEscalation = startNotificationEscalationSweeper(container, clock, logger)
  // Run pending Kaizen gradings on a one-minute timer (the Worker uses cron); no-op
  // unless the Kaizen feature is wired.
  const stopKaizenSweeper = startKaizenSweeper(container, clock, logger)
  // Re-sync stale GitHub repo projections — the backstop for missed webhooks (the
  // Worker's `github-reconcile` cron); no-op unless the GitHub App module is wired.
  const stopGitHubReconcile = container.github
    ? startGitHubReconcileSweeper(
        {
          repoProjectionRepository: new DrizzleRepoProjectionRepository(db),
          installationRepository: new DrizzleGitHubInstallationRepository(db),
          syncRepoById: (workspaceId, repoGithubId) =>
            container.github!.syncService.syncRepoById(workspaceId, repoGithubId),
        },
        clock,
        logger,
      )
    : () => {}

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
    stopArtifactRetention()
    stopScheduleSweeper()
    stopEnvironmentSweeper()
    stopNotificationEscalation()
    stopKaizenSweeper()
    stopGitHubReconcile()
    stopRealtime()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    try {
      await boss.stop()
      await pool.end()
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'shutdown error')
    }
    try {
      // Facade-owned disposables (e.g. the local facade's native host-process harnesses) —
      // released in their OWN try so a failing boss.stop()/pool.end() above can't skip them and
      // orphan the in-flight agent children they abort. Graceful teardown beats the exit-hook
      // backstop.
      await container.onShutdown?.()
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'onShutdown error')
    }
    process.exit(0)
  }
  process.once('SIGTERM', () => void shutdown('SIGTERM'))
  process.once('SIGINT', () => void shutdown('SIGINT'))

  return server
}
