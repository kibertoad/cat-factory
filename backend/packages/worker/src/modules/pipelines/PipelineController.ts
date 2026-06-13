import { createPipelineSchema } from '@cat-factory/contracts'
import { Hono } from 'hono'
import type { AppEnv } from '../../infrastructure/http/types'
import { param } from '../../infrastructure/http/params'
import { jsonBody } from '../../infrastructure/http/validation'

/** Pipeline palette CRUD. Mounted under `/workspaces/:workspaceId`. */
export function pipelineController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.get('/pipelines', async (c) => {
    return c.json(
      await c.get('container').pipelineService.list(param(c, 'workspaceId')),
    )
  })

  app.post('/pipelines', jsonBody(createPipelineSchema), async (c) => {
    const pipeline = await c
      .get('container')
      .pipelineService.create(param(c, 'workspaceId'), c.req.valid('json'))
    return c.json(pipeline, 201)
  })

  app.delete('/pipelines/:pipelineId', async (c) => {
    await c
      .get('container')
      .pipelineService.remove(param(c, 'workspaceId'), param(c, 'pipelineId'))
    return c.body(null, 204)
  })

  return app
}
