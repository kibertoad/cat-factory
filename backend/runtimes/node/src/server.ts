import { serve } from '@hono/node-server'
import {
  type AppEnv,
  CORS_ALLOWED_HEADERS,
  CORS_EXPOSED_HEADERS,
  type ConfigProblem,
  type ServerContainer,
  corsReflectsWhenUnset,
  createMisconfiguredApp,
  formatConfigProblems,
  handleError,
  isConfigValidationError,
  logger,
  operationalMetrics,
  parseLogLevel,
  mountAuthGate,
  mountRequestLogging,
  setLogLevel,
  registerCoreControllers,
  corsOriginFor,
  sweepHealth,
  sweepKeyDriftAndRaise,
  WebCryptoSecretCipher,
} from '@cat-factory/server'
import { bootPersistence } from './bootPersistence.js'
import { installProcessFailureGuards } from './processGuards.js'
import { startOtelLogExport } from './logExport.js'
import { startBootClock } from './bootTimings.js'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import {
  type RegistrationWarning,
  logRegistrationWarning,
  validateRegistrationsOnce,
} from '@cat-factory/orchestration'
import { PgBoss } from 'pg-boss'
import { type AppCachesProfile, createAppCaches } from '@cat-factory/caching'
import { buildCacheNotifications } from './cacheNotifications.js'
import { type NodeContainerOptions, buildNodeContainer } from './container.js'
import { createDbClient } from './db/client.js'
import { executionRuntime } from './execution/config.js'
import { startExecutionWorker, startStaleRunSweeper } from './execution/pgBossRunner.js'
import { startBootstrapWorker } from './execution/bootstrapRunner.js'
import { startGitHubSyncWorker } from './execution/githubSyncRunner.js'
import { startTrackerSyncWorker } from './execution/trackerSyncRunner.js'
import { startEnvConfigRepairWorker } from './execution/envConfigRepairRunner.js'
import {
  PgBossEnvironmentTestRunner,
  startEnvTestSweeper,
  startEnvTestWorker,
} from './execution/envTestRunner.js'
import { startEnvironmentSweeper } from './environments.js'
import { startScheduleSweeper } from './recurring.js'
import { resolveSweepInterval, startInitiativeLoopSweeper } from './initiativeLoop.js'
import { startKaizenSweeper } from './kaizen.js'
import { startNotificationEscalationSweeper } from './notifications.js'
import {
  startFoundationalSourceSweeper,
  startServiceCatalogSweeper,
} from './foundationalServices.js'
import { startPlatformHealthSweeper } from './platformHealth.js'
import { startInfraReachabilitySweeper } from './infraReachability.js'
import { startSpendAlertSweeper } from './spendAlerts.js'
import { buildRealtimePropagator } from './propagator.js'
import { warnIfRedisUnreachableInBackground } from './redisProbe.js'
import { type ReadinessProbe, makeReadinessProbe } from './readiness.js'
import { type MachineSubscribeDeps, NodeRealtimeHub, attachRealtime } from './realtime.js'
import { DrizzleGitHubInstallationRepository } from './repositories/containerExecution.js'
import { createDrizzleRepositories } from './repositories/drizzle.js'
import { DrizzleEnvironmentTestRunRepository } from './repositories/environmentTest.js'
import { startGitHubReconcileSweeper } from './githubReconcile.js'
import { startPlatformMetricsSweeper } from './platformMetrics.js'
import { startSweeper } from './sweeper.js'
import {
  DEAD_LETTER_SWEEP_INTERVAL_MS,
  probePgBossQueueDepth,
  sweepDeadLetterQueues,
} from './queueDepth.js'
import {
  DrizzleCommitProjectionRepository,
  DrizzleRepoProjectionRepository,
} from './repositories/github.js'
import { DrizzleSubscriptionActivationRepository } from './repositories/personalSubscription.js'
import { DrizzleNotificationRepository } from './repositories/notifications.js'
import { startArtifactRetentionSweeper, startRetentionSweeper } from './retention.js'
import { SystemClock } from './runtime.js'
import { getErrorMessage } from '@cat-factory/kernel'
import type { Logger } from '@cat-factory/kernel'

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

  // Correlation FIRST — before CORS and before the container is stashed — so every response,
  // including a CORS denial, carries a request id and produces one log line. Shared verbatim
  // with the Worker.
  mountRequestLogging(app)

  app.use(
    '*',
    cors({
      // Shared with the Worker, including WHICH paths answer any origin: the credential-free MCP
      // discovery and authorization routes, whose browser-hosted clients run on origins no
      // operator lists.
      origin: (origin, c) =>
        corsOriginFor(
          new URL(c.req.url).pathname,
          origin,
          env.CORS_ALLOWED_ORIGINS,
          corsReflectsWhenUnset(env.ENVIRONMENT),
        ),
      // Same shared allow-list the Worker uses, so the facades stay symmetric (Hono
      // would otherwise echo the requested headers, masking a drift like the missing
      // X-Connection-Id the Worker hit).
      allowHeaders: [...CORS_ALLOWED_HEADERS],
      // …and the correlation id back out, or the SPA can see it on the wire but not read it.
      exposeHeaders: [...CORS_EXPOSED_HEADERS],
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
  /**
   * Supplied by a deployment that can act as a MOTHERSHIP, enabling the machine-authed inbound
   * event subscription (`GET /internal/events/subscribe/:ws`). The local facade's mothership boot
   * deliberately leaves it off — it is a machine-API client, not a server (see
   * {@link MachineSubscribeDeps}).
   */
  machineSubscribe?: MachineSubscribeDeps
}): { server: ReturnType<typeof serve>; stopRealtime: ReturnType<typeof attachRealtime> } {
  const { port, hostname } = resolveBind(opts.env, opts.host)
  const server = serve({ fetch: opts.app.fetch, port, ...(hostname ? { hostname } : {}) })
  // Accept the SPA's WebSocket event-stream upgrades on the same listener (the Worker uses a
  // per-workspace Durable Object; `@hono/node-server` doesn't upgrade on its own, so attach a
  // `ws` server here). Same listener serves the mothership-mode machine subscription when wired.
  const stopRealtime = attachRealtime(
    server,
    opts.realtimeHub,
    opts.auth,
    logger,
    opts.machineSubscribe,
  )
  logger.info(`${opts.label} listening`, { port, host: hostname ?? '0.0.0.0' })
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
    `cat-factory node server is MISCONFIGURED — serving the fallback error backend so the UI can explain what to fix.\n${formatConfigProblems(problems)}`,
    { problems: problems.map((p) => p.key) },
  )
  const app = createMisconfiguredApp(problems)
  const { port, hostname } = resolveBind(env, host)
  const server = serve({ fetch: app.fetch, port, ...(hostname ? { hostname } : {}) })
  logger.info('cat-factory misconfigured fallback listening', { port, host: hostname ?? '0.0.0.0' })
  return server
}

