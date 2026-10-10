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
import { mountWorkspacePermission } from '../../http/workspaceAccess.js'
import { param } from '../../http/params.js'
import { requireCapability } from '../../http/guards.js'

/** Resolve the release-health module, or refuse with a 503 naming what isn't wired. */
function requireReleaseHealth<E extends AppEnv>(c: Context<E>): ReleaseHealthModule {
  return requireCapability(
    c.get('container').releaseHealth,
    'The observability integration is not configured',
  )
}

/**
 * Per-workspace settings for the post-release-health gate: the (single) observability
 * connection (provider + credentials, write-only, never read back) and the per-block
 * monitor/SLO mappings the gate reads. Mounted under `/workspaces/:workspaceId`.
 */
export function releaseHealthController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  mountWorkspacePermission(app, 'settings.manage', ['/observability', '/release-health-configs'])

  buildHonoRoute(app, getObservabilityConnectionContract, async (c) => {
    const rh = requireReleaseHealth(c)
    return c.json(await rh.service.getConnection(param(c, 'workspaceId')), 200)
  })

  buildHonoRoute(app, setObservabilityConnectionContract, async (c) => {
    const rh = requireReleaseHealth(c)
    return c.json(await rh.service.setConnection(param(c, 'workspaceId'), c.req.valid('json')), 200)
  })

  buildHonoRoute(app, deleteObservabilityConnectionContract, async (c) => {
    const rh = requireReleaseHealth(c)
    await rh.service.deleteConnection(param(c, 'workspaceId'))
    return c.body(null, 204)
  })

  buildHonoRoute(app, listReleaseHealthConfigsContract, async (c) => {
    const rh = requireReleaseHealth(c)
    return c.json(await rh.service.listConfigs(param(c, 'workspaceId')), 200)
  })

  buildHonoRoute(app, upsertReleaseHealthConfigContract, async (c) => {
    const rh = requireReleaseHealth(c)
    const config = await rh.service.upsertConfig(
      param(c, 'workspaceId'),
      c.req.valid('param').blockId,
      c.req.valid('json'),
    )
    return c.json(config, 200)
  })

  buildHonoRoute(app, deleteReleaseHealthConfigContract, async (c) => {
    const rh = requireReleaseHealth(c)
    await rh.service.deleteConfig(param(c, 'workspaceId'), c.req.valid('param').blockId)
    return c.body(null, 204)
  })

  return app
}
