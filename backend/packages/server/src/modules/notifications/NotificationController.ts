import {
  actNotificationContract,
  dismissNotificationContract,
  listNotificationsContract,
} from '@cat-factory/contracts'
import type { NotificationsModule } from '@cat-factory/orchestration'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { optionalJsonBody } from '../../http/optionalJsonBody.js'
import { param } from '../../http/params.js'
import { notificationActEffect } from './notificationActions.js'
import { UnavailableError } from '@cat-factory/kernel'

/** Resolve the notifications module or send a 503, returning null when unconfigured. */
function requireNotifications<E extends AppEnv>(c: Context<E>): NotificationsModule | null {
  return c.get('container').notifications ?? null
}

const unavailable = (): never => {
  throw new UnavailableError('Notifications are not configured')
}

/**
 * Human-actionable notifications. `act` performs the notification's typed
 * side-effect (merge the PR for a `merge_review` / `pipeline_complete`, retry the
 * run for a `ci_failed` / `test_failed`) and then resolves it; `dismiss` just
 * resolves it. The
 * board patches its store from the `notification` WorkspaceEvent the service emits
 * on resolve, but the responses also carry the updated notification.
 * Mounted under `/workspaces/:workspaceId`.
 */
export function notificationController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // Open notifications for the board inbox (the snapshot also carries these).
  buildHonoRoute(app, listNotificationsContract, async (c) => {
    const notifications = requireNotifications(c)
    if (!notifications) return unavailable()
    return c.json(await notifications.service.listOpen(param(c, 'workspaceId')), 200)
  })

  // Act on a notification: atomically claim it (`open` → `acted`), then run its side-effect
  // exactly once. `service.act` performs the claim BEFORE the side-effect so two concurrent
  // acts (double-click, two inboxes, HTTP retry) can't both merge/retry; a failed side-effect
  // reopens the card so the human can retry.
  // Same as the merge route: the effort tag is optional, so `act` with no body at all stays
  // the historical call (a headless caller never sends one).
  app.use('/notifications/:notificationId/act', optionalJsonBody)
  buildHonoRoute(app, actNotificationContract, async (c) => {
    const notifications = requireNotifications(c)
    if (!notifications) return unavailable()
    const workspaceId = param(c, 'workspaceId')
    const id = c.req.valid('param').notificationId
    const container = c.get('container')
    const userId = c.get('user')?.id
    // All-optional body, so `{}` is the historical no-body act. A merge card may carry the
    // reviewer-effort tag so confirming the merge and tagging it is ONE request.
    const { reviewEffort } = c.req.valid('json')
    const acted = await notifications.service.act(
      workspaceId,
      id,
      notificationActEffect(container, workspaceId, userId, reviewEffort),
    )
    return c.json(acted, 200)
  })

  // Dismiss a notification without acting on it.
  buildHonoRoute(app, dismissNotificationContract, async (c) => {
    const notifications = requireNotifications(c)
    if (!notifications) return unavailable()
    const container = c.get('container')
    const workspaceId = param(c, 'workspaceId')
    const dismissed = await notifications.service.resolve(
      workspaceId,
      c.req.valid('param').notificationId,
      'dismiss',
    )
    // Dismissing a merge-decision card is a human DECLINING to merge. Record it so the class's
    // rollup counts a rejection rather than leaving the record forever `pending_review` — which
    // would silently inflate the auto-merge-share denominator. Best-effort inside the engine.
    if (
      (dismissed.type === 'merge_review' || dismissed.type === 'pipeline_complete') &&
      dismissed.executionId
    ) {
      await container.executionService.recordMergeRejection(workspaceId, dismissed.executionId)
    }
    return c.json(dismissed, 200)
  })

  return app
}
