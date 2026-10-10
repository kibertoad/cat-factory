import {
  challengePrReviewFindingContract,
  dismissPrReviewFindingContract,
  getPrReviewContract,
  resolvePrReviewContract,
  resumePrReviewContract,
} from '@cat-factory/contracts'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import { runWithInitiator } from '../../github/runInitiatorContext.js'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'

/**
 * Workspace-scoped PR deep-review endpoints. The read-only `pr-reviewer` agent slices an open
 * pull request and surfaces prioritized findings; the run then parks for a human to SELECT
 * which findings matter. The read returns the run's active review state (null when no
 * `pr-reviewer` step carries one); `resolve` records the curated selection and completes the
 * read-only review, advancing the run. `resume` is the exception to the park-then-act shape: it
 * acts on a review still IN FLIGHT, re-dispatching a wedged one for only the slices that never
 * reported. Mounted under `/workspaces/:workspaceId`.
 */
export function prReviewController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // The run's active PR-review state (null when no pr-reviewer step carries one).
  buildHonoRoute(app, getPrReviewContract, async (c) => {
    const state = await c
      .get('container')
      .executionService.decisions.getPrReview(
        param(c, 'workspaceId'),
        c.req.valid('param').executionId,
      )
    return c.json(state, 200)
  })

  // Resolve a parked PR review: record the human's finding selection + how it was resolved,
  // then advance the run. Runs under the acting user's ambient context for parity with the
  // other run-driving endpoints.
  buildHonoRoute(app, resolvePrReviewContract, async (c) => {
    const { executionId } = c.req.valid('param')
    const input = c.req.valid('json')
    const userId = c.get('user')?.id
    const state = await runWithInitiator(
      { workspaceId: param(c, 'workspaceId'), initiatedBy: userId },
      () =>
        c
          .get('container')
          .executionService.decisions.resolvePrReview(param(c, 'workspaceId'), executionId, input),
    )
    return c.json(state, 200)
  })

  // Resume a review stuck mid-`reviewing`: re-dispatch the reviewer for only the slices that never
  // reported, folding the already-captured reports in as context. Runs under the acting user's
  // ambient context like the other dispatching endpoints — this mints a fresh container job.
  buildHonoRoute(app, resumePrReviewContract, async (c) => {
    const { executionId } = c.req.valid('param')
    const userId = c.get('user')?.id
    const state = await runWithInitiator(
      { workspaceId: param(c, 'workspaceId'), initiatedBy: userId },
      () =>
        c
          .get('container')
          .executionService.decisions.resumePrReview(param(c, 'workspaceId'), executionId),
    )
    return c.json(state, 200)
  })

  // Dismiss a parked finding entirely (curation, not a resolution — the run stays parked).
  buildHonoRoute(app, dismissPrReviewFindingContract, async (c) => {
    const { executionId, findingId } = c.req.valid('param')
    const state = await c
      .get('container')
      .executionService.decisions.dismissPrReviewFinding(
        param(c, 'workspaceId'),
        executionId,
        findingId,
      )
    return c.json(state, 200)
  })

  // Challenge a parked finding: dispatch the Challenge Investigator to re-examine it. Runs under
  // the acting user's ambient context (the investigator dispatch mints tokens like other run work).
  buildHonoRoute(app, challengePrReviewFindingContract, async (c) => {
    const { executionId, findingId } = c.req.valid('param')
    const input = c.req.valid('json')
    const userId = c.get('user')?.id
    const state = await runWithInitiator(
      { workspaceId: param(c, 'workspaceId'), initiatedBy: userId },
      () =>
        c
          .get('container')
          .executionService.decisions.challengePrReviewFinding(
            param(c, 'workspaceId'),
            executionId,
            findingId,
            input,
          ),
    )
    return c.json(state, 200)
  })

  return app
}
