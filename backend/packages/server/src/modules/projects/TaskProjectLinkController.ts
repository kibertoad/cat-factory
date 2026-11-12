import {
  linkTaskProjectsContract,
  listTaskProjectsContract,
  unlinkTaskProjectContract,
} from '@cat-factory/contracts'
import type { TaskProjectLinkService } from '@cat-factory/orchestration'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { requireCapability } from '../../http/guards.js'
import { param } from '../../http/params.js'

/** The task-project link service, or a 503 naming what isn't wired. */
export function requireTaskProjectLinks<E extends AppEnv>(c: Context<E>): TaskProjectLinkService {
  const projects = requireCapability(c.get('container').projects, 'Projects are not configured')
  return requireCapability(projects.taskLinks, 'Linking projects to tasks is not configured')
}

/**
 * Projects linked to a task as read-only context: list, link and unlink. Mounted under
 * `/workspaces/:workspaceId`; member-level writes under the auth gate's viewer write floor.
 */
export function taskProjectLinkController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  buildHonoRoute(app, listTaskProjectsContract, async (c) => {
    const projects = await requireTaskProjectLinks(c).list(
      param(c, 'workspaceId'),
      c.req.valid('param').blockId,
    )
    return c.json({ projects }, 200)
  })

  buildHonoRoute(app, linkTaskProjectsContract, async (c) => {
    const projects = await requireTaskProjectLinks(c).link(
      param(c, 'workspaceId'),
      c.req.valid('param').blockId,
      c.req.valid('json').projectIds,
    )
    return c.json({ projects }, 200)
  })

  buildHonoRoute(app, unlinkTaskProjectContract, async (c) => {
    const { blockId, projectId } = c.req.valid('param')
    await requireTaskProjectLinks(c).unlink(param(c, 'workspaceId'), blockId, projectId)
    return c.body(null, 204)
  })

  return app
}
