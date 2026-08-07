import * as v from 'valibot'
import { notificationSchema, notificationTypeSchema } from './notifications.js'
import { platformFailingRunSchema } from './observability.js'

// ---------------------------------------------------------------------------
// Notification-webhook wire contracts. A workspace registers outbound HTTPS endpoints that
// receive its notifications as they are raised — the delivery channel a HEADLESS integration
// needs, since it has no in-app inbox to watch and no browser to hold a WebSocket open.
//
// This is a `NotificationChannel` like the in-app and Slack channels, composed into the same
// `CompositeNotificationChannel`, so nothing about how notifications are RAISED changes. The
// motivating case is the parked-decision loop: a public-API run that parks on a requirements
// review should reach its caller by push rather than by polling (see
// `backend/docs/adr/0047-headless-clarification-loop.md`, D3).
//
// The endpoint's `secret` is write-only on the wire: it is stored encrypted and never read back,
// exactly like the other outbound credentials. Deliveries are signed with it so a receiver can
// verify the payload really came from this deployment.
//
// A workspace may register SEVERAL named endpoints, each with its own secret and its own filters,
// addressed by a caller-chosen {@link notificationWebhookIdSchema}. The original singular routes
// (`/api/v1/notification-webhook`) are a projection onto the one id
// {@link DEFAULT_NOTIFICATION_WEBHOOK_ID}, so a consumer written before the collection existed
// keeps addressing exactly the endpoint it always did.
// ---------------------------------------------------------------------------

/**
 * The id of the endpoint the SINGULAR routes address. Registering through
 * `PUT /api/v1/notification-webhook` writes this id, and it appears in the collection like any
 * other entry, so the two surfaces describe one store rather than two.
 */
export const DEFAULT_NOTIFICATION_WEBHOOK_ID = 'default'

/**
 * How many endpoints one workspace may register. Every delivery fans out to every subscribed
 * endpoint on a run's terminal path, so the set has to be bounded by something other than an
 * operator's patience; ten is well above the "one receiver per integration" the collection exists
 * to serve. Exceeding it is a 409 with `reason: 'webhook_limit_reached'`.
 */
export const MAX_NOTIFICATION_WEBHOOKS_PER_WORKSPACE = 10

/**
 * A webhook's id: CALLER-CHOSEN, not server-minted, which is what makes enrolment idempotent for
 * the consumer that needs it most. A gatekeeper Worker booting cold can `PUT` its own well-known
 * id and be enrolled whether or not it has ever run before, with no id table of its own and no
 * create-or-discover dance against a surface it may be racing another instance on.
 *
 * Constrained to a lowercase slug because it is a path segment on both management surfaces and an
 * operator reads it in a log line beside the endpoint's URL.
 */
export const notificationWebhookIdSchema = v.pipe(
  v.string(),
  // Deliberately NOT trimmed, unlike the body strings beside it. Trimming would admit `" ci "` and
  // then store `ci`, so the id a caller PUT and the id it must address afterwards would differ.
  v.regex(
    /^[a-z0-9][a-z0-9_-]{0,62}$/u,
    'A webhook id must be 1-63 characters of lowercase letters, digits, `-` or `_`, starting with a letter or digit',
  ),
)

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

/**
 * The PLATFORM-HEALTH transitions the same endpoint can subscribe to: the deployment watching
 * ITSELF, which is what an on-call integration is wired to. `firing` is delivered when the set of
 * tripped conditions CHANGES (so an incident pages once, and again only if it gets worse or
 * better in kind), `resolved` when the sweep observes the account recover.
 *
 * This is deliberately its own family rather than the `platform_health` notification type on the
 * `types` filter next door, which delivers the same alert as a CARD. Both are legitimate — a
 * human inbox wants the card — but only this one is safe to page on: a card is re-delivered when
 * a human acts on it or waves it off, and on the wire that dismissal is indistinguishable from
 * the sweep clearing the card because the deployment recovered.
 *
 * Mirrors kernel's `PLATFORM_ALERT_EVENTS`; keep the member lists in step.
 */
