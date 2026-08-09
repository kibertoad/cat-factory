import type {
  ExecutionEventPublisher,
  Notification,
  NotificationChannel,
} from '@cat-factory/kernel'

/**
 * The in-app notification channel: pushes the `notification` WorkspaceEvent to the
 * board (via the same event publisher that carries execution/board events) so the
 * inbox + per-block badge update live. The canonical row is already persisted by
 * the NotificationService, so this is purely the live push — best-effort, errors
 * swallowed by the publisher.
 *
 * Takes EVERY delivery edge (it is a STATE transport, not an alert one): a board holding an
 * open card has to see that card settle or escalate, and the push is the only thing that says
 * so before the next full snapshot. The mute a workspace sets on `in_app` is applied one layer
 * out by {@link RoutedNotificationChannel}, which gates the raise alone for that reason.
 *
 * Runtime-neutral: it wraps whatever {@link ExecutionEventPublisher} a facade wires
 * (the Worker's Durable-Object publisher, the Node service's WebSocket-hub publisher),
 * so both facades deliver in-app notifications through the same channel. Composed
 * alongside Slack/email channels via CompositeNotificationChannel, with no change to
 * the code that raises notifications.
 */
export class InAppNotificationChannel implements NotificationChannel {
  constructor(private readonly publisher: ExecutionEventPublisher) {}

  async deliver(workspaceId: string, notification: Notification): Promise<void> {
    await this.publisher.notificationChanged?.(workspaceId, notification)
  }
}
