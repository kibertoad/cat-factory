import {
  attachPublicTaskProjectContract,
  detachPublicTaskProjectContract,
  listPublicTaskProjectsContract,
  type PublicLinkedProject,
  type TaskLinkedProject,
} from '@cat-factory/contracts'
import { NotFoundError } from '@cat-factory/kernel'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { requireTaskProjectLinks } from '../projects/TaskProjectLinkController.js'
import { authorizeOrThrow } from './publicApiAuth.js'

// A task's linked projects on `/api/v1`: list, link and unlink. Every write delegates to the same
// service the app's own routes call, so a link the board refuses is refused here too. They return
// no `PublicTask`, so they serve a task under a service and a task under a project alike.

function toPublicLinkedProject(link: TaskLinkedProject): PublicLinkedProject {
  return { projectId: link.projectId, kind: link.kind, title: link.title, linkedAt: link.linkedAt }
}

/** A board task the key may edit, under a service or a project, or the 404 hiding anything else. */
async function requireBoardTask<E extends AppEnv>(
  c: Context<E>,
  workspaceId: string,
  taskId: string,
): Promise<void> {
  const block = await c.get('container').boardService.getBoardTask(workspaceId, taskId)
  if (!block) throw new NotFoundError('Task', taskId, { reason: 'task_not_found' })
}

export function publicTaskProjectController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  buildHonoRoute(app, listPublicTaskProjectsContract, async (c) => {
    const auth = await authorizeOrThrow(c, listPublicTaskProjectsContract.minScope)
    const { taskId } = c.req.valid('param')
    await requireBoardTask(c, auth.workspaceId, taskId)
    const links = await requireTaskProjectLinks(c).list(auth.workspaceId, taskId)
    return c.json({ projects: links.map(toPublicLinkedProject) }, 200)
  })

  buildHonoRoute(app, attachPublicTaskProjectContract, async (c) => {
    const auth = await authorizeOrThrow(c, attachPublicTaskProjectContract.minScope)
    const { taskId } = c.req.valid('param')
    const { projectId } = c.req.valid('json')
    await requireBoardTask(c, auth.workspaceId, taskId)
    const links = await requireTaskProjectLinks(c).link(auth.workspaceId, taskId, [projectId])
    const linked = links.find((link) => link.projectId === projectId)
    if (!linked)
      throw new NotFoundError('Project', projectId, { reason: 'project_link_unconfirmed' })
    return c.json(toPublicLinkedProject(linked), 201)
  })

  buildHonoRoute(app, detachPublicTaskProjectContract, async (c) => {
    const auth = await authorizeOrThrow(c, detachPublicTaskProjectContract.minScope)
    const { taskId } = c.req.valid('param')
    await requireBoardTask(c, auth.workspaceId, taskId)
    await requireTaskProjectLinks(c).unlink(auth.workspaceId, taskId, c.req.valid('json').projectId)
    return c.body(null, 204)
  })

  return app
}
