import { UnavailableError } from '@cat-factory/kernel'
import {
  addPackageRegistryContract,
  deletePackageRegistryContract,
  listPackageRegistriesContract,
} from '@cat-factory/contracts'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { PackageRegistriesModule } from '@cat-factory/orchestration'
import type { AppEnv } from '../../http/env.js'
import { requireWorkspacePermission } from '../../http/workspaceAccess.js'
import { param } from '../../http/params.js'

/** Resolve the package-registries module or raise a 503 — it isn't wired on this deployment. */
function requirePackageRegistries<E extends AppEnv>(c: Context<E>): PackageRegistriesModule {
  const packageRegistries = c.get('container').packageRegistries
  if (!packageRegistries)
    throw new UnavailableError('The package-registry integration is not configured')
  return packageRegistries
}

/**
 * Per-workspace private package-registry entries (npm private orgs, GitHub Packages)
 * that agent containers use to resolve private dependencies. Tokens are write-only —
 * the list view carries only the non-secret summary. Mounted under
 * `/workspaces/:workspaceId`.
 */
export function packageRegistriesController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.use('*', requireWorkspacePermission('integrations.manage'))

  buildHonoRoute(app, listPackageRegistriesContract, async (c) => {
    const registries = requirePackageRegistries(c)
    return c.json(await registries.service.list(param(c, 'workspaceId')), 200)
  })

  buildHonoRoute(app, addPackageRegistryContract, async (c) => {
    const registries = requirePackageRegistries(c)
    return c.json(await registries.service.add(param(c, 'workspaceId'), c.req.valid('json')), 200)
  })

  buildHonoRoute(app, deletePackageRegistryContract, async (c) => {
    const registries = requirePackageRegistries(c)
    await registries.service.remove(param(c, 'workspaceId'), c.req.valid('param').entryId)
    return c.body(null, 204)
  })

  return app
}
