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

/**
 * WHICH lifecycle edge a delivery reports. The NotificationService re-delivers a card on
 * every transition it makes, and the transports split hard on what that means:
 *
 * - A STATE transport (the in-app push, the outbound webhook) carries the card's current
 *   value, so it wants every edge: a board holding an open card has to see it settle, or
 *   it renders an already-dismissed decision as still actionable until the next reload.
 * - An ALERT transport (email, Slack) interrupts a human, so it wants the FIRST edge only.
 *   Mailing a board "Decision needed: …" after the decision was made is not a stale render,
 *   it is a wrong statement that cannot be taken back.
 *
 * Without this, a channel can only guess from `notification.status`, and the two edges that
 * matter most are indistinguishable there: an escalation and a fresh raise are both `open`.
 * It is a required parameter so a new call site fails to typecheck rather than silently
 * picking whichever reading the channel it happens to reach assumes.
 *
 * The members, in lifecycle order:
 * - `raised`: a human is being asked something they have NOT been asked. A new card, or one
 *   whose user-visible content changed.
 * - `refreshed`: the same open card moved without a new ask. The escalation sweep flipped it
 *   red; a failed action put it back.
 * - `settled`: the card is no longer actionable. Acted on, resolved, or auto-dismissed.
 *
 * Declared as a LIST rather than a bare union because one consumer has to check it at runtime:
 * the mothership relay reads this off the wire from a node that may be a different build, and a
 * predicate derived from the vocabulary's own members cannot fall out of step with it.
 */
export const NOTIFICATION_DELIVERY_REASONS = ['raised', 'refreshed', 'settled'] as const

export type NotificationDeliveryReason = (typeof NOTIFICATION_DELIVERY_REASONS)[number]

/** Whether an arbitrary value is one of {@link NOTIFICATION_DELIVERY_REASONS}. */
export function isNotificationDeliveryReason(value: unknown): value is NotificationDeliveryReason {
  return (NOTIFICATION_DELIVERY_REASONS as readonly unknown[]).includes(value)
}

/**
 * Whether this edge is a NEW ask, and so the one an alert transport delivers on.
 *
 * The single place that judgement lives: three transports would otherwise each restate it,
 * and a fourth would arrive stating it slightly differently. Exhaustive over the union, so
 * adding an edge fails the build here rather than defaulting to "interrupt everyone".
 */
export function isAlertingDelivery(reason: NotificationDeliveryReason): boolean {
  switch (reason) {
    case 'raised':
      return true
    case 'refreshed':
    case 'settled':
      return false
    default:
      return assertNeverDeliveryReason(reason)
  }
}

function assertNeverDeliveryReason(reason: never): never {
  throw new Error(`unhandled notification delivery reason: ${String(reason)}`)
}

export interface NotificationChannel {
  /** Deliver (or re-deliver) a notification to this channel's medium, on `reason`'s edge. */
  deliver(
    workspaceId: string,
    notification: Notification,
    reason: NotificationDeliveryReason,
  ): Promise<void>
}

/** Fan a notification out to every configured channel, isolating per-channel failures. */
export class CompositeNotificationChannel implements NotificationChannel {
  constructor(private readonly channels: NotificationChannel[]) {}

  async deliver(
    workspaceId: string,
    notification: Notification,
    reason: NotificationDeliveryReason,
  ): Promise<void> {
    await Promise.all(
      this.channels.map(async (channel) => {
        try {
          await channel.deliver(workspaceId, notification, reason)
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
 * It gates the ALERTING edge ONLY (see {@link NotificationDeliveryReason}). Two things
 * follow from that, and both are the point rather than a concession:
 *
 * - A mute stops the interruption, never a correction. The card is persisted whatever the
 *   routing says and reaches every board on its next snapshot, so withholding the SETTLED
 *   push would leave those boards rendering a decision that was already made as still
 *   waiting for one, curable only by a reload.
 * - The routing read happens on the raise and nowhere else. The escalation sweep re-delivers
 *   every overdue card in a workspace in one loop; a gate that consulted the store per card
 *   would be a read per card per channel, and one mothership round trip each.
 *
 * What remains is one read per raised card per routed channel. That is deliberate rather
 * than un-batched: the two routed channels land in DIFFERENT channel sets (the in-app push is
 * local, email is external and mothership-delivered), so there is no single point that could
 * ask once for both, and a raise is a human-scale event.
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

  async deliver(
    workspaceId: string,
    notification: Notification,
    reason: NotificationDeliveryReason,
  ): Promise<void> {
    if (isAlertingDelivery(reason) && !(await this.routes(workspaceId, notification))) return
    await this.inner.deliver(workspaceId, notification, reason)
  }

  private async routes(workspaceId: string, notification: Notification): Promise<boolean> {
    try {
      return await this.router.isRouted(workspaceId, notification.type, this.channel)
    } catch (error) {
      this.onError?.(error, {
        workspaceId,
        notificationId: notification.id,
        channel: this.channel,
      })
      return defaultNotificationRoute(notification.type, this.channel)
    }
  }
}
