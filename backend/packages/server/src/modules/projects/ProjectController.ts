import {
  createProjectContract,
  getResearchProjectViewContract,
  getResearchRevisionContract,
  listPinnableResearchDefinitionsContract,
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
import { researchCredentialReadiness } from '../research/researchCredentialReadiness.js'

/** Resolve the projects module, or refuse with a 503 naming what isn't wired. */
function requireProjects<E extends AppEnv>(c: Context<E>): ProjectsModule {
  return requireCapability(c.get('container').projects, 'Projects are not configured')
}

/** The research project reader, a capability behind the projects module. */
function requireResearchViews<E extends AppEnv>(c: Context<E>) {
  return requireCapability(
    requireProjects(c).research.views,
    'Research findings are not configured',
  )
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

  buildHonoRoute(app, listPinnableResearchDefinitionsContract, async (c) => {
    const container = c.get('container')
    const accountId = await container.workspaceService.accountOf(param(c, 'workspaceId'))
    const resolved = await container.researchDefinitions.list(accountId ?? '')
    return c.json(
      resolved.map(({ definition, origin }) => ({
        key: definition.key,
        version: definition.version,
        title: definition.title,
        brief: definition.brief,
        inputs: definition.inputs,
        origin,
      })),
      200,
    )
  })

  buildHonoRoute(app, getResearchProjectViewContract, async (c) => {
    const views = requireResearchViews(c)
    const workspaceId = param(c, 'workspaceId')
    const resolver = c.get('container').toolSecretResolver
    const view = await views.read(workspaceId, c.req.valid('param').projectId, (definition) =>
      researchCredentialReadiness(definition, workspaceId, resolver),
    )
    return c.json(view, 200)
  })

  buildHonoRoute(app, getResearchRevisionContract, async (c) => {
    const { projectId, revisionId } = c.req.valid('param')
    const detail = await requireResearchViews(c).revision(
      param(c, 'workspaceId'),
      projectId,
      revisionId,
    )
    return c.json(detail, 200)
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
