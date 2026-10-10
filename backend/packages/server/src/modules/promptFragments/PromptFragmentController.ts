import { listFragmentCatalogContract } from '@cat-factory/contracts'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { AppEnv } from '../../http/env.js'

/**
 * Serves the universal best-practice prompt fragment pool read-only: the shipped catalog plus
 * whatever the deployment registered on the app-owned `PromptFragmentRegistry`. It is
 * workspace-independent, so it lives outside the workspace-scoped API. The frontend fetches it
 * once to populate the per-service and per-block pickers.
 *
 * Read through `container.promptFragments` (the SOURCE), not a module global: on a mothership-mode
 * node the authoritative pool is the mothership's, and a picker offering ids from a different set
 * than a run folds is exactly the drift that seam exists to remove, one surface along.
 *
 * The response is cached for an hour, which is safe for the same reason it always was: the pool is
 * code, so it changes only when the deployment is redeployed. A FAILED remote read throws (an
 * `UnavailableError` through `handleError`) rather than answering with a short catalog that a
 * browser would then cache for an hour as if it were the truth.
 */
export function promptFragmentController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  buildHonoRoute(app, listFragmentCatalogContract, async (c) => {
    const fragments = await c.get('container').promptFragments.all()
    c.header('Cache-Control', 'public, max-age=3600')
    return c.json(fragments, 200)
  })

  return app
}
