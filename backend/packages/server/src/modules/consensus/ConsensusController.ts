import { Hono } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'

/**
 * Read-only consensus endpoints (the optional `@cat-factory/consensus` mechanism). The
 * live transcript is pushed via the `consensus` workspace event; this lets a window
 * load the latest session for a block on open / after a reload. Returns `{ session: null }`
 * when the consensus repository isn't wired or no session has run for the block — never a
 * hard error, so the SPA degrades gracefully when consensus is off. Mounted under
 * `/workspaces/:workspaceId`.
 */
export function consensusController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // The most recent consensus session for a block (null when none / not configured).
  app.get('/blocks/:blockId/consensus-session', async (c) => {
    const repo = c.get('container').consensusSessionRepository
    if (!repo) return c.json({ session: null })
    const session = await repo.getByBlock(param(c, 'workspaceId'), param(c, 'blockId'))
    return c.json({ session })
  })

  return app
}
