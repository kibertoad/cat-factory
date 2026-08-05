import {
  listWorkspaceAgentSettingsContract,
  updateWorkspaceAgentSettingsContract,
} from '@cat-factory/contracts'
import type { WorkspaceAgentSettingsModule } from '@cat-factory/orchestration'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { mountWorkspacePermission } from '../../http/workspaceAccess.js'
import { param } from '../../http/params.js'
import { requireCapability } from '../../http/guards.js'

/** Resolve the agent-settings module, or refuse with a 503 naming what isn't wired. */
function requireAgentSettings<E extends AppEnv>(c: Context<E>): WorkspaceAgentSettingsModule {
  return requireCapability(
    c.get('container').workspaceAgentSettings,
    'Agent settings are not configured',
  )
}

/**
 * A workspace's per-agent-kind generation settings — the pipeline builder's output-budget
 * control. Mounted under `/workspaces/:workspaceId`.
 *
 * Gated on `settings.manage`, the same permission as the prompt overrides this sits beside and
 * for the same reason: the pipeline builder is member-tier, but raising a kind's ceiling changes
 * what EVERY run in the workspace may spend, which is the same blast radius as the model mapping.
 * Reads pass the mount, so a member using the builder can still see the budget a step will run
 * under.
 */
export function workspaceAgentSettingsController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  mountWorkspacePermission(app, 'settings.manage', ['/agent-settings'])

  buildHonoRoute(app, listWorkspaceAgentSettingsContract, async (c) => {
    const settings = requireAgentSettings(c)
    return c.json(await settings.service.list(param(c, 'workspaceId')), 200)
  })

  buildHonoRoute(app, updateWorkspaceAgentSettingsContract, async (c) => {
    const settings = requireAgentSettings(c)
    const { agentKind } = c.req.valid('param')
    // Null when the update left nothing configured — the row is gone and the kind inherits the
    // deployment ceiling again. Returned as-is so the editor renders the server's view rather
    // than guessing whether its clear took effect.
    const updated = await settings.service.update(
      param(c, 'workspaceId'),
      agentKind,
      c.req.valid('json'),
    )
    return c.json(updated, 200)
  })

  return app
}
