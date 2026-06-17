import { replyReviewItemSchema, updateReviewItemStatusSchema } from '@cat-factory/contracts'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { RequirementsModule } from '@cat-factory/core'
import type { AppEnv } from '../../infrastructure/http/types'
import { param } from '../../infrastructure/http/params'
import { jsonBody } from '../../infrastructure/http/validation'

/** Resolve the requirements module or send a 503, returning null when unconfigured. */
function requireRequirements(c: Context<AppEnv>): RequirementsModule | null {
  return c.get('container').requirements ?? null
}

const unavailable = (c: Context<AppEnv>) =>
  c.json({ error: { code: 'unavailable', message: 'Requirements review is not configured' } }, 503)

/**
 * Workspace-scoped requirements-review endpoints. The reviewer is stateless and
 * synchronous (no container, no durable driver): generating a review and
 * incorporating answers both run an LLM inline and return the updated entity, so
 * the SPA patches its store from the response without a real-time event. Mounted
 * under `/workspaces/:workspaceId`.
 */
export function requirementReviewController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // The current review for a block (null when none has been run yet).
  app.get('/blocks/:blockId/requirement-review', async (c) => {
    const requirements = requireRequirements(c)
    if (!requirements) return unavailable(c)
    const review = await requirements.service.getForBlock(
      param(c, 'workspaceId'),
      param(c, 'blockId'),
    )
    return c.json(review)
  })

  // Run a fresh review of the block's collected requirements (replaces any prior).
  app.post('/blocks/:blockId/requirement-review', async (c) => {
    const requirements = requireRequirements(c)
    if (!requirements) return unavailable(c)
    const review = await requirements.service.review(param(c, 'workspaceId'), param(c, 'blockId'))
    return c.json(review, 201)
  })

  // Answer a single review item.
  app.post(
    '/requirement-reviews/:reviewId/items/:itemId/reply',
    jsonBody(replyReviewItemSchema),
    async (c) => {
      const requirements = requireRequirements(c)
      if (!requirements) return unavailable(c)
      const review = await requirements.service.replyToItem(
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
    '/requirement-reviews/:reviewId/items/:itemId',
    jsonBody(updateReviewItemStatusSchema),
    async (c) => {
      const requirements = requireRequirements(c)
      if (!requirements) return unavailable(c)
      const review = await requirements.service.setItemStatus(
        param(c, 'workspaceId'),
        param(c, 'reviewId'),
        param(c, 'itemId'),
        c.req.valid('json').status,
      )
      return c.json(review)
    },
  )

  // Fold the answers back into the block's requirements (all items must be settled).
  app.post('/requirement-reviews/:reviewId/incorporate', async (c) => {
    const requirements = requireRequirements(c)
    if (!requirements) return unavailable(c)
    const result = await requirements.service.incorporate(
      param(c, 'workspaceId'),
      param(c, 'reviewId'),
    )
    return c.json(result)
  })

  return app
}