export const platformAlertEventSchema = v.picklist([
  'platform_health.firing',
  'platform_health.resolved',
])
export type PlatformAlertEventName = v.InferOutput<typeof platformAlertEventSchema>

/** A workspace's registered notification webhook, as exposed to clients (never the secret). */
export const notificationWebhookSchema = v.object({
  /**
   * Which endpoint this is, within the workspace. `default` is the one the singular
   * `/api/v1/notification-webhook` routes address.
   */
  id: v.string(),
  /** An operator-facing label. Defaults to the id when a registration supplies none. */
  name: v.string(),
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
  /**
   * Which platform-health transitions are delivered. EMPTY means NONE, like {@link runEvents}:
   * subscribing a receiver to alerts about the deployment itself is always an explicit choice.
   */
  alertEvents: v.array(platformAlertEventSchema),
  /** Whether deliveries are currently attempted. Registering an endpoint enables it. */
  enabled: v.boolean(),
  /** Whether a signing secret is set (the secret itself is never returned). */
  hasSecret: v.boolean(),
  updatedAt: v.number(),
})
export type NotificationWebhook = v.InferOutput<typeof notificationWebhookSchema>

/**
 * Register or update the workspace's notification webhook. EVERY field is keep-on-omit: what the
 * body leaves out retains its stored value, so subscribing an existing endpoint to a new event
 * family is a one-field write.
 *
 * That uniformity is the point, and `url` is optional for it. A mandatory re-send would make the
 * common edit carry a value the caller did not intend to change, and a caller re-sending a URL it
 * cached before someone else rotated the endpoint would silently redirect the workspace's
 * deliveries back to the old receiver while appearing to only add a subscription. The first `PUT`
 * on a workspace with nothing registered still needs one, and the service refuses with
 * `reason: 'webhook_url_required'` rather than storing a half-endpoint.
 *
 * When supplied it must be `https:`: deliveries carry a signed payload describing internal work,
 * and plaintext HTTP would leak it on the wire.
 *
 * `secret` is write-only: omit it to keep the stored one, pass a new value to rotate it.
 */
export const putNotificationWebhookSchema = v.object({
  /** Omit ⇒ keep the registered endpoint (required only when registering the first one). */
  url: v.optional(
    v.pipe(
      v.string(),
      v.trim(),
      v.url(),
      v.startsWith('https://', 'The webhook endpoint must be an https:// URL'),
      v.maxLength(2000),
    ),
  ),
  /** Omit ⇒ keep the stored label (the endpoint's id, for a registration that named none). */
  name: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(100))),
  /** Omit ⇒ deliver the default parking types. */
  types: v.optional(v.array(notificationTypeSchema)),
  /** Omit ⇒ keep the current run-event subscription (none, for an endpoint that never set one). */
  runEvents: v.optional(v.array(runLifecycleEventSchema)),
  /** Omit ⇒ keep the current platform-health subscription (none, for an endpoint that never set one). */
  alertEvents: v.optional(v.array(platformAlertEventSchema)),
  enabled: v.optional(v.boolean()),
  /** New signing secret; omit to keep the current one. */
  secret: v.optional(v.pipe(v.string(), v.trim(), v.minLength(16), v.maxLength(200))),
})
export type PutNotificationWebhookInput = v.InferOutput<typeof putNotificationWebhookSchema>

/**
 * What `GET /api/v1/notification-webhook` and `GET /api/v1/notification-webhooks/:webhookId`
 * answer: the addressed endpoint, or `null` when none is registered under that id. A 404 would be
 * the conventional answer for the second one and is deliberately not used: "am I already wired
 * up?" is the call an integration makes at startup, and it should read one response shape rather
 * than branch on a status this surface also uses for a mistyped path.
 *
 * Both the session surface and the public one project the SAME
 * {@link notificationWebhookSchema}, because the projection is already the client-facing shape
 * with the secret reduced to a boolean, and a second near-identical DTO would be one more thing
 * to keep in step for no caller-visible gain.
 *
 * The WRAPPER, though, is public-surface-only, and it is not decoration. A bare nullable body is
 * an honest wire shape but a poor generated one: the SDK emitters model a null at the top level of
 * a response far less faithfully than a null on a FIELD (Go decodes a `null` body into a
 * zero-valued struct, so "no endpoint registered" would arrive as an endpoint whose URL is the
 * empty string). Wrapping keeps "none is registered" a value every client reads the same way, and
 * leaves room to add a sibling field later without changing the response type.
 */
