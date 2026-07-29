import {
  listServiceCatalogContract,
  listServiceMountsContract,
  mountServiceContract,
  unmountServiceContract,
  updateServiceMountLayoutContract,
} from '@cat-factory/contracts'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { ServicesModule } from '@cat-factory/orchestration'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'
import { requireCapability } from '../../http/guards.js'

/** Resolve the in-org services module, or refuse with a 503 naming what isn't wired. */
function requireServices<E extends AppEnv>(c: Context<E>): ServicesModule {
  return requireCapability(c.get('container').services, 'Shared services are not configured')
}

/**
 * In-org service sharing: list/mount/unmount the account's services on a workspace board
 * and re-lay-out a mounted frame. Mounted under `/workspaces/:workspaceId`. The org
 * *catalog* a board can mount from is `GET /services/catalog` (the requesting workspace's
 * account's services). Mounting only adds a shared service to this board; unmounting only
 * removes it — neither touches the canonical, account-owned service.
 */
export function serviceMountController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // Services currently mounted onto this board.
  buildHonoRoute(app, listServiceMountsContract, async (c) => {
    const services = requireServices(c)
    return c.json(await services.service.listMounts(param(c, 'workspaceId')), 200)
  })

  // The org catalog: services owned by this workspace's account (mountable here).
  buildHonoRoute(app, listServiceCatalogContract, async (c) => {
    const services = requireServices(c)
    // `accountOf` is `undefined` for an unknown board, `null` for the legacy/unscoped
    // org, or the account id. The org catalog includes the null-account org.
    const accountId = await c.get('container').workspaceService.accountOf(param(c, 'workspaceId'))
    if (accountId === undefined) return c.json([], 200)
    return c.json(await services.service.listForAccount(accountId), 200)
  })

  // Mount an existing org service onto this board.
  buildHonoRoute(app, mountServiceContract, async (c) => {
    const services = requireServices(c)
    const mount = await services.service.mount(
      param(c, 'workspaceId'),
      c.req.valid('param').serviceId,
      c.req.valid('json'),
    )
    return c.json(mount, 201)
  })

  // Update a mount's per-workspace layout override (frame position/size).
  buildHonoRoute(app, updateServiceMountLayoutContract, async (c) => {
    const services = requireServices(c)
    const mount = await services.service.updateLayout(
      param(c, 'workspaceId'),
      c.req.valid('param').serviceId,
      c.req.valid('json'),
    )
    return c.json(mount, 200)
  })

  // Remove a service from this board (does NOT delete the shared service).
  buildHonoRoute(app, unmountServiceContract, async (c) => {
    const services = requireServices(c)
    await services.service.unmount(param(c, 'workspaceId'), c.req.valid('param').serviceId)
    return c.body(null, 204)
  })

  return app
}
