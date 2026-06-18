import type { ExecutionEventPublisher, Notification, NotificationChannel } from '@cat-factory/kernel'

/**
 * The in-app notification channel: pushes the `notification` WorkspaceEvent to the
 * board (via the same event publisher that carries execution/board events) so the
 * inbox + per-block badge update live. The canonical row is already persisted by
 * the NotificationService, so this is purely the live push — best-effort, errors
 * swallowed by the publisher.
 *
 * This is the only channel today; future EmailNotificationChannel /
 * SlackNotificationChannel implement the same {@link NotificationChannel} port and
 * are composed alongside it via CompositeNotificationChannel, with no change to the
 * code that raises notifications.
 */
export class InAppNotificationChannel implements NotificationChannel {
  constructor(private readonly publisher: ExecutionEventPublisher) {}

  async deliver(workspaceId: string, notification: Notification): Promise<void> {
    await this.publisher.notificationChanged?.(workspaceId, notification)
  }
}
