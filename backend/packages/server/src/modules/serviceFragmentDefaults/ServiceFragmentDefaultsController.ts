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
import { requireCapability } from '../../http/guards.js'

/** Resolve the service-fragment-defaults module, or refuse with a 503 naming what isn't wired. */
function requireDefaults<E extends AppEnv>(c: Context<E>): ServiceFragmentDefaultsModule {
  return requireCapability(
    c.get('container').serviceFragmentDefaults,
    'Service fragment defaults are not configured',
  )
}

/**
 * Read/replace a workspace's default service-fragment selection (the best-practice
 * fragment ids new services inherit). PUT replaces the whole list wholesale. Mounted
 * under `/workspaces/:workspaceId`.
 */
export function serviceFragmentDefaultsController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  buildHonoRoute(app, getServiceFragmentDefaultsContract, async (c) => {
    const defaults = requireDefaults(c)
    return c.json(await defaults.service.get(param(c, 'workspaceId')), 200)
  })

  buildHonoRoute(app, setServiceFragmentDefaultsContract, async (c) => {
    const defaults = requireDefaults(c)
    const stored = await defaults.service.set(param(c, 'workspaceId'), c.req.valid('json'))
    return c.json(stored, 200)
  })

  return app
}
