import { serve } from '@hono/node-server'
import {
  type AppEnv,
  CORS_ALLOWED_HEADERS,
  type ConfigProblem,
  type ServerContainer,
  corsReflectsWhenUnset,
  createMisconfiguredApp,
  formatConfigProblems,
  handleError,
  isConfigValidationError,
  logger,
  requireEnv,
  mountAuthGate,
  registerCoreControllers,
  resolveCorsOrigin,
} from '@cat-factory/server'
import { loadNodeConfig } from './config.js'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { validateRegistrationsOnce } from '@cat-factory/orchestration'
import { PgBoss } from 'pg-boss'
import { type AppCachesProfile, createAppCaches } from '@cat-factory/caching'
import { buildCacheNotifications } from './cacheNotifications.js'
import { type NodeContainerOptions, buildNodeContainer } from './container.js'
import { createDbClient } from './db/client.js'
import { migrate } from './db/migrate.js'
import { executionRuntime } from './execution/config.js'
import { startExecutionWorker, startStaleRunSweeper } from './execution/pgBossRunner.js'
import { startBootstrapWorker } from './execution/bootstrapRunner.js'
import { startGitHubSyncWorker } from './execution/githubSyncRunner.js'
import { startEnvConfigRepairWorker } from './execution/envConfigRepairRunner.js'
import { startEnvironmentSweeper } from './environments.js'
import { startScheduleSweeper } from './recurring.js'
import { resolveSweepInterval, startInitiativeLoopSweeper } from './initiativeLoop.js'
import { startKaizenSweeper } from './kaizen.js'
import { startNotificationEscalationSweeper } from './notifications.js'
import { buildRealtimePropagator } from './propagator.js'
import { type ReadinessProbe, makeReadinessProbe } from './readiness.js'
import { NodeRealtimeHub, attachRealtime } from './realtime.js'
import { DrizzleGitHubInstallationRepository } from './repositories/containerExecution.js'
import { createDrizzleRepositories } from './repositories/drizzle.js'
import { startGitHubReconcileSweeper } from './githubReconcile.js'
import {
  DrizzleCommitProjectionRepository,
  DrizzleRepoProjectionRepository,
} from './repositories/github.js'
import { DrizzleSubscriptionActivationRepository } from './repositories/personalSubscription.js'
import { DrizzleNotificationRepository } from './repositories/notifications.js'
import { startArtifactRetentionSweeper, startRetentionSweeper } from './retention.js'
import { SystemClock } from './runtime.js'

// The Node facade: the SAME shared Hono app (controllers + middleware) the Cloudflare
// Worker mounts, served over `@hono/node-server`. The middleware order mirrors the
// Worker exactly so auth/authz behave identically across runtimes.

export interface CreateServerOptions extends NodeContainerOptions {}

export interface CreateAppOptions {
  /**
   * A readiness probe mounted on the public `GET /ready`. Wired by {@link start} from the live
   * Postgres pool + pg-boss so a broken replica drains out of rotation. Omitted (embedded
   * `createServer`, local mothership mode) ⇒ `/ready` mirrors `/health` — there is no local
   * durable-execution substrate to probe. See {@link ./readiness.js}.
   */
  readiness?: ReadinessProbe
}

/** Build the Hono app around a ready container (shared by `createServer` + `start`). */
export function createApp(
  container: ServerContainer,
  env: NodeJS.ProcessEnv = process.env,
  opts: CreateAppOptions = {},
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

  // Liveness: the process is up. Always 200 — a restart can't fix a dead downstream, and this is
  // what the orchestrator restarts on. Readiness (pool + pg-boss) is `/ready` below.
  app.get('/health', (c) => c.json({ status: 'ok' }))
  // Readiness: drained on when the pool dies, pg-boss stops, or shutdown begins. Public (before the
  // auth gate) so a load balancer can probe it unauthenticated, like `/health`. With no probe wired
  // (embedded/mothership) it reports ready — there is no local substrate to drain on.
  app.get('/ready', async (c) => {
    if (!opts.readiness) return c.json({ status: 'ready', checks: {} })
    const report = await opts.readiness()
    return c.json(
      { status: report.ready ? 'ready' : 'not_ready', checks: report.checks },
      report.ready ? 200 : 503,
    )
  })

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
  const { port, hostname } = resolveBind(opts.env, opts.host)
  const server = serve({ fetch: opts.app.fetch, port, ...(hostname ? { hostname } : {}) })
  // Accept the SPA's WebSocket event-stream upgrades on the same listener (the Worker uses a
  // per-workspace Durable Object; `@hono/node-server` doesn't upgrade on its own, so attach a
  // `ws` server here).
  const stopRealtime = attachRealtime(server, opts.realtimeHub, opts.auth, logger)
  logger.info({ port, host: hostname ?? '0.0.0.0' }, `${opts.label} listening`)
  return { server, stopRealtime }
}

