import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { serve } from '@hono/node-server'
import {
  type AgentKindRegistry,
  DEFAULT_APP_CACHES_PROFILE,
  NodeRealtimeHub,
  createApp,
  serveAppWithRealtime,
  start,
} from '@cat-factory/node-server'
import { logger } from '@cat-factory/server'
import { validateRegistrationsOnce } from '@cat-factory/orchestration'
import { applyLocalDefaults } from './config.js'
import { buildLocalContainer } from './container.js'
import { githubPatCreationUrl } from './github.js'
import {
  RECOMMENDED_HARNESS_IMAGE,
  type ImageExec,
  refreshHarnessImage,
  resolveHarnessImage,
  resolveRefreshMode,
} from './harnessImage.js'
import { isMothershipMode } from './mothership.js'
import { createRuntimeAdapter, resolveRuntimeId } from './runtimes/index.js'

const execFileAsync = promisify(execFile)

// Boot the local-mode service. It reuses the Node facade's `start()` — Postgres +
// pg-boss + the execution worker + sweepers, served over @hono/node-server — passing
// the local composition root so agent jobs run in local containers (Docker/Podman/
// OrbStack/Colima/Apple `container`) and GitHub is reached via a PAT. Requires
// DATABASE_URL (point it at the local Postgres); set LOCAL_HARNESS_IMAGE to run
// repo-operating agent jobs (without it the board still serves and only container
// kinds fail, loudly).
//
// A native ephemeral-environment backend (e.g. the built-in `kubernetes` one, or a
// third-party adapter) is selected per-workspace from the env-backend registry by the
// stored connection `kind` — registered as an import side effect, no facade seam needed.
// `buildContainer` is intentionally NOT exposed: overriding it would discard local mode's
// differentiators (local container transport, PAT-backed GitHub client).
export async function startLocal(
  options: {
    env?: NodeJS.ProcessEnv
    host?: string
    /**
     * App-owned DI seam for custom agent kinds — a deployment news a
     * `defaultAgentKindRegistry()`, registers its own kinds on it, and passes it here.
     * Threaded through to `buildLocalContainer` (both the Postgres and mothership paths).
     * Absent → the built-in-only default.
     */
    agentKindRegistry?: AgentKindRegistry
  } = {},
): Promise<Awaited<ReturnType<typeof start>>> {
  const env = options.env ?? process.env

  // The auth gate defaults OPEN in local mode and the listener binds to all interfaces
  // (so on native Linux Docker the agent containers can reach the LLM proxy via the
  // bridge gateway). That combination means anyone on your network can reach the API —
  // surface it so it is a choice, not a surprise. Lock it down with AUTH_DEV_OPEN=false,
  // or HOST=127.0.0.1 on Docker Desktop (where host.docker.internal still resolves).
  const localized = applyLocalDefaults(env)

  // Container-runtime preflight: log the selected runtime + its capabilities + the host
  // alias the harness will use to reach this service, and probe that the CLI is present.
  // A misconfigured runtime then fails loud at boot rather than on the first dispatch.
  await preflightRuntime(localized)

  // Harness-image preflight: resolve the effective image (an explicit LOCAL_HARNESS_IMAGE, else
  // the backend-matched RECOMMENDED_HARNESS_IMAGE) and refresh it so a rerun can't launch a
  // stale — or, via a mutable `:latest`, a too-new — harness image. Fire-and-forget so a slow
  // (potentially multi-GB) pull never delays serving the board: it never throws, and the
  // container transport is built lazily on first dispatch, so the refresh races ahead of any
  // actual use. Disable with LOCAL_HARNESS_IMAGE_REFRESH=off.
  void preflightHarnessImage(localized).catch(() => {})

  // NB: reaping per-run containers a previous run orphaned (a crash/hard kill leaves exited
  // managed containers behind) + draining pool orphans + pre-warming is done on the SERVING
  // transport, which `buildLocalContainer` builds (with the DB-stored pool config) and warms
  // eagerly at boot when an image is configured — so it is not repeated here.

  // Source control is reached via a PAT in local mode (there is no GitHub-App connect flow):
  // a GITHUB_PAT or a GITLAB_PAT. Without EITHER the board still serves, but every repo-
  // operating agent step — clone, push, open PR/MR, the CI gate, the real merge — fails.
  // Surface it at boot with a click-through URL that pre-selects the scopes, so it is a
  // one-step fix rather than a runtime surprise.
  if (!localized.GITHUB_PAT?.trim() && !localized.GITLAB_PAT?.trim()) {
    logger.warn(
      `local mode: neither GITHUB_PAT nor GITLAB_PAT is set — agent steps that clone, push, ` +
        `open PRs/MRs, gate on CI or merge will fail. Create a GitHub token (scopes pre-selected) ` +
        `at ${githubPatCreationUrl()} then set GITHUB_PAT (or set GITLAB_PAT for GitLab) and restart.`,
    )
  }

  if (localized.AUTH_DEV_OPEN !== 'false' && !env.HOST?.trim()) {
    logger.warn(
      'local mode: the auth gate is OPEN and the server binds to all interfaces — anyone ' +
        'on your network can reach the API. Set AUTH_DEV_OPEN=false, or HOST=127.0.0.1 on ' +
        'Docker Desktop, to restrict it.',
    )
  }

  // Mothership mode boots WITHOUT Postgres (no DATABASE_URL / migrate / pg-boss): org/durable
  // state lives on the mothership and runs are driven by the in-process work runner. Take the
  // dedicated boot path instead of the Node facade's `start()` (which requires Postgres).
  if (isMothershipMode(localized)) {
    return startLocalMothership(localized, options.host, options.agentKindRegistry)
  }

  return start({
    // The LOCALIZED env, not the raw one: `start()` builds the shared app via `createApp`,
    // whose CORS middleware reads `env.ENVIRONMENT` / `env.CORS_ALLOWED_ORIGINS` DIRECTLY
    // (not via AppConfig). Passing the raw env would drop every `applyLocalDefaults` default
    // for those direct reads — the reason the SPA hit a CORS wall until the operator set
    // CORS_ALLOWED_ORIGINS by hand. `buildLocalContainer` re-applies the defaults idempotently.
    env: localized,
    host: options.host,
    agentKindRegistry: options.agentKindRegistry,
    buildContainer: (o) => buildLocalContainer(o),
    // Pass the repo projection through live: local mode seeds `github_repos` via the
    // out-of-process `link-repo` CLI and runs single-node with no invalidation bus, so an
    // in-memory TTL'd entry would keep serving a pre-link (or pre-monorepo-flag) projection
    // after the CLI writes it. Same isolate-safe reasoning as the Worker; the resolver reads
    // live and the (no-op) invalidations on the in-process sync/bootstrap paths stay wired.
    cachesProfile: {
      repoProjection: { ...DEFAULT_APP_CACHES_PROFILE.repoProjection, enabled: false },
    },
  })
}

