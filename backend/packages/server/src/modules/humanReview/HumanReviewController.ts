import { requestHumanReviewFixSchema } from '@cat-factory/contracts'
import { Hono } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'
import { jsonBody } from '../../http/validation.js'

/**
 * Workspace-scoped run-driving endpoint for the human-review gate. The gate self-drives off the
 * PR's GitHub review state (approve → advance; review threads → fixer), but a human can ALSO
 * request a freeform fix at any time — dispatched to the `fixer` immediately, bypassing the grace
 * window. Acts on the block's parked `human-review` step via the execution service and returns the
 * updated execution instance. Mounted under `/workspaces/:workspaceId`.
 */
export function humanReviewController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.post(
    '/blocks/:blockId/human-review/request-fix',
    jsonBody(requestHumanReviewFixSchema),
    async (c) => {
      const instance = await c
        .get('container')
        .executionService.requestHumanReviewFix(
          param(c, 'workspaceId'),
          param(c, 'blockId'),
          c.req.valid('json').instructions,
        )
      return c.json(instance)
    },
  )

  return app
}
