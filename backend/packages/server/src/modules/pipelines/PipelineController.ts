import {
  clonePipelineContract,
  createPipelineContract,
  deletePipelineContract,
  listPipelinesContract,
  organizePipelineContract,
  reseedPipelineContract,
  updatePipelineContract,
} from '@cat-factory/contracts'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'

/** Pipeline palette CRUD. Mounted under `/workspaces/:workspaceId`. */
export function pipelineController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  buildHonoRoute(app, listPipelinesContract, async (c) => {
    return c.json(await c.get('container').pipelineService.list(param(c, 'workspaceId')), 200)
  })

  buildHonoRoute(app, createPipelineContract, async (c) => {
    const pipeline = await c
      .get('container')
      .pipelineService.create(param(c, 'workspaceId'), c.req.valid('json'))
    return c.json(pipeline, 201)
  })

  // Clone any pipeline (built-in or custom) into a new, editable copy.
  buildHonoRoute(app, clonePipelineContract, async (c) => {
    const pipeline = await c
      .get('container')
      .pipelineService.clone(
        param(c, 'workspaceId'),
        c.req.valid('param').pipelineId,
        c.req.valid('json'),
      )
    return c.json(pipeline, 201)
  })

  // Edit a custom pipeline in place. Built-in pipelines reject this (clone first).
  buildHonoRoute(app, updatePipelineContract, async (c) => {
    const pipeline = await c
      .get('container')
      .pipelineService.update(
        param(c, 'workspaceId'),
        c.req.valid('param').pipelineId,
        c.req.valid('json'),
      )
    return c.json(pipeline, 200)
  })

  // Organize a pipeline in the library: set labels / archive state. The only mutation
  // allowed on a built-in pipeline (view metadata, not structure), so built-ins reject
  // `update`/`delete` but accept this.
  buildHonoRoute(app, organizePipelineContract, async (c) => {
    const pipeline = await c
      .get('container')
      .pipelineService.organize(
        param(c, 'workspaceId'),
        c.req.valid('param').pipelineId,
        c.req.valid('json'),
      )
    return c.json(pipeline, 200)
  })

  // Restore a built-in pipeline to its current catalog definition (adopt an improved
  // built-in, or repair a drifted/invalid one). Custom pipelines reject this (delete them).
  buildHonoRoute(app, reseedPipelineContract, async (c) => {
    const pipeline = await c
      .get('container')
      .pipelineService.reseed(param(c, 'workspaceId'), c.req.valid('param').pipelineId)
    return c.json(pipeline, 200)
  })

  buildHonoRoute(app, deletePipelineContract, async (c) => {
    await c
      .get('container')
      .pipelineService.remove(param(c, 'workspaceId'), c.req.valid('param').pipelineId)
    return c.body(null, 204)
  })

  return app
}
