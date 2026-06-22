import { setServiceFragmentDefaultsSchema } from '@cat-factory/contracts'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { ServiceFragmentDefaultsModule } from '@cat-factory/orchestration'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'
import { jsonBody } from '../../http/validation.js'

/** Resolve the service-fragment-defaults module or send a 503, returning null when unconfigured. */
function requireDefaults(c: Context<AppEnv>): ServiceFragmentDefaultsModule | null {
  return c.get('container').serviceFragmentDefaults ?? null
}

const unavailable = (c: Context<AppEnv>) =>
  c.json(
    { error: { code: 'unavailable', message: 'Service fragment defaults are not configured' } },
    503,
  )

/**
 * Read/replace a workspace's default service-fragment selection (the best-practice
 * fragment ids new services inherit). PUT replaces the whole list wholesale. Mounted
 * under `/workspaces/:workspaceId`.
 */
export function serviceFragmentDefaultsController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.get('/service-fragment-defaults', async (c) => {
    const defaults = requireDefaults(c)
    if (!defaults) return unavailable(c)
    return c.json(await defaults.service.get(param(c, 'workspaceId')))
  })

  app.put('/service-fragment-defaults', jsonBody(setServiceFragmentDefaultsSchema), async (c) => {
    const defaults = requireDefaults(c)
    if (!defaults) return unavailable(c)
    const stored = await defaults.service.set(param(c, 'workspaceId'), c.req.valid('json'))
    return c.json(stored)
  })

  return app
}
