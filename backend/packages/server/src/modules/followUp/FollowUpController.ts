import { answerFollowUpSchema } from '@cat-factory/contracts'
import { Hono } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'
import { jsonBody } from '../../http/validation.js'

/**
 * Workspace-scoped Follow-up companion endpoints. The Coder surfaces forward-looking items
 * (loose ends / side-tasks / questions) live on its run step; these endpoints let a human
 * decide each one — file a follow-up as a tracker issue, send it back to the Coder, answer a
 * question, or dismiss it. Each returns the updated live state; when the run is parked on the
 * follow-up gate and the last item is decided, the execution service drives the run forward
 * (loop the Coder for the queued / answered items, else advance). Mounted under
 * `/workspaces/:workspaceId`.
 */
export function followUpController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // The live follow-up state for a run (null when the companion is off / nothing surfaced).
  app.get('/executions/:executionId/follow-ups', async (c) => {
    const state = await c
      .get('container')
      .executionService.getFollowUps(param(c, 'workspaceId'), param(c, 'executionId'))
    return c.json(state)
  })

  // File a follow-up item as a tracker issue (GitHub Issues / Jira).
  app.post('/executions/:executionId/follow-ups/:itemId/file', async (c) => {
    const state = await c
      .get('container')
      .executionService.fileFollowUp(
        param(c, 'workspaceId'),
        param(c, 'executionId'),
        param(c, 'itemId'),
      )
    return c.json(state)
  })

  // Send a follow-up item back to the Coder (queued for its next pass).
  app.post('/executions/:executionId/follow-ups/:itemId/queue', async (c) => {
    const state = await c
      .get('container')
      .executionService.queueFollowUp(
        param(c, 'workspaceId'),
        param(c, 'executionId'),
        param(c, 'itemId'),
      )
    return c.json(state)
  })

  // Answer a question item (the answer folds into the Coder's next pass).
  app.post(
    '/executions/:executionId/follow-ups/:itemId/answer',
    jsonBody(answerFollowUpSchema),
    async (c) => {
      const { answer } = c.req.valid('json')
      const state = await c
        .get('container')
        .executionService.answerFollowUp(
          param(c, 'workspaceId'),
          param(c, 'executionId'),
          param(c, 'itemId'),
          answer,
        )
      return c.json(state)
    },
  )

  // Dismiss a follow-up / question item without acting on it.
  app.post('/executions/:executionId/follow-ups/:itemId/dismiss', async (c) => {
    const state = await c
      .get('container')
      .executionService.dismissFollowUp(
        param(c, 'workspaceId'),
        param(c, 'executionId'),
        param(c, 'itemId'),
      )
    return c.json(state)
  })

  return app
}