export const publicNotificationWebhookSchema = v.object({
  /** The registered endpoint, or `null` when the workspace has none. */
  webhook: v.nullable(notificationWebhookSchema),
})
export type PublicNotificationWebhook = v.InferOutput<typeof publicNotificationWebhookSchema>

/**
 * What `GET /api/v1/notification-webhooks` answers: every endpoint the workspace has registered,
 * ordered by id so two reads of an unchanged workspace agree.
 *
 * Deliberately NOT paginated, unlike every other public list. Paging exists to bound a set the
 * platform cannot bound itself, and this one is bounded at
 * {@link MAX_NOTIFICATION_WEBHOOKS_PER_WORKSPACE} by the write path: a cursor here would hand
 * every client a loop to write for a set that fits in one response by construction, and would
 * quietly become the reason nobody noticed the cap had been raised.
 */
export const publicNotificationWebhookListSchema = v.object({
  webhooks: v.array(notificationWebhookSchema),
})
export type PublicNotificationWebhookList = v.InferOutput<
  typeof publicNotificationWebhookListSchema
>

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
 * silently drift the day a fifth is added. A durable replay can therefore re-emit a settled run.
 *
 * **Dedupe on `deliveryId`, never on the body.** A re-delivery describes the same settled run, but
 * `sentAt` and `run.occurredAt` are re-stamped from the clock when it is produced, so two
 * deliveries of one transition are NOT byte-identical and a content hash will not collapse them.
 * Everything a receiver routes or acts on — the ids, the event, the outcome — is stable; only the
 * observation timestamps move. That is what makes the receiver's cheap dedupe the right contract
 * rather than a claim table this platform would then have to sweep.
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
 * One condition that tripped on a platform-health delivery, with the numbers behind it.
 *
 * `reason` is a plain string rather than the closed {@link platformAlertReasonSchema} picklist,
 * and that is the same call the SDKs make for the error envelope's `code`: the vocabulary grows
 * additively, so narrowing it here would mean a deployment one release ahead of its receiver
 * either fails to encode, or silently drops, the very condition it is paging about. The current
 * members are `failure_rate_high`, `duration_p99_high`, `backlog_high`, `throughput_stalled`,
 * `failure_kind_dominant`, `failure_kind_rate_high` and `sweep_degraded`; a receiver routes on
 * the ones it knows and treats
 * the rest as an unrecognised condition rather than as no condition.
 */
export const platformAlertWebhookConditionSchema = v.object({
  /** The tripped condition (see above for the current vocabulary). */
  reason: v.string(),
  /** The observed value that crossed the threshold (a rate 0..1, ms, or a count by reason). */
  value: v.number(),
  /** The configured threshold it crossed, in the same unit as {@link value}. */
  threshold: v.number(),
  /**
   * The failure kind a KIND-SCOPED condition is about (`evicted`, `timeout`, …), on the
   * conditions that have one: today only `failure_kind_rate_high`, where several rules fire
   * under the same `reason` and this is what tells them apart. Absent on every deployment-wide
   * condition, and a receiver that ignores it still routes correctly on the reason.
   */
  kind: v.optional(v.string()),
})
export type PlatformAlertWebhookCondition = v.InferOutput<
  typeof platformAlertWebhookConditionSchema
>

