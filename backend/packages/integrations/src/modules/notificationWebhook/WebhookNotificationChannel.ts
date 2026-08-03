import {
  DEFAULT_NOTIFICATION_WEBHOOK_TYPES,
  type NotificationWebhookDelivery,
} from '@cat-factory/contracts'
import type {
  Clock,
  Notification,
  NotificationChannel,
  NotificationType,
  NotificationWebhookRecord,
  NotificationWebhookRepository,
  OperationalMetrics,
  SecretCipher,
  UrlSafetyPolicy,
} from '@cat-factory/kernel'
import { postSignedWebhook } from './signedDelivery.js'
import { WEBHOOK_SIGNATURE_HEADERS } from './webhookSignature.js'

// WebhookNotificationChannel: an outbound HTTP delivery transport for the existing notification
// mechanism. It implements the same `NotificationChannel` port as the in-app and Slack channels
// and is composed alongside them via `CompositeNotificationChannel` — so the engine call sites
// that raise notifications are untouched.
//
// This is the channel a HEADLESS integration needs. A public-API caller has no in-app inbox to
// watch and no browser to hold a WebSocket open, so without a push it can only learn that its run
// parked by polling. That matters most for the clarification loop: a parked run waits for a human
// INDEFINITELY, so "the caller will notice eventually" is not a design (see
// `docs/initiatives/headless-clarification-loop.md`, D3).
//
// The retry/SSRF/signing machinery lives in `signedDelivery.ts`, shared with the run-lifecycle
// sink that POSTs to the SAME registered endpoint — those are properties of the endpoint, not of
// the payload.
//
// Runtime-neutral (fetch + decrypt + one DB read), so it lives here in @cat-factory/integrations
// and serves BOTH runtime facades unchanged.

export interface WebhookNotificationChannelDependencies {
  notificationWebhookRepository: NotificationWebhookRepository
  secretCipher: SecretCipher
  clock: Clock
  /** HTTP transport (each runtime exposes a global `fetch`); injectable for tests. */
  fetchImpl?: typeof fetch
  /** Sleep between retries; injectable so tests don't spend real wall-clock on backoff. */
  sleep?: (ms: number) => Promise<void>
  /**
   * The deployment's widened URL guard for webhook endpoints, when one is configured
   * (`NOTIFICATION_WEBHOOK_ALLOW_URL_HOSTS` / `_ALLOW_HTTP_URLS`). Absent ⇒ the strict
   * public-https default: no private/internal hosts, no cloud-metadata endpoint. Resolved from the
   * webhook's OWN config slice, so widening it cannot widen the runner-pool or environment guard.
   */
  urlSafetyPolicy?: UrlSafetyPolicy
  /**
   * Optional observability hook invoked when a delivery ultimately fails. Delivery is best-effort
   * (a receiver outage must never break the notification lifecycle), but a swallowed failure
   * should still be diagnosable — the facades wire this to their structured logger, so a broken
   * endpoint surfaces instead of vanishing. Mirrors `SlackNotificationChannel.onError`.
   */
  onError?: (
    error: unknown,
    context: { workspaceId: string; notificationId: string; type: string },
  ) => void
  /**
   * Where a spent delivery is COUNTED, beside the per-failure report `onError` makes. The
   * hook answers "why did this one card not arrive"; the counter answers "are deliveries
   * failing at a rate nobody has noticed" — an endpoint that has been rejecting every card
   * for a week produces a steady trickle of individual warnings and no signal at all.
   */
  operationalMetrics?: OperationalMetrics
}

export class WebhookNotificationChannel implements NotificationChannel {
  constructor(private readonly deps: WebhookNotificationChannelDependencies) {}

  async deliver(workspaceId: string, notification: Notification): Promise<void> {
    try {
      await this.post(workspaceId, notification)
    } catch (error) {
      // Best-effort: never let a receiver outage/misconfig break the notification lifecycle
      // (CompositeNotificationChannel also isolates us, belt-and-braces). Surface it through the
      // optional observability hook so the failure is diagnosable instead of silently dropped.
      this.deps.onError?.(error, {
        workspaceId,
        notificationId: notification.id,
        type: notification.type,
      })
      // The notification TYPE is a bounded enum, so it is safe as a dimension and is the one
      // split worth having: an endpoint that only fails on a particular card is a receiver
      // bug, where a flat failure across types is an outage.
      this.deps.operationalMetrics?.increment('notification.delivery_failed', {
        channel: 'webhook',
        type: notification.type,
      })
    }
  }

  private async post(workspaceId: string, notification: Notification): Promise<void> {
    const webhook = await this.deps.notificationWebhookRepository.get(workspaceId)
    if (!webhook || !webhook.enabled) return
    if (!deliversType(webhook, notification.type)) return

    const body: NotificationWebhookDelivery = {
      // Stable per notification-and-status: a retried attempt repeats it, so a receiver dedupes on
      // it. The status suffix keeps the delivery of a RESOLVED card (channels are re-delivered on
      // resolve) distinct from the original open one, which is a genuinely different event.
      deliveryId: `${notification.id}-${notification.status}`,
      sentAt: this.deps.clock.now(),
      workspaceId,
      runId: notification.executionId,
      taskId: notification.blockId,
      notification,
    }
    await postSignedWebhook(this.deps, {
      url: webhook.url,
      secretSealed: webhook.secretSealed,
      payload: JSON.stringify(body),
      sentAt: body.sentAt,
    })
  }
}

/**
 * Whether a webhook delivers this notification type. An EMPTY filter means the defaults (the
 * parking + actionable-tail types), NOT everything — registering an endpoint should not silently
 * fire-hose every operator card at an integration that only wanted to hear about parked decisions.
 */
function deliversType(webhook: NotificationWebhookRecord, type: NotificationType): boolean {
  const types: readonly NotificationType[] = webhook.types.length
    ? webhook.types
    : DEFAULT_NOTIFICATION_WEBHOOK_TYPES
  return types.includes(type)
}

export { WEBHOOK_SIGNATURE_HEADERS }
