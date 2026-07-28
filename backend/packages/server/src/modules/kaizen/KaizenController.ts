import { UnavailableError } from '@cat-factory/kernel'
import { getKaizenOverviewContract, getKaizenRunGradingsContract } from '@cat-factory/contracts'
import type { KaizenModule } from '@cat-factory/orchestration'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'

/** Resolve the Kaizen module or raise a 503 — it isn't wired on this deployment. */
function requireKaizen<E extends AppEnv>(c: Context<E>): KaizenModule {
  const kaizen = c.get('container').kaizen
  if (!kaizen) throw new UnavailableError('Kaizen is not configured')
  return kaizen
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
