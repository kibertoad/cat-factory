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

/**
 * The RUN-LIFECYCLE events the same endpoint can subscribe to: the ordinary lifecycle of work an
 * integration queued, none of which raises a notification. A task whose pipeline carries a
 * `merger` merges its own PR and settles with an empty inbox — the happy path, and the one a CI
 * system most wants to hear about. Deliberately only the EDGES: a per-step feed would be a
 * firehose (the engine emits on every container poll), which is what the SSE endpoints are for.
 *
 * Mirrors kernel's `RUN_LIFECYCLE_EVENTS`; keep the member lists in step.
 */
export const runLifecycleEventSchema = v.picklist(['run.started', 'run.completed', 'run.failed'])
export type RunLifecycleEventName = v.InferOutput<typeof runLifecycleEventSchema>

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
  /**
   * Which run-lifecycle events are delivered. EMPTY means NONE — the opposite of `types` above,
   * deliberately: an endpoint registered before this existed must not start receiving a new event
   * family it never asked for, so subscribing is explicit.
   */
  runEvents: v.array(runLifecycleEventSchema),
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
  /** Omit ⇒ keep the current run-event subscription (none, for an endpoint that never set one). */
  runEvents: v.optional(v.array(runLifecycleEventSchema)),
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
 * The JSON body of one RUN-LIFECYCLE delivery, POSTed to the same endpoint with the same
 * signature headers. `event` is what a receiver switches on — a notification delivery carries
 * `notification`, this one carries `run`, so the two are told apart by shape as well as by name.
 *
 * `deliveryId` is `<runId>:<event>`: stable across retries AND across a re-delivery, which is the
 * dedupe key a receiver MUST use. Delivery is AT-LEAST-ONCE by design. The terminal events are
 * pushed from the engine's terminal-emit funnel — the same place the run's other terminal hooks
 * live — because a run reaches `done` from four independent sites and a hook at each would
 * silently drift the day a fifth is added. A durable replay can therefore re-emit a settled run,
 * and the repeat carries byte-identical content, so it is the receiver's cheap dedupe rather than
 * a claim table this platform would then have to sweep.
 */
export const runWebhookDeliverySchema = v.object({
  deliveryId: v.string(),
  /** Epoch-ms the delivery was produced (also the signed timestamp — see the signature headers). */
  sentAt: v.number(),
  workspaceId: v.string(),
  event: runLifecycleEventSchema,
  run: v.object({
    runId: v.string(),
    /** The board task the run belongs to — the id every `/api/v1/tasks/:taskId/*` route takes. */
    taskId: v.string(),
    taskTitle: v.string(),
    pipelineId: v.string(),
    pipelineName: v.string(),
    /** Epoch-ms the run started; NULL when the run row carries none (never stamped 0). */
    startedAt: v.nullable(v.number()),
    occurredAt: v.number(),
    /**
     * The PR the run opened, when it opened one. On a terminal event `null` is a REAL answer —
     * a findings/spike pipeline opens nothing — not "not known yet".
     */
    pullRequestUrl: v.nullable(v.string()),
    /** Present only on `run.failed`. */
    failure: v.nullable(
      v.object({
        kind: v.string(),
        message: v.string(),
        reason: v.nullable(v.string()),
      }),
    ),
  }),
})
export type RunWebhookDelivery = v.InferOutput<typeof runWebhookDeliverySchema>

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
