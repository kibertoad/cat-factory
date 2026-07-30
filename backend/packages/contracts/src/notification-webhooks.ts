import * as v from 'valibot'
import { notificationSchema, notificationTypeSchema } from './notifications.js'

// ---------------------------------------------------------------------------
// Notification-webhook wire contracts. A workspace can register ONE outbound HTTPS endpoint that
// receives its notifications as they are raised — the delivery channel a HEADLESS integration
// needs, since it has no in-app inbox to watch and no browser to hold a WebSocket open.
//
// This is a `NotificationChannel` like the in-app and Slack channels, composed into the same
// `CompositeNotificationChannel`, so nothing about how notifications are RAISED changes. The
// motivating case is the parked-decision loop: a public-API run that parks on a requirements
// review should reach its caller by push rather than by polling (see
// `docs/initiatives/headless-clarification-loop.md`, D3).
//
// The endpoint's `secret` is write-only on the wire: it is stored encrypted and never read back,
// exactly like the other outbound credentials. Deliveries are signed with it so a receiver can
// verify the payload really came from this deployment.
// ---------------------------------------------------------------------------

/** A workspace's registered notification webhook, as exposed to clients (never the secret). */
export const notificationWebhookSchema = v.object({
  /** The HTTPS endpoint deliveries are POSTed to. */
  url: v.string(),
  /**
   * Which notification types are delivered. EMPTY means "the parking types" — the defaults a
   * headless overseer cares about — rather than "everything", so registering an endpoint can't
   * accidentally fire-hose every card at an integration that only wanted to hear about parks.
   */
  types: v.array(notificationTypeSchema),
  /** Whether deliveries are currently attempted. Registering an endpoint enables it. */
  enabled: v.boolean(),
  /** Whether a signing secret is set (the secret itself is never returned). */
  hasSecret: v.boolean(),
  updatedAt: v.number(),
})
export type NotificationWebhook = v.InferOutput<typeof notificationWebhookSchema>

/**
 * Register or update the workspace's notification webhook. `secret` is write-only: omit it to keep
 * the stored one, pass a new value to rotate it. An `https:` URL is required — deliveries carry a
 * signed payload describing internal work, and plaintext HTTP would leak it on the wire.
 */
export const putNotificationWebhookSchema = v.object({
  url: v.pipe(
    v.string(),
    v.trim(),
    v.url(),
    v.startsWith('https://', 'The webhook endpoint must be an https:// URL'),
    v.maxLength(2000),
  ),
  /** Omit ⇒ deliver the default parking types. */
  types: v.optional(v.array(notificationTypeSchema)),
  enabled: v.optional(v.boolean()),
  /** New signing secret; omit to keep the current one. */
  secret: v.optional(v.pipe(v.string(), v.trim(), v.minLength(16), v.maxLength(200))),
})
export type PutNotificationWebhookInput = v.InferOutput<typeof putNotificationWebhookSchema>

/**
 * The JSON body of one webhook delivery. Deliberately a thin envelope over the SAME
 * `notificationSchema` the in-app inbox and the public `GET /api/v1/notifications` already expose
 * — a notification is already a small client-facing projection with no block/execution/credential
 * internals, so there is no separate wire shape to keep in step.
 *
 * `deliveryId` is stable per (notification, delivery attempt-series): a receiver dedupes on it,
 * since a retried delivery repeats the same id. `runId`/`taskId` are lifted out of the
 * notification for routing convenience — a receiver can dispatch on them without unpacking the
 * card. Signature headers, not body fields, carry the authenticity proof.
 */
export const notificationWebhookDeliverySchema = v.object({
  deliveryId: v.string(),
  /** Epoch-ms the delivery was produced (also the signed timestamp — see the signature headers). */
  sentAt: v.number(),
  workspaceId: v.string(),
  /** The run the notification concerns, when it names one. */
  runId: v.nullable(v.string()),
  /** The board task the notification concerns, when it names one. */
  taskId: v.nullable(v.string()),
  notification: notificationSchema,
})
export type NotificationWebhookDelivery = v.InferOutput<typeof notificationWebhookDeliverySchema>

/**
 * The notification types delivered when a webhook declares no explicit `types` filter: the
 * human-parking cards a headless overseer must react to, plus the failure tails it can act on
 * through the public notification surface. Deliberately NOT every type — the block-less/system
 * cards (`platform_health`, `infra_unreachable`, `budget_paused`, `key_drift`, `initiative`) are
 * operator concerns with no external action, and shipping them by default turns the endpoint into a
 * firehose. A deployment that DOES want an infrastructure outage on its webhook can name it in the
 * per-webhook `types` filter, which is exactly what that filter is for.
 */
export const DEFAULT_NOTIFICATION_WEBHOOK_TYPES = [
  'requirement_review',
  'clarity_review',
  'decision_required',
  'fork_decision_pending',
  'merge_review',
  'pipeline_complete',
  'ci_failed',
  'test_failed',
] as const satisfies readonly v.InferOutput<typeof notificationTypeSchema>[]
