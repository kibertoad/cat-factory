import type { NotificationType } from '../domain/types.js'
import type { PlatformAlertEventKind } from './platform-alert.js'
import type { RunLifecycleEventKind } from './run-lifecycle.js'

// Persistence port for a workspace's outbound notification webhook — the delivery endpoint a
// HEADLESS integration registers so it learns about parked decisions (and the actionable run
// tails) by push instead of polling. One endpoint per workspace, keyed by workspace id, exactly
// like the tracker/Slack settings rows.
//
// The signing secret is stored SEALED (the deployment `SecretCipher`, like every other outbound
// credential) and never leaves the backend: it is used only to sign an outgoing delivery, and the
// management API reports `hasSecret` rather than the value. That is why this record — the internal
// shape — carries the sealed blob while the wire type does not.

/** A workspace's registered notification webhook, as persisted. */
export interface NotificationWebhookRecord {
  workspaceId: string
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

export interface NotificationWebhookRepository {
  /** The workspace's webhook, or null when none is registered. */
  get(workspaceId: string): Promise<NotificationWebhookRecord | null>
  /** Create or replace the workspace's webhook (keyed by workspace id). */
  put(record: NotificationWebhookRecord): Promise<void>
  /** Remove the workspace's webhook. Idempotent — deleting an absent row is a no-op. */
  delete(workspaceId: string): Promise<void>
}