/**
 * Everything {@link start} accepts. A named interface rather than an inline literal so the
 * registry-seam guard (`test/registry-seams.spec.ts`) can assert against the BOOT ENTRY POINT a
 * deployment actually calls, not only against the container builder behind it. Asserting the
 * builder alone is what let `pipelineRegistry` sit on `NodeContainerOptions` (documented, guarded,
 * green) while being unreachable through this function.
 */
export interface StartOptions {
  env?: NodeJS.ProcessEnv
  /**
   * The composition root to build. Defaults to {@link buildNodeContainer}; a sibling
   * facade (local mode) passes its own builder (same signature) so it reuses this
   * whole boot sequence (Postgres + pg-boss + sweepers) while supplying only its
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
   * App-owned DI seam for custom task types (mirroring `agentKindRegistry`): a deployment news
   * a `defaultTaskTypeRegistry()`, registers its namespaced task types on it by reference, and
   * passes it here. Forwarded to `buildNodeContainer` (and, via the local facade's builder, to
   * `buildLocalContainer`). Absent → no custom task types (the built-in picklist only).
   */
  taskTypeRegistry?: NodeContainerOptions['taskTypeRegistry']
  /**
   * App-owned DI seam for the deployment's INLINE USE CASES (mirroring `taskTypeRegistry`): a
   * deployment news a `defaultInlineUseCaseRegistry()`, registers its non-container model
   * operations on it by reference, and passes it here. `/api/v1/use-cases` then publishes and runs
   * them. Absent → an empty catalog. See backend/docs/inline-use-cases.md.
   */
  inlineUseCaseRegistry?: NodeContainerOptions['inlineUseCaseRegistry']
  /**
   * App-owned DI seam for the deployment's FOUNDATIONAL SERVICES (mirroring
   * `agentKindRegistry`): a deployment news a `defaultFoundationalServiceRegistry()`, registers
   * the shared capabilities its org already runs on it by reference, and passes it here. They
   * resolve as the `builtin` tier of every workspace's catalog. Absent → an empty catalog tier.
   */
  foundationalServiceRegistry?: NodeContainerOptions['foundationalServiceRegistry']
  /**
   * App-owned DI seam for the deployment's GENERATIVE BINARY INTEGRATIONS (the same shape once
   * more): a deployment news a `defaultBinaryGeneratorRegistry()`, registers the image / music /
   * video generation APIs it pays for on it by reference, and passes it here. A pipeline step
   * whose kind carries the `binary-output` trait then SELECTS from them
   * (`stepOptions.binaryOutput.generatorIds`). Absent → an empty registry, so any step selecting
   * an integration is refused at admission rather than dispatching an agent that cannot generate.
   */
  binaryGeneratorRegistry?: NodeContainerOptions['binaryGeneratorRegistry']
  /**
   * App-owned DI seam for the deployment's OWN BINARY ARTIFACT STORES: a deployment news a
   * `defaultBinaryStoreRegistry()`, registers stores implementing the `BinaryBlobBackend` port on
   * it by reference, and passes it here. Each becomes a `custom` choice in the account-settings
   * storage picker, and the per-account resolver builds one when an account selects it. Absent →
   * this runtime's built-in `fs` / `db` / `s3` backends alone.
   *
   * Unlike {@link binaryGeneratorRegistry} this one is per-process even in MOTHERSHIP mode, and
   * that is not an oversight: a store is a live client only the process holding the bytes can
   * build, so there is nothing for a machine API to carry and no second copy to disagree with.
   *
   * What follows from that, and is the part easy to get wrong: a store must be registered on
   * EVERY process that handles its bytes, which in mothership mode is TWO. The node writes them
   * through its own registry, and THIS process runs the artifact-retention sweep, which deletes
   * them through this one. Register only on the node and the bytes are written and never
   * reclaimed: the sweep resolves no store for those accounts, skips them, and reports the zero
   * it would report for a deployment that stores nothing (the resolver names the account and the
   * unknown store id once, which is the only signal there is).
   */
  binaryStoreRegistry?: NodeContainerOptions['binaryStoreRegistry']
  /**
   * App-owned DI seam for the deployment's PREDEFINED PIPELINES: a deployment news a
   * `defaultPipelineRegistry()`, registers (and retires) pipelines on it by reference, and passes
   * it here. Registered entries seed into every new workspace, are reconciled against the CATALOG
   * on every board read, and validate at boot. Absent → the built-in palette only.
   *
   * **In MOTHERSHIP mode a registration here decides no run**, for the same reason
   * {@link binaryGeneratorRegistry} does not: a run ADOPTS its pipeline from the catalog the
   * mothership served the board, so this node's copy is a second one by construction. Boot warns
   * and names the ids. They are still boot-VALIDATED, because a laptop is the cheapest place to
   * learn a definition names an agent kind nothing registers.
   */
  pipelineRegistry?: NodeContainerOptions['pipelineRegistry']
  /**
   * App-owned DI seam for custom POLLING GATES: a deployment news a `defaultGateRegistry()`,
   * installs the built-ins with `registerBuiltinGates(...)`, registers its own `GateDefinition`s
   * on it by reference, and passes it here. Absent → the built-in suite only.
   */
  gateRegistry?: NodeContainerOptions['gateRegistry']
  /**
   * App-owned DI seam for custom JUDGES (an inline LLM scoring a step's work against a rubric):
   * a deployment news a `defaultJudgeRegistry()`, registers its `JudgeDefinition`s on it by
   * reference, and passes it here. Absent → the empty default (the platform ships no judges).
   */
  judgeRegistry?: NodeContainerOptions['judgeRegistry']
  /**
   * App-owned DI seam for custom STEP COMPLETION RESOLVERS: a deployment news a
   * `defaultStepResolverRegistry()`, registers its resolvers on it by reference, and passes it
   * here. Absent → the empty default (the built-in `merger` resolver is a privileged engine
   * built-in, not a registry entry).
   */
  stepResolverRegistry?: NodeContainerOptions['stepResolverRegistry']
  /**
   * App-owned DI seam for VCS PROVIDERS: a deployment news a `defaultVcsRegistry()`, registers a
   * provider bundle on it by reference, and passes it here. Absent → the built-in
   * `github` + `gitlab` bundle.
   */
  vcsRegistry?: NodeContainerOptions['vcsRegistry']
  /**
   * App-owned DI seam for the deployment's best-practice PROMPT FRAGMENTS and the per-task-type
   * default sets that select them: a deployment news a `promptFragmentRegistryWithBuiltins()`,
   * registers its standards on it by reference, and passes it here. Absent → the shipped catalog
   * alone.
   *
   * Passing a bare `defaultPromptFragmentRegistry()` is how a deployment says it wants ONLY its own
   * standards; the built-ins install through the same public methods, so there is no hidden tier.
   */
  promptFragmentRegistry?: NodeContainerOptions['promptFragmentRegistry']
  /**
   * Raise selected boot-validation WARNINGS to errors, failing boot instead of logging.
   *
   * The severities are set by what the PLATFORM can know, and for one warning the DEPLOYMENT knows
   * more: `task_type_unknown_fragment` cannot separate a typo in a code-owned fragment id from a
   * legitimate account/workspace-tier id that only merges per workspace at run time. A deployment
   * whose operations reference only fragments it registers itself has no second cause, and for it
   * the warning names an operation silently running short of its own standing guidance.
   *
   *     start({
   *       escalateRegistrationWarning: (p) => p.code === 'task_type_unknown_fragment',
   *     })
   *
   * A declaration that MIXES the two tiers (code-registered standards beside a tenant-tier
   * reference) is escalated per id, because a warning names ONE `subject`. Test the namespace your
   * own code-registered ids live under, POSITIVELY:
   *
   *     escalateRegistrationWarning: (p) =>
   *       p.code === 'task_type_unknown_fragment' && p.subject.startsWith('acme.'),
   *
   * The inverse (`!p.subject.startsWith('src:')`) reads as the same rule and is not one: a
   * hand-authored account-tier row and a repo-sourced file pinning its own frontmatter `id` both
   * carry a plain slug, so it fails boot on exactly the tenant-tier reference it means to spare.
   *
   * Escalated problems join the aggregated boot failure rather than producing a second one.
   */
  escalateRegistrationWarning?: (problem: RegistrationWarning) => boolean
  /**
   * Build the resolver that supplies a registered capability's CREDENTIALS at dispatch. A tool
   * server's (MCP) and a generative binary integration's alike. Called once at composition with
   * this process's environment. Absent → the deployment-environment default,
   * `createEnvToolSecretResolver(env)`.
   *
   * The `ToolSecretResolver` port's extension seam: a deployment holding PER-WORKSPACE
   * credentials (its own sealed store, Vault) implements the port and passes it here rather
   * than reassembling the boot sequence, which is what reaching the port used to cost, and
   * which forgoes every preflight `start()` exists to provide.
   */
  createToolSecretResolver?: NodeContainerOptions['createToolSecretResolver']
  /**
   * Whether this node's environment answers a capability credential the workspace has not
   * stored. Defaults to true; a multi-tenant deployment sets it false so a tenant that has
   * typed nothing resolves nothing instead of silently running on the operator's own vendor
   * account. See `NodeContainerOptions.capabilityCredentialEnvironmentFallback`.
   */
  capabilityCredentialEnvironmentFallback?: NodeContainerOptions['capabilityCredentialEnvironmentFallback']
  /**
   * The address to bind the HTTP listener to. Defaults to `HOST` from the env, else
   * all interfaces. A facade or operator can pass `127.0.0.1` to keep the service off
   * the LAN, but note repo-operating agent containers reach this service's LLM proxy
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
   * DEFAULT (`MODEL_PRESET_SEED_IDS.{kimi,glm,claude,chatgpt}`). A deploy-app wrapper passes this to
   * change the out-of-the-box default without editing library code, e.g.
   * `start({ defaultModelPresetId: MODEL_PRESET_SEED_IDS.claude })`. Forwarded to
   * `buildNodeContainer` (and, via the local facade's builder, to `buildLocalContainer`).
   * Applied only at FIRST seed of a workspace's preset library, so a user's later manual
   * default choice is always preserved. Omitted ⇒ the facade default (Node → Kimi K2.7).
   */
  defaultModelPresetId?: string
  /**
   * A deployment's pre-declared environment-handler seeds (each a `RegisterHandlerInput`). A
   * deploy-app wrapper passes this so the server auto-registers the deployment's infra handlers
   * per workspace with no manual SPA step. Forwarded onto the `NodeContainerOptions` handed to
   * `buildContainer` (so it
   * rides through `createCore`), and used AFTER listen to boot-backfill every existing workspace;
   * new workspaces are seeded by `WorkspaceService.create`. Also reaches `buildLocalContainer` via
   * the local facade's builder. Omitted ⇒ no seeding.
   */
  seedEnvironmentHandlers?: NodeContainerOptions['seedEnvironmentHandlers']
  /**
   * A deployment's pre-declared SHARED STACKS (each a `CreateSharedStackInput`): the long-lived
   * compose infra its previews attach to. Threaded and backfilled exactly like
   * {@link seedEnvironmentHandlers}; a seed's ordered compose layers may be inline documents,
   * paths in another repo, or paths in the stack's own clone, so a deployment can describe a
   * service's full infra dependencies in code. Omitted ⇒ no seeding.
   */
  seedSharedStacks?: NodeContainerOptions['seedSharedStacks']
  /**
   * Optional last-mile transform over the {@link ConfigProblem} list before the misconfiguration
   * fallback is served, letting a sibling facade layer a facade-specific remedy onto the shared
   * problems. Local mode passes one that advertises its `.env`-generating CLI (which the hosted
   * Node/Worker facades have no analogue for) ABOVE the per-variable remedies. Absent ⇒ the
   * problems are served verbatim.
   */
  augmentConfigProblems?: (problems: ConfigProblem[]) => ConfigProblem[]
}

