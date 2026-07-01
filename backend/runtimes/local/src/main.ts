import { logger } from '@cat-factory/server'
import { startLocal } from './server.js'

// Default entrypoint: `pnpm build` then `node dist/main.js`. Requires DATABASE_URL
// (the local Postgres). LOCAL_HARNESS_IMAGE is optional — unset uses the backend-matched
// RECOMMENDED_HARNESS_IMAGE, refreshed at boot. Set PORT to override the listen port
// (PUBLIC_URL defaults from it).
startLocal().catch((err: unknown) => {
  logger.error({ err: err instanceof Error ? err.message : String(err) }, 'failed to start')
  process.exit(1)
})
