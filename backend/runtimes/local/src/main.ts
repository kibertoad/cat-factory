import { logger } from '@cat-factory/server'
import { startLocal } from './server.js'

// Default entrypoint: `pnpm build` then `node dist/main.js`. Requires DATABASE_URL
// (the local Postgres) and LOCAL_HARNESS_IMAGE (the executor-harness image run per
// job). Set PORT to override the listen port (PUBLIC_URL defaults from it).
startLocal().catch((err: unknown) => {
  logger.error({ err: err instanceof Error ? err.message : String(err) }, 'failed to start')
  process.exit(1)
})
