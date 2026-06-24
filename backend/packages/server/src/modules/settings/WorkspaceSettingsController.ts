import { updateWorkspaceSettingsSchema } from '@cat-factory/contracts'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { WorkspaceSettingsModule } from '@cat-factory/orchestration'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'
import { jsonBody } from '../../http/validation.js'

/** Resolve the workspace-settings module or send a 503, returning null when unconfigured. */
function requireSettings(c: Context<AppEnv>): WorkspaceSettingsModule | null {
  return c.get('container').settings ?? null
}

const unavailable = (c: Context<AppEnv>) =>
  c.json({ error: { code: 'unavailable', message: 'Workspace settings are not configured' } }, 503)

/**
 * Read/update a workspace's runtime settings (the human-wait escalation threshold +
 * the per-service running-task limit policy). `GET` lazily falls back to the built-in
 * defaults; `PUT` patches the supplied fields. Mounted under `/workspaces/:workspaceId`.
 */
export function workspaceSettingsController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.get('/settings', async (c) => {
    const settings = requireSettings(c)
    if (!settings) return unavailable(c)
    return c.json(await settings.service.get(param(c, 'workspaceId')))
  })

  app.put('/settings', jsonBody(updateWorkspaceSettingsSchema), async (c) => {
    const settings = requireSettings(c)
    if (!settings) return unavailable(c)
    const updated = await settings.service.update(param(c, 'workspaceId'), c.req.valid('json'))
    return c.json(updated)
  })

  return app
}
