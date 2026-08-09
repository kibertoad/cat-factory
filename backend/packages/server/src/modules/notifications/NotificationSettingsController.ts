import {
  getNotificationSettingsContract,
  updateNotificationSettingsContract,
} from '@cat-factory/contracts'
import type { NotificationSettingsService } from '@cat-factory/orchestration'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { requireCapability } from '../../http/guards.js'
import { param } from '../../http/params.js'
import { mountWorkspacePermission } from '../../http/workspaceAccess.js'

/**
 * Resolve the notification manager, or refuse with a 503 naming what isn't wired. It has
 * its OWN accessor rather than borrowing the notifications module's: the routing store is
 * optional within a wired notifications module, so a message about notifications being
 * unconfigured would name a subsystem the operator has already wired.
 */
function requireNotificationSettings<E extends AppEnv>(c: Context<E>): NotificationSettingsService {
  return requireCapability(
    c.get('container').notifications?.settingsService,
    'The notification manager is not configured',
  )
}

/**
 * The notification manager: which notification types this board delivers on which channel.
 *
 * Its own controller rather than routes on {@link notificationController}, because the tiers
 * differ: acting on a card is a MEMBER's everyday work, while re-routing what the whole board
 * is told is workspace configuration. A controller gates one permission over its own prefixes,
 * so mixing the two would either under-gate the settings or lock members out of their inbox.
 *
 * The READ is left at the member tier on purpose: the settings surface renders the resolved
 * routing, and it carries no credential or endpoint — only which types go where.
 *
 * Mounted under `/workspaces/:workspaceId`.
 */
export function notificationSettingsController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  mountWorkspacePermission(app, 'settings.manage', ['/notification-settings'])

  buildHonoRoute(app, getNotificationSettingsContract, async (c) => {
    const settings = requireNotificationSettings(c)
    return c.json(await settings.get(param(c, 'workspaceId')), 200)
  })

  // A full replace of the override matrix, like the Slack routing write: the settings surface
  // always sends the whole thing, and a merge would make "turn this cell back to its default"
  // unexpressible.
  buildHonoRoute(app, updateNotificationSettingsContract, async (c) => {
    const settings = requireNotificationSettings(c)
    const { matrix } = c.req.valid('json')
    return c.json(await settings.update(param(c, 'workspaceId'), matrix), 200)
  })

  return app
}
