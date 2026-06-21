import { start } from '@cat-factory/node-server'
import { buildLocalContainer } from './container.js'

// Boot the local-mode service. It reuses the Node facade's `start()` — Postgres +
// pg-boss + the execution worker + sweepers, served over @hono/node-server — passing
// the local composition root so agent jobs run in local Docker containers and GitHub
// is reached via a PAT. Requires DATABASE_URL (point it at the local Postgres) and
// LOCAL_HARNESS_IMAGE (the executor-harness image to run per job).
export function startLocal(options: { env?: NodeJS.ProcessEnv } = {}): ReturnType<typeof start> {
  return start({ env: options.env ?? process.env, buildContainer: buildLocalContainer })
}
