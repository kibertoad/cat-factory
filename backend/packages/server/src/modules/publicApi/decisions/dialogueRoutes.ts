import {
  incorporatePublicRunBrainstormContract,
  incorporatePublicRunClarityContract,
  proceedPublicRunBrainstormContract,
  proceedPublicRunClarityContract,
  replyPublicRunBrainstormOptionContract,
  replyPublicRunClarityFindingContract,
  reReviewPublicRunBrainstormContract,
  reReviewPublicRunClarityContract,
  resolvePublicRunBrainstormExceededContract,
  resolvePublicRunClarityExceededContract,
  setPublicRunBrainstormOptionStatusContract,
  setPublicRunClarityFindingStatusContract,
} from '@cat-factory/contracts'
import { buildHonoRoute } from '@toad-contracts/hono'
import type { Hono } from 'hono'
import type { AppEnv } from '../../../http/env.js'
import { buildDecisionList } from './projection.js'
import { failureBody, gateBrainstormAction, gateClarityAction } from './scope.js'

// The two iterative-review loops beside requirements: CLARITY (bug-report triage) and the two
// BRAINSTORM dialogues. Both mirror the requirements routes verb for verb, because they are the
// same loop over a different subject — the engine drives all three through one
// `ReviewGateController`, so exposing them differently here would invent a distinction the
// platform does not have.
//
// Both are addressed the way requirements is: by ITEM id, with the live entity resolved from the
// run's block (and, for a brainstorm, its stage). The INTERNAL routes for both are entity-keyed
// (`/clarity-reviews/:reviewId/items/:itemId`, `/brainstorms/:sessionId/items/:itemId`); copying
// that here would make a headless caller thread through an id it never chose.

export function registerClarityDecisionRoutes(app: Hono<AppEnv>): void {
  // Answer one triage finding.
  buildHonoRoute(app, replyPublicRunClarityFindingContract, async (c) => {
    const { runId, itemId } = c.req.valid('param')
    const gated = await gateClarityAction(c, runId)
    if ('fail' in gated) {
      return c.json(failureBody(gated.fail), gated.fail.status)
    }
    const { workspaceId, scoped, clarity, review } = gated
    await clarity.service.replyToItem(workspaceId, review.id, itemId, c.req.valid('json').reply)
    return c.json(await buildDecisionList(c, workspaceId, scoped), 200)
  })

  // Dismiss a finding as not applicable, or reopen one dismissed by mistake.
  buildHonoRoute(app, setPublicRunClarityFindingStatusContract, async (c) => {
    const { runId, itemId } = c.req.valid('param')
    const gated = await gateClarityAction(c, runId)
    if ('fail' in gated) {
      return c.json(failureBody(gated.fail), gated.fail.status)
    }
    const { workspaceId, scoped, clarity, review } = gated
    await clarity.service.setItemStatus(workspaceId, review.id, itemId, c.req.valid('json').status)
    return c.json(await buildDecisionList(c, workspaceId, scoped), 200)
  })

  // Fold the recorded answers into a standardized bug report. ASYNCHRONOUS, as requirements.
  buildHonoRoute(app, incorporatePublicRunClarityContract, async (c) => {
    const { runId } = c.req.valid('param')
    const gated = await gateClarityAction(c, runId)
    if ('fail' in gated) {
      return c.json(failureBody(gated.fail), gated.fail.status)
    }
    const { workspaceId, scoped } = gated
    await c
      .get('container')
      .executionService.clarityReview.incorporate(
        workspaceId,
        scoped.blockId,
        c.req.valid('json').feedback,
      )
    return c.json(await buildDecisionList(c, workspaceId, scoped), 200)
  })

  // One more triage pass over the clarified report.
  buildHonoRoute(app, reReviewPublicRunClarityContract, async (c) => {
    const { runId } = c.req.valid('param')
    const gated = await gateClarityAction(c, runId)
    if ('fail' in gated) {
      return c.json(failureBody(gated.fail), gated.fail.status)
    }
    const { workspaceId, scoped } = gated
    await c.get('container').executionService.clarityReview.reReview(workspaceId, scoped.blockId)
    return c.json(await buildDecisionList(c, workspaceId, scoped), 200)
  })

  // Settle the clarity phase and advance the parked run.
  buildHonoRoute(app, proceedPublicRunClarityContract, async (c) => {
    const { runId } = c.req.valid('param')
    const gated = await gateClarityAction(c, runId)
    if ('fail' in gated) {
      return c.json(failureBody(gated.fail), gated.fail.status)
    }
    const { workspaceId, scoped } = gated
    await c.get('container').executionService.clarityReview.proceed(workspaceId, scoped.blockId)
    return c.json(await buildDecisionList(c, workspaceId, scoped), 200)
  })

  // Resolve a review that hit its iteration cap (extra round / proceed / stop and reset).
  buildHonoRoute(app, resolvePublicRunClarityExceededContract, async (c) => {
    const { runId } = c.req.valid('param')
    const gated = await gateClarityAction(c, runId)
    if ('fail' in gated) {
      return c.json(failureBody(gated.fail), gated.fail.status)
    }
    const { workspaceId, scoped } = gated
    await c
      .get('container')
      .executionService.clarityReview.resolveExceeded(
        workspaceId,
        scoped.blockId,
        c.req.valid('json').choice,
      )
    return c.json(await buildDecisionList(c, workspaceId, scoped), 200)
  })
}

