import {
  upsertDatadogConnectionSchema,
  upsertReleaseHealthConfigSchema,
} from '@cat-factory/contracts'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { ReleaseHealthModule } from '@cat-factory/orchestration'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'
import { jsonBody } from '../../http/validation.js'

/** Resolve the release-health module or send a 503, returning null when unconfigured. */
function requireReleaseHealth(c: Context<AppEnv>): ReleaseHealthModule | null {
  return c.get('container').releaseHealth ?? null
}

const unavailable = (c: Context<AppEnv>) =>
  c.json(
    { error: { code: 'unavailable', message: 'The Datadog integration is not configured' } },
    503,
  )

/**
 * Per-workspace settings for the post-release-health gate: the (single) Datadog
 * connection (keys write-only, never read back) and the per-block monitor/SLO
 * mappings the gate reads. Mounted under `/workspaces/:workspaceId`.
 */
export function releaseHealthController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.get('/datadog/connection', async (c) => {
    const rh = requireReleaseHealth(c)
    if (!rh) return unavailable(c)
    return c.json(await rh.service.getConnection(param(c, 'workspaceId')))
  })

  app.put('/datadog/connection', jsonBody(upsertDatadogConnectionSchema), async (c) => {
    const rh = requireReleaseHealth(c)
    if (!rh) return unavailable(c)
    return c.json(await rh.service.setConnection(param(c, 'workspaceId'), c.req.valid('json')))
  })

  app.delete('/datadog/connection', async (c) => {
    const rh = requireReleaseHealth(c)
    if (!rh) return unavailable(c)
    await rh.service.deleteConnection(param(c, 'workspaceId'))
    return c.body(null, 204)
  })

  app.get('/release-health-configs', async (c) => {
    const rh = requireReleaseHealth(c)
    if (!rh) return unavailable(c)
    return c.json(await rh.service.listConfigs(param(c, 'workspaceId')))
  })

  app.put(
    '/release-health-configs/:blockId',
    jsonBody(upsertReleaseHealthConfigSchema),
    async (c) => {
      const rh = requireReleaseHealth(c)
      if (!rh) return unavailable(c)
      const config = await rh.service.upsertConfig(
        param(c, 'workspaceId'),
        param(c, 'blockId'),
        c.req.valid('json'),
      )
      return c.json(config)
    },
  )

  app.delete('/release-health-configs/:blockId', async (c) => {
    const rh = requireReleaseHealth(c)
    if (!rh) return unavailable(c)
    await rh.service.deleteConfig(param(c, 'workspaceId'), param(c, 'blockId'))
    return c.body(null, 204)
  })

  return app
}
