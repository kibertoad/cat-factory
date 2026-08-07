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
import { fanOutSignedWebhook } from './signedDelivery.js'
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
// `backend/docs/adr/0047-headless-clarification-loop.md`, D3).
//
// The retry/SSRF/signing machinery lives in `signedDelivery.ts`, shared with the two sinks that
// POST to the SAME registered endpoints — those are properties of the endpoint, not of the
// payload. A workspace can register several, so a card fans out to every endpoint whose `types`
// filter admits it, isolated per endpoint.
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
    context: { workspaceId: string; notificationId: string; type: string; webhookId?: string },
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
      //
      // With the fan-out below reporting each endpoint's own failure, what reaches HERE is the
      // read or the compose failing — a fault of the workspace's configuration rather than of any
      // one receiver, which is why this report names no `webhookId`.
      this.reportFailure(error, workspaceId, notification)
    }
  }

  private async post(workspaceId: string, notification: Notification): Promise<void> {
    const endpoints = (await this.deps.notificationWebhookRepository.list(workspaceId)).filter(
      (webhook) => webhook.enabled && deliversType(webhook, notification.type),
    )
    if (endpoints.length === 0) return

    const body: NotificationWebhookDelivery = {
      // Stable per notification-and-status: a retried attempt repeats it, so a receiver dedupes on
      // it. The status suffix keeps the delivery of a RESOLVED card (channels are re-delivered on
      // resolve) distinct from the original open one, which is a genuinely different event.
      //
      // Deliberately NOT scoped by endpoint: each receiver only ever sees its own copy, so an
      // endpoint segment would put a value in the dedupe key that no receiver can act on, and
      // would break the one case where two subscriptions DO collapse correctly (the same URL
      // registered twice, which should deliver one card once).
      deliveryId: `${notification.id}-${notification.status}`,
      sentAt: this.deps.clock.now(),
      workspaceId,
      runId: notification.executionId,
      taskId: notification.blockId,
      notification,
    }
    await fanOutSignedWebhook(
      this.deps,
      endpoints,
      { payload: JSON.stringify(body), sentAt: body.sentAt },
      (error, target) => this.reportFailure(error, workspaceId, notification, target.id),
    )
  }

  private reportFailure(
    error: unknown,
    workspaceId: string,
    notification: Notification,
    webhookId?: string,
  ): void {
    this.deps.onError?.(error, {
      workspaceId,
      notificationId: notification.id,
      type: notification.type,
      ...(webhookId === undefined ? {} : { webhookId }),
    })
    // The notification TYPE is a bounded enum, so it is safe as a dimension and is the one
    // split worth having: an endpoint that only fails on a particular card is a receiver
    // bug, where a flat failure across types is an outage. The webhook ID is deliberately NOT a
    // dimension: it is operator-chosen, so every workspace's naming would mint its own series.
    this.deps.operationalMetrics?.increment('notification.delivery_failed', {
      channel: 'webhook',
      type: notification.type,
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
