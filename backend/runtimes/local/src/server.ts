import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { start } from '@cat-factory/node-server'
import { logger } from '@cat-factory/server'
import { applyLocalDefaults } from './config.js'
import { buildLocalContainer } from './container.js'
import { githubPatCreationUrl } from './github.js'
import { createLocalContainerTransportFromEnv } from './LocalContainerRunnerTransport.js'
import { createRuntimeAdapter, resolveRuntimeId } from './runtimes/index.js'

const execFileAsync = promisify(execFile)

// Boot the local-mode service. It reuses the Node facade's `start()` — Postgres +
// pg-boss + the execution worker + sweepers, served over @hono/node-server — passing
// the local composition root so agent jobs run in local containers (Docker/Podman/
// OrbStack/Colima/Apple `container`) and GitHub is reached via a PAT. Requires
// DATABASE_URL (point it at the local Postgres); set LOCAL_HARNESS_IMAGE to run
// repo-operating agent jobs (without it the board still serves and only container
// kinds fail, loudly).
export async function startLocal(
  options: { env?: NodeJS.ProcessEnv } = {},
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

  // Best-effort: reap per-run containers a previous run orphaned (a crash or hard kill
  // can leave exited managed containers behind, since their `release()` never ran).
  // Skipped when no image is configured (nothing to reap).
  if (localized.LOCAL_HARNESS_IMAGE?.trim()) {
    try {
      const reaped = await createLocalContainerTransportFromEnv(localized).reapExited()
      if (reaped > 0) logger.info({ reaped }, 'reaped orphaned local job containers')
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'could not reap orphaned local job containers',
      )
    }
  }

  // GitHub is reached via a PAT in local mode (there is no GitHub-App connect flow). Without
  // one the board still serves, but every repo-operating agent step — clone, push, open PR,
  // the CI gate, the real merge — fails. Surface it at boot with a click-through URL that
  // pre-selects the scopes, so it is a one-step fix rather than a runtime surprise.
  if (!localized.GITHUB_PAT?.trim()) {
    logger.warn(
      `local mode: GITHUB_PAT is not set — agent steps that clone, push, open PRs, gate on ` +
        `CI or merge will fail. Create a token (scopes pre-selected) at ${githubPatCreationUrl()} ` +
        `then set GITHUB_PAT and restart.`,
    )
  }

  if (localized.AUTH_DEV_OPEN !== 'false' && !env.HOST?.trim()) {
    logger.warn(
      'local mode: the auth gate is OPEN and the server binds to all interfaces — anyone ' +
        'on your network can reach the API. Set AUTH_DEV_OPEN=false, or HOST=127.0.0.1 on ' +
        'Docker Desktop, to restrict it.',
    )
  }

  return start({ env, buildContainer: buildLocalContainer })
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
