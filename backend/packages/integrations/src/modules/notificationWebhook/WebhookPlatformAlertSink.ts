import type { PlatformAlertWebhookDelivery } from '@cat-factory/contracts'
import type {
  Clock,
  NotificationWebhookRepository,
  PlatformAlertEvent,
  PlatformAlertSink,
  SecretCipher,
  UrlSafetyPolicy,
} from '@cat-factory/kernel'
import { postSignedWebhook } from './signedDelivery.js'

// WebhookPlatformAlertSink: the PLATFORM-HEALTH half of the workspace's one registered outbound
// endpoint. Its two siblings deliver facts about the workspace's work — the cards a human must
// resolve, and the lifecycle of the runs an integration queued. This one delivers the deployment
// watching itself: the alert an on-call rotation is paged by.
//
// Why it is not simply the `platform_health` notification type on the channel next door, which
// can already be named in a webhook's `types` filter: a card is delivered on every content change
// AND re-delivered when it is acted on or dismissed, so a human tidying the in-app inbox reaches
// the receiver as `status: 'dismissed'` — byte-for-byte the same shape as the sweep dismissing
// that card because the deployment recovered. An on-call integration would close its incident
// because somebody cleared a badge. The edges here come from the SWEEP'S OWN VERDICT instead, so
// `platform_health.resolved` means the platform observed recovery and nothing else does.
//
// One endpoint, one secret, one SSRF guard, one retry budget: the delivery core is shared with
// both siblings because everything interesting about a delivery is a property of the ENDPOINT
// rather than of the payload. The three bodies are told apart by shape as well as by name — this
// one carries `event` + `alert`.
//
// Runtime-neutral (fetch + decrypt + one DB read), like its siblings, so it serves both facades.

export interface WebhookPlatformAlertSinkDependencies {
  notificationWebhookRepository: NotificationWebhookRepository
  secretCipher: SecretCipher
  clock: Clock
  /** HTTP transport (each runtime exposes a global `fetch`); injectable for tests. */
  fetchImpl?: typeof fetch
  /** Sleep between retries; injectable so tests don't spend real wall-clock on backoff. */
  sleep?: (ms: number) => Promise<void>
  /** The deployment's widened endpoint guard, when configured. Absent ⇒ strict public-https. */
  urlSafetyPolicy?: UrlSafetyPolicy
  /**
   * Optional observability hook invoked when a delivery ultimately fails. Delivery is best-effort
   * — a pager endpoint's outage must never stop the sweep that noticed the deployment was
   * unhealthy — but a swallowed failure here is the one that matters most: it means nobody was
   * told. The facades wire it to their structured logger.
   */
  onError?: (
    error: unknown,
    context: { workspaceId: string; accountId: string; event: string },
  ) => void
}

export class WebhookPlatformAlertSink implements PlatformAlertSink {
  constructor(private readonly deps: WebhookPlatformAlertSinkDependencies) {}

  async platformHealthChanged(workspaceId: string, event: PlatformAlertEvent): Promise<void> {
    try {
      await this.post(workspaceId, event)
    } catch (error) {
      this.deps.onError?.(error, {
        workspaceId,
        accountId: event.accountId,
        event: event.event,
      })
    }
  }

  private async post(workspaceId: string, event: PlatformAlertEvent): Promise<void> {
    const webhook = await this.deps.notificationWebhookRepository.get(workspaceId)
    if (!webhook || !webhook.enabled) return
    // EMPTY means NONE, like the run-lifecycle filter and unlike the notification `types` one: an
    // endpoint registered to hear about parked decisions must never start paging an on-call
    // rotation because the deployment shipped a new event family.
    if (!webhook.alertEvents.includes(event.event)) return

    const body: PlatformAlertWebhookDelivery = {
      deliveryId: deliveryIdFor(event),
      sentAt: this.deps.clock.now(),
      workspaceId,
      event: event.event,
      alert: {
        accountId: event.accountId,
        window: event.window,
        conditions: event.conditions.map((condition) => ({
          reason: condition.reason,
          value: condition.value,
          threshold: condition.threshold,
        })),
        occurredAt: event.occurredAt,
        failingRuns: event.failingRuns.map((run) => ({
          executionId: run.executionId,
          blockId: run.blockId,
          failureKind: run.failureKind,
          createdAt: run.createdAt,
        })),
        failedTotal: event.failedTotal,
      },
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
 * `<cardId>:<event>:<reasons>` — the receiver's dedupe key.
 *
 * It has two jobs that pull in opposite directions, which is why neither half alone would do.
 * The CARD id is the platform's record of the open alert: it is reused while an incident is open
 * and minted afresh for the next one, so it collapses the retries of one delivery without
 * collapsing two separate incidents that happen to trip the same condition. The REASON SET is
 * what changes within one incident (one condition escalating to two re-raises the same card), so
 * without it an escalation would land on the id of the alert it escalated from and a deduping
 * receiver would drop the page that says it got worse.
 *
 * The resolved edge carries no reasons, so the pair is already unique.
 */
function deliveryIdFor(event: PlatformAlertEvent): string {
  const reasons = event.conditions.map((condition) => condition.reason).join(',')
  return reasons ? `${event.cardId}:${event.event}:${reasons}` : `${event.cardId}:${event.event}`
}