/**
 * Boot the Node HTTP server: connect to Postgres (`DATABASE_URL`), ensure the schema,
 * start pg-boss + the durable execution worker + the stale-run sweeper, build the app,
 * and listen. Registers SIGTERM/SIGINT handlers for a clean, ordered shutdown.
 */
export async function start(options: StartOptions = {}): Promise<ReturnType<typeof serve>> {
  const env = options.env ?? process.env
  // Before ANYTHING else: apply the configured verbosity and arm the process-level guards, so a
  // failure inside boot itself (a bad binding, a Postgres that never answers) is logged at the
  // operator's chosen level rather than lost. `LOG_LEVEL` is a plain env var, not part of
  // `AppConfig`, precisely so it applies before config validation can reject the boot.
  setLogLevel(parseLogLevel(env.LOG_LEVEL))
  installProcessFailureGuards(logger)
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

/**
 * Bring up every pg-boss consumer as ONE parallel wave (app-startup initiative, item 2). Each is an
 * independent `createQueue(name)` + `work(name)` on its OWN queue with no ordering dependency
 * between them, so awaiting them serially cost ~10 back-to-back DB round trips on the boot path for
 * no reason; the wave collapses that to ~2.
 *
 * Called AFTER `boss.start()` and BEFORE listen: the documented invariant is that an enqueued job
 * always has a consumer (revisiting that ordering is item 11, not this slice). A parked run waits
 * for a human indefinitely (no decision timeout); the escalating notification — not a killed run —
 * signals a human is overdue.
 *
 * Extracted from {@link bootServer} to keep it within the function-size budget, alongside
 * {@link startBackgroundSweepers}; the set + concurrency are unchanged.
 */
async function startDurableWorkers(
  boss: PgBoss,
  container: ServerContainer,
  runtime: ReturnType<typeof executionRuntime>,
): Promise<void> {
  const opts = { concurrency: runtime.concurrency }
  await Promise.all([
    startExecutionWorker(boss, container, runtime.drive, logger, opts),
    // Durably drive bootstrap runs too (the Worker uses a per-run BootstrapWorkflow);
    // a no-op queue when the bootstrap module isn't wired.
    startBootstrapWorker(boss, container, runtime.drive, logger, opts),
    // Durably drive env-config-repair runs (the Worker uses a per-run EnvConfigRepairWorkflow);
    // a no-op queue when the repair module isn't wired.
    startEnvConfigRepairWorker(boss, container, runtime.drive, logger, opts),
    // Durably drive ephemeral-environment self-test runs (the Worker uses a per-run
    // EnvironmentTestWorkflow); a no-op queue when the environments module isn't wired.
    startEnvTestWorker(boss, container, runtime.drive, logger, opts),
    // Async GitHub ingest (the analogue of the Worker's GITHUB_SYNC_QUEUE consumer +
    // GitHubBackfillWorkflow): drain the `github.sync` queue the gateway seams enqueue onto,
    // so webhook deliveries / resyncs / backfills apply out of band and the request acks fast.
    startGitHubSyncWorker(boss, container, logger, opts),
    // Async TRACKER ingest (the analogue of the Worker's TRACKER_SYNC_QUEUE consumer): drain the
    // `tracker.sync` queue the webhook receiver enqueues onto, so a pushed issue event fires its
    // intake schedule — and a ticket reply drives the parked review — out of band, while the
    // tracker gets its prompt 2xx. A no-op queue when task sources aren't wired.
    startTrackerSyncWorker(boss, container, logger, opts),
  ])
}

/**
 * Start every background sweeper (the setInterval-based maintenance timers) after the listener
 * binds, returning each one's stop fn so {@link bootServer}'s ordered shutdown can halt them.
 * Extracted from `bootServer` to keep it within the statement budget; the set + order is unchanged.
 */
function startBackgroundSweepers(deps: {
  boss: PgBoss
  pool: ReturnType<typeof createDbClient>['pool']
  db: ReturnType<typeof createDbClient>['db']
  container: ServerContainer
  repos: ReturnType<typeof createDrizzleRepositories>
  runtime: ReturnType<typeof executionRuntime>
  clock: SystemClock
  env: NodeJS.ProcessEnv
}) {
  const { boss, pool, db, container, repos, runtime, clock, env } = deps
  const stopSweeper = startStaleRunSweeper(boss, pool, container, runtime.sweeper, runtime.queue, {
    log: logger,
    metrics: operationalMetrics,
    health: sweepHealth,
  })
  // Env-test self-tests live in their own table (not agent_runs), so the stale-run
  // sweeper above never sees them — this sibling re-enqueues a drive for any stale run;
  // the drive's own budget-exhaustion finalize settles one that still can't finish.
  // Reads the LOCAL store directly (sweeping is deployment-internal, like the other
  // `listStale` surfaces): on a satellite the local table is empty and this no-ops.
  const stopEnvTestSweeper = startEnvTestSweeper(
    new PgBossEnvironmentTestRunner(boss, runtime.queue),
    new DrizzleEnvironmentTestRunRepository(db),
    { leaseMs: runtime.sweeper.leaseMs, intervalMs: runtime.sweeper.intervalMs },
    logger,
    operationalMetrics,
    sweepHealth,
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
      agentToolCallRepository: repos.agentToolCallRepository,
      pipelineScheduleRepository: repos.pipelineScheduleRepository,
      subscriptionActivationRepository: new DrizzleSubscriptionActivationRepository(db),
      subscriptionQuotaCycleRepository: repos.subscriptionQuotaCycleRepository,
      provisioningLogRepository: repos.provisioningLogRepository,
      passwordResetTokenRepository: repos.passwordResetTokenRepository,
      machineNodeRepository: repos.machineNodeRepository,
      authAttemptRepository: repos.authAttemptRepository,
      commitRepository: new DrizzleCommitProjectionRepository(db),
      notificationRepository: new DrizzleNotificationRepository(db),
      // Both operator-observability projections live in the main DB beside `agent_runs`.
      gateOutcomeRepository: repos.gateOutcomeRepository,
      platformMetricsRepository: repos.platformMetricsRepository,
      // The account audit log, in its own `audit` schema: audit retention is measured in years
      // and gets its own knob, so it can never be shortened by tuning something else.
      auditEventRepository: repos.auditEventRepository,
      // The durable cost-attribution rollup: this sweep is its only writer, and prunes it
      // nowhere (see `RetentionRepos`).
      spendRollupRepository: repos.spendRollupRepository,
    },
    container.config.retention,
    clock,
    logger,
    sweepHealth,
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
        sweepHealth,
      )
    : () => {}
  // Fire due recurring pipelines on a one-minute timer (the Worker uses cron).
  const stopScheduleSweeper = startScheduleSweeper(container, clock, logger, sweepHealth)
  // Tick the initiative execution loop on a one-minute timer (the Worker uses cron); reconciles
  // + spawns for every executing initiative. Terminal child runs poke the loop directly, so this
  // is the backstop cadence; no-op unless the initiatives module is wired. Resolve the interval
  // from the INJECTED `env` (not `process.env`) so an `INITIATIVE_LOOP_INTERVAL_MS` passed through
  // `start({ env })` is honoured — the e2e backend relies on the fast sweep for its first spawn.
  const stopInitiativeLoop = startInitiativeLoopSweeper(
    container,
    clock,
    logger,
    sweepHealth,
    resolveSweepInterval(env),
  )
  // Tear down expired ephemeral environments (the Worker uses cron); no-op unless the
  // environments integration is wired.
  const stopEnvironmentSweeper = startEnvironmentSweeper(container, clock, logger, sweepHealth)
  // Escalate long-waiting notifications yellow → red (the Worker uses cron); the
  // overdue-human signal now that runs never time out waiting for input.
  const stopNotificationEscalation = startNotificationEscalationSweeper(
    container,
    clock,
    logger,
    sweepHealth,
  )
  // Run pending Kaizen gradings on a one-minute timer (the Worker uses cron); no-op
  // unless the Kaizen feature is wired.
  const stopKaizenSweeper = startKaizenSweeper(container, clock, logger, sweepHealth)
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
        sweepHealth,
      )
    : () => {}
  // Push deployment-level (platform-operator) observability aggregates to the OTLP endpoint
  // as OpenTelemetry gauge metrics (the Worker uses cron). No-op unless the platform
  // observability read is wired AND `OTEL_PLATFORM_METRICS` opted in on top of the exporter.
  const stopPlatformMetrics = container.platformObservability
    ? startPlatformMetricsSweeper(
        {
          otel: container.config.otel,
          platformObservability: container.platformObservability,
          workspaceRepository: repos.workspaceRepository,
          // The queue gauge rides the SAME flush as the counters, so an operator sees backlog
          // and the events that caused it on one timeline. One `getQueues()` per tick answers
          // every queue, so this is an aggregate read, not a per-queue probe loop.
          probeQueueDepth: () => probePgBossQueueDepth(boss),
        },
        clock,
        logger,
        operationalMetrics,
        sweepHealth,
      )
    : () => {}
  // Raise/clear `platform_health` notifications when the deployment's own run health crosses a
  // threshold (the Worker uses cron). No-op unless `PLATFORM_ALERTS` is opted in and the
  // notifications + platform-observability reads are wired.
  const stopPlatformHealth = startPlatformHealthSweeper(container, clock, logger, sweepHealth)
  // Probe each workspace's CONFIGURED infrastructure connections and report a dead one as
  // `unreachable` (the Worker uses cron). No-op unless `INFRA_REACHABILITY_WATCH` is opted in.
  const stopInfraReachability = startInfraReachabilitySweeper(container, clock, logger, sweepHealth)
  // Warn a workspace that its spend is crossing a budget threshold or is projected to overrun,
  // while there is still time to act (the Worker uses cron). No opt-in flag: a configured budget
  // is the opt-in, and the sweep no-ops when notifications are unwired.
  const stopSpendAlerts = startSpendAlertSweeper(container, clock, logger, sweepHealth)
  // Refresh repo-linked foundational-service sources so a merged contract change reaches the
  // catalog without anyone opening the management surface (the Worker uses cron). No-op unless
  // the catalog + GitHub are both wired.
  const stopFoundationalSources = startFoundationalSourceSweeper(container, logger, sweepHealth)
  // Re-import connected SERVICE CATALOGS (developer portals) on its own, longer window, so a
  // service the organisation retired stops being handed to agents as current. No-op unless the
  // catalog and its encryption key are both wired.
  const stopServiceCatalog = startServiceCatalogSweeper(container, logger, sweepHealth)
  // Report what has landed in the dead-letter queues (slice 4.5). Reporting only, never a
  // replay: a job that failed every retry will fail again, so the decision to re-drive one
  // stays a human's. Before this, a job that exhausted `retryLimit` simply stopped existing.
  const stopDeadLetter = startSweeper({
    name: 'dead-letter',
    intervalMs: DEAD_LETTER_SWEEP_INTERVAL_MS,
    log: logger,
    health: sweepHealth,
    failureMessage: 'dead-letter sweep failed',
    tick: async () => {
      await sweepDeadLetterQueues(boss, logger)
    },
  })
  return {
    stopSweeper,
    stopDeadLetter,
    stopEnvTestSweeper,
    stopRetention,
    stopArtifactRetention,
    stopScheduleSweeper,
    stopInitiativeLoop,
    stopEnvironmentSweeper,
    stopNotificationEscalation,
    stopKaizenSweeper,
    stopGitHubReconcile,
    stopPlatformMetrics,
    stopPlatformHealth,
    stopInfraReachability,
    stopSpendAlerts,
    stopFoundationalSources,
    stopServiceCatalog,
  }
}

