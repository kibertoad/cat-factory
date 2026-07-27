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
  UrlSafetyPolicy,
} from '@cat-factory/kernel'
import { ValidationError } from '@cat-factory/kernel'
import { DEFAULT_MAX_REDIRECTS, safeFetch } from '../shared/safe-fetch.js'
import { assertSafeNotificationWebhookUrl } from './webhookUrl.js'
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

/**
 * The ceiling on ONE delivery across all of its attempts. This is the number that matters, and it
 * is not the per-attempt timeout multiplied out: `NotificationService.raise` AWAITS the channel
 * fan-out, so every millisecond spent here is latency added to the engine step that raises the
 * notification — the very step that parks a run. Three 5s attempts plus backoff would let a dead
 * receiver add ~15.8s to a park, which the in-app and Slack channels never do.
 *
 * So the retry budget is a WALL-CLOCK deadline, not an attempt count: attempts stop as soon as the
 * remaining budget is gone, and each attempt's own timeout is clamped to what is left. Delivery is
 * best-effort by contract, so a receiver too slow to answer inside the budget is treated exactly
 * like one that failed — logged through `onError`, never propagated.
 */
const TOTAL_DELIVERY_BUDGET_MS = 6000

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

    // The endpoint is operator-supplied, and the body we are about to POST carries the workspace's
    // work descriptions signed with a deployment secret. So the URL is re-validated on EVERY
    // redirect hop through the shared SSRF seam: `startsWith('https://')` at registration only ever
    // vouched for the FIRST url, and a receiver is free to 302 that to the cloud-metadata endpoint.
    // `safeFetch` also strips the body and credential headers on a cross-origin hop, so a permitted
    // host cannot bounce the delivery to a different one.
    const assertSafe = (u: string) => assertSafeNotificationWebhookUrl(u, this.deps.urlSafetyPolicy)

    const deadline = this.deps.clock.now() + TOTAL_DELIVERY_BUDGET_MS
    let lastError: unknown
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        // Only back off if there is budget left to use afterwards — sleeping into the deadline
        // would burn the caller's latency and then not even attempt the retry it paid for.
        const backoff = BASE_RETRY_MS * 2 ** (attempt - 1)
        if (this.deps.clock.now() + backoff >= deadline) break
        await this.sleep(backoff)
      }
      // Clamp this attempt to whatever is left, so the TOTAL is bounded rather than the per-attempt
      // timeout multiplied by the attempt count.
      const remaining = deadline - this.deps.clock.now()
      if (remaining <= 0) break
      try {
        const response = await safeFetch(
          webhook.url,
          {
            method: 'POST',
            headers,
            body: payload,
            signal: AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, remaining)),
          },
          assertSafe,
          makeWebhookError,
          DEFAULT_MAX_REDIRECTS,
          this.fetchImpl,
        )
        if (response.ok) return
        // A 4xx is the receiver saying "this request is wrong" — a bad secret, a rejected shape, a
        // revoked endpoint. Retrying cannot fix it and only multiplies the load, so give up now
        // and let the error hook report it. 5xx / network faults are transient: those retry.
        lastError = new Error(`Webhook endpoint responded ${response.status}`)
        if (response.status >= 400 && response.status < 500) break
      } catch (error) {
        // A blocked hop (`assertSafe` threw) is a CONFIGURATION fault, not a transient one:
        // retrying re-walks the same redirect chain to the same rejected target. Give up and let
        // the operator see it, exactly as with a 4xx.
        lastError = error
        if (error instanceof ValidationError) break
      }
    }
    throw lastError ?? new Error('Webhook delivery failed')
  }
}

/** Builds the redirect/size errors `safeFetch` raises, carrying its status for the log line. */
function makeWebhookError(status: number, message: string): Error {
  return new Error(`Webhook delivery failed (${status}): ${message}`)
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
