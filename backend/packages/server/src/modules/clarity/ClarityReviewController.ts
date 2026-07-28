import { UnavailableError } from '@cat-factory/kernel'
import {
  getClarityReviewContract,
  incorporateClarityContract,
  proceedClarityContract,
  reReviewClarityContract,
  replyClarityItemContract,
  resolveClarityExceededContract,
  reviewClarityContract,
  updateClarityItemStatusContract,
} from '@cat-factory/contracts'
import type { ClarityModule } from '@cat-factory/orchestration'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'

/**
 * Resolve the clarity module or raise a 503 — it isn't wired on this deployment. Several
 * routes below call this purely as an ASSERTION (they reach the same feature through
 * `executionService.clarityReview`, so the module value itself is unused): with clarity
 * unwired the endpoint must still 503 rather than 500 deeper in.
 */
function requireClarity<E extends AppEnv>(c: Context<E>): ClarityModule {
  const clarity = c.get('container').clarity
  if (!clarity) throw new UnavailableError('Clarity review is not configured')
  return clarity
}

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
  buildHonoRoute(app, getClarityReviewContract, async (c) => {
    const clarity = requireClarity(c)
    const review = await clarity.service.getForBlock(
      param(c, 'workspaceId'),
      c.req.valid('param').blockId,
    )
    return c.json(review, 200)
  })

  // Run a fresh triage of the block's bug report (replaces any prior). Routed through the
  // execution service so the off-path surface honours the task's merge-preset knobs and
  // threads in any upstream investigator output, exactly like the gate.
  buildHonoRoute(app, reviewClarityContract, async (c) => {
    requireClarity(c)
    const review = await c
      .get('container')
      .executionService.clarityReview.review(param(c, 'workspaceId'), c.req.valid('param').blockId)
    return c.json(review, 201)
  })

  // Answer a single review item.
  buildHonoRoute(app, replyClarityItemContract, async (c) => {
    const clarity = requireClarity(c)
    const { reviewId, itemId } = c.req.valid('param')
    const review = await clarity.service.replyToItem(
      param(c, 'workspaceId'),
      reviewId,
      itemId,
      c.req.valid('json').reply,
    )
    return c.json(review, 200)
  })

  // Set a review item's status (resolve / dismiss / reopen).
  buildHonoRoute(app, updateClarityItemStatusContract, async (c) => {
    const clarity = requireClarity(c)
    const { reviewId, itemId } = c.req.valid('param')
    const review = await clarity.service.setItemStatus(
      param(c, 'workspaceId'),
      reviewId,
      itemId,
      c.req.valid('json').status,
    )
    return c.json(review, 200)
  })

  // Incorporate the answers ASYNCHRONOUSLY (the durable driver folds + re-reviews).
  buildHonoRoute(app, incorporateClarityContract, async (c) => {
    requireClarity(c)
    const review = await c
      .get('container')
      .executionService.clarityReview.incorporate(
        param(c, 'workspaceId'),
        c.req.valid('param').blockId,
        c.req.valid('json').feedback,
      )
    return c.json(review, 200)
  })

  // Re-review the clarified report (one more reviewer pass).
  buildHonoRoute(app, reReviewClarityContract, async (c) => {
    requireClarity(c)
    const review = await c
      .get('container')
      .executionService.clarityReview.reReview(
        param(c, 'workspaceId'),
        c.req.valid('param').blockId,
      )
    return c.json(review, 200)
  })

  // Proceed: settle the clarity review (last clarified report wins downstream) and advance.
  buildHonoRoute(app, proceedClarityContract, async (c) => {
    requireClarity(c)
    const review = await c
      .get('container')
      .executionService.clarityReview.proceed(param(c, 'workspaceId'), c.req.valid('param').blockId)
    return c.json(review, 200)
  })

  // Resolve a review that hit its iteration cap: one more round / proceed / stop-reset.
  buildHonoRoute(app, resolveClarityExceededContract, async (c) => {
    requireClarity(c)
    const review = await c
      .get('container')
      .executionService.clarityReview.resolveExceeded(
        param(c, 'workspaceId'),
        c.req.valid('param').blockId,
        c.req.valid('json').choice,
      )
    return c.json(review, 200)
  })

  return app
}