/**
 * Boot backfill for a deployment's DECLARED SEEDS — the environment handlers that provision an
 * environment, and the shared stacks its previews attach to: idempotently ensure each exists for
 * EVERY existing workspace, so a deployment that ships them doesn't need a per-workspace manual SPA
 * step (new workspaces are covered by `WorkspaceService.create`). A no-op for a seeder that isn't
 * wired, or whose seed list is empty (the seeder itself is then a no-op). BEST-EFFORT: a
 * per-workspace failure is logged and skipped, and a total failure (e.g. the workspace enumeration
 * itself) is caught — a seed failure must never crash boot. Shared by the Node boot (after listen)
 * and the local mothership boot (which doesn't run `bootServer`).
 *
 * The workspace list is enumerated ONCE and both seeders run over it, so adding a seeded primitive
 * costs no extra pass. Enumerates via `workspaceService.list(null)` — a null `WorkspaceVisibility`
 * returns ALL boards (the auth-disabled path) — which is exactly the boot-time "every workspace"
 * set. (The container exposes `workspaceService`, not a bare `workspaceRepository`; `list`
 * delegates to `listVisible(null)`.)
 */
export async function backfillDeclaredSeeds(
  container: Pick<
    ServerContainer,
    'environmentHandlerSeeder' | 'sharedStackSeeder' | 'workspaceService'
  >,
  log: Logger,
): Promise<void> {
  const seeders = [
    { label: 'environment-handler', seeder: container.environmentHandlerSeeder },
    { label: 'shared-stack', seeder: container.sharedStackSeeder },
  ].filter((entry) => entry.seeder !== undefined)
  if (seeders.length === 0) return
  try {
    const workspaces = await container.workspaceService.list(null)
    for (const ws of workspaces) {
      for (const { label, seeder } of seeders) {
        try {
          await seeder!.ensureForWorkspace(ws.id)
        } catch (err) {
          log.warn(`${label} seed backfill failed for workspace`, {
            workspaceId: ws.id,
            err: getErrorMessage(err),
          })
        }
      }
    }
  } catch (err) {
    log.warn('declared-seed backfill could not enumerate workspaces', {
      err: getErrorMessage(err),
    })
  }
}

