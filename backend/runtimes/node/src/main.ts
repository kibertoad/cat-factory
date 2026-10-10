import { getErrorMessage } from '@cat-factory/kernel'
import { logger } from '@cat-factory/server'
import { start } from './server.js'

// Default entrypoint: `pnpm build` then `node dist/main.js`. Requires DATABASE_URL;
// set PORT to override the listen port.
start().catch((err: unknown) => {
  logger.error('failed to start', { err: getErrorMessage(err) })
  process.exit(1)
})
