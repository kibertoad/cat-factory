import {
  approveVisualConfirmContract,
  recaptureVisualConfirmContract,
  requestVisualConfirmFixContract,
} from '@cat-factory/contracts'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'

/**
 * Workspace-scoped run-driving endpoints for the visual-confirmation gate. Each acts on the
 * block's parked `visual-confirmation` step via the execution service: approve (advance),
 * request a fix from findings (dispatch the Tester's `fixer`), or recapture (refresh the
 * actual-vs-reference pairs from the latest UI-tester report). They return the updated
 * execution instance. Mounted under `/workspaces/:workspaceId`.
 */
export function visualConfirmationController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // The human approved the screenshots: advance the pipeline.
  buildHonoRoute(app, approveVisualConfirmContract, async (c) => {
    const instance = await c
      .get('container')
      .executionService.approveVisualConfirm(param(c, 'workspaceId'), c.req.valid('param').blockId)
    return c.json(instance, 200)
  })

  // Submit findings and request a fix: dispatch the fixer, then re-park.
  buildHonoRoute(app, requestVisualConfirmFixContract, async (c) => {
    const instance = await c
      .get('container')
      .executionService.requestVisualConfirmFix(
        param(c, 'workspaceId'),
        c.req.valid('param').blockId,
        c.req.valid('json').findings,
      )
    return c.json(instance, 200)
  })

  // Refresh the actual-vs-reference pairs from the latest UI-tester report.
  buildHonoRoute(app, recaptureVisualConfirmContract, async (c) => {
    const instance = await c
      .get('container')
      .executionService.recaptureVisualConfirm(
        param(c, 'workspaceId'),
        c.req.valid('param').blockId,
      )
    return c.json(instance, 200)
  })

  return app
}