/**
 * Boot the local-mode service in MOTHERSHIP mode: no Postgres, no pg-boss. The container
 * (built by {@link buildLocalContainer}) composes the remote (RPC-backed) org repositories +
 * the local `node:sqlite` credential store, and carries the in-process work runner that drives
 * runs through the same advance/poll loop. This serves the SAME shared Hono app + WebSocket
 * event transport the Node boot does — only the durable-execution + persistence substrate
 * differs.
 *
 * The periodic Postgres-backed sweepers the Node `start()` runs (retention, recurring-pipeline
 * fire, notification escalation, Kaizen) are intentionally NOT started here: they prune/scan
 * stores that live on the mothership (its own cron owns them). Durable execution IS now provided
 * locally — the container's work runner is backed by a file-based `node:sqlite` work queue (the
 * no-pg-boss analogue), so a crash/restart re-drives in-flight runs; telemetry local-first sync
 * remains a later initiative slice (PR 5).
 */
async function startLocalMothership(
  env: NodeJS.ProcessEnv,
  host?: string,
  agentKindRegistry?: AgentKindRegistry,
): Promise<Awaited<ReturnType<typeof serve>>> {
  logger.info(
    { mothership: env.LOCAL_MOTHERSHIP_URL },
    'local mode: booting in MOTHERSHIP mode (no local Postgres; org state served remotely)',
  )
  // Shared with the engine's event publisher (wired inside the container) and the HTTP
  // server's WebSocket upgrade listener below, exactly as the Node `start()` does. Local
  // mode is always single-node, so the bare hub IS the real-time sink — no cross-node
  // propagator (Redis) is wired here.
  const realtimeHub = new NodeRealtimeHub()
  const container = buildLocalContainer({ env, realtimeSink: realtimeHub, agentKindRegistry })

  // Validate registered gates / agent kinds once before serving (parity with `start()`).
  validateRegistrationsOnce({
    agentKindRegistry: container.agentKindRegistry,
    onWarn: (problem) => logger.warn({ code: problem.code }, problem.message),
  })

  const app = createApp(container, env)
  // Shared serve + WebSocket-upgrade helper (one implementation with `start()`, so port/host
  // resolution can't drift). The shutdown sequence stays local because it differs from `start()`:
  // no pg-boss/pool to stop, but the local credential SQLite handle to release.
  const { server, stopRealtime } = serveAppWithRealtime({
    app,
    realtimeHub,
    auth: container.config.auth,
    env,
    host,
    label: 'cat-factory local (mothership) server',
  })

  let shuttingDown = false
  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info({ signal }, 'shutting down cat-factory local (mothership) server')
    stopRealtime()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    // Release the local credential SQLite handle (mothership mode owns it).
    await container.onShutdown?.()
    process.exit(0)
  }
  process.once('SIGTERM', () => void shutdown('SIGTERM'))
  process.once('SIGINT', () => void shutdown('SIGINT'))

  return server
}

