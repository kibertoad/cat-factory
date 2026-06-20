import { putTrackerSettingsSchema } from '@cat-factory/contracts'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { TrackerModule } from '@cat-factory/orchestration'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'
import { jsonBody } from '../../http/validation.js'

/** Resolve the tracker-settings module or send a 503, returning null when unconfigured. */
function requireTracker(c: Context<AppEnv>): TrackerModule | null {
  return c.get('container').tracker ?? null
}

const unavailable = (c: Context<AppEnv>) =>
  c.json({ error: { code: 'unavailable', message: 'Issue tracker is not configured' } }, 503)

/**
 * Read/write a workspace's issue-tracker selection (GitHub Issues or Jira). Mounted
 * under `/workspaces/:workspaceId`.
 */
export function trackerSettingsController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.get('/tracker-settings', async (c) => {
    const tracker = requireTracker(c)
    if (!tracker) return unavailable(c)
    return c.json(await tracker.service.get(param(c, 'workspaceId')))
  })

  app.put('/tracker-settings', jsonBody(putTrackerSettingsSchema), async (c) => {
    const tracker = requireTracker(c)
    if (!tracker) return unavailable(c)
    return c.json(await tracker.service.put(param(c, 'workspaceId'), c.req.valid('json')))
  })

  return app
}
