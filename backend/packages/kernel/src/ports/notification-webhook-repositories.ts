import type { NotificationType } from '../domain/types.js'
import type { PlatformAlertEventKind } from './platform-alert.js'
import type { RunLifecycleEventKind } from './run-lifecycle.js'

// Persistence port for a workspace's outbound notification webhooks — the delivery endpoints a
// HEADLESS integration registers so it learns about parked decisions (and the actionable run
// tails) by push instead of polling. Keyed by (workspace id, endpoint id): a workspace registers
// SEVERAL, so a second integration enrolling cannot silently unregister the first.
//
// The signing secret is stored SEALED (the deployment `SecretCipher`, like every other outbound
// credential) and never leaves the backend: it is used only to sign an outgoing delivery, and the
// management API reports `hasSecret` rather than the value. That is why this record — the internal
// shape — carries the sealed blob while the wire type does not.

/** A workspace's registered notification webhook, as persisted. */
export interface NotificationWebhookRecord {
  workspaceId: string
  /**
   * Which endpoint this is within the workspace, chosen by whoever registered it. The management
   * service reserves `default` for the singular routes; this layer treats it as an opaque key.
   */
  id: string
  /** An operator-facing label, defaulted to {@link id} by the service when none is supplied. */
  name: string
  /** The HTTPS endpoint deliveries are POSTed to. */
  url: string
  /**
   * The notification types delivered. EMPTY means "the defaults"
   * (`DEFAULT_NOTIFICATION_WEBHOOK_TYPES`) — see the contract for why an empty filter is not
   * "everything".
   */
  types: NotificationType[]
  /**
   * The RUN-LIFECYCLE events delivered to the same endpoint (`run.started` / `run.completed` /
   * `run.failed`). EMPTY means NONE — the opposite of `types` above, deliberately: notifications
   * are what the endpoint was built to deliver, so an unset filter there means "the sensible
   * defaults", whereas lifecycle events are the later addition and an existing endpoint must not
   * start receiving a new event family it never asked for. Unconfigured is byte-for-byte the
   * prior behaviour.
   */
  runEvents: RunLifecycleEventKind[]
  /**
   * The PLATFORM-HEALTH transitions delivered to the same endpoint
   * (`platform_health.firing` / `platform_health.resolved`). EMPTY means NONE, for the same
   * reason as {@link runEvents}: this is the family an ON-CALL receiver subscribes to, and an
   * endpoint registered to hear about parked decisions must never start paging somebody because
   * the deployment shipped a new event family.
   */
  alertEvents: PlatformAlertEventKind[]
  /** Whether deliveries are currently attempted. */
  enabled: boolean
  /**
   * The signing secret, SEALED with the deployment `SecretCipher`. Null when the workspace
   * registered an endpoint without one, in which case deliveries are unsigned — supported for a
   * receiver that authenticates by network position (a private endpoint), but a signed endpoint
   * is what a public receiver should use.
   */
  secretSealed: string | null
  updatedAt: number
}

/**
 * What a `put` did: wrote the row, or refused to CREATE one because the workspace is already at
 * its endpoint limit. A refusal is a decision the caller renders, never a silent no-op.
 */
export type NotificationWebhookPutOutcome = 'stored' | 'limit_reached'

export interface NotificationWebhookRepository {
  /** One endpoint, or null when nothing is registered under that id. */
  get(workspaceId: string, id: string): Promise<NotificationWebhookRecord | null>
  /**
   * Every endpoint the workspace has registered, ordered by id in BYTE order.
   *
   * Byte order specifically, because an implementation's default is not one order: SQLite's is
   * BINARY and Postgres' is the database's locale collation, which sorts `web-hook` after
   * `webhook` by ignoring the punctuation an id is free to contain. Both implementations therefore
   * name a collation rather than taking the default, and the conformance suite pins the ordering
   * with ids that tell the two apart.
   *
   * This is what the three delivery paths read: ONE query per raised notification / run edge /
   * health transition, fanned out in memory. A `get` per subscribed endpoint would be an N+1 on
   * the run's terminal path, which is the hottest place this store is read from.
   */
  list(workspaceId: string): Promise<NotificationWebhookRecord[]>
  /**
   * Create or replace one endpoint (keyed by workspace id AND endpoint id), refusing a CREATE that
   * would take the workspace past `limit` endpoints.
   *
   * The cap is enforced HERE, not by counting first and writing after, because a count read in one
   * statement and acted on in the next binds nothing: two enrolments racing each other both see
   * room and both take it. That is not a hypothetical for this store, it is the access pattern it
   * was built for (a cold-booting integration writing its own well-known id, possibly two
   * instances of it at once). Neither engine makes the naive version safe: Postgres takes no
   * predicate lock on rows that do not exist yet, and SQLite serializes each STATEMENT rather than
   * a read-then-write pair.
   *
   * The limit is passed in rather than known here, so `MAX_NOTIFICATION_WEBHOOKS_PER_WORKSPACE`
   * stays the one definition in contracts and this layer only enforces what it is told.
   *
   * `'limit_reached'` is returned rather than thrown: which HTTP status a full workspace deserves
   * is the service's call, not the store's. Replacing an endpoint that already exists is always
   * `'stored'`, even at or over the limit, because disabling and deleting are exactly the edits an
   * operator makes to get back under it.
   */
  put(record: NotificationWebhookRecord, limit: number): Promise<NotificationWebhookPutOutcome>
  /** Remove one endpoint. Idempotent — deleting an absent row is a no-op. */
  delete(workspaceId: string, id: string): Promise<void>
}