/**
 * The JSON body of one PLATFORM-HEALTH delivery, POSTed to the same endpoint with the same
 * signature headers. `event` is what a receiver switches on: a notification delivery carries
 * `notification`, a run delivery carries `run`, this one carries `alert`.
 *
 * `deliveryId` is `<cardId>:<event>:<transition>[:<reasons>]`: stable across the retries of one
 * delivery and distinct for each transition of one incident, so a receiver dedupes on it. The
 * card id is the platform's own record of the open alert, so it keeps two separate incidents
 * apart; the transition ordinal keeps two edges of ONE incident apart, including the case the
 * reason set alone would collapse (a condition set that escalates and later subsides back to
 * what it was is three transitions over two distinct sets). Do NOT substitute `occurredAt` for
 * the ordinal: two of the deployment's sweepers can observe one transition and would stamp
 * different times for it, which the ordinal is derived specifically to avoid.
 *
 * Three properties of this feed are worth stating plainly, because an on-call integration is
 * built differently depending on them:
 *
 * - **Edges only, and only on a CHANGE of the firing set.** The sweep runs every couple of
 *   minutes for the length of an incident; it does not re-deliver an unchanged alert, so absence
 *   of traffic means "nothing changed", never "recovered".
 * - **One account-level condition fans out per subscribed WORKSPACE.** Health is aggregated per
 *   account and endpoints are registered per workspace, so a receiver watching several workspaces
 *   of one account sees one delivery each. Group on `alert.accountId` to collapse them.
 * - **The resolved edge follows the platform's own open card.** If a human dismisses the
 *   `platform_health` card from the in-app inbox while the condition is still firing, the sweep
 *   has nothing left to clear, so a later recovery emits no `platform_health.resolved`. The next
 *   change to the firing set raises a fresh card and delivers `firing` again. A receiver that
 *   cannot tolerate a hanging incident should auto-resolve on its own timer rather than waiting
 *   for an edge the platform may have no state to produce.
 */
export const platformAlertWebhookDeliverySchema = v.object({
  deliveryId: v.string(),
  /** Epoch-ms the delivery was produced (also the signed timestamp — see the signature headers). */
  sentAt: v.number(),
  workspaceId: v.string(),
  event: platformAlertEventSchema,
  alert: v.object({
    /**
     * The account whose aggregate health this describes — the grain the condition is actually
     * evaluated at, and the id to group the per-workspace fan-out by.
     */
    accountId: v.string(),
    /**
     * The window the aggregate was computed over. One of `1h` / `24h` / `7d` today (the
     * {@link platformAlertWindowSchema} vocabulary), sent as a plain string for the same
     * additive-tolerance reason as the condition's `reason`.
     */
    window: v.string(),
    /**
     * The conditions firing at this transition, sorted by reason. EMPTY on
     * `platform_health.resolved`, where the absence of conditions IS the content.
     */
    conditions: v.array(platformAlertWebhookConditionSchema),
    /**
     * Epoch-ms the sweep observed this transition (not when the incident opened: an escalation
     * carries the moment it got worse). Every delivery of one account-level transition shares
     * the value, so it groups the per-workspace fan-out alongside `accountId`.
     */
    occurredAt: v.number(),
    /**
     * A bounded sample of the runs behind a failure-driven alert, in THIS workspace only. Empty
     * for a condition with no run evidence behind it (a backlog or throughput alert), and empty
     * when the evidence read failed — {@link failedTotal} is what tells those apart from a
     * workspace where nothing failed.
     */
    failingRuns: v.array(platformFailingRunSchema),
    /**
     * How many runs in this workspace had failed in the window when the alert fired, so the
     * capped sample states what it left out. NULL when the platform could not read it: a
     * different fact from zero, reported as one.
     */
    failedTotal: v.nullable(v.number()),
  }),
})
export type PlatformAlertWebhookDelivery = v.InferOutput<typeof platformAlertWebhookDeliverySchema>

/**
 * The notification types delivered when a webhook declares no explicit `types` filter: the
 * human-parking cards a headless overseer must react to, plus the failure tails it can act on
 * through the public notification surface. Deliberately NOT every type — the block-less/system
 * cards (`platform_health`, `infra_unreachable`, `budget_paused`, `budget_threshold`, `key_drift`,
 * `initiative`) are
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
