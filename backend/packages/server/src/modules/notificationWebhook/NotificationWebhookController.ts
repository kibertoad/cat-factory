import {
  DEFAULT_NOTIFICATION_WEBHOOK_ID,
  deleteNamedNotificationWebhookContract,
  deleteNotificationWebhookContract,
  getNamedNotificationWebhookContract,
  getNotificationWebhookContract,
  listNotificationWebhooksContract,
  putNamedNotificationWebhookContract,
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
 * Workspace-scoped management of the OUTBOUND notification webhooks: the HTTPS endpoints a
 * workspace registers to receive its notifications by push. This is how a headless integration —
 * which has no in-app inbox and no browser WebSocket — learns that a run parked on a human
 * decision (see `docs/initiatives/headless-clarification-loop.md`, D3).
 *
 * Two shapes over one store: the SINGULAR routes address the `default` id, the COLLECTION
 * addresses any of them. Neither has logic of its own — both delegate to the same service methods
 * the public surface calls, so the id defaulting is the only thing the singular half adds.
 *
 * The signing secret is write-only: `put` accepts it, the projection reports only `hasSecret`, and
 * nothing reads it back. Mounted under `/workspaces/:workspaceId` behind `integrations.manage` —
 * one permission for the whole controller, so a route added later inherits the correct gate (see
 * the workspace-RBAC section of CLAUDE.md). BOTH prefixes are listed: `/notification-webhook` is
 * registered as `ALL /notification-webhook/*`, which does not match the plural path, so the
 * collection would otherwise be ungated.
 */
export function notificationWebhookController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  mountWorkspacePermission(app, 'integrations.manage', [
    '/notification-webhook',
    '/notification-webhooks',
  ])

  buildHonoRoute(app, getNotificationWebhookContract, async (c) => {
    const webhooks = requireWebhooks(c)
    return c.json(await webhooks.get(param(c, 'workspaceId'), DEFAULT_NOTIFICATION_WEBHOOK_ID), 200)
  })

  buildHonoRoute(app, putNotificationWebhookContract, async (c) => {
    const webhooks = requireWebhooks(c)
    const saved = await webhooks.put(
      param(c, 'workspaceId'),
      DEFAULT_NOTIFICATION_WEBHOOK_ID,
      c.req.valid('json'),
    )
    return c.json(saved, 200)
  })

  buildHonoRoute(app, deleteNotificationWebhookContract, async (c) => {
    const webhooks = requireWebhooks(c)
    await webhooks.remove(param(c, 'workspaceId'), DEFAULT_NOTIFICATION_WEBHOOK_ID)
    return c.body(null, 204)
  })

  buildHonoRoute(app, listNotificationWebhooksContract, async (c) => {
    const webhooks = requireWebhooks(c)
    return c.json({ webhooks: await webhooks.list(param(c, 'workspaceId')) }, 200)
  })

  buildHonoRoute(app, getNamedNotificationWebhookContract, async (c) => {
    const webhooks = requireWebhooks(c)
    const webhook = await webhooks.get(param(c, 'workspaceId'), param(c, 'webhookId'))
    return c.json({ webhook }, 200)
  })

  buildHonoRoute(app, putNamedNotificationWebhookContract, async (c) => {
    const webhooks = requireWebhooks(c)
    const saved = await webhooks.put(
      param(c, 'workspaceId'),
      param(c, 'webhookId'),
      c.req.valid('json'),
    )
    return c.json(saved, 200)
  })

  buildHonoRoute(app, deleteNamedNotificationWebhookContract, async (c) => {
    const webhooks = requireWebhooks(c)
    await webhooks.remove(param(c, 'workspaceId'), param(c, 'webhookId'))
    return c.body(null, 204)
  })

  return app
}
