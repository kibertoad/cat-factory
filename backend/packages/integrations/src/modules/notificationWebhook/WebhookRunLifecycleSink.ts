import type { RunWebhookDelivery } from '@cat-factory/contracts'
import type {
  Clock,
  NotificationWebhookRepository,
  RunLifecycleEvent,
  RunLifecycleSink,
  SecretCipher,
  UrlSafetyPolicy,
} from '@cat-factory/kernel'
import { postSignedWebhook } from './signedDelivery.js'

// WebhookRunLifecycleSink: the run-lifecycle half of the workspace's ONE registered outbound
// endpoint. Where `WebhookNotificationChannel` pushes the cards a human must resolve, this pushes
// the lifecycle of the work itself — started / completed / failed — which raises no notification
// at all on the happy path (a pipeline with a `merger` merges its own PR and settles with an empty
// inbox). Without it a headless caller's only way to learn its task finished is to keep polling.
//
// One endpoint, one secret, one SSRF guard, one retry budget: an operator registers a receiver
// once and chooses which families it hears, rather than configuring two near-identical webhooks.
// The two bodies are told apart by shape as well as by name — a lifecycle delivery carries `event`
// + `run`, a notification delivery carries `notification`.
//
// Runtime-neutral (fetch + decrypt + one DB read), like its sibling, so it serves both facades.

export interface WebhookRunLifecycleSinkDependencies {
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
   * — a receiver outage must never fail the run it was registered to watch — but a swallowed
   * failure should still be diagnosable, so the facades wire this to their structured logger.
   */
  onError?: (error: unknown, context: { workspaceId: string; runId: string; event: string }) => void
}

export class WebhookRunLifecycleSink implements RunLifecycleSink {
  constructor(private readonly deps: WebhookRunLifecycleSinkDependencies) {}

  async runTransitioned(workspaceId: string, event: RunLifecycleEvent): Promise<void> {
    try {
      await this.post(workspaceId, event)
    } catch (error) {
      this.deps.onError?.(error, {
        workspaceId,
        runId: event.runId,
        event: event.event,
      })
    }
  }

  private async post(workspaceId: string, event: RunLifecycleEvent): Promise<void> {
    const webhook = await this.deps.notificationWebhookRepository.get(workspaceId)
    if (!webhook || !webhook.enabled) return
    // EMPTY means NONE here, unlike the notification `types` filter next door: an endpoint
    // registered before run events existed must not silently start receiving a new event family.
    if (!webhook.runEvents.includes(event.event)) return

    const body: RunWebhookDelivery = {
      // `<runId>:<event>` — stable across retries AND across a re-delivery, so it is the dedupe
      // key a receiver uses. Delivery is at-least-once by design (see the contract doc).
      deliveryId: `${event.runId}:${event.event}`,
      sentAt: this.deps.clock.now(),
      workspaceId,
      event: event.event,
      run: {
        runId: event.runId,
        taskId: event.taskId,
        taskTitle: event.taskTitle,
        pipelineId: event.pipelineId,
        pipelineName: event.pipelineName,
        startedAt: event.startedAt,
        occurredAt: event.occurredAt,
        pullRequestUrl: event.pullRequestUrl,
        failure: event.failure,
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
