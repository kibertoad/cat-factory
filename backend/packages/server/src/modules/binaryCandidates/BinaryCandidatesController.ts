import { getBinaryCandidatesContract, keepBinaryCandidatesContract } from '@cat-factory/contracts'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import { runWithInitiator } from '../../github/runInitiatorContext.js'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'

/**
 * Workspace-scoped generated-candidate endpoints. A binary-output step configured to COMPARE
 * generates a candidate from each of its selected integrations, stages them, and parks; these
 * endpoints let a human read the staged candidates and KEEP one (or several under distinct ids).
 * Keeping re-runs the same step to deliver exactly what survived and clear the rest. The read
 * returns null when no step carries candidate state. Mounted under `/workspaces/:workspaceId`.
 *
 * No dedicated permission gate: both routes sit under the workspace auth gate, whose viewer WRITE
 * FLOOR already refuses a non-member's POST, and keeping a candidate is member-tier work exactly
 * as choosing an implementation fork is. A controller of its own gate would be a second opinion
 * about the same tier.
 */
export function binaryCandidatesController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // The run's active candidate state (null when no step carries one).
  buildHonoRoute(app, getBinaryCandidatesContract, async (c) => {
    const state = await c
      .get('container')
      .executionService.decisions.getBinaryCandidates(
        param(c, 'workspaceId'),
        c.req.valid('param').executionId,
      )
    return c.json(state, 200)
  })

  // Keep the chosen candidates. Runs under the acting user's ambient context for the same reason
  // choosing a fork does: the resumed run dispatches a container pass immediately, and its
  // credentials resolve against the initiator.
  buildHonoRoute(app, keepBinaryCandidatesContract, async (c) => {
    const { executionId } = c.req.valid('param')
    const input = c.req.valid('json')
    const userId = c.get('user')?.id
    const state = await runWithInitiator(
      { workspaceId: param(c, 'workspaceId'), initiatedBy: userId },
      () =>
        c
          .get('container')
          .executionService.decisions.keepBinaryCandidates(
            param(c, 'workspaceId'),
            executionId,
            input,
          ),
    )
    return c.json(state, 200)
  })

  return app
}
