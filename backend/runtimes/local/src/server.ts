import { start } from '@cat-factory/node-server'
import { logger } from '@cat-factory/server'
import { applyLocalDefaults } from './config.js'
import { buildLocalContainer } from './container.js'
import { createLocalDockerTransportFromEnv } from './LocalDockerRunnerTransport.js'

// Boot the local-mode service. It reuses the Node facade's `start()` — Postgres +
// pg-boss + the execution worker + sweepers, served over @hono/node-server — passing
// the local composition root so agent jobs run in local Docker containers and GitHub
// is reached via a PAT. Requires DATABASE_URL (point it at the local Postgres); set
// LOCAL_HARNESS_IMAGE to run repo-operating agent jobs (without it the board still
// serves and only container kinds fail, loudly).
export async function startLocal(
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<Awaited<ReturnType<typeof start>>> {
  const env = options.env ?? process.env

  // Best-effort: reap per-job containers a previous run orphaned (a crash or hard kill
  // can leave exited `cat-factory.managed=local-docker` containers behind, since their
  // `release()` never ran). Skipped when no image is configured (nothing to reap).
  if (env.LOCAL_HARNESS_IMAGE?.trim()) {
    try {
      const reaped = await createLocalDockerTransportFromEnv(env).reapExited()
      if (reaped > 0) logger.info({ reaped }, 'reaped orphaned local job containers')
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'could not reap orphaned local job containers',
      )
    }
  }

  // The auth gate defaults OPEN in local mode and the listener binds to all interfaces
  // (so on native Linux Docker the agent containers can reach the LLM proxy via the
  // bridge gateway). That combination means anyone on your network can reach the API —
  // surface it so it is a choice, not a surprise. Lock it down with AUTH_DEV_OPEN=false,
  // or HOST=127.0.0.1 on Docker Desktop (where host.docker.internal still resolves).
  const localized = applyLocalDefaults(env)
  if (localized.AUTH_DEV_OPEN !== 'false' && !env.HOST?.trim()) {
    logger.warn(
      'local mode: the auth gate is OPEN and the server binds to all interfaces — anyone ' +
        'on your network can reach the API. Set AUTH_DEV_OPEN=false, or HOST=127.0.0.1 on ' +
        'Docker Desktop, to restrict it.',
    )
  }

  return start({ env, buildContainer: buildLocalContainer })
}
