import {
  incorporatePublicRunRequirementsContract,
  proceedPublicRunRequirementsContract,
  replyPublicRunFindingContract,
  reReviewPublicRunRequirementsContract,
  resolvePublicRunRequirementsExceededContract,
  setPublicRunFindingStatusContract,
} from '@cat-factory/contracts'
import { buildHonoRoute } from '@toad-contracts/hono'
import type { Hono } from 'hono'
import type { AppEnv } from '../../../http/env.js'
import { buildDecisionList } from './projection.js'
import { failureBody, gateRequirementsAction } from './scope.js'

/**
 * The REQUIREMENTS review loop. Each route is the external twin of a `RequirementReviewController`
 * route, calling the same service method. The item-level routes are addressed by ITEM id (not
 * review id): a headless caller reads the findings from `GET .../decisions`, and making it also
 * thread a review id through would be ceremony over a value it never chose. The live review is
 * resolved from the run's block, exactly as the SPA's block-scoped routes do.
 */
export function registerRequirementsDecisionRoutes(app: Hono<AppEnv>): void {
  // Answer one finding.
  buildHonoRoute(app, replyPublicRunFindingContract, async (c) => {
    const { runId, itemId } = c.req.valid('param')
    const gated = await gateRequirementsAction(c, runId)
    if ('fail' in gated) {
      return c.json(failureBody(gated.fail), gated.fail.status)
    }
    const { workspaceId, scoped, requirements, review } = gated
    await requirements.service.replyToItem(
      workspaceId,
      review.id,
      itemId,
      c.req.valid('json').reply,
    )
    return c.json(await buildDecisionList(c, workspaceId, scoped), 200)
  })

  // Dismiss a finding as not applicable, or reopen one dismissed by mistake.
  buildHonoRoute(app, setPublicRunFindingStatusContract, async (c) => {
    const { runId, itemId } = c.req.valid('param')
    const gated = await gateRequirementsAction(c, runId)
    if ('fail' in gated) {
      return c.json(failureBody(gated.fail), gated.fail.status)
    }
    const { workspaceId, scoped, requirements, review } = gated
    await requirements.service.setItemStatus(
      workspaceId,
      review.id,
      itemId,
      c.req.valid('json').status,
    )
    return c.json(await buildDecisionList(c, workspaceId, scoped), 200)
  })

  // Fold the recorded answers into the standardized document. ASYNCHRONOUS: it records the intent
  // on the parked step and signals the durable driver, which folds + re-reviews in the background —
  // so the returned list shows the review `incorporating`, and the caller learns the outcome from
  // the SSE stream or a follow-up read, exactly as the SPA does.
  buildHonoRoute(app, incorporatePublicRunRequirementsContract, async (c) => {
    const { runId } = c.req.valid('param')
    const gated = await gateRequirementsAction(c, runId)
    if ('fail' in gated) {
      return c.json(failureBody(gated.fail), gated.fail.status)
    }
    const { workspaceId, scoped } = gated
    await c
      .get('container')
      .executionService.requirementsReview.incorporate(
        workspaceId,
        scoped.blockId,
        c.req.valid('json').feedback,
      )
    return c.json(await buildDecisionList(c, workspaceId, scoped), 200)
  })

  // One more reviewer pass over the incorporated document. On convergence the parked run advances.
  buildHonoRoute(app, reReviewPublicRunRequirementsContract, async (c) => {
    const { runId } = c.req.valid('param')
    const gated = await gateRequirementsAction(c, runId)
    if ('fail' in gated) {
      return c.json(failureBody(gated.fail), gated.fail.status)
    }
    const { workspaceId, scoped } = gated
    await c
      .get('container')
      .executionService.requirementsReview.reReview(workspaceId, scoped.blockId)
    return c.json(await buildDecisionList(c, workspaceId, scoped), 200)
  })

  // Settle the requirements phase and advance the parked run.
  buildHonoRoute(app, proceedPublicRunRequirementsContract, async (c) => {
    const { runId } = c.req.valid('param')
    const gated = await gateRequirementsAction(c, runId)
    if ('fail' in gated) {
      return c.json(failureBody(gated.fail), gated.fail.status)
    }
    const { workspaceId, scoped } = gated
    await c
      .get('container')
      .executionService.requirementsReview.proceed(workspaceId, scoped.blockId)
    return c.json(await buildDecisionList(c, workspaceId, scoped), 200)
  })

  // Resolve a review that hit its iteration cap (extra round / proceed / stop and reset).
  buildHonoRoute(app, resolvePublicRunRequirementsExceededContract, async (c) => {
    const { runId } = c.req.valid('param')
    const gated = await gateRequirementsAction(c, runId)
    if ('fail' in gated) {
      return c.json(failureBody(gated.fail), gated.fail.status)
    }
    const { workspaceId, scoped } = gated
    await c
      .get('container')
      .executionService.requirementsReview.resolveExceeded(
        workspaceId,
        scoped.blockId,
        c.req.valid('json').choice,
      )
    return c.json(await buildDecisionList(c, workspaceId, scoped), 200)
  })
}
