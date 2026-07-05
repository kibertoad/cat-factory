import {
  createSharedStackContract,
  deleteSharedStackContract,
  ensureSharedStackUpContract,
  listSharedStacksContract,
  teardownSharedStackContract,
  updateSharedStackContract,
} from '@cat-factory/contracts'
import type { SharedStacksModule } from '@cat-factory/orchestration'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'

/** Resolve the shared-stacks module or send a 503, returning null when unconfigured. */
function requireSharedStacks<E extends AppEnv>(c: Context<E>): SharedStacksModule | null {
  return c.get('container').sharedStacks ?? null
}

const unavailable = <E extends AppEnv>(c: Context<E>) =>
  c.json({ error: { code: 'unavailable', message: 'Shared stacks are not configured' } }, 503)

/**
 * CRUD + lifecycle for a workspace's shared stacks (long-lived compose infra a consumer
 * environment attaches to over an external network). CRUD works on every facade; the
 * `ensure-up` / `teardown` lifecycle actions drive a host Docker daemon, so they succeed only
 * on the local facade (elsewhere the service refuses with a clear error). Mounted under
 * `/workspaces/:workspaceId`.
 */
export function sharedStackController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  buildHonoRoute(app, listSharedStacksContract, async (c) => {
    const stacks = requireSharedStacks(c)
    if (!stacks) return unavailable(c)
    return c.json(await stacks.service.list(param(c, 'workspaceId')), 200)
  })

  buildHonoRoute(app, createSharedStackContract, async (c) => {
    const stacks = requireSharedStacks(c)
    if (!stacks) return unavailable(c)
    const stack = await stacks.service.create(param(c, 'workspaceId'), c.req.valid('json'))
    return c.json(stack, 201)
  })

  buildHonoRoute(app, updateSharedStackContract, async (c) => {
    const stacks = requireSharedStacks(c)
    if (!stacks) return unavailable(c)
    const stack = await stacks.service.update(
      param(c, 'workspaceId'),
      c.req.valid('param').stackId,
      c.req.valid('json'),
    )
    return c.json(stack, 200)
  })

  buildHonoRoute(app, deleteSharedStackContract, async (c) => {
    const stacks = requireSharedStacks(c)
    if (!stacks) return unavailable(c)
    await stacks.service.remove(param(c, 'workspaceId'), c.req.valid('param').stackId)
    return c.body(null, 204)
  })

  buildHonoRoute(app, ensureSharedStackUpContract, async (c) => {
    const stacks = requireSharedStacks(c)
    if (!stacks) return unavailable(c)
    const stack = await stacks.service.ensureUp(
      param(c, 'workspaceId'),
      c.req.valid('param').stackId,
    )
    return c.json(stack, 200)
  })

  buildHonoRoute(app, teardownSharedStackContract, async (c) => {
    const stacks = requireSharedStacks(c)
    if (!stacks) return unavailable(c)
    const stack = await stacks.service.teardown(
      param(c, 'workspaceId'),
      c.req.valid('param').stackId,
    )
    return c.json(stack, 200)
  })

  return app
}
