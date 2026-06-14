import { resolveDecisionSchema, startExecutionSchema } from '@cat-factory/contracts'
import { Hono } from 'hono'
import type { AppEnv } from '../../infrastructure/http/types'
import { param } from '../../infrastructure/http/params'
import { jsonBody } from '../../infrastructure/http/validation'

/**
 * The execution engine endpoints — starting/cancelling runs, resolving decisions
 * and merging PRs. Runs advance durably server-side via Cloudflare Workflows;
 * progress reaches the browser over the WebSocket events stream, not by polling.
 * Mounted under `/workspaces/:workspaceId`.
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

  // Current spend-safeguard status (token usage vs budget for this period).
  app.get('/spend', async (c) => {
    return c.json(await c.get('container').spendService.status())
  })

  // Resume runs paused by the spend safeguard in this workspace.
  app.post('/spend/resume', async (c) => {
    const instances = await c
      .get('container')
      .executionService.resumePaused(param(c, 'workspaceId'))
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
