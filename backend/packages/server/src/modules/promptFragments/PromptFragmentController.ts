import { universalFragments } from '@cat-factory/prompt-fragments'
import { Hono } from 'hono'
import type { AppEnv } from '../../http/env.js'

/**
 * Serves the universal best-practice prompt fragment pool read-only — the
 * build-static catalog (compiled into the facade from @cat-factory/prompt-fragments)
 * plus any fragments a deployment registered at startup. It is workspace-independent,
 * so it lives outside the workspace-scoped API and is cacheable. The frontend fetches
 * it once to populate the per-service and per-block pickers.
 */
export function promptFragmentController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.get('/prompt-fragments', (c) => {
    c.header('Cache-Control', 'public, max-age=3600')
    return c.json(universalFragments())
  })

  return app
}
