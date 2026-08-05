import {
  deleteNotificationWebhookContract,
  getNotificationWebhookContract,
  putNotificationWebhookContract,
} from '@cat-factory/contracts'
import type { NotificationWebhookService } from '@cat-factory/integrations'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { mountWorkspacePermission } from '../../http/workspaceAccess.js'
import { param } from '../../http/params.js'
import { requireCapability } from '../../http/guards.js'

/** Resolve the webhook service, or refuse with a 503 naming what isn't wired. */
function requireWebhooks<E extends AppEnv>(c: Context<E>): NotificationWebhookService {
  return requireCapability(
    c.get('container').notificationWebhooks,
    'Notification webhooks are not configured',
  )
}

/**
 * Workspace-scoped management of the OUTBOUND notification webhook: the one HTTPS endpoint a
 * workspace registers to receive its notifications by push. This is how a headless integration —
 * which has no in-app inbox and no browser WebSocket — learns that a run parked on a human
 * decision (see `docs/initiatives/headless-clarification-loop.md`, D3).
 *
 * The signing secret is write-only: `put` accepts it, the projection reports only `hasSecret`, and
 * nothing reads it back. Mounted under `/workspaces/:workspaceId` behind `integrations.manage` —
 * one permission for the whole controller, so a route added later inherits the correct gate (see
 * the workspace-RBAC section of CLAUDE.md).
 */
export function notificationWebhookController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  mountWorkspacePermission(app, 'integrations.manage', ['/notification-webhook'])

  buildHonoRoute(app, getNotificationWebhookContract, async (c) => {
    const webhooks = requireWebhooks(c)
    return c.json(await webhooks.get(param(c, 'workspaceId')), 200)
  })

  buildHonoRoute(app, putNotificationWebhookContract, async (c) => {
    const webhooks = requireWebhooks(c)
    const saved = await webhooks.put(param(c, 'workspaceId'), c.req.valid('json'))
    return c.json(saved, 200)
  })

  buildHonoRoute(app, deleteNotificationWebhookContract, async (c) => {
    const webhooks = requireWebhooks(c)
    await webhooks.remove(param(c, 'workspaceId'))
    return c.body(null, 204)
  })

  return app
}