/**
 * Resolve the HTTP listen address (`PORT` / `HOST`, with an optional explicit `host` override).
 * Shared by {@link serveAppWithRealtime} and {@link serveMisconfigured} so the fallback backend can
 * never bind a different port/host than the real server — the SPA reaches the deployment at one
 * fixed address, and the whole point of the fallback is that it answers there too.
 */
function resolveBind(env: NodeJS.ProcessEnv, host?: string): { port: number; hostname?: string } {
  const port = Number(env.PORT ?? 8787)
  const hostname = host ?? env.HOST?.trim() ?? undefined
  return { port, ...(hostname ? { hostname } : {}) }
}

/**
 * Serve the misconfiguration FALLBACK backend on the normal port/host. Used when {@link start}
 * (or the local facade's boot) catches a {@link ConfigValidationError}: instead of exiting — which
 * leaves the SPA showing a bare "can't reach the backend" panel with no clue what's wrong — we keep
 * the deployment reachable serving a minimal app that reports the exact missing variables, so the
 * SPA can render its dedicated "backend misconfigured" screen. Logs a clear operator message too.
 */
export function serveMisconfigured(
  problems: ConfigProblem[],
  env: NodeJS.ProcessEnv,
  host?: string,
): ReturnType<typeof serve> {
  logger.error(
    { problems: problems.map((p) => p.key) },
    `cat-factory node server is MISCONFIGURED — serving the fallback error backend so the UI can explain what to fix.\n${formatConfigProblems(problems)}`,
  )
  const app = createMisconfiguredApp(problems)
  const { port, hostname } = resolveBind(env, host)
  const server = serve({ fetch: app.fetch, port, ...(hostname ? { hostname } : {}) })
  logger.info({ port, host: hostname ?? '0.0.0.0' }, 'cat-factory misconfigured fallback listening')
  return server
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
     * App-owned DI seam for custom agent kinds (mirroring the Worker's `buildContainer`
     * override): a deployment news a `defaultAgentKindRegistry()`, registers its own kinds on
     * it by reference, and passes it here. Forwarded to `buildNodeContainer` (and, via the
     * local facade's builder, to `buildLocalContainer`). Absent → the built-in-only default.
     */
    agentKindRegistry?: NodeContainerOptions['agentKindRegistry']
    /**
     * App-owned DI seam for custom initiative presets (mirroring `agentKindRegistry`): a
     * deployment news a `defaultInitiativePresetRegistry()`, registers its own presets on it by
     * reference, and passes it here. Forwarded to `buildNodeContainer`. Absent → the built-in-only
     * default (generic / docs-refresh / tech-migration).
     */
    initiativePresetRegistry?: NodeContainerOptions['initiativePresetRegistry']
    /**
     * The address to bind the HTTP listener to. Defaults to `HOST` from the env, else
     * all interfaces. A facade or operator can pass `127.0.0.1` to keep the service off
     * the LAN — but note repo-operating agent containers reach this service's LLM proxy
     * via `PUBLIC_URL`, so on native Linux Docker (where that resolves to the bridge
     * gateway, not loopback) a loopback-only bind makes the proxy unreachable to them.
     */
    host?: string
    /**
     * Per-cache profile overrides merged over the default profile. A sibling facade passes
     * this to opt a cache out where its coherence assumptions don't hold: local mode makes
     * the repo projection pass-through because its `link-repo` CLI writes the projection
     * out-of-process and local mode has no cross-process invalidation bus (the same reason
     * the Worker's isolate-safe profile passes it through). Omitted ⇒ the default profile.
     */
    cachesProfile?: Partial<AppCachesProfile>
    /**
     * The catalog id of the built-in model preset a fresh workspace is seeded with as its
     * DEFAULT (`MODEL_PRESET_SEED_IDS.{kimi,glm,claude}`). A deploy-app wrapper passes this to
     * change the out-of-the-box default without editing library code — e.g.
     * `start({ defaultModelPresetId: MODEL_PRESET_SEED_IDS.claude })`. Forwarded to
     * `buildNodeContainer` (and, via the local facade's builder, to `buildLocalContainer`).
     * Applied only at FIRST seed of a workspace's preset library, so a user's later manual
     * default choice is always preserved. Omitted ⇒ the facade default (Node → Kimi K2.7).
     */
    defaultModelPresetId?: string
    /**
     * Optional last-mile transform over the {@link ConfigProblem} list before the misconfiguration
     * fallback is served, letting a sibling facade layer a facade-specific remedy onto the shared
     * problems. Local mode passes one that advertises its `.env`-generating CLI (which the hosted
     * Node/Worker facades have no analogue for) ABOVE the per-variable remedies. Absent ⇒ the
     * problems are served verbatim.
     */
    augmentConfigProblems?: (problems: ConfigProblem[]) => ConfigProblem[]
  } = {},
): Promise<ReturnType<typeof serve>> {
  const env = options.env ?? process.env
  try {
    return await bootServer(options, env)
  } catch (err) {
    // A mandatory env var / binding is missing or invalid: don't die (which leaves the SPA on a
    // bare "can't reach the backend" panel) — keep the port reachable serving the fallback backend
    // so the UI can tell the developer exactly what to fix. Any OTHER failure is a real crash and
    // is rethrown to the entrypoint (which exits non-zero).
    if (isConfigValidationError(err)) {
      const problems = options.augmentConfigProblems?.(err.problems) ?? err.problems
      return serveMisconfigured(problems, env, options.host)
    }
    throw err
  }
}