/**
 * Log the resolved container runtime + capabilities + networking, and probe that its CLI
 * is installed. Non-fatal: the board still boots if the binary is missing (only
 * container-backed agent kinds then fail), mirroring how a missing image is handled.
 */
async function preflightRuntime(localized: NodeJS.ProcessEnv): Promise<void> {
  const adapter = createRuntimeAdapter(localized)
  logger.info(
    {
      runtime: resolveRuntimeId(localized),
      binary: adapter.binary,
      localDind: adapter.capabilities.localDind,
      hostAlias: adapter.hostAlias,
      publicUrl: localized.PUBLIC_URL,
    },
    'local mode: container runtime selected',
  )
  if (!adapter.capabilities.localDind) {
    logger.info(
      `local mode: the '${resolveRuntimeId(localized)}' runtime cannot run the Tester's local ` +
        `docker-compose infra (no Docker-in-Docker). Tasks must use the ephemeral test ` +
        `environment (with an environment provider configured) or a 'No infra dependencies' ` +
        `service; a local-infra Tester run is refused at start.`,
    )
  }
  try {
    await execFileAsync(adapter.binary, ['--version'], { timeout: 10_000 })
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), binary: adapter.binary },
      `local mode: container CLI '${adapter.binary}' is not runnable — repo-operating agent ` +
        `steps will fail until it is installed and on PATH (or set LOCAL_DOCKER_BINARY / ` +
        `LOCAL_CONTAINER_RUNTIME).`,
    )
  }
}

/**
 * Resolve + refresh the executor-harness image at boot so a rerun uses the version this backend
 * is matched to rather than a stale local copy. Delegates the logic (and its logging) to
 * {@link refreshHarnessImage}; this wrapper only supplies the runtime binary + a real exec seam.
 */
async function preflightHarnessImage(localized: NodeJS.ProcessEnv): Promise<void> {
  const adapter = createRuntimeAdapter(localized)
  await refreshHarnessImage({
    image: resolveHarnessImage(localized),
    recommended: RECOMMENDED_HARNESS_IMAGE,
    binary: adapter.binary,
    runtimeId: resolveRuntimeId(localized),
    mode: resolveRefreshMode(localized),
    exec: makeImageExec(adapter.binary),
    log: { info: (m) => logger.info(m), warn: (m) => logger.warn(m) },
  })
}

/** A container-CLI runner that captures stdout + a normalised exit status (0 = success). */
function makeImageExec(binary: string): ImageExec {
  return async (args) => {
    try {
      const { stdout } = await execFileAsync(binary, args, {
        timeout: 120_000,
        maxBuffer: 10 * 1024 * 1024,
      })
      return { status: 0, stdout: stdout ?? '' }
    } catch (err) {
      const e = err as { code?: number; stdout?: string }
      return { status: typeof e.code === 'number' ? e.code : 1, stdout: e.stdout ?? '' }
    }
  }
}
