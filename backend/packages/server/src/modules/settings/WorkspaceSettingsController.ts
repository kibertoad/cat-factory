import {
  getWorkspaceSettingsContract,
  updateWorkspaceSettingsContract,
} from '@cat-factory/contracts'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { WorkspaceSettingsModule } from '@cat-factory/orchestration'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'

/** Resolve the workspace-settings module or send a 503, returning null when unconfigured. */
function requireSettings<E extends AppEnv>(c: Context<E>): WorkspaceSettingsModule | null {
  return c.get('container').settings ?? null
}

const unavailable = <E extends AppEnv>(c: Context<E>) =>
  c.json({ error: { code: 'unavailable', message: 'Workspace settings are not configured' } }, 503)

/**
 * Read/update a workspace's runtime settings (the human-wait escalation threshold +
 * the per-service running-task limit policy). `GET` lazily falls back to the built-in
 * defaults; `PUT` patches the supplied fields. Mounted under `/workspaces/:workspaceId`.
 */
export function workspaceSettingsController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  buildHonoRoute(app, getWorkspaceSettingsContract, async (c) => {
    const settings = requireSettings(c)
    if (!settings) return unavailable(c)
    return c.json(await settings.service.get(param(c, 'workspaceId')), 200)
  })

  buildHonoRoute(app, updateWorkspaceSettingsContract, async (c) => {
    const settings = requireSettings(c)
    if (!settings) return unavailable(c)
    const workspaceId = param(c, 'workspaceId')
    const updated = await settings.service.update(workspaceId, c.req.valid('json'))
    // A budget edit must take effect immediately, not after the spend service's
    // short pricing cache TTL — drop the workspace's cached pricing now.
    c.get('container').spendService.invalidatePricing(workspaceId)
    return c.json(updated, 200)
  })

  return app
}
