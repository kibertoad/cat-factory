import * as v from 'valibot'
import { notificationTypeSchema, type NotificationType } from './notifications.js'

// ---------------------------------------------------------------------------
// The notification MANAGER: which notification types a workspace delivers on which
// channel. The routing rule lives here, in contracts, because both sides have to
// AGREE about the same answer — the engine decides whether to deliver, and the
// settings UI has to render the very same resolved state (including the shipped
// default a workspace has never overridden). A rule restated on each side drifts,
// and here the drift is silent: the toggle says "on" while nothing is sent.
//
// Scope, and why these two channels and not the others:
//   - `in_app` and `email` are workspace-wide YES/NO per type: there is nothing to
//     configure beyond "send it or don't", so a matrix is the whole story.
//   - Slack and the outbound webhooks are DESTINATION-configured — a Slack route
//     carries the channel it posts to, a webhook endpoint carries its own `types`
//     filter — so "which types" is answered where the destination is declared. A
//     second switch here would be a place to look that does not decide.
//
// A cell is an OVERRIDE, not the value: absent means "this workspace has never said",
// which resolves to the shipped default for that (type, channel). That is what lets a
// new notification type, or a new channel, arrive with a sensible default instead of
// reading as an explicit `false` nobody chose.
// ---------------------------------------------------------------------------

/**
 * A channel the notification manager routes. See the module comment for why the
 * destination-configured transports (Slack, outbound webhooks) are deliberately absent.
 */
export const notificationDeliveryChannelSchema = v.picklist(['in_app', 'email'])
export type NotificationDeliveryChannel = v.InferOutput<typeof notificationDeliveryChannelSchema>

/** Every routed channel, in the order the settings UI renders its columns. */
export const NOTIFICATION_DELIVERY_CHANNELS = [
  'in_app',
  'email',
] as const satisfies readonly NotificationDeliveryChannel[]

/**
 * The types email is ON for by default: the ones where something is STOPPED and stays
 * stopped until a human acts, or where the deployment itself is degraded. Email is the
 * channel that reaches someone who is not looking at the board, so its default has to be
 * the set worth interrupting them over.
 *
 * Deliberately EXCLUDED, though they are human-actionable: the per-step review parks
 * (`requirement_review`, `human_review`, `judge_review`, `pr_review_ready`,
 * `fork_decision_pending`, `followup_pending`, …). Several of them arrive on nearly every
 * task, so mailing them by default is the firehose that gets a sender's domain filtered and
 * teaches people to ignore the channel. A workspace that wants them turns them on per type,
 * which is what the manager is for.
 *
 * `budget_threshold` is out for the same reason `budget_paused` is in: the warning is
 * proactive and recurring, the pause has already stopped work.
 */
export const HIGH_IMPACT_NOTIFICATION_TYPES = [
  // A run finished but its PR needs a human merge decision.
  'merge_review',
  // An iterative gate spent its budget and parked on a human decision — the run waits
  // indefinitely, so nobody learns it stopped unless they are watching the board.
  'decision_required',
  // The machine gave up: CI is still red / the tester still withholds its greenlight.
  'ci_failed',
  'test_failed',
  // Production regressed after a deploy.
  'release_regression',
  // Deployment-level: aggregate run health, a dead infrastructure connection, runs paused
  // by the spend safeguard, credentials that no longer decrypt. Each stops (or is about to
  // stop) work for everyone, and none of them has anyone watching a board.
  'platform_health',
  'infra_unreachable',
  'budget_paused',
  'key_drift',
] as const satisfies readonly NotificationType[]

const HIGH_IMPACT_SET: ReadonlySet<NotificationType> = new Set(HIGH_IMPACT_NOTIFICATION_TYPES)

/** Whether a type is one of the high-impact events email carries by default (see above). */
export function isHighImpactNotificationType(type: NotificationType): boolean {
  return HIGH_IMPACT_SET.has(type)
}

/**
 * One type's routing OVERRIDES. Every cell is optional and absent means "never chosen",
 * which resolves to {@link defaultNotificationRoute}. Adding a channel to the union
 * therefore leaves every stored row valid, and the new channel arrives on its default
 * rather than as a `false` no human picked.
 */
