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
  SecretCipher,
} from '@cat-factory/kernel'
import { signWebhookDelivery, WEBHOOK_SIGNATURE_HEADERS } from './webhookSignature.js'

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
// Runtime-neutral (fetch + decrypt + one DB read), so it lives here in @cat-factory/integrations
// and serves BOTH runtime facades unchanged.

/** How many attempts one delivery gets, and how long to wait between them (exponential). */
const MAX_ATTEMPTS = 3
const BASE_RETRY_MS = 250

/** Give up on a single HTTP attempt after this long, so a black-holing endpoint can't hang us. */
const REQUEST_TIMEOUT_MS = 5000

export interface WebhookNotificationChannelDependencies {
  notificationWebhookRepository: NotificationWebhookRepository
  secretCipher: SecretCipher
  clock: Clock
  /** HTTP transport (each runtime exposes a global `fetch`); injectable for tests. */
  fetchImpl?: typeof fetch
  /** Sleep between retries; injectable so tests don't spend real wall-clock on backoff. */
  sleep?: (ms: number) => Promise<void>
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
}

export class WebhookNotificationChannel implements NotificationChannel {
  private readonly fetchImpl: typeof fetch
  private readonly sleep: (ms: number) => Promise<void>

  constructor(private readonly deps: WebhookNotificationChannelDependencies) {
    this.fetchImpl = deps.fetchImpl ?? ((...args) => globalThis.fetch(...args))
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

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
    const payload = JSON.stringify(body)
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'user-agent': 'cat-factory',
    }
    if (webhook.secretSealed) {
      const secret = await this.deps.secretCipher.decrypt(webhook.secretSealed)
      Object.assign(headers, await signWebhookDelivery(secret, payload, body.sentAt))
    }

    let lastError: unknown
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) await this.sleep(BASE_RETRY_MS * 2 ** (attempt - 1))
      try {
        const response = await this.fetchImpl(webhook.url, {
          method: 'POST',
          headers,
          body: payload,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
        if (response.ok) return
        // A 4xx is the receiver saying "this request is wrong" — a bad secret, a rejected shape, a
        // revoked endpoint. Retrying cannot fix it and only multiplies the load, so give up now
        // and let the error hook report it. 5xx / network faults are transient: those retry.
        lastError = new Error(`Webhook endpoint responded ${response.status}`)
        if (response.status >= 400 && response.status < 500) break
      } catch (error) {
        lastError = error
      }
    }
    throw lastError ?? new Error('Webhook delivery failed')
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
