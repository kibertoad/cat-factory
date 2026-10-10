import {
  createSharedStackContract,
  deleteSharedStackContract,
  detectSharedStackContract,
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
import { mountWorkspacePermission } from '../../http/workspaceAccess.js'
import { param } from '../../http/params.js'
import { requireCapability } from '../../http/guards.js'

/** Resolve the shared-stacks module, or refuse with a 503 naming what isn't wired. */
function requireSharedStacks<E extends AppEnv>(c: Context<E>): SharedStacksModule {
  return requireCapability(c.get('container').sharedStacks, 'Shared stacks are not configured')
}

/**
 * CRUD + lifecycle for a workspace's shared stacks (long-lived compose infra a consumer
 * environment attaches to over an external network). CRUD works on every facade; the
 * `ensure-up` / `teardown` lifecycle actions drive a host Docker daemon, so they succeed only
 * on the local facade (elsewhere the service refuses with a clear error). Mounted under
 * `/workspaces/:workspaceId`.
 */
export function sharedStackController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  mountWorkspacePermission(app, 'integrations.manage', ['/shared-stacks'])

  buildHonoRoute(app, listSharedStacksContract, async (c) => {
    const stacks = requireSharedStacks(c)
    return c.json(await stacks.service.list(param(c, 'workspaceId')), 200)
  })

  buildHonoRoute(app, createSharedStackContract, async (c) => {
    const stacks = requireSharedStacks(c)
    const stack = await stacks.service.create(param(c, 'workspaceId'), c.req.valid('json'))
    return c.json(stack, 201)
  })

  buildHonoRoute(app, detectSharedStackContract, async (c) => {
    const stacks = requireSharedStacks(c)
    const recommendation = await stacks.service.detect(param(c, 'workspaceId'), c.req.valid('json'))
    return c.json(recommendation, 200)
  })

  buildHonoRoute(app, updateSharedStackContract, async (c) => {
    const stacks = requireSharedStacks(c)
    const stack = await stacks.service.update(
      param(c, 'workspaceId'),
      c.req.valid('param').stackId,
      c.req.valid('json'),
    )
    return c.json(stack, 200)
  })

  buildHonoRoute(app, deleteSharedStackContract, async (c) => {
    const stacks = requireSharedStacks(c)
    await stacks.service.remove(param(c, 'workspaceId'), c.req.valid('param').stackId)
    return c.body(null, 204)
  })

  buildHonoRoute(app, ensureSharedStackUpContract, async (c) => {
    const stacks = requireSharedStacks(c)
    const stack = await stacks.service.ensureUp(
      param(c, 'workspaceId'),
      c.req.valid('param').stackId,
    )
    return c.json(stack, 200)
  })

  buildHonoRoute(app, teardownSharedStackContract, async (c) => {
    const stacks = requireSharedStacks(c)
    const stack = await stacks.service.teardown(
      param(c, 'workspaceId'),
      c.req.valid('param').stackId,
    )
    return c.json(stack, 200)
  })

  return app
}
