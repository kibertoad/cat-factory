import { getJudgeDecisionContract, resolveJudgeContract } from '@cat-factory/contracts'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import { runWithInitiator } from '../../github/runInitiatorContext.js'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'

/**
 * Workspace-scoped JUDGE endpoints — the fourth step-taxonomy bucket (see
 * `docs/initiatives/judge-registry.md`). A judge step scores the run's work against a
 * registered rubric and, when the verdict misses the task's threshold, parks the run. These
 * endpoints let a human read the verdict and resolve the park: proceed anyway, bounce the work
 * back to the producing step for rework, or stop the run.
 *
 * Both routes delegate to the SAME `ExecutionService` methods the public API's decisions
 * surface calls, so the park's CAS + approval-id arbitration and the task's preset knobs apply
 * identically whichever surface answers first. The read returns null when no step carries judge
 * state. Mounted under `/workspaces/:workspaceId`.
 */
export function judgeController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // The run's active judge state (null when no step carries one).
  buildHonoRoute(app, getJudgeDecisionContract, async (c) => {
    const state = await c
      .get('container')
      .executionService.getJudgeState(param(c, 'workspaceId'), c.req.valid('param').executionId)
    return c.json(state, 200)
  })

  // Resolve a parked verdict. Runs under the acting user's ambient context so a resumed run's
  // container work (a bounce re-runs the producing step) uses their per-user credentials where
  // applicable — the same treatment the fork-decision choice gets.
  buildHonoRoute(app, resolveJudgeContract, async (c) => {
    const { executionId } = c.req.valid('param')
    const input = c.req.valid('json')
    const userId = c.get('user')?.id
    const state = await runWithInitiator(
      { workspaceId: param(c, 'workspaceId'), initiatedBy: userId },
      () =>
        c
          .get('container')
          .executionService.resolveJudgeDecision(param(c, 'workspaceId'), executionId, input),
    )
    return c.json(state, 200)
  })

  return app
}
