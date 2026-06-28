import {
  addEpicContract,
  addFrameContract,
  addModuleContract,
  addServiceFromRepoContract,
  addTaskContract,
  assignEpicContract,
  moveBlockContract,
  removeBlockContract,
  reparentBlockContract,
  toggleDependencyContract,
  updateBlockContract,
} from '@cat-factory/contracts'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'

/**
 * Board mutations. Mounted under `/workspaces/:workspaceId`, so every handler
 * reads the workspace id from the inherited path param.
 */
export function boardController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  buildHonoRoute(app, addFrameContract, async (c) => {
    const block = await c
      .get('container')
      .boardService.addFrame(param(c, 'workspaceId'), c.req.valid('json'))
    return c.json(block, 201)
  })

  // Import an existing GitHub repo as a service frame — no bootstrap / agent run.
  // First link + sync the repo into the workspace (it may be App-accessible but
  // not yet tracked here), then create the `ready` frame and link the repo to it.
  // A 409 tells the client the App can't see the repo yet (grant it access); the
  // board service 404s an unknown repo and 422s one already on the board.
  buildHonoRoute(app, addServiceFromRepoContract, async (c) => {
    const container = c.get('container')
    const workspaceId = param(c, 'workspaceId')
    const { repoGithubId } = c.req.valid('json')
    if (container.github) {
      const linked = await container.github.syncService.linkRepo(workspaceId, repoGithubId)
      if (!linked) {
        return c.json(
          {
            error: {
              code: 'repo_not_accessible',
              message:
                'The GitHub App cannot access this repository yet. Grant it access, then try again.',
            },
          },
          409,
        )
      }
    }
    const block = await container.boardService.addServiceFromRepo(workspaceId, c.req.valid('json'))
    return c.json(block, 201)
  })

  buildHonoRoute(app, addTaskContract, async (c) => {
    const block = await c
      .get('container')
      .boardService.addTask(
        param(c, 'workspaceId'),
        c.req.valid('param').blockId,
        c.req.valid('json'),
        c.get('user')?.id ?? null,
      )
    return c.json(block, 201)
  })

  buildHonoRoute(app, addModuleContract, async (c) => {
    const block = await c
      .get('container')
      .boardService.addModule(
        param(c, 'workspaceId'),
        c.req.valid('param').blockId,
        c.req.valid('json'),
      )
    return c.json(block, 201)
  })

  // Add an epic grouping node (optionally placed under a service/module via parentId).
  buildHonoRoute(app, addEpicContract, async (c) => {
    const block = await c
      .get('container')
      .boardService.addEpic(param(c, 'workspaceId'), c.req.valid('json'))
    return c.json(block, 201)
  })

  // Assign a task to an epic, or detach it (epicId: null).
  buildHonoRoute(app, assignEpicContract, async (c) => {
    const block = await c
      .get('container')
      .boardService.assignToEpic(
        param(c, 'workspaceId'),
        c.req.valid('param').blockId,
        c.req.valid('json').epicId,
      )
    return c.json(block, 200)
  })

  buildHonoRoute(app, updateBlockContract, async (c) => {
    const block = await c
      .get('container')
      .boardService.updateBlock(
        param(c, 'workspaceId'),
        c.req.valid('param').blockId,
        c.req.valid('json'),
      )
    return c.json(block, 200)
  })

  buildHonoRoute(app, moveBlockContract, async (c) => {
    const block = await c.get('container').boardService.moveBlock(
      param(c, 'workspaceId'),
      c.req.valid('param').blockId,
      c.req.valid('json').position,
      // Skip echoing this move back to the connection that made it (no self-refresh that
      // snaps an in-flight drag back to a stale position) — see the `X-Connection-Id` /
      // `?cid=` plumbing in the SPA and the realtime hubs.
      c.req.header('x-connection-id') ?? null,
    )
    return c.json(block, 200)
  })

  buildHonoRoute(app, reparentBlockContract, async (c) => {
    const block = await c
      .get('container')
      .boardService.reparent(
        param(c, 'workspaceId'),
        c.req.valid('param').blockId,
        c.req.valid('json'),
        c.req.header('x-connection-id') ?? null,
      )
    return c.json(block, 200)
  })

  buildHonoRoute(app, removeBlockContract, async (c) => {
    const container = c.get('container')
    const workspaceId = param(c, 'workspaceId')
    const blockId = c.req.valid('param').blockId
    // Tear down any running runs under this subtree FIRST — killing their containers
    // and durable drivers — so deleting a service/module never orphans a container
    // that would idle until its watchdog. Then remove the blocks + run records.
    await container.executionService.teardownForBlockTree(workspaceId, blockId)
    await container.boardService.removeBlock(workspaceId, blockId)
    return c.body(null, 204)
  })

  buildHonoRoute(app, toggleDependencyContract, async (c) => {
    const block = await c
      .get('container')
      .boardService.toggleDependency(
        param(c, 'workspaceId'),
        c.req.valid('param').blockId,
        c.req.valid('json').sourceId,
      )
    return c.json(block, 200)
  })

  return app
}
