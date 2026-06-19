import { FRAGMENTS } from '@cat-factory/prompt-fragments'
import { Hono } from 'hono'
import type { AppEnv } from '../../http/env.js'

/**
 * Serves the best-practice prompt fragment catalog read-only. The catalog is
 * build-static (compiled into the worker from @cat-factory/prompt-fragments) and
 * workspace-independent, so it lives outside the workspace-scoped API and is
 * cacheable. The frontend fetches it once to populate the per-block picker.
 */
export function promptFragmentController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.get('/prompt-fragments', (c) => {
    c.header('Cache-Control', 'public, max-age=3600')
    return c.json(FRAGMENTS)
  })

  return app
}
