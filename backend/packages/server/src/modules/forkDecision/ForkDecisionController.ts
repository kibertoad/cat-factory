import { chooseForkContract, getForkDecisionContract } from '@cat-factory/contracts'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import { runWithInitiator } from '../../github/runInitiatorContext.js'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'

/**
 * Workspace-scoped implementation-fork decision endpoints. Before the Coder writes code the
 * read-only proposer surfaces materially different ways to implement the task and the run
 * parks; these endpoints let a human read the surfaced approaches and CHOOSE one (a proposed
 * fork or their own free-text approach). Choosing re-runs the Coder with the chosen approach
 * folded in as a binding directive. The read returns null when no coder step carries fork
 * state. Chat is added in a later slice. Mounted under `/workspaces/:workspaceId`.
 */
export function forkDecisionController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // The run's active fork-decision state (null when no coder step carries one).
  buildHonoRoute(app, getForkDecisionContract, async (c) => {
    const state = await c
      .get('container')
      .executionService.getForkDecision(param(c, 'workspaceId'), c.req.valid('param').executionId)
    return c.json(state, 200)
  })

  // Choose an implementation approach (a proposed fork id or a custom approach) — the Coder
  // then runs with it folded in. Runs under the acting user's ambient context so the resumed
  // run's container work (clone/push) uses their per-user credentials where applicable.
  buildHonoRoute(app, chooseForkContract, async (c) => {
    const { executionId } = c.req.valid('param')
    const input = c.req.valid('json')
    const userId = c.get('user')?.id
    const state = await runWithInitiator(userId, () =>
      c.get('container').executionService.chooseFork(param(c, 'workspaceId'), executionId, input),
    )
    return c.json(state, 200)
  })

  return app
}
