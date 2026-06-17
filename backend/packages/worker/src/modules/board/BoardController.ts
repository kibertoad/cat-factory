import {
  addFrameSchema,
  addModuleSchema,
  addTaskSchema,
  moveBlockSchema,
  reparentSchema,
  toggleDependencySchema,
  updateBlockSchema,
} from '@cat-factory/contracts'
import { Hono } from 'hono'
import type { AppEnv } from '../../infrastructure/http/types'
import { param } from '../../infrastructure/http/params'
import { jsonBody } from '../../infrastructure/http/validation'

/**
 * Board mutations. Mounted under `/workspaces/:workspaceId`, so every handler
 * reads the workspace id from the inherited path param.
 */
export function boardController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.post('/blocks', jsonBody(addFrameSchema), async (c) => {
    const block = await c
      .get('container')
      .boardService.addFrame(param(c, 'workspaceId'), c.req.valid('json'))
    return c.json(block, 201)
  })

  app.post('/blocks/:blockId/tasks', jsonBody(addTaskSchema), async (c) => {
    const block = await c
      .get('container')
      .boardService.addTask(param(c, 'workspaceId'), param(c, 'blockId'), c.req.valid('json'))
    return c.json(block, 201)
  })

  app.post('/blocks/:blockId/modules', jsonBody(addModuleSchema), async (c) => {
    const block = await c
      .get('container')
      .boardService.addModule(param(c, 'workspaceId'), param(c, 'blockId'), c.req.valid('json'))
    return c.json(block, 201)
  })

  app.patch('/blocks/:blockId', jsonBody(updateBlockSchema), async (c) => {
    const block = await c
      .get('container')
      .boardService.updateBlock(param(c, 'workspaceId'), param(c, 'blockId'), c.req.valid('json'))
    return c.json(block)
  })

  app.post('/blocks/:blockId/move', jsonBody(moveBlockSchema), async (c) => {
    const block = await c
      .get('container')
      .boardService.moveBlock(
        param(c, 'workspaceId'),
        param(c, 'blockId'),
        c.req.valid('json').position,
      )
    return c.json(block)
  })

  app.post('/blocks/:blockId/reparent', jsonBody(reparentSchema), async (c) => {
    const block = await c
      .get('container')
      .boardService.reparent(param(c, 'workspaceId'), param(c, 'blockId'), c.req.valid('json'))
    return c.json(block)
  })

  app.delete('/blocks/:blockId', async (c) => {
    const container = c.get('container')
    const workspaceId = param(c, 'workspaceId')
    const blockId = param(c, 'blockId')
    // Tear down any running runs under this subtree FIRST — killing their containers
    // and durable drivers — so deleting a service/module never orphans a container
    // that would idle until its watchdog. Then remove the blocks + run records.
    await container.executionService.teardownForBlockTree(workspaceId, blockId)
    await container.boardService.removeBlock(workspaceId, blockId)
    return c.body(null, 204)
  })

  app.post('/blocks/:blockId/dependencies', jsonBody(toggleDependencySchema), async (c) => {
    const block = await c
      .get('container')
      .boardService.toggleDependency(
        param(c, 'workspaceId'),
        param(c, 'blockId'),
        c.req.valid('json').sourceId,
      )
    return c.json(block)
  })

  return app
}