export function registerBrainstormDecisionRoutes(app: Hono<AppEnv>): void {
  // Respond to one proposed option (pick it, or steer it).
  buildHonoRoute(app, replyPublicRunBrainstormOptionContract, async (c) => {
    const { runId, stage, itemId } = c.req.valid('param')
    const gated = await gateBrainstormAction(c, runId, stage)
    if ('fail' in gated) {
      return c.json(failureBody(gated.fail), gated.fail.status)
    }
    const { workspaceId, scoped, brainstorm, review } = gated
    await brainstorm.services[stage].replyToItem(
      workspaceId,
      review.id,
      itemId,
      c.req.valid('json').reply,
    )
    return c.json(await buildDecisionList(c, workspaceId, scoped), 200)
  })

  // Dismiss a proposed option, or reopen one dismissed by mistake.
  buildHonoRoute(app, setPublicRunBrainstormOptionStatusContract, async (c) => {
    const { runId, stage, itemId } = c.req.valid('param')
    const gated = await gateBrainstormAction(c, runId, stage)
    if ('fail' in gated) {
      return c.json(failureBody(gated.fail), gated.fail.status)
    }
    const { workspaceId, scoped, brainstorm, review } = gated
    await brainstorm.services[stage].setItemStatus(
      workspaceId,
      review.id,
      itemId,
      c.req.valid('json').status,
    )
    return c.json(await buildDecisionList(c, workspaceId, scoped), 200)
  })

  // Fold the picks into one converged direction. ASYNCHRONOUS, as requirements.
  buildHonoRoute(app, incorporatePublicRunBrainstormContract, async (c) => {
    const { runId, stage } = c.req.valid('param')
    const gated = await gateBrainstormAction(c, runId, stage)
    if ('fail' in gated) {
      return c.json(failureBody(gated.fail), gated.fail.status)
    }
    const { workspaceId, scoped } = gated
    await c
      .get('container')
      .executionService.brainstorm.incorporate(
        workspaceId,
        scoped.blockId,
        stage,
        c.req.valid('json').feedback,
      )
    return c.json(await buildDecisionList(c, workspaceId, scoped), 200)
  })

  // One more brainstorm pass against the converged direction.
  buildHonoRoute(app, reReviewPublicRunBrainstormContract, async (c) => {
    const { runId, stage } = c.req.valid('param')
    const gated = await gateBrainstormAction(c, runId, stage)
    if ('fail' in gated) {
      return c.json(failureBody(gated.fail), gated.fail.status)
    }
    const { workspaceId, scoped } = gated
    await c
      .get('container')
      .executionService.brainstorm.reReview(workspaceId, scoped.blockId, stage)
    return c.json(await buildDecisionList(c, workspaceId, scoped), 200)
  })

  // Settle the brainstorm (the last converged direction wins downstream) and advance the run.
  buildHonoRoute(app, proceedPublicRunBrainstormContract, async (c) => {
    const { runId, stage } = c.req.valid('param')
    const gated = await gateBrainstormAction(c, runId, stage)
    if ('fail' in gated) {
      return c.json(failureBody(gated.fail), gated.fail.status)
    }
    const { workspaceId, scoped } = gated
    await c.get('container').executionService.brainstorm.proceed(workspaceId, scoped.blockId, stage)
    return c.json(await buildDecisionList(c, workspaceId, scoped), 200)
  })

  // Resolve a session that hit its iteration cap (extra round / proceed / stop and reset).
  buildHonoRoute(app, resolvePublicRunBrainstormExceededContract, async (c) => {
    const { runId, stage } = c.req.valid('param')
    const gated = await gateBrainstormAction(c, runId, stage)
    if ('fail' in gated) {
      return c.json(failureBody(gated.fail), gated.fail.status)
    }
    const { workspaceId, scoped } = gated
    await c
      .get('container')
      .executionService.brainstorm.resolveExceeded(
        workspaceId,
        scoped.blockId,
        stage,
        c.req.valid('json').choice,
      )
    return c.json(await buildDecisionList(c, workspaceId, scoped), 200)
  })
}
