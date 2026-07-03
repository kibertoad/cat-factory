import {
  createInitiativeContract,
  getInitiativeByBlockContract,
  getInitiativeContract,
  listInitiativesContract,
} from '@cat-factory/contracts'
import type { InitiativesModule } from '@cat-factory/orchestration'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'

/** Resolve the initiatives module or send a 503, returning null when unconfigured. */
function requireInitiatives<E extends AppEnv>(c: Context<E>): InitiativesModule | null {
  return c.get('container').initiatives ?? null
}

const unavailable = <E extends AppEnv>(c: Context<E>) =>
  c.json({ error: { code: 'unavailable', message: 'Initiatives are not configured' } }, 503)

/**
 * Workspace-scoped initiative endpoints: create (the initiative-level board block +
 * its empty entity in one call — the Create Initiative button's target) and the
 * reads the tracker window / inspector load from. The planning pipeline itself is
 * started through the ordinary execution endpoints against the initiative block
 * (`pl_initiative` — enforced by the engine's runnable guard). Mounted under
 * `/workspaces/:workspaceId`.
 */
export function initiativeController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  buildHonoRoute(app, createInitiativeContract, async (c) => {
    const initiatives = requireInitiatives(c)
    if (!initiatives) return unavailable(c)
    const created = await initiatives.service.create(param(c, 'workspaceId'), c.req.valid('json'))
    return c.json(created, 201)
  })

  buildHonoRoute(app, listInitiativesContract, async (c) => {
    const initiatives = requireInitiatives(c)
    if (!initiatives) return unavailable(c)
    return c.json(await initiatives.service.list(param(c, 'workspaceId')), 200)
  })

  buildHonoRoute(app, getInitiativeContract, async (c) => {
    const initiatives = requireInitiatives(c)
    if (!initiatives) return unavailable(c)
    const { initiativeId } = c.req.valid('param')
    return c.json(await initiatives.service.get(param(c, 'workspaceId'), initiativeId), 200)
  })

  buildHonoRoute(app, getInitiativeByBlockContract, async (c) => {
    const initiatives = requireInitiatives(c)
    if (!initiatives) return unavailable(c)
    const { blockId } = c.req.valid('param')
    return c.json(await initiatives.service.getByBlock(param(c, 'workspaceId'), blockId), 200)
  })

  return app
}
