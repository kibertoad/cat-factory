import type { RunWebhookDelivery } from '@cat-factory/contracts'
import type {
  Clock,
  NotificationWebhookRepository,
  RunLifecycleEvent,
  RunLifecycleSink,
  SecretCipher,
  UrlSafetyPolicy,
} from '@cat-factory/kernel'
import { fanOutSignedWebhook } from './signedDelivery.js'

// WebhookRunLifecycleSink: the run-lifecycle family of the workspace's registered outbound
// endpoints. Where `WebhookNotificationChannel` pushes the cards a human must resolve, this pushes
// the lifecycle of the work itself — started / completed / failed — which raises no notification
// at all on the happy path (a pipeline with a `merger` merges its own PR and settles with an empty
// inbox). Without it a headless caller's only way to learn its task finished is to keep polling.
//
// One secret, one SSRF guard and one retry budget PER ENDPOINT: an operator registers a receiver
// once and chooses which families it hears, rather than configuring two near-identical webhooks
// per integration. The three bodies are told apart by shape as well as by name — a lifecycle
// delivery carries `event` + `run`, a notification delivery carries `notification`.
//
// A workspace can register several endpoints, so a transition fans out to every one subscribed to
// this family, isolated per endpoint (see `fanOutSignedWebhook`).
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
  onError?: (
    error: unknown,
    context: { workspaceId: string; runId: string; event: string; webhookId?: string },
  ) => void
}

export class WebhookRunLifecycleSink implements RunLifecycleSink {
  constructor(private readonly deps: WebhookRunLifecycleSinkDependencies) {}

  async runTransitioned(workspaceId: string, event: RunLifecycleEvent): Promise<void> {
    try {
      await this.post(workspaceId, event)
    } catch (error) {
      // A per-endpoint failure is reported by the fan-out with the endpoint named; what reaches
      // here is the read or the compose failing, which belongs to no one receiver.
      this.deps.onError?.(error, {
        workspaceId,
        runId: event.runId,
        event: event.event,
      })
    }
  }

  private async post(workspaceId: string, event: RunLifecycleEvent): Promise<void> {
    const endpoints = (await this.deps.notificationWebhookRepository.list(workspaceId)).filter(
      // EMPTY means NONE here, unlike the notification `types` filter next door: an endpoint
      // registered before run events existed must not silently start receiving a new event family.
      (webhook) => webhook.enabled && webhook.runEvents.includes(event.event),
    )
    if (endpoints.length === 0) return

    const body: RunWebhookDelivery = {
      // `<runId>:<event>` — stable across retries AND across a re-delivery, so it is the dedupe
      // key a receiver uses. Delivery is at-least-once by design (see the contract doc), and the
      // key has to carry that job alone: `sentAt` below and the projection's `occurredAt` are
      // re-stamped on a replay, so a receiver hashing the BODY would not collapse the repeat.
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
    await fanOutSignedWebhook(
      this.deps,
      endpoints,
      { payload: JSON.stringify(body), sentAt: body.sentAt },
      (error, target) =>
        this.deps.onError?.(error, {
          workspaceId,
          runId: event.runId,
          event: event.event,
          webhookId: target.id,
        }),
    )
  }
}
