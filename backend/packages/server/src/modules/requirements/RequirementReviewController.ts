import {
  incorporateRequirementsSchema,
  replyReviewItemSchema,
  resolveRequirementsExceededSchema,
  updateReviewItemStatusSchema,
} from '@cat-factory/contracts'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { RequirementsModule } from '@cat-factory/orchestration'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'
import { jsonBody } from '../../http/validation.js'

/** Resolve the requirements module or send a 503, returning null when unconfigured. */
function requireRequirements(c: Context<AppEnv>): RequirementsModule | null {
  return c.get('container').requirements ?? null
}

const unavailable = (c: Context<AppEnv>) =>
  c.json({ error: { code: 'unavailable', message: 'Requirements review is not configured' } }, 503)

/**
 * Workspace-scoped requirements-review endpoints. The initial review runs an LLM inline and
 * returns the entity. Incorporation, by contrast, is ASYNCHRONOUS: it records the human's
 * intent on the parked run, signals the durable driver to fold + re-review in the
 * background, and returns at once with the `incorporating` review so the SPA can return the
 * user to the board — they are summoned again (a notification) only if input is needed.
 * Mounted under `/workspaces/:workspaceId`.
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
  // Routed through the execution service so the off-path surface honours the task's
  // merge-preset knobs (iteration budget + tolerated severity) exactly like the gate.
  app.post('/blocks/:blockId/requirement-review', async (c) => {
    const requirements = requireRequirements(c)
    if (!requirements) return unavailable(c)
    const review = await c
      .get('container')
      .executionService.reviewRequirements(param(c, 'workspaceId'), param(c, 'blockId'))
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

  // Incorporate the answers ASYNCHRONOUSLY: the durable driver folds them into one
  // standard-format document and re-reviews it in the background. Optional `feedback` is the
  // "do it differently" lever when redoing a merge. Returns the `incorporating` review at
  // once (no LLM in the request) so the SPA returns the user to the board; a notification
  // calls them back only if the re-review needs input. Blocks scoped (the review is resolved
  // from the block) to match the other run-driving endpoints.
  app.post(
    '/blocks/:blockId/requirement-review/incorporate',
    jsonBody(incorporateRequirementsSchema),
    async (c) => {
      const requirements = requireRequirements(c)
      if (!requirements) return unavailable(c)
      const review = await c
        .get('container')
        .executionService.incorporateRequirements(
          param(c, 'workspaceId'),
          param(c, 'blockId'),
          c.req.valid('json').feedback,
        )
      return c.json(review)
    },
  )

  // Re-review the incorporated document (one more reviewer pass). On convergence the
  // parked run advances; otherwise the response carries the next cycle's findings (or the
  // iteration-cap state). Returns the updated review.
  app.post('/blocks/:blockId/requirement-review/re-review', async (c) => {
    const requirements = requireRequirements(c)
    if (!requirements) return unavailable(c)
    const review = await c
      .get('container')
      .executionService.reReviewRequirements(param(c, 'workspaceId'), param(c, 'blockId'))
    return c.json(review)
  })

  // Proceed: settle the requirements (last incorporated doc wins downstream) and advance
  // the parked run. Used when every finding is dismissed.
  app.post('/blocks/:blockId/requirement-review/proceed', async (c) => {
    const requirements = requireRequirements(c)
    if (!requirements) return unavailable(c)
    const review = await c
      .get('container')
      .executionService.proceedRequirements(param(c, 'workspaceId'), param(c, 'blockId'))
    return c.json(review)
  })

  // Resolve a review that hit its iteration cap: one more round / proceed anyway / stop
  // and reset the task to phase zero. Returns the updated review.
  app.post(
    '/blocks/:blockId/requirement-review/resolve-exceeded',
    jsonBody(resolveRequirementsExceededSchema),
    async (c) => {
      const requirements = requireRequirements(c)
      if (!requirements) return unavailable(c)
      const review = await c
        .get('container')
        .executionService.resolveRequirementsExceeded(
          param(c, 'workspaceId'),
          param(c, 'blockId'),
          c.req.valid('json').choice,
        )
      return c.json(review)
    },
  )

  return app
}
