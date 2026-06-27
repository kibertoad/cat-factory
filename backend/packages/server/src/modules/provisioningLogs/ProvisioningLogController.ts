import { listProvisioningLogsContract, provisioningLogQuerySchema } from '@cat-factory/contracts'
import * as v from 'valibot'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { ProvisioningLogsModule } from '@cat-factory/orchestration'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'

/** Resolve the provisioning-log module or send a 503, returning null when unconfigured. */
function requireProvisioningLogs<E extends AppEnv>(c: Context<E>): ProvisioningLogsModule | null {
  return c.get('container').provisioningLogs ?? null
}

const unavailable = <E extends AppEnv>(c: Context<E>) =>
  c.json({ error: { code: 'unavailable', message: 'Provisioning log is not configured' } }, 503)

/** Drop undefined query params so valibot's optionals don't see empty strings. */
function presentQuery<E extends AppEnv>(c: Context<E>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of ['subsystem', 'executionId', 'targetId', 'limit', 'before']) {
    const value = c.req.query(key)
    if (value !== undefined && value !== '') out[key] = value
  }
  return out
}

/**
 * Workspace-scoped read access to the unified provisioning event log: the history
 * behind the "View logs" buttons in the environment-provider and runner-pool config
 * panels, and the run-details env surface. Filterable by subsystem / execution /
 * target, newest first. Mounted under `/workspaces/:workspaceId`.
 */
export function provisioningLogController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  buildHonoRoute(app, listProvisioningLogsContract, async (c) => {
    const logs = requireProvisioningLogs(c)
    if (!logs) return unavailable(c)
    const parsed = v.safeParse(provisioningLogQuerySchema, presentQuery(c))
    if (!parsed.success) {
      return c.json({ error: { code: 'invalid_query', message: 'Invalid query parameters' } }, 400)
    }
    const entries = await logs.service.list(param(c, 'workspaceId'), parsed.output)
    return c.json({ entries }, 200)
  })

  return app
}