export const notificationChannelOverridesSchema = v.object({
  in_app: v.optional(v.boolean()),
  email: v.optional(v.boolean()),
})
export type NotificationChannelOverrides = v.InferOutput<typeof notificationChannelOverridesSchema>

/** A workspace's per-type routing overrides. Types absent from the map are fully default. */
export const notificationRoutingMatrixSchema = v.record(
  notificationTypeSchema,
  notificationChannelOverridesSchema,
)
export type NotificationRoutingMatrix = v.InferOutput<typeof notificationRoutingMatrixSchema>

/** A workspace's notification manager settings, as served. */
export const notificationSettingsSchema = v.object({
  matrix: notificationRoutingMatrixSchema,
  /** Epoch ms of the last write; `0` when the workspace has never configured routing. */
  updatedAt: v.number(),
})
export type NotificationSettings = v.InferOutput<typeof notificationSettingsSchema>

/** Replace a workspace's routing matrix (a full replace, like the Slack routing write). */
export const updateNotificationSettingsSchema = v.object({
  matrix: notificationRoutingMatrixSchema,
})
export type UpdateNotificationSettingsInput = v.InferOutput<typeof updateNotificationSettingsSchema>

/**
 * The shipped default for one (type, channel) — what applies until a workspace overrides it.
 *
 * `in_app` is ON for every type: the inbox is where a human-actionable card lives, and the
 * push is what makes it appear without a reload. Turning it off is a legitimate "stop
 * interrupting me about this kind" choice, and it never hides anything: the card is persisted
 * either way and is still in the inbox on the next snapshot.
 *
 * `email` is ON only for {@link HIGH_IMPACT_NOTIFICATION_TYPES}, so a deployment that connects
 * a sender does not start mailing its members about every step of every run.
 */
export function defaultNotificationRoute(
  type: NotificationType,
  channel: NotificationDeliveryChannel,
): boolean {
  return channel === 'in_app' ? true : isHighImpactNotificationType(type)
}

/**
 * Whether a workspace delivers `type` on `channel`: its override when it has one, else the
 * shipped default. THE routing decision — the engine gates delivery on it and the settings UI
 * renders the toggle from it, so neither can state something the other does not do.
 */
export function isNotificationRouted(
  matrix: NotificationRoutingMatrix | null | undefined,
  type: NotificationType,
  channel: NotificationDeliveryChannel,
): boolean {
  return matrix?.[type]?.[channel] ?? defaultNotificationRoute(type, channel)
}

/**
 * Decode a persisted routing matrix, dropping only what this build cannot read.
 *
 * Per TYPE rather than through {@link notificationRoutingMatrixSchema}, because a row written by
 * an older build can name a notification type (or a channel) that has since been retired, and a
 * single strict parse would then discard EVERY override in the row — silently unmuting every
 * other type at once. Dropping the one unreadable cell leaves the workspace's other choices
 * standing, and the dropped one falls back to the shipped default, which is what an un-overridden
 * cell already means. Nothing renders a retired name, so there is none to state.
 *
 * A value that is not an object at all resolves to "no overrides" rather than throwing: the
 * caller is on the delivery path, where a throw could only cost the human the notification they
 * are waiting for.
 */
export function decodeNotificationRoutingMatrix(raw: unknown): NotificationRoutingMatrix {
  if (!raw || typeof raw !== 'object') return {}
  const matrix: NotificationRoutingMatrix = {}
  for (const [type, cell] of Object.entries(raw as Record<string, unknown>)) {
    const parsedType = v.safeParse(notificationTypeSchema, type)
    if (!parsedType.success) continue
    // `v.object` drops unknown entries, so a retired CHANNEL costs its own cell and nothing else.
    const parsedCell = v.safeParse(notificationChannelOverridesSchema, cell)
    if (!parsedCell.success) continue
    matrix[parsedType.output] = parsedCell.output
  }
  return matrix
}

/** The resolved routing for one type across every channel (the settings UI's row). */
export function resolveNotificationRouting(
  matrix: NotificationRoutingMatrix | null | undefined,
  type: NotificationType,
): Record<NotificationDeliveryChannel, boolean> {
  return {
    in_app: isNotificationRouted(matrix, type, 'in_app'),
    email: isNotificationRouted(matrix, type, 'email'),
  }
}
