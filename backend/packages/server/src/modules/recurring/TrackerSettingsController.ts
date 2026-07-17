import { getTrackerSettingsContract, putTrackerSettingsContract } from '@cat-factory/contracts'
import type { TrackerModule } from '@cat-factory/orchestration'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { requireWorkspacePermission } from '../../http/workspaceAccess.js'
import { param } from '../../http/params.js'

/** Resolve the tracker-settings module or send a 503, returning null when unconfigured. */
function requireTracker<E extends AppEnv>(c: Context<E>): TrackerModule | null {
  return c.get('container').tracker ?? null
}

const unavailable = <E extends AppEnv>(c: Context<E>) =>
  c.json({ error: { code: 'unavailable', message: 'Issue tracker is not configured' } }, 503)

/**
 * Read/write a workspace's issue-tracker selection (GitHub Issues or Jira). Mounted
 * under `/workspaces/:workspaceId`.
 */
export function trackerSettingsController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.use('*', requireWorkspacePermission('settings.manage'))

  buildHonoRoute(app, getTrackerSettingsContract, async (c) => {
    const tracker = requireTracker(c)
    if (!tracker) return unavailable(c)
    return c.json(await tracker.service.get(param(c, 'workspaceId')), 200)
  })

  buildHonoRoute(app, putTrackerSettingsContract, async (c) => {
    const tracker = requireTracker(c)
    if (!tracker) return unavailable(c)
    return c.json(await tracker.service.put(param(c, 'workspaceId'), c.req.valid('json')), 200)
  })

  return app
}
