import { getKaizenOverviewContract, getKaizenRunGradingsContract } from '@cat-factory/contracts'
import type { KaizenModule } from '@cat-factory/orchestration'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'
import { requireCapability } from '../../http/guards.js'

/** Resolve the Kaizen module, or refuse with a 503 naming what isn't wired. */
function requireKaizen<E extends AppEnv>(c: Context<E>): KaizenModule {
  return requireCapability(c.get('container').kaizen, 'Kaizen is not configured')
}

/**
 * Workspace-scoped Kaizen endpoints (read-only). The Kaizen screen reads the grading
 * history + verified-combo library; the run window reads the gradings for one run to show
 * each step's scheduled→running→complete status and results. Grading itself is scheduled by
 * the engine at run completion and run by the background sweep — never triggered over HTTP.
 * Mounted under `/workspaces/:workspaceId`.
 */
export function kaizenController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // The Kaizen screen: recent grading history + the verified-combo library.
  buildHonoRoute(app, getKaizenOverviewContract, async (c) => {
    const kaizen = requireKaizen(c)
    const overview = await kaizen.service.getOverview(param(c, 'workspaceId'))
    return c.json(overview, 200)
  })

  // The gradings recorded for one run (the run-window status surface).
  buildHonoRoute(app, getKaizenRunGradingsContract, async (c) => {
    const kaizen = requireKaizen(c)
    const gradings = await kaizen.service.listForExecution(
      param(c, 'workspaceId'),
      c.req.valid('param').executionId,
    )
    return c.json({ gradings }, 200)
  })

  return app
}
