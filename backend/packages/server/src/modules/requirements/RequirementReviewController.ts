import {
  acceptRequirementRecommendationContract,
  getRequirementReviewContract,
  incorporateRequirementsContract,
  proceedRequirementsContract,
  reRequestRequirementRecommendationContract,
  reReviewRequirementsContract,
  rejectRequirementRecommendationContract,
  replyRequirementItemContract,
  requestRequirementRecommendationsContract,
  resolveRequirementsExceededContract,
  reviewRequirementsContract,
  updateRequirementItemStatusContract,
} from '@cat-factory/contracts'
import type { RequirementsModule } from '@cat-factory/orchestration'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'

/** Resolve the requirements module or send a 503, returning null when unconfigured. */
function requireRequirements<E extends AppEnv>(c: Context<E>): RequirementsModule | null {
  return c.get('container').requirements ?? null
}

const unavailable = <E extends AppEnv>(c: Context<E>) =>
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
  buildHonoRoute(app, getRequirementReviewContract, async (c) => {
    const requirements = requireRequirements(c)
    if (!requirements) return unavailable(c)
    const review = await requirements.service.getForBlock(
      param(c, 'workspaceId'),
      c.req.valid('param').blockId,
    )
    return c.json(review, 200)
  })

  // Run a fresh review of the block's collected requirements (replaces any prior).
  // Routed through the execution service so the off-path surface honours the task's
  // merge-preset knobs (iteration budget + tolerated severity) exactly like the gate.
  buildHonoRoute(app, reviewRequirementsContract, async (c) => {
    const requirements = requireRequirements(c)
    if (!requirements) return unavailable(c)
    const review = await c
      .get('container')
      .executionService.reviewRequirements(param(c, 'workspaceId'), c.req.valid('param').blockId)
    return c.json(review, 201)
  })

  // Answer a single review item.
  buildHonoRoute(app, replyRequirementItemContract, async (c) => {
    const requirements = requireRequirements(c)
    if (!requirements) return unavailable(c)
    const { reviewId, itemId } = c.req.valid('param')
    const review = await requirements.service.replyToItem(
      param(c, 'workspaceId'),
      reviewId,
      itemId,
      c.req.valid('json').reply,
    )
    return c.json(review, 200)
  })

  // Set a review item's status (resolve / dismiss / reopen).
  buildHonoRoute(app, updateRequirementItemStatusContract, async (c) => {
    const requirements = requireRequirements(c)
    if (!requirements) return unavailable(c)
    const { reviewId, itemId } = c.req.valid('param')
    const review = await requirements.service.setItemStatus(
      param(c, 'workspaceId'),
      reviewId,
      itemId,
      c.req.valid('json').status,
    )
    return c.json(review, 200)
  })

  // Incorporate the answers ASYNCHRONOUSLY: the durable driver folds them into one
  // standard-format document and re-reviews it in the background. Optional `feedback` is the
  // "do it differently" lever when redoing a merge. Returns the `incorporating` review at
  // once (no LLM in the request) so the SPA returns the user to the board; a notification
  // calls them back only if the re-review needs input. Blocks scoped (the review is resolved
  // from the block) to match the other run-driving endpoints.
  buildHonoRoute(app, incorporateRequirementsContract, async (c) => {
    const requirements = requireRequirements(c)
    if (!requirements) return unavailable(c)
    const review = await c
      .get('container')
      .executionService.incorporateRequirements(
        param(c, 'workspaceId'),
        c.req.valid('param').blockId,
        c.req.valid('json').feedback,
      )
    return c.json(review, 200)
  })

  // Re-review the incorporated document (one more reviewer pass). On convergence the
  // parked run advances; otherwise the response carries the next cycle's findings (or the
  // iteration-cap state). Returns the updated review.
  buildHonoRoute(app, reReviewRequirementsContract, async (c) => {
    const requirements = requireRequirements(c)
    if (!requirements) return unavailable(c)
    const review = await c
      .get('container')
      .executionService.reReviewRequirements(param(c, 'workspaceId'), c.req.valid('param').blockId)
    return c.json(review, 200)
  })

  // Proceed: settle the requirements (last incorporated doc wins downstream) and advance
  // the parked run. Used when every finding is dismissed.
  buildHonoRoute(app, proceedRequirementsContract, async (c) => {
    const requirements = requireRequirements(c)
    if (!requirements) return unavailable(c)
    const review = await c
      .get('container')
      .executionService.proceedRequirements(param(c, 'workspaceId'), c.req.valid('param').blockId)
    return c.json(review, 200)
  })

  // Ask the Requirement Writer to recommend grounded answers for a batch of findings the human
  // marked "recommend something". ASYNCHRONOUS: appends `pending` placeholder recommendations
  // and signals the durable driver to run the Writer per finding in the background (grounded on
  // best-practice fragments → spec/tech-spec → web search), returning at once with the
  // placeholders so the user goes back to the board; a notification calls them back when the
  // batch is ready. Block-scoped (the live review is resolved from the block); a no-op when no
  // review exists.
  buildHonoRoute(app, requestRequirementRecommendationsContract, async (c) => {
    const requirements = requireRequirements(c)
    if (!requirements) return unavailable(c)
    const workspaceId = param(c, 'workspaceId')
    const blockId = c.req.valid('param').blockId
    const review = await requirements.service.getForBlock(workspaceId, blockId)
    if (!review) return c.json(null, 200)
    const body = c.req.valid('json')
    const updated = await c
      .get('container')
      .executionService.requestRecommendations(workspaceId, blockId, body.itemIds, body.note)
    return c.json(updated, 200)
  })

  // Accept a recommendation (it becomes the finding's answer, folded into the next
  // incorporation), reject it, or re-request it with a "do it differently" note.
  buildHonoRoute(app, acceptRequirementRecommendationContract, async (c) => {
    const requirements = requireRequirements(c)
    if (!requirements) return unavailable(c)
    const { reviewId, recId } = c.req.valid('param')
    const review = await requirements.service.acceptRecommendation(
      param(c, 'workspaceId'),
      reviewId,
      recId,
    )
    return c.json(review, 200)
  })

  buildHonoRoute(app, rejectRequirementRecommendationContract, async (c) => {
    const requirements = requireRequirements(c)
    if (!requirements) return unavailable(c)
    const { reviewId, recId } = c.req.valid('param')
    const review = await requirements.service.rejectRecommendation(
      param(c, 'workspaceId'),
      reviewId,
      recId,
    )
    return c.json(review, 200)
  })

  // Re-request a recommendation with a "do it differently" note. ASYNCHRONOUS like the batch:
  // resets the recommendation to `pending` and signals the driver to re-run the Writer.
  buildHonoRoute(app, reRequestRequirementRecommendationContract, async (c) => {
    const requirements = requireRequirements(c)
    if (!requirements) return unavailable(c)
    const { reviewId, recId } = c.req.valid('param')
    const review = await c
      .get('container')
      .executionService.reRequestRecommendation(
        param(c, 'workspaceId'),
        reviewId,
        recId,
        c.req.valid('json').note,
      )
    return c.json(review, 200)
  })

  // Resolve a review that hit its iteration cap: one more round / proceed anyway / stop
  // and reset the task to phase zero. Returns the updated review.
  buildHonoRoute(app, resolveRequirementsExceededContract, async (c) => {
    const requirements = requireRequirements(c)
    if (!requirements) return unavailable(c)
    const review = await c
      .get('container')
      .executionService.resolveRequirementsExceeded(
        param(c, 'workspaceId'),
        c.req.valid('param').blockId,
        c.req.valid('json').choice,
      )
    return c.json(review, 200)
  })

  return app
}
