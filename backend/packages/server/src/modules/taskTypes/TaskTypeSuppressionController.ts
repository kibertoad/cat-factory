import {
  listTaskTypeSuppressionsContract,
  restoreTaskTypeContract,
  suppressTaskTypeContract,
} from '@cat-factory/contracts'
import type { TaskTypeSuppressionModule } from '@cat-factory/orchestration'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { mountWorkspacePermission } from '../../http/workspaceAccess.js'
import { param } from '../../http/params.js'
import { requireCapability } from '../../http/guards.js'

/** Resolve the suppression module, or refuse with a 503 naming what isn't wired. */
function requireSuppressions<E extends AppEnv>(c: Context<E>): TaskTypeSuppressionModule {
  return requireCapability(
    c.get('container').taskTypeSuppressions,
    'Task-type suppression is not configured',
  )
}

/**
 * Which of the deployment's REUSABLE OPERATIONS this board offers
 * (`backend/docs/reusable-operations.md`). Mounted under `/workspaces/:workspaceId`.
 *
 * Gated on `settings.manage`: hiding an operation changes what every member of the board can
 * create, which is board configuration on the same footing as the merge presets and the prompt
 * overrides. Reads pass the mount, so a member can see the catalog their picker is drawn from.
 *
 * Every route returns the WHOLE list rather than the row it changed, because the screen's two
 * halves move together: suppressing a type removes it from the board snapshot's `customTaskTypes`,
 * and the client must not have to reconcile a point response against a catalog it just invalidated.
 */
export function taskTypeSuppressionController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  mountWorkspacePermission(app, 'settings.manage', ['/task-type-suppressions'])

  buildHonoRoute(app, listTaskTypeSuppressionsContract, async (c) => {
    const module = requireSuppressions(c)
    return c.json({ taskTypes: await module.service.list(param(c, 'workspaceId')) }, 200)
  })

  buildHonoRoute(app, suppressTaskTypeContract, async (c) => {
    const module = requireSuppressions(c)
    const workspaceId = param(c, 'workspaceId')
    await module.service.suppress(workspaceId, c.req.valid('param').taskType)
    return c.json({ taskTypes: await module.service.list(workspaceId) }, 200)
  })

  buildHonoRoute(app, restoreTaskTypeContract, async (c) => {
    const module = requireSuppressions(c)
    const workspaceId = param(c, 'workspaceId')
    await module.service.restore(workspaceId, c.req.valid('param').taskType)
    return c.json({ taskTypes: await module.service.list(workspaceId) }, 200)
  })

  return app
}
