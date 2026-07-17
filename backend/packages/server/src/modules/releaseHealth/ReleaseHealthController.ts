import {
  deleteObservabilityConnectionContract,
  deleteReleaseHealthConfigContract,
  getObservabilityConnectionContract,
  listReleaseHealthConfigsContract,
  setObservabilityConnectionContract,
  upsertReleaseHealthConfigContract,
} from '@cat-factory/contracts'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { ReleaseHealthModule } from '@cat-factory/orchestration'
import type { AppEnv } from '../../http/env.js'
import { requireWorkspacePermission } from '../../http/workspaceAccess.js'
import { param } from '../../http/params.js'

/** Resolve the release-health module or send a 503, returning null when unconfigured. */
function requireReleaseHealth<E extends AppEnv>(c: Context<E>): ReleaseHealthModule | null {
  return c.get('container').releaseHealth ?? null
}

const unavailable = <E extends AppEnv>(c: Context<E>) =>
  c.json(
    { error: { code: 'unavailable', message: 'The observability integration is not configured' } },
    503,
  )

/**
 * Per-workspace settings for the post-release-health gate: the (single) observability
 * connection (provider + credentials, write-only, never read back) and the per-block
 * monitor/SLO mappings the gate reads. Mounted under `/workspaces/:workspaceId`.
 */
export function releaseHealthController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.use('*', requireWorkspacePermission('settings.manage'))

  buildHonoRoute(app, getObservabilityConnectionContract, async (c) => {
    const rh = requireReleaseHealth(c)
    if (!rh) return unavailable(c)
    return c.json(await rh.service.getConnection(param(c, 'workspaceId')), 200)
  })

  buildHonoRoute(app, setObservabilityConnectionContract, async (c) => {
    const rh = requireReleaseHealth(c)
    if (!rh) return unavailable(c)
    return c.json(await rh.service.setConnection(param(c, 'workspaceId'), c.req.valid('json')), 200)
  })

  buildHonoRoute(app, deleteObservabilityConnectionContract, async (c) => {
    const rh = requireReleaseHealth(c)
    if (!rh) return unavailable(c)
    await rh.service.deleteConnection(param(c, 'workspaceId'))
    return c.body(null, 204)
  })

  buildHonoRoute(app, listReleaseHealthConfigsContract, async (c) => {
    const rh = requireReleaseHealth(c)
    if (!rh) return unavailable(c)
    return c.json(await rh.service.listConfigs(param(c, 'workspaceId')), 200)
  })

  buildHonoRoute(app, upsertReleaseHealthConfigContract, async (c) => {
    const rh = requireReleaseHealth(c)
    if (!rh) return unavailable(c)
    const config = await rh.service.upsertConfig(
      param(c, 'workspaceId'),
      c.req.valid('param').blockId,
      c.req.valid('json'),
    )
    return c.json(config, 200)
  })

  buildHonoRoute(app, deleteReleaseHealthConfigContract, async (c) => {
    const rh = requireReleaseHealth(c)
    if (!rh) return unavailable(c)
    await rh.service.deleteConfig(param(c, 'workspaceId'), c.req.valid('param').blockId)
    return c.body(null, 204)
  })

  return app
}