/** The real boot sequence, wrapped by {@link start} so a {@link ConfigValidationError} falls back. */
async function bootServer(
  options: NonNullable<Parameters<typeof start>[0]>,
  env: NodeJS.ProcessEnv,
): Promise<ReturnType<typeof serve>> {
  const databaseUrl = requireEnv(env, 'DATABASE_URL')
  // Validate the full config UP FRONT — it is pure (no I/O), so an ENCRYPTION_KEY / auth-provider
  // problem surfaces as a ConfigValidationError here, BEFORE we open a Postgres connection or run
  // migrations. Without this the same throw would fire deep inside `buildContainer` only after the
  // heavy DB boot, and a bad-config restart would needlessly hammer Postgres first.
  loadNodeConfig(env)
  // Optional schema overrides for a SHARED database (where `public` is unavailable, or another
  // service already owns the default `drizzle`/`pgboss` schemas). All default to the prior
  // behaviour, so a stock deployment is unchanged:
  //   - DB_SCHEMA — the default (`public`) app tables, relocated via the connection search_path.
  //   - DB_MIGRATIONS_SCHEMA — the drizzle migration ledger (`drizzle`), so cat-factory's ledger
  //     can't collide with another drizzle-using service's `drizzle.__drizzle_migrations`.
  //   - DB_PGBOSS_SCHEMA — pg-boss's queue schema (`pgboss`).
  // The named app schemas (telemetry/sandbox/provisioning) are always explicitly qualified and
  // unaffected.
  const dbSchema = env.DB_SCHEMA
  const migrationsSchema = env.DB_MIGRATIONS_SCHEMA
  const { db, pool } = createDbClient(databaseUrl, dbSchema)
  const boss = new PgBoss({
    connectionString: databaseUrl,
    // Default (`pgboss`) when unset — a single object literal (not a string|object union) so it
    // resolves to pg-boss's options-constructor overload.
    ...(env.DB_PGBOSS_SCHEMA?.trim() ? { schema: env.DB_PGBOSS_SCHEMA.trim() } : {}),
  })
  // Migrations (Drizzle, app schema) and pg-boss's own schema provisioning are
  // independent — neither reads the other's tables. Run the app migration FIRST and on its
  // own: a migration failure (drift guard / a bad lineage) is then the clean, unambiguous
  // top-level rejection the entrypoint reports, rather than racing pg-boss's own schema
  // provisioning inside a `Promise.all` (which would half-provision pg-boss on a doomed boot
  // and could mask the real migration error). The small overlap we give up is worth the
  // debuggability. `migrate()` throws a MigrationFailedError / DbSchemaInconsistentError with
  // a recovery hint when the DB is wedged.
  await migrate(db, pool, { schema: dbSchema, migrationsSchema })
  await boss.start()
  // pg-boss lifecycle flags for the `/ready` probe: it's running once `start()` resolves and stops
  // being ready when it emits `stopped` (graceful shutdown) or `draining` flips at SIGTERM. The
  // pool's own health is probed live per request (a `SELECT 1`), so it needs no flag.
  let bossRunning = true
  boss.on('stopped', () => {
    bossRunning = false
  })
  let draining = false

  // Build the repositories once and share them with both the container and the
  // retention sweeper (so the sweeper prunes the very stores the app writes to).
  const clock = new SystemClock()
  const repos = createDrizzleRepositories(db, clock)
  const buildContainer = options.buildContainer ?? buildNodeContainer
  // The per-workspace real-time subscriber registry. Created here (not in the container
  // builder) because it must be shared between the engine's event publisher — wired
  // inside the container — and the HTTP server's WebSocket upgrade listener attached
  // below. The local facade's builder forwards these options to buildNodeContainer
  // unchanged, so local mode gets live updates too.
  const realtimeHub = new NodeRealtimeHub()
  // Wrap the hub in the layered propagator: when REDIS_URL is set (a multi-node deployment)
  // events also fan to peer nodes over Redis pub/sub so a browser on any node sees them; with
  // no bus configured (local mode, single replica) it is the bare hub with zero overhead. The
  // engine writes through this sink; the HTTP upgrade listener still registers sockets on the
  // hub directly.
  const realtimePropagator = buildRealtimePropagator(realtimeHub, env, logger)
  // The process-wide cache bag (caching initiative). In-memory only; when REDIS_URL is
  // set (multi-node) each cache also broadcasts its invalidations to peers over its own
  // Redis notification channel, mirroring the realtime propagator's gating. Built here
  // (not in the container builder) so this process owns exactly one bag + its shutdown.
  const caches = createAppCaches({
    notificationPairFactory: await buildCacheNotifications(env, logger),
    logger,
    ...(options.cachesProfile ? { profile: options.cachesProfile } : {}),
  })
  const container = buildContainer({
    db,
    boss,
    env,
    repos,
    realtimeSink: realtimePropagator,
    caches,
    agentKindRegistry: options.agentKindRegistry,
    initiativePresetRegistry: options.initiativePresetRegistry,
    // Forward the deployment's default-preset choice (undefined ⇒ the builder's facade
    // default). The local facade rides on this same field via its `buildContainer` override.
    defaultModelPresetId: options.defaultModelPresetId,
  })
  // Connect the cross-node adapters (a no-op when none are configured) so peer events start
  // reaching this node's browsers.
  await realtimePropagator.start(logger)

  // Validate the registered extensions (gates / agent kinds) once, before serving — every
  // `register*` import side effect has run by now. A typo'd gate helperKind or an unknown
  // resultView fails loudly here instead of mid-run. Mirrors the Worker's first-request guard.
  validateRegistrationsOnce({
    agentKindRegistry: container.agentKindRegistry,
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
  // Async GitHub ingest (the analogue of the Worker's GITHUB_SYNC_QUEUE consumer +
  // GitHubBackfillWorkflow): drain the `github.sync` queue the gateway seams enqueue onto,
  // so webhook deliveries / resyncs / backfills apply out of band and the request acks fast.
  await startGitHubSyncWorker(boss, container, logger, {
    concurrency: runtime.concurrency,
  })
  // Readiness probe for `/ready`: a live Postgres round-trip + the pg-boss flag, draining the
  // instant shutdown begins so a load balancer stops routing here while in-flight requests finish.
  const readiness = makeReadinessProbe({
    ping: async () => {
      await pool.query('SELECT 1')
    },
    pgBossHealthy: () => bossRunning,
    isDraining: () => draining,
  })
  const app = createApp(container, env, { readiness })
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
      agentSearchQueryRepository: repos.agentSearchQueryRepository,
      pipelineScheduleRepository: repos.pipelineScheduleRepository,
      subscriptionActivationRepository: new DrizzleSubscriptionActivationRepository(db),
      subscriptionQuotaCycleRepository: repos.subscriptionQuotaCycleRepository,
      provisioningLogRepository: repos.provisioningLogRepository,
      passwordResetTokenRepository: repos.passwordResetTokenRepository,
      commitRepository: new DrizzleCommitProjectionRepository(db),
      notificationRepository: new DrizzleNotificationRepository(db),
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
  // Tick the initiative execution loop on a one-minute timer (the Worker uses cron); reconciles
  // + spawns for every executing initiative. Terminal child runs poke the loop directly, so this
  // is the backstop cadence; no-op unless the initiatives module is wired. Resolve the interval
  // from the INJECTED `env` (not `process.env`) so an `INITIATIVE_LOOP_INTERVAL_MS` passed through
  // `start({ env })` is honoured — the e2e backend relies on the fast sweep for its first spawn.
  const stopInitiativeLoop = startInitiativeLoopSweeper(
    container,
    clock,
    logger,
    resolveSweepInterval(env),
  )
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
    // Flip `/ready` to not-ready FIRST so a load balancer drains this replica out of rotation
    // before we start tearing down — new requests go elsewhere while in-flight ones finish.
    draining = true
    logger.info({ signal }, 'shutting down cat-factory node server')
    stopSweeper()
    stopRetention()
    stopArtifactRetention()
    stopScheduleSweeper()
    stopInitiativeLoop()
    stopEnvironmentSweeper()
    stopNotificationEscalation()
    stopKaizenSweeper()
    stopGitHubReconcile()
    stopRealtime()
    // Release any cross-node propagation adapters (Redis connections); a no-op when none.
    await realtimePropagator.stop()
    // Quit the cache-invalidation notification clients (a no-op for bare in-memory caches).
    await caches.close()
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
