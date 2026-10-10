import {
  deleteIncidentEnrichmentContract,
  getIncidentEnrichmentContract,
  setIncidentEnrichmentContract,
} from '@cat-factory/contracts'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { IncidentEnrichmentModule } from '@cat-factory/orchestration'
import type { AppEnv } from '../../http/env.js'
import { mountWorkspacePermission } from '../../http/workspaceAccess.js'
import { param } from '../../http/params.js'
import { requireCapability } from '../../http/guards.js'

/** Resolve the incident-enrichment module, or refuse with a 503 naming what isn't wired. */
function requireIncidentEnrichment<E extends AppEnv>(c: Context<E>): IncidentEnrichmentModule {
  return requireCapability(
    c.get('container').incidentEnrichmentSettings,
    'The incident-enrichment integration is not configured',
  )
}

/**
 * Per-workspace incident-enrichment settings (PagerDuty + incident.io). The credentials
 * are write-only — `GET` returns only a presence summary, `PUT` merges the supplied
 * provider group(s), `DELETE` clears the connection. Mounted under `/workspaces/:workspaceId`.
 */
export function incidentEnrichmentController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  mountWorkspacePermission(app, 'settings.manage', ['/incident-enrichment'])

  buildHonoRoute(app, getIncidentEnrichmentContract, async (c) => {
    const ie = requireIncidentEnrichment(c)
    return c.json(await ie.service.getConnection(param(c, 'workspaceId')), 200)
  })

  buildHonoRoute(app, setIncidentEnrichmentContract, async (c) => {
    const ie = requireIncidentEnrichment(c)
    return c.json(await ie.service.setConnection(param(c, 'workspaceId'), c.req.valid('json')), 200)
  })

  buildHonoRoute(app, deleteIncidentEnrichmentContract, async (c) => {
    const ie = requireIncidentEnrichment(c)
    await ie.service.deleteConnection(param(c, 'workspaceId'))
    return c.body(null, 204)
  })

  return app
}
