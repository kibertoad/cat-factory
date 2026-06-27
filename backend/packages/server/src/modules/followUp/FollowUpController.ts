import {
  answerFollowUpContract,
  dismissFollowUpContract,
  fileFollowUpContract,
  getFollowUpsContract,
  queueFollowUpContract,
} from '@cat-factory/contracts'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'

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
  buildHonoRoute(app, getFollowUpsContract, async (c) => {
    const state = await c
      .get('container')
      .executionService.getFollowUps(param(c, 'workspaceId'), c.req.valid('param').executionId)
    return c.json(state, 200)
  })

  // File a follow-up item as a tracker issue (GitHub Issues / Jira).
  buildHonoRoute(app, fileFollowUpContract, async (c) => {
    const { executionId, itemId } = c.req.valid('param')
    const state = await c
      .get('container')
      .executionService.fileFollowUp(param(c, 'workspaceId'), executionId, itemId)
    return c.json(state, 200)
  })

  // Send a follow-up item back to the Coder (queued for its next pass).
  buildHonoRoute(app, queueFollowUpContract, async (c) => {
    const { executionId, itemId } = c.req.valid('param')
    const state = await c
      .get('container')
      .executionService.queueFollowUp(param(c, 'workspaceId'), executionId, itemId)
    return c.json(state, 200)
  })

  // Answer a question item (the answer folds into the Coder's next pass).
  buildHonoRoute(app, answerFollowUpContract, async (c) => {
    const { executionId, itemId } = c.req.valid('param')
    const { answer } = c.req.valid('json')
    const state = await c
      .get('container')
      .executionService.answerFollowUp(param(c, 'workspaceId'), executionId, itemId, answer)
    return c.json(state, 200)
  })

  // Dismiss a follow-up / question item without acting on it.
  buildHonoRoute(app, dismissFollowUpContract, async (c) => {
    const { executionId, itemId } = c.req.valid('param')
    const state = await c
      .get('container')
      .executionService.dismissFollowUp(param(c, 'workspaceId'), executionId, itemId)
    return c.json(state, 200)
  })

  return app
}
