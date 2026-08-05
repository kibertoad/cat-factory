import { getTrackerSettingsContract, putTrackerSettingsContract } from '@cat-factory/contracts'
import type { TrackerModule } from '@cat-factory/orchestration'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { mountWorkspacePermission } from '../../http/workspaceAccess.js'
import { param } from '../../http/params.js'
import { requireCapability } from '../../http/guards.js'

/** Resolve the tracker-settings module, or refuse with a 503 naming what isn't wired. */
function requireTracker<E extends AppEnv>(c: Context<E>): TrackerModule {
  return requireCapability(c.get('container').tracker, 'Issue tracker is not configured')
}

/**
 * Read/write a workspace's issue-tracker selection (GitHub Issues or Jira). Mounted
 * under `/workspaces/:workspaceId`.
 */
export function trackerSettingsController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  mountWorkspacePermission(app, 'settings.manage', ['/tracker-settings'])

  buildHonoRoute(app, getTrackerSettingsContract, async (c) => {
    const tracker = requireTracker(c)
    return c.json(await tracker.service.get(param(c, 'workspaceId')), 200)
  })

  buildHonoRoute(app, putTrackerSettingsContract, async (c) => {
    const tracker = requireTracker(c)
    return c.json(await tracker.service.put(param(c, 'workspaceId'), c.req.valid('json')), 200)
  })

  return app
}
