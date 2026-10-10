import {
  getWorkspaceSettingsContract,
  updateWorkspaceSettingsContract,
} from '@cat-factory/contracts'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { WorkspaceSettingsModule } from '@cat-factory/orchestration'
import type { AppEnv } from '../../http/env.js'
import { mountWorkspacePermission } from '../../http/workspaceAccess.js'
import { param } from '../../http/params.js'
import { requireCapability } from '../../http/guards.js'

/** Resolve the workspace-settings module, or refuse with a 503 naming what isn't wired. */
function requireSettings<E extends AppEnv>(c: Context<E>): WorkspaceSettingsModule {
  return requireCapability(c.get('container').settings, 'Workspace settings are not configured')
}

/**
 * Read/update a workspace's runtime settings (the human-wait escalation threshold +
 * the per-service running-task limit policy). `GET` lazily falls back to the built-in
 * defaults; `PUT` patches the supplied fields. Mounted under `/workspaces/:workspaceId`.
 */
export function workspaceSettingsController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  mountWorkspacePermission(app, 'settings.manage', ['/settings'])

  buildHonoRoute(app, getWorkspaceSettingsContract, async (c) => {
    const settings = requireSettings(c)
    return c.json(await settings.service.get(param(c, 'workspaceId')), 200)
  })

  buildHonoRoute(app, updateWorkspaceSettingsContract, async (c) => {
    const settings = requireSettings(c)
    const workspaceId = param(c, 'workspaceId')
    // `update` invalidates the shared `workspaceSettings` cache slice after it commits, so a
    // budget edit takes effect immediately for SpendService's pricing overlay (which reads
    // the same slice) — no separate spend-cache drop needed.
    const updated = await settings.service.update(workspaceId, c.req.valid('json'))
    return c.json(updated, 200)
  })

  return app
}
