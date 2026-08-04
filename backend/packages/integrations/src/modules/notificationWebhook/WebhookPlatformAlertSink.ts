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
          ...(condition.kind === undefined ? {} : { kind: condition.kind }),
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
 * `<cardId>:<event>:<transition>[:<reasons>]`: the receiver's dedupe key, identifying exactly
 * one TRANSITION.
 *
 * The two ids compose because each survives a case the other collapses. The CARD id is the
 * platform's record of the open alert, reused while an incident lasts and minted afresh for the
 * next, so it keeps two separate incidents that trip the same condition apart. The TRANSITION
 * ordinal counts the edges within one incident, which is what the alternatives get wrong: the
 * reason set RECURS ({A} escalating to {A,B} and subsiding to {A} is three transitions over two
 * sets, so a receiver would drop the page saying it had subsided), while a TIMESTAMP over-
 * separates, because sweepers are only guarded against overlap within one process and two nodes
 * observing one transition would page twice. The ordinal is derived from the card both of them
 * read, so it is identical for a genuine duplicate and distinct for a genuine transition.
 *
 * The REASON SET is then redundant for uniqueness and kept anyway: it is what makes the key
 * legible in a receiver's own logs. A kind-scoped condition is written `reason=kind` there, since
 * three per-kind rules firing would otherwise repeat one code three times and name none of the
 * kinds — which is the whole content of that segment. The resolved edge carries no conditions and
 * drops the segment entirely.
 *
 * What the key must NOT separate is the retries of one delivery, and it cannot: those re-POST an
 * already-composed body, so every part here is fixed for the whole retry budget.
 */
function deliveryIdFor(event: PlatformAlertEvent): string {
  const base = `${event.cardId}:${event.event}:${event.transition}`
  const reasons = event.conditions
    .map((condition) =>
      condition.kind ? `${condition.reason}=${condition.kind}` : condition.reason,
    )
    .join(',')
  return reasons ? `${base}:${reasons}` : base
}
