import { mountServiceInputSchema, updateMountInputSchema } from '@cat-factory/contracts'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { ServicesModule } from '@cat-factory/orchestration'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'
import { jsonBody } from '../../http/validation.js'

/** Resolve the in-org services module or send a 503, returning null when unconfigured. */
function requireServices(c: Context<AppEnv>): ServicesModule | null {
  return c.get('container').services ?? null
}

const unavailable = (c: Context<AppEnv>) =>
  c.json({ error: { code: 'unavailable', message: 'Shared services are not configured' } }, 503)

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
  app.get('/services', async (c) => {
    const services = requireServices(c)
    if (!services) return unavailable(c)
    return c.json(await services.service.listMounts(param(c, 'workspaceId')))
  })

  // The org catalog: services owned by this workspace's account (mountable here).
  app.get('/services/catalog', async (c) => {
    const services = requireServices(c)
    if (!services) return unavailable(c)
    // `accountOf` is `undefined` for an unknown board, `null` for the legacy/unscoped
    // org, or the account id. The org catalog includes the null-account org.
    const accountId = await c.get('container').workspaceService.accountOf(param(c, 'workspaceId'))
    if (accountId === undefined) return c.json([])
    return c.json(await services.service.listForAccount(accountId))
  })

  // Mount an existing org service onto this board.
  app.post('/services/:serviceId', jsonBody(mountServiceInputSchema), async (c) => {
    const services = requireServices(c)
    if (!services) return unavailable(c)
    const mount = await services.service.mount(
      param(c, 'workspaceId'),
      param(c, 'serviceId'),
      c.req.valid('json'),
    )
    return c.json(mount, 201)
  })

  // Update a mount's per-workspace layout override (frame position/size).
  app.patch('/services/:serviceId/layout', jsonBody(updateMountInputSchema), async (c) => {
    const services = requireServices(c)
    if (!services) return unavailable(c)
    const mount = await services.service.updateLayout(
      param(c, 'workspaceId'),
      param(c, 'serviceId'),
      c.req.valid('json'),
    )
    return c.json(mount)
  })

  // Remove a service from this board (does NOT delete the shared service).
  app.delete('/services/:serviceId', async (c) => {
    const services = requireServices(c)
    if (!services) return unavailable(c)
    await services.service.unmount(param(c, 'workspaceId'), param(c, 'serviceId'))
    return c.body(null, 204)
  })

  return app
}
