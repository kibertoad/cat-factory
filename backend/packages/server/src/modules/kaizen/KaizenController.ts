import { Hono } from 'hono'
import type { Context } from 'hono'
import type { KaizenModule } from '@cat-factory/orchestration'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'

/** Resolve the Kaizen module or send a 503, returning null when unconfigured. */
function requireKaizen(c: Context<AppEnv>): KaizenModule | null {
  return c.get('container').kaizen ?? null
}

const unavailable = (c: Context<AppEnv>) =>
  c.json({ error: { code: 'unavailable', message: 'Kaizen is not configured' } }, 503)

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
  app.get('/kaizen', async (c) => {
    const kaizen = requireKaizen(c)
    if (!kaizen) return unavailable(c)
    const overview = await kaizen.service.getOverview(param(c, 'workspaceId'))
    return c.json(overview)
  })

  // The gradings recorded for one run (the run-window status surface).
  app.get('/executions/:executionId/kaizen', async (c) => {
    const kaizen = requireKaizen(c)
    if (!kaizen) return unavailable(c)
    const gradings = await kaizen.service.listForExecution(
      param(c, 'workspaceId'),
      param(c, 'executionId'),
    )
    return c.json({ gradings })
  })

  return app
}
