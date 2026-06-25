import { Hono } from 'hono'
import type { Context } from 'hono'
import type { NotificationsModule } from '@cat-factory/orchestration'
import { NotFoundError } from '@cat-factory/kernel'
import { runWithInitiator } from '../../github/runInitiatorContext.js'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'

/** Resolve the notifications module or send a 503, returning null when unconfigured. */
function requireNotifications(c: Context<AppEnv>): NotificationsModule | null {
  return c.get('container').notifications ?? null
}

const unavailable = (c: Context<AppEnv>) =>
  c.json({ error: { code: 'unavailable', message: 'Notifications are not configured' } }, 503)

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
  app.get('/notifications', async (c) => {
    const notifications = requireNotifications(c)
    if (!notifications) return unavailable(c)
    return c.json(await notifications.service.listOpen(param(c, 'workspaceId')))
  })

  // Act on a notification: run its side-effect, then mark it acted.
  app.post('/notifications/:notificationId/act', async (c) => {
    const notifications = requireNotifications(c)
    if (!notifications) return unavailable(c)
    const workspaceId = param(c, 'workspaceId')
    const id = param(c, 'notificationId')
    const notification = await notifications.service.get(workspaceId, id)
    if (!notification) throw new NotFoundError('Notification', id)
    if (notification.status !== 'open') return c.json(notification)

    const container = c.get('container')
    switch (notification.type) {
      case 'merge_review':
      case 'pipeline_complete':
        // Confirm + merge the PR for real (block is `pr_ready` → `done`). Runs under
        // the acting user's ambient context so their per-user PAT (when set) merges.
        if (notification.blockId) {
          await runWithInitiator(c.get('user')?.id, () =>
            container.executionService.mergePr(workspaceId, notification.blockId!),
          )
        }
        break
      case 'ci_failed':
      case 'test_failed':
        // Re-run the failed pipeline once CI / the tests are presumably fixed.
        if (notification.executionId) {
          await container.executionService.retry(workspaceId, notification.executionId)
        }
        break
    }
    return c.json(await notifications.service.resolve(workspaceId, id, 'act'))
  })

  // Dismiss a notification without acting on it.
  app.post('/notifications/:notificationId/dismiss', async (c) => {
    const notifications = requireNotifications(c)
    if (!notifications) return unavailable(c)
    return c.json(
      await notifications.service.resolve(
        param(c, 'workspaceId'),
        param(c, 'notificationId'),
        'dismiss',
      ),
    )
  })

  return app
}
