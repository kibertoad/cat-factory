import { defaultNotificationRoute } from '@cat-factory/contracts'
import type {
  Notification,
  NotificationDeliveryChannel,
  NotificationPayload,
  NotificationType,
} from '../domain/types.js'

/**
 * The input to raise (or re-raise) a notification. The canonical shape the engine and
 * the gate/resolver extension seams use to surface a human-actionable notification; the
 * NotificationService maps it onto a persisted `Notification` row + a delivery. Lives in
 * kernel (not orchestration) so runtime-neutral extension points — e.g. a custom gate's
 * `onExhausted` via {@link GateContext} — can build one without depending on orchestration.
 */
export interface RaiseNotificationInput {
  type: NotificationType
  blockId: string | null
  executionId: string | null
  title: string
  body: string
  payload?: NotificationPayload | null
}

// Port for *delivering* a notification to humans. The NotificationService owns
// the canonical persistence + lifecycle (raise / list / resolve); a channel is
// purely "how a human is told". This is the extension seam for future delivery
// mechanisms: in-app (push the `notification` WorkspaceEvent to the board) is the
// only channel today, but an EmailNotificationChannel / SlackNotificationChannel
// implement the same port and are composed in via CompositeNotificationChannel —
// no change to the call sites that raise notifications.
//
// All deliveries are best-effort: a channel failure must never break the state
// transition that raised the notification (the row is already persisted). Channels
// swallow their own errors, exactly like the event publisher.

export interface NotificationChannel {
  /** Deliver (or re-deliver, on resolve) a notification to this channel's medium. */
  deliver(workspaceId: string, notification: Notification): Promise<void>
}

/** Fan a notification out to every configured channel, isolating per-channel failures. */
export class CompositeNotificationChannel implements NotificationChannel {
  constructor(private readonly channels: NotificationChannel[]) {}

  async deliver(workspaceId: string, notification: Notification): Promise<void> {
    await Promise.all(
      this.channels.map(async (channel) => {
        try {
          await channel.deliver(workspaceId, notification)
        } catch {
          // Best-effort: one channel failing must not block the others or the caller.
        }
      }),
    )
  }
}

/** The no-op channel: delivers nothing (tests, or a deployment with no channels wired). */
export class NoopNotificationChannel implements NotificationChannel {
  async deliver(): Promise<void> {}
}

/**
 * Whether a workspace routes a notification type to one channel — the notification
 * manager's decision, as the delivery path sees it. The implementation reads the
 * workspace's stored overrides and falls back to the shipped default
 * (`isNotificationRouted` in `@cat-factory/contracts`, the single source of truth the
 * settings UI renders from).
 */
export interface NotificationRouter {
  isRouted(
    workspaceId: string,
    type: NotificationType,
    channel: NotificationDeliveryChannel,
  ): Promise<boolean>
}

/**
 * Gates one channel's deliveries on the workspace's routing for that channel.
 *
 * A DECORATOR rather than a filter inside {@link CompositeNotificationChannel}, because
 * only some transports are routed here: Slack and the outbound webhooks answer "which
 * types" where their destination is declared (a Slack route's channel, a webhook
 * endpoint's own `types` filter), so wrapping them would be a second switch for a
 * question already decided. A facade wraps exactly the channels the manager owns, and
 * what it wrapped is legible at the wiring site.
 *
 * A router failure means the decision is UNKNOWN, and the honest reading of that is the
 * SHIPPED DEFAULT rather than silence: a settings read failing must not be the reason a
 * human never hears that their run parked, and it must not turn every muted type into a
 * mailshot either. So a throw falls back to the same default a workspace that never
 * configured anything gets, and is reported through `onError` instead of swallowed.
 */
export class RoutedNotificationChannel implements NotificationChannel {
  constructor(
    private readonly channel: NotificationDeliveryChannel,
    private readonly router: NotificationRouter,
    private readonly inner: NotificationChannel,
    private readonly onError?: (
      error: unknown,
      context: {
        workspaceId: string
        notificationId: string
        channel: NotificationDeliveryChannel
      },
    ) => void,
  ) {}

  async deliver(workspaceId: string, notification: Notification): Promise<void> {
    let routed = defaultNotificationRoute(notification.type, this.channel)
    try {
      routed = await this.router.isRouted(workspaceId, notification.type, this.channel)
    } catch (error) {
      this.onError?.(error, {
        workspaceId,
        notificationId: notification.id,
        channel: this.channel,
      })
    }
    if (!routed) return
    await this.inner.deliver(workspaceId, notification)
  }
}
