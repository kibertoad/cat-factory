import {
  createProjectContract,
  listProjectCatalogContract,
  mountProjectContract,
  setProjectServicesContract,
  unmountProjectContract,
  updateProjectMountLayoutContract,
} from '@cat-factory/contracts'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { ProjectsModule } from '@cat-factory/orchestration'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'
import { requireCapability } from '../../http/guards.js'

/** Resolve the projects module, or refuse with a 503 naming what isn't wired. */
function requireProjects<E extends AppEnv>(c: Context<E>): ProjectsModule {
  return requireCapability(c.get('container').projects, 'Projects are not configured')
}

/**
 * Projects on a workspace board: create one, set its service links, list the account's catalog,
 * and mount, unmount or re-lay it out. Mounted under `/workspaces/:workspaceId`. Member-level
 * writes, under the auth gate's viewer write floor like the service mount routes. Deleting a
 * project is deleting its root block.
 */
export function projectController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  buildHonoRoute(app, listProjectCatalogContract, async (c) => {
    const projects = requireProjects(c)
    const accountId = await c.get('container').workspaceService.accountOf(param(c, 'workspaceId'))
    if (accountId === undefined) return c.json([], 200)
    return c.json(await projects.service.listForAccount(accountId), 200)
  })

  buildHonoRoute(app, createProjectContract, async (c) => {
    const projects = requireProjects(c)
    const created = await projects.service.create(param(c, 'workspaceId'), c.req.valid('json'))
    return c.json(created, 201)
  })

  buildHonoRoute(app, setProjectServicesContract, async (c) => {
    const projects = requireProjects(c)
    const project = await projects.service.setServices(
      param(c, 'workspaceId'),
      c.req.valid('param').projectId,
      c.req.valid('json').serviceIds,
    )
    return c.json(project, 200)
  })

  buildHonoRoute(app, mountProjectContract, async (c) => {
    const projects = requireProjects(c)
    const mount = await projects.service.mount(
      param(c, 'workspaceId'),
      c.req.valid('param').projectId,
      c.req.valid('json'),
    )
    return c.json(mount, 201)
  })

  buildHonoRoute(app, updateProjectMountLayoutContract, async (c) => {
    const projects = requireProjects(c)
    const mount = await projects.service.updateLayout(
      param(c, 'workspaceId'),
      c.req.valid('param').projectId,
      c.req.valid('json'),
    )
    return c.json(mount, 200)
  })

  buildHonoRoute(app, unmountProjectContract, async (c) => {
    const projects = requireProjects(c)
    await projects.service.unmount(param(c, 'workspaceId'), c.req.valid('param').projectId)
    return c.body(null, 204)
  })

  return app
}
