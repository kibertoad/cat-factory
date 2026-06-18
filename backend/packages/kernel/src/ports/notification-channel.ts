import type { Notification } from '../domain/types'

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
