import { UnavailableError } from '@cat-factory/kernel'
import { getTrackerSettingsContract, putTrackerSettingsContract } from '@cat-factory/contracts'
import type { TrackerModule } from '@cat-factory/orchestration'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { requireWorkspacePermission } from '../../http/workspaceAccess.js'
import { param } from '../../http/params.js'

/** Resolve the tracker-settings module or raise a 503 — it isn't wired on this deployment. */
function requireTracker<E extends AppEnv>(c: Context<E>): TrackerModule {
  const tracker = c.get('container').tracker
  if (!tracker) throw new UnavailableError('Issue tracker is not configured')
  return tracker
}

/**
 * Read/write a workspace's issue-tracker selection (GitHub Issues or Jira). Mounted
 * under `/workspaces/:workspaceId`.
 */
export function trackerSettingsController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.use('*', requireWorkspacePermission('settings.manage'))

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
