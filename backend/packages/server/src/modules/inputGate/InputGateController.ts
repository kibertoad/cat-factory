import { resolveInputGateContract } from '@cat-factory/contracts'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import { runWithInitiator } from '../../github/runInitiatorContext.js'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'

/**
 * Workspace-scoped PRE-TOKEN INPUT GATE endpoint. The gate parks a run before its first agent
 * step when the task states nothing an agent could act on (see
 * `docs/initiatives/pre-token-input-gate.md`); this is how a human clears that park, either by
 * fixing the task and asking for a `recheck`, or by waiving the findings with `proceed`.
 *
 * There is no matching read: the verdict rides the run (`ExecutionInstance.inputGate`), which
 * the board snapshot and the live stream already carry.
 *
 * Runs under the acting user's ambient context, like the judge and fork-decision resolutions:
 * clearing the park wakes the durable driver, so the work that follows belongs to whoever
 * released it. The user id is also what the waiver is recorded against. Mounted under
 * `/workspaces/:workspaceId`; the workspace write floor in `mountAuthGate` is the authorization
 * (a viewer cannot release somebody else's run).
 */
export function inputGateController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  buildHonoRoute(app, resolveInputGateContract, async (c) => {
    const { executionId } = c.req.valid('param')
    const { choice } = c.req.valid('json')
    const workspaceId = param(c, 'workspaceId')
    const userId = c.get('user')?.id
    const gate = await runWithInitiator({ workspaceId, initiatedBy: userId }, () =>
      c
        .get('container')
        .executionService.resolveInputGate(workspaceId, executionId, choice, userId),
    )
    return c.json(gate, 200)
  })

  return app
}