/**
 * Stop every background sweeper.
 *
 * Generic over the returned bag rather than a list of calls, so a sweeper added to
 * {@link startBackgroundSweepers} is stopped on shutdown by construction. The ORDER among them is
 * not significant (each is a `clearInterval`), and it is the object's insertion order anyway; what
 * IS significant is that all of them stop before the realtime hub, the pool and the log sink, which
 * the caller keeps in sequence around this one call.
 */
function stopAll(sweepers: Record<string, () => void>): void {
  for (const stop of Object.values(sweepers)) stop()
}

/** The real boot sequence, wrapped by {@link start} so a {@link ConfigValidationError} falls back. */
async function bootServer(
  options: NonNullable<Parameters<typeof start>[0]>,
  env: NodeJS.ProcessEnv,
): Promise<ReturnType<typeof serve>> {
  // Boot-phase instrumentation (app-startup initiative, item 1): bracket each phase so the "ready"
  // line below reports where the boot seconds actually go. Cheap `performance.now()` marks; the
  // summary is logged once, after listen.
  const bootClock = startBootClock()
  const { db, pool, boss, encryptionKey, isBossRunning } = await bootPersistence(env, bootClock)
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
    operationalMetrics,
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
    taskTypeRegistry: options.taskTypeRegistry,
    inlineUseCaseRegistry: options.inlineUseCaseRegistry,
    foundationalServiceRegistry: options.foundationalServiceRegistry,
    binaryGeneratorRegistry: options.binaryGeneratorRegistry,
    binaryStoreRegistry: options.binaryStoreRegistry,
    pipelineRegistry: options.pipelineRegistry,
    gateRegistry: options.gateRegistry,
    judgeRegistry: options.judgeRegistry,
    stepResolverRegistry: options.stepResolverRegistry,
    vcsRegistry: options.vcsRegistry,
    promptFragmentRegistry: options.promptFragmentRegistry,
    createToolSecretResolver: options.createToolSecretResolver,
    capabilityCredentialEnvironmentFallback: options.capabilityCredentialEnvironmentFallback,
    // Forward the deployment's default-preset choice (undefined ⇒ the builder's facade
    // default). The local facade rides on this same field via its `buildContainer` override.
    defaultModelPresetId: options.defaultModelPresetId,
    // Forward the deployment's environment-handler seeds onto `o` so they reach `createCore`
    // (and, via the local facade's builder, `buildLocalContainer`). The boot backfill below runs
    // the resulting `container.environmentHandlerSeeder` over every existing workspace.
    seedEnvironmentHandlers: options.seedEnvironmentHandlers,
    // …and its declared shared stacks, forwarded the same way and backfilled by the same call.
    seedSharedStacks: options.seedSharedStacks,
  })
  bootClock.mark('container')
  // Install the OTLP log export as soon as config is resolved (a no-op unless `OTEL_LOGS=true`
  // on top of a configured exporter), so everything from here on (registration validation, the
  // sweepers, every request) reaches the operator's log backend as well as stdout. It
  // cannot start earlier: the endpoint is config, and config is what the boot before this
  // point is busy resolving.
  const logExport = startOtelLogExport(container.config.otel, logger)
  // ADR 0026 D6.2: a one-shot drift sweep at boot — attempt to decrypt every sealed credential
  // and raise ONE `key_drift` card per affected workspace (or clear a stale one), so drift is a
  // single legible issue instead of a stream of opaque per-request errors. Runs after the
  // container is built (it needs the notifications module + the inventory). Best-effort +
  // fire-and-forget so it never delays the listen; a no-op when unwired (no ENCRYPTION_KEY).
  if (encryptionKey) {
    void sweepKeyDriftAndRaise(
      container,
      (info) => new WebCryptoSecretCipher({ masterKeyBase64: encryptionKey, info }),
      logger.child({ sweep: 'key-drift' }),
    ).catch((error: unknown) => logger.warn('key drift sweep failed', { err: String(error) }))
  }
  // Connect the cross-node adapters (a no-op when none are configured) so peer events start
  // reaching this node's browsers.
  await realtimePropagator.start(logger)
  bootClock.mark('bus')
  // Best-effort boot probe of the Redis bus (A7): when REDIS_URL is set but the bus is
  // unreachable, ioredis retries silently in the background and cross-node realtime + cache
  // coherence are quietly degraded. One bounded, non-fatal probe surfaces that at boot with the
  // host and how to verify, instead of leaving the operator to discover it from stale peers.
  // FIRE-AND-FORGET (app-startup initiative, item 5): the probe is diagnostics-only — ioredis
  // retries regardless — so a set-but-down bus must NOT hold the listener for the probe's full
  // ~3.5s bound, precisely the degraded case where the replica should start serving SOONER. It
  // logs its one warning if/when the bounded probe later resolves; a no-op when REDIS_URL is unset
  // (single-node / local mode).
  warnIfRedisUnreachableInBackground(env, logger)

  // Validate the registered extensions (gates / agent kinds) once, before serving — every
  // `register*` import side effect has run by now. A typo'd gate helperKind or an unknown
  // resultView fails loudly here instead of mid-run. Mirrors the Worker's first-request guard.
  validateRegistrationsOnce({
    // The CONTAINER, not a hand-picked list of its registries: it satisfies `ValidatedRegistries`
    // wholly, so a registry the validator gains later is checked here with no edit, and this call
    // site cannot fall behind its siblings the way the local mothership one did.
    registries: container,
    onWarn: logRegistrationWarning(logger),
    // Deployment policy over platform judgement: a warning the platform must keep soft (because it
    // structurally cannot see the answer) may be a hard defect for THIS deployment, which knows
    // whether its own registrations use the tenant tier at all.
    escalateWarning: options.escalateRegistrationWarning,
  })

  const runtime = executionRuntime(container.config, env)
  await startDurableWorkers(boss, container, runtime)
  bootClock.mark('workers')
  // Readiness probe for `/ready`: a live Postgres round-trip, the pg-boss graceful-stop flag AND
  // a real round-trip through pg-boss's OWN connection, draining the instant shutdown begins so a
  // load balancer stops routing here while in-flight requests finish. The boss round-trip is
  // slice 4.3: the flag alone only ever observed the clean `stopped` transition, so a boss whose
  // substrate died under a running process reported healthy forever — the one thing a readiness
  // probe exists to catch. `getQueues()` is a metadata read through pg-boss's own pool (the app's
  // `SELECT 1` uses a different one), so it fails exactly when that pool is gone.
  const readiness = makeReadinessProbe({
    ping: async () => {
      await pool.query('SELECT 1')
    },
    pgBossHealthy: isBossRunning,
    pgBossPing: async () => {
      await boss.getQueues()
    },
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
    // Mothership-mode INBOUND real-time: a Node deployment can be a mothership, so accept the
    // machine-authed per-workspace subscription on this listener too. The scope binding reads the
    // deployment's OWN workspace store — the same resolver the persistence RPC and the upstream
    // publish endpoint scope against.
    machineSubscribe: {
      accountOf: (workspaceId) => repos.workspaceRepository.accountOf(workspaceId),
      // A revoked node must not keep reading workspace events (SEC-5).
      isRevoked: (nodeId) => repos.machineNodeRepository.isRevoked(nodeId),
    },
  })
  bootClock.mark('listen')
  // One structured line naming where the boot seconds went (app-startup initiative, item 1). The
  // per-phase breakdown is what every later optimization slice reports its before/after against.
  const timings = bootClock.summary()
  logger.info(`cat-factory node server ready in ${timings.totalMs} ms`, timings)

  // The background sweepers only schedule `setInterval`s (no work runs until a timer fires), so
  // start them AFTER the listener binds — the server accepts requests a few ms sooner. The pg-boss
  // workers above stay before listen so an enqueued job always has a consumer.
  // Held as ONE object rather than destructured: every entry is a `clearInterval` closure and the
  // shutdown below stops all of them, so naming each sweeper a third time bought nothing but a
  // place to forget one.
  const sweepers = startBackgroundSweepers({
    boss,
    pool,
    db,
    container,
    repos,
    runtime,
    clock,
    env,
  })

  // Backfill the deployment's declared environment-handler seeds onto every existing workspace
  // (idempotent; new workspaces are seeded by WorkspaceService.create). FIRE-AND-FORGET after the
  // listener binds so it never delays serving; best-effort + fully logged inside, and a no-op when
  // no seeder/seeds are wired — a seed failure must never crash boot.
  void backfillDeclaredSeeds(container, logger)

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
    logger.info('shutting down cat-factory node server', { signal })
    stopAll(sweepers)
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
      logger.error('shutdown error', { err: getErrorMessage(err) })
    }
    try {
      // Facade-owned disposables (e.g. the local facade's native host-process harnesses) —
      // released in their OWN try so a failing boss.stop()/pool.end() above can't skip them and
      // orphan the in-flight agent children they abort. Graceful teardown beats the exit-hook
      // backstop.
      await container.onShutdown?.()
    } catch (err) {
      logger.error('onShutdown error', { err: getErrorMessage(err) })
    }
    // LAST, and after every other stop: detach the log sink and deliver what it still holds,
    // so the shutdown's own lines (including the two errors above, which are exactly the ones
    // worth having) leave the process before it does. A no-op when the export is not wired.
    await logExport.stop()
    process.exit(0)
  }
  process.once('SIGTERM', () => void shutdown('SIGTERM'))
  process.once('SIGINT', () => void shutdown('SIGINT'))

  return server
}
