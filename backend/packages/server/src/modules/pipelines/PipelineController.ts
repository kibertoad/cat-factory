import {
  clonePipelineSchema,
  createPipelineSchema,
  organizePipelineSchema,
  updatePipelineSchema,
} from '@cat-factory/contracts'
import { Hono } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'
import { jsonBody } from '../../http/validation.js'

/** Pipeline palette CRUD. Mounted under `/workspaces/:workspaceId`. */
export function pipelineController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.get('/pipelines', async (c) => {
    return c.json(await c.get('container').pipelineService.list(param(c, 'workspaceId')))
  })

  app.post('/pipelines', jsonBody(createPipelineSchema), async (c) => {
    const pipeline = await c
      .get('container')
      .pipelineService.create(param(c, 'workspaceId'), c.req.valid('json'))
    return c.json(pipeline, 201)
  })

  // Clone any pipeline (built-in or custom) into a new, editable copy.
  app.post('/pipelines/:pipelineId/clone', jsonBody(clonePipelineSchema), async (c) => {
    const pipeline = await c
      .get('container')
      .pipelineService.clone(param(c, 'workspaceId'), param(c, 'pipelineId'), c.req.valid('json'))
    return c.json(pipeline, 201)
  })

  // Edit a custom pipeline in place. Built-in pipelines reject this (clone first).
  app.patch('/pipelines/:pipelineId', jsonBody(updatePipelineSchema), async (c) => {
    const pipeline = await c
      .get('container')
      .pipelineService.update(param(c, 'workspaceId'), param(c, 'pipelineId'), c.req.valid('json'))
    return c.json(pipeline)
  })

  // Organize a pipeline in the library: set labels / archive state. The only mutation
  // allowed on a built-in pipeline (view metadata, not structure), so built-ins reject
  // `update`/`delete` but accept this.
  app.patch('/pipelines/:pipelineId/organize', jsonBody(organizePipelineSchema), async (c) => {
    const pipeline = await c
      .get('container')
      .pipelineService.organize(
        param(c, 'workspaceId'),
        param(c, 'pipelineId'),
        c.req.valid('json'),
      )
    return c.json(pipeline)
  })

  app.delete('/pipelines/:pipelineId', async (c) => {
    await c.get('container').pipelineService.remove(param(c, 'workspaceId'), param(c, 'pipelineId'))
    return c.body(null, 204)
  })

  return app
}
