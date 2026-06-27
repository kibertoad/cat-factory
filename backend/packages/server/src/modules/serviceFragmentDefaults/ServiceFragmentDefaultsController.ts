import {
  getServiceFragmentDefaultsContract,
  setServiceFragmentDefaultsContract,
} from '@cat-factory/contracts'
import type { ServiceFragmentDefaultsModule } from '@cat-factory/orchestration'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'

/** Resolve the service-fragment-defaults module or send a 503, returning null when unconfigured. */
function requireDefaults<E extends AppEnv>(c: Context<E>): ServiceFragmentDefaultsModule | null {
  return c.get('container').serviceFragmentDefaults ?? null
}

const unavailable = <E extends AppEnv>(c: Context<E>) =>
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

  buildHonoRoute(app, getServiceFragmentDefaultsContract, async (c) => {
    const defaults = requireDefaults(c)
    if (!defaults) return unavailable(c)
    return c.json(await defaults.service.get(param(c, 'workspaceId')), 200)
  })

  buildHonoRoute(app, setServiceFragmentDefaultsContract, async (c) => {
    const defaults = requireDefaults(c)
    if (!defaults) return unavailable(c)
    const stored = await defaults.service.set(param(c, 'workspaceId'), c.req.valid('json'))
    return c.json(stored, 200)
  })

  return app
}
