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
import { param } from '../../http/params.js'

/** Resolve the incident-enrichment module or send a 503, returning null when unconfigured. */
function requireIncidentEnrichment<E extends AppEnv>(
  c: Context<E>,
): IncidentEnrichmentModule | null {
  return c.get('container').incidentEnrichmentSettings ?? null
}

const unavailable = <E extends AppEnv>(c: Context<E>) =>
  c.json(
    {
      error: {
        code: 'unavailable',
        message: 'The incident-enrichment integration is not configured',
      },
    },
    503,
  )

/**
 * Per-workspace incident-enrichment settings (PagerDuty + incident.io). The credentials
 * are write-only — `GET` returns only a presence summary, `PUT` merges the supplied
 * provider group(s), `DELETE` clears the connection. Mounted under `/workspaces/:workspaceId`.
 */
export function incidentEnrichmentController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  buildHonoRoute(app, getIncidentEnrichmentContract, async (c) => {
    const ie = requireIncidentEnrichment(c)
    if (!ie) return unavailable(c)
    return c.json(await ie.service.getConnection(param(c, 'workspaceId')), 200)
  })

  buildHonoRoute(app, setIncidentEnrichmentContract, async (c) => {
    const ie = requireIncidentEnrichment(c)
    if (!ie) return unavailable(c)
    return c.json(await ie.service.setConnection(param(c, 'workspaceId'), c.req.valid('json')), 200)
  })

  buildHonoRoute(app, deleteIncidentEnrichmentContract, async (c) => {
    const ie = requireIncidentEnrichment(c)
    if (!ie) return unavailable(c)
    await ie.service.deleteConnection(param(c, 'workspaceId'))
    return c.body(null, 204)
  })

  return app
}
