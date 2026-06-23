import {
  incorporateClaritySchema,
  replyClarityItemSchema,
  resolveClarityExceededSchema,
  updateClarityItemStatusSchema,
} from '@cat-factory/contracts'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { ClarityModule } from '@cat-factory/orchestration'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'
import { jsonBody } from '../../http/validation.js'

/** Resolve the clarity module or send a 503, returning null when unconfigured. */
function requireClarity(c: Context<AppEnv>): ClarityModule | null {
  return c.get('container').clarity ?? null
}

const unavailable = (c: Context<AppEnv>) =>
  c.json({ error: { code: 'unavailable', message: 'Clarity review is not configured' } }, 503)

/**
 * Workspace-scoped clarity-review (bug-report triage) endpoints. The clarity mirror of the
 * requirements-review controller: the initial review runs an LLM inline and returns the
 * entity; incorporation is ASYNCHRONOUS (records the intent on the parked run, signals the
 * durable driver to fold + re-review, returns at once with the `incorporating` review).
 * Mounted under `/workspaces/:workspaceId`.
 */
export function clarityReviewController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // The current review for a block (null when none has been run yet).
  app.get('/blocks/:blockId/clarity-review', async (c) => {
    const clarity = requireClarity(c)
    if (!clarity) return unavailable(c)
    const review = await clarity.service.getForBlock(param(c, 'workspaceId'), param(c, 'blockId'))
    return c.json(review)
  })

  // Run a fresh triage of the block's bug report (replaces any prior). Routed through the
  // execution service so the off-path surface honours the task's merge-preset knobs and
  // threads in any upstream investigator output, exactly like the gate.
  app.post('/blocks/:blockId/clarity-review', async (c) => {
    const clarity = requireClarity(c)
    if (!clarity) return unavailable(c)
    const review = await c
      .get('container')
      .executionService.reviewClarity(param(c, 'workspaceId'), param(c, 'blockId'))
    return c.json(review, 201)
  })

  // Answer a single review item.
  app.post(
    '/clarity-reviews/:reviewId/items/:itemId/reply',
    jsonBody(replyClarityItemSchema),
    async (c) => {
      const clarity = requireClarity(c)
      if (!clarity) return unavailable(c)
      const review = await clarity.service.replyToItem(
        param(c, 'workspaceId'),
        param(c, 'reviewId'),
        param(c, 'itemId'),
        c.req.valid('json').reply,
      )
      return c.json(review)
    },
  )

  // Set a review item's status (resolve / dismiss / reopen).
  app.patch(
    '/clarity-reviews/:reviewId/items/:itemId',
    jsonBody(updateClarityItemStatusSchema),
    async (c) => {
      const clarity = requireClarity(c)
      if (!clarity) return unavailable(c)
      const review = await clarity.service.setItemStatus(
        param(c, 'workspaceId'),
        param(c, 'reviewId'),
        param(c, 'itemId'),
        c.req.valid('json').status,
      )
      return c.json(review)
    },
  )

  // Incorporate the answers ASYNCHRONOUSLY (the durable driver folds + re-reviews).
  app.post(
    '/blocks/:blockId/clarity-review/incorporate',
    jsonBody(incorporateClaritySchema),
    async (c) => {
      const clarity = requireClarity(c)
      if (!clarity) return unavailable(c)
      const review = await c
        .get('container')
        .executionService.incorporateClarity(
          param(c, 'workspaceId'),
          param(c, 'blockId'),
          c.req.valid('json').feedback,
        )
      return c.json(review)
    },
  )

  // Re-review the clarified report (one more reviewer pass).
  app.post('/blocks/:blockId/clarity-review/re-review', async (c) => {
    const clarity = requireClarity(c)
    if (!clarity) return unavailable(c)
    const review = await c
      .get('container')
      .executionService.reReviewClarity(param(c, 'workspaceId'), param(c, 'blockId'))
    return c.json(review)
  })

  // Proceed: settle the clarity review (last clarified report wins downstream) and advance.
  app.post('/blocks/:blockId/clarity-review/proceed', async (c) => {
    const clarity = requireClarity(c)
    if (!clarity) return unavailable(c)
    const review = await c
      .get('container')
      .executionService.proceedClarity(param(c, 'workspaceId'), param(c, 'blockId'))
    return c.json(review)
  })

  // Resolve a review that hit its iteration cap: one more round / proceed / stop-reset.
  app.post(
    '/blocks/:blockId/clarity-review/resolve-exceeded',
    jsonBody(resolveClarityExceededSchema),
    async (c) => {
      const clarity = requireClarity(c)
      if (!clarity) return unavailable(c)
      const review = await c
        .get('container')
        .executionService.resolveClarityExceeded(
          param(c, 'workspaceId'),
          param(c, 'blockId'),
          c.req.valid('json').choice,
        )
      return c.json(review)
    },
  )

  return app
}
