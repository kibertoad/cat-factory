import { createWorkspaceSchema } from '@cat-factory/contracts'
import { Hono } from 'hono'
import type { AppEnv } from '../../infrastructure/http/types'
import { param } from '../../infrastructure/http/params'
import { jsonBody } from '../../infrastructure/http/validation'

/** Board (workspace) lifecycle and full-snapshot retrieval. */
export function workspaceController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // The signed-in user's id scopes the board list and stamps ownership on create.
  // When auth is disabled (`user` unset), ownerId is null → no scoping (dev).
  app.get('/workspaces', async (c) => {
    const ownerId = c.get('user')?.id ?? null
    return c.json(await c.get('container').workspaceService.list(ownerId))
  })

  app.post('/workspaces', jsonBody(createWorkspaceSchema), async (c) => {
    const container = c.get('container')
    const ownerId = c.get('user')?.id ?? null
    const snapshot = await container.workspaceService.create(c.req.valid('json'), ownerId)
    const spend = await container.spendService.status()
    return c.json({ ...snapshot, spend }, 201)
  })

  app.get('/workspaces/:workspaceId', async (c) => {
    const container = c.get('container')
    const snapshot = await container.workspaceService.snapshot(param(c, 'workspaceId'))
    const spend = await container.spendService.status()
    return c.json({ ...snapshot, spend })
  })

  app.delete('/workspaces/:workspaceId', async (c) => {
    await c.get('container').workspaceService.delete(param(c, 'workspaceId'))
    return c.body(null, 204)
  })

  return app
}
