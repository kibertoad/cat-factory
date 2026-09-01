import {
  connectServiceCatalogContract,
  disconnectServiceCatalogContract,
  getServiceCatalogContract,
  probeServiceCatalogContract,
  syncServiceCatalogContract,
} from '@cat-factory/contracts'
import type { FoundationalServiceModule } from '@cat-factory/orchestration'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'
import { requireCapability } from '../../http/guards.js'
import { mountWorkspacePermission } from '../../http/workspaceAccess.js'

/**
 * The workspace's SERVICE CATALOG connection: the developer portal (Backstage) whose services are
 * imported into the foundational-services catalog agents read.
 *
 * Its OWN controller rather than five more routes on `FoundationalServiceController`, for two
 * reasons that both matter. It is workspace-only where that one is mounted at both tiers (the
 * credential rides the workspace-keyed secret delegation, so there is no account-scoped shape of
 * it to serve), and its resource is a singleton with no `:serviceId` in any path. Folding it in
 * would have meant a scope-conditional route set inside a controller whose whole point is that
 * both mounts serve the same one.
 *
 * See backend/docs/service-catalog-import.md.
 */
export function serviceCatalogController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // `integrations.manage` rather than `settings.manage`: this stores a third-party credential and
  // points the platform at an external system, which is the same class of act as connecting the
  // tracker or the runner pool. The mount covers `/service-catalog` AND its `/*` children (the
  // helper pairs them), so `probe` and `sync` are gated by virtue of the resource they hang off
  // rather than by someone remembering a `use` line beside each.
  mountWorkspacePermission(app, 'integrations.manage', ['/service-catalog'])

  buildHonoRoute(app, getServiceCatalogContract, async (c) => {
    const connection = await requireServiceCatalog(c).connectionService.get(param(c, 'workspaceId'))
    return c.json(connection, 200)
  })

  buildHonoRoute(app, connectServiceCatalogContract, async (c) => {
    const connection = await requireServiceCatalog(c).connectionService.connect(
      param(c, 'workspaceId'),
      c.req.valid('json'),
    )
    return c.json(connection, 200)
  })

  buildHonoRoute(app, disconnectServiceCatalogContract, async (c) => {
    const module = requireServiceCatalog(c)
    // The IMPORTED services are retired FIRST, while the connection still exists: an estate that
    // nothing refreshes still reads to every agent as the organisation's current one, and doing it
    // in the other order would leave those rows behind if the second call failed.
    await module.syncService.retireImported(param(c, 'workspaceId'))
    await module.connectionService.disconnect(param(c, 'workspaceId'))
    return c.body(null, 204)
  })

  buildHonoRoute(app, probeServiceCatalogContract, async (c) => {
    const result = await requireServiceCatalog(c).connectionService.probe(c.req.valid('json'))
    return c.json(result, 200)
  })

  buildHonoRoute(app, syncServiceCatalogContract, async (c) => {
    const result = await requireServiceCatalog(c).syncService.sync(param(c, 'workspaceId'))
    return c.json(result, 200)
  })

  return app
}

/**
 * The service-catalog half of the foundational-services module, or a 503 naming what is missing.
 *
 * A capability BEHIND a capability, so it gets its own accessor rather than a message borrowed
 * from its parent: a deployment can perfectly well run the foundational catalog with no encryption
 * key for a portal credential, and telling that operator "the catalog is not configured" would
 * name a module they have already wired.
 */
function requireServiceCatalog<E extends AppEnv>(
  c: Context<E>,
): NonNullable<FoundationalServiceModule['serviceCatalog']> {
  const catalog = requireCapability(
    c.get('container').foundationalServices,
    'The foundational-services catalog is not configured',
  )
  return requireCapability(
    catalog.serviceCatalog,
    'Importing a service catalog requires the service-catalog encryption key to be configured',
  )
}
