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

/** Resolve the clarity module or send a 503, returning null when unconfigured. */
function requireClarity<E extends AppEnv>(c: Context<E>): ClarityModule | null {
  return c.get('container').clarity ?? null
}

const unavailable = <E extends AppEnv>(c: Context<E>) =>
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
  buildHonoRoute(app, getClarityReviewContract, async (c) => {
    const clarity = requireClarity(c)
    if (!clarity) return unavailable(c)
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
    const clarity = requireClarity(c)
    if (!clarity) return unavailable(c)
    const review = await c
      .get('container')
      .executionService.reviewClarity(param(c, 'workspaceId'), c.req.valid('param').blockId)
    return c.json(review, 201)
  })

  // Answer a single review item.
  buildHonoRoute(app, replyClarityItemContract, async (c) => {
    const clarity = requireClarity(c)
    if (!clarity) return unavailable(c)
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
    if (!clarity) return unavailable(c)
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
    const clarity = requireClarity(c)
    if (!clarity) return unavailable(c)
    const review = await c
      .get('container')
      .executionService.incorporateClarity(
        param(c, 'workspaceId'),
        c.req.valid('param').blockId,
        c.req.valid('json').feedback,
      )
    return c.json(review, 200)
  })

  // Re-review the clarified report (one more reviewer pass).
  buildHonoRoute(app, reReviewClarityContract, async (c) => {
    const clarity = requireClarity(c)
    if (!clarity) return unavailable(c)
    const review = await c
      .get('container')
      .executionService.reReviewClarity(param(c, 'workspaceId'), c.req.valid('param').blockId)
    return c.json(review, 200)
  })

  // Proceed: settle the clarity review (last clarified report wins downstream) and advance.
  buildHonoRoute(app, proceedClarityContract, async (c) => {
    const clarity = requireClarity(c)
    if (!clarity) return unavailable(c)
    const review = await c
      .get('container')
      .executionService.proceedClarity(param(c, 'workspaceId'), c.req.valid('param').blockId)
    return c.json(review, 200)
  })

  // Resolve a review that hit its iteration cap: one more round / proceed / stop-reset.
  buildHonoRoute(app, resolveClarityExceededContract, async (c) => {
    const clarity = requireClarity(c)
    if (!clarity) return unavailable(c)
    const review = await c
      .get('container')
      .executionService.resolveClarityExceeded(
        param(c, 'workspaceId'),
        c.req.valid('param').blockId,
        c.req.valid('json').choice,
      )
    return c.json(review, 200)
  })

  return app
}
