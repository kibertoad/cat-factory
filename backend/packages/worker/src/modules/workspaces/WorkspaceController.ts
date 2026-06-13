import { createWorkspaceSchema } from '@cat-factory/contracts'
import { Hono } from 'hono'
import type { AppEnv } from '../../infrastructure/http/types'
import { param } from '../../infrastructure/http/params'
import { jsonBody } from '../../infrastructure/http/validation'

/** Board (workspace) lifecycle and full-snapshot retrieval. */
export function workspaceController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.get('/workspaces', async (c) => {
    return c.json(await c.get('container').workspaceService.list())
  })

  app.post('/workspaces', jsonBody(createWorkspaceSchema), async (c) => {
    const container = c.get('container')
    const snapshot = await container.workspaceService.create(c.req.valid('json'))
    return c.json({ ...snapshot, executionMode: container.config.execution.mode }, 201)
  })

  app.get('/workspaces/:workspaceId', async (c) => {
    const container = c.get('container')
    const snapshot = await container.workspaceService.snapshot(param(c, 'workspaceId'))
    return c.json({ ...snapshot, executionMode: container.config.execution.mode })
  })

  app.delete('/workspaces/:workspaceId', async (c) => {
    await c.get('container').workspaceService.delete(param(c, 'workspaceId'))
    return c.body(null, 204)
  })

  return app
}
