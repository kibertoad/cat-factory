import { resolveDecisionSchema, startExecutionSchema, tickSchema } from '@cat-factory/contracts'
import { Hono } from 'hono'
import type { AppEnv } from '../../infrastructure/http/types'
import { param } from '../../infrastructure/http/params'
import { jsonBody } from '../../infrastructure/http/validation'

/**
 * The simulation engine endpoints — starting/cancelling runs, advancing the
 * clock, resolving decisions and merging PRs. Mounted under
 * `/workspaces/:workspaceId`.
 */
export function executionController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.post('/blocks/:blockId/executions', jsonBody(startExecutionSchema), async (c) => {
    const instance = await c
      .get('container')
      .executionService.start(
        param(c, 'workspaceId'),
        param(c, 'blockId'),
        c.req.valid('json').pipelineId,
      )
    return c.json(instance, 201)
  })

  app.delete('/blocks/:blockId/executions', async (c) => {
    const block = await c
      .get('container')
      .executionService.cancel(param(c, 'workspaceId'), param(c, 'blockId'))
    return c.json(block)
  })

  app.post('/blocks/:blockId/merge', async (c) => {
    const block = await c
      .get('container')
      .executionService.mergePr(param(c, 'workspaceId'), param(c, 'blockId'))
    return c.json(block)
  })

  app.post('/tick', jsonBody(tickSchema), async (c) => {
    const instances = await c
      .get('container')
      .executionService.tick(param(c, 'workspaceId'), c.req.valid('json').ticks ?? 1)
    return c.json(instances)
  })

  app.post(
    '/executions/:executionId/decisions/:decisionId',
    jsonBody(resolveDecisionSchema),
    async (c) => {
      const instance = await c
        .get('container')
        .executionService.resolveDecision(
          param(c, 'workspaceId'),
          param(c, 'executionId'),
          param(c, 'decisionId'),
          c.req.valid('json').choice,
        )
      return c.json(instance)
    },
  )

  return app
}
