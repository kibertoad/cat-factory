import type {
  Clock,
  NotificationWebhookRepository,
  SecretCipher,
  UrlSafetyPolicy,
} from '@cat-factory/kernel'
import { NotificationWebhookService } from './NotificationWebhookService.js'
import { WebhookNotificationChannel } from './WebhookNotificationChannel.js'
import { WebhookRunLifecycleSink } from './WebhookRunLifecycleSink.js'

/**
 * HKDF `info` tag the notification-webhook signing secret is sealed under, so it is
 * cryptographically isolated from every other sealed credential class (Slack tokens, tracker
 * credentials, package-registry auth) even though they share the deployment master key.
 */
export const NOTIFICATION_WEBHOOK_CIPHER_INFO = 'cat-factory:notification-webhook'

export interface NotificationWebhookSupportDependencies {
  notificationWebhookRepository: NotificationWebhookRepository
  secretCipher: SecretCipher
  clock: Clock
  /**
   * The deployment's widened endpoint guard (its own `NOTIFICATION_WEBHOOK_ALLOW_*` slice), or
   * absent for the strict public-https default. Handed to BOTH halves from here, so the rule that
   * admits an endpoint at registration is by construction the rule the delivery path enforces.
   */
  urlSafetyPolicy?: UrlSafetyPolicy
  fetchImpl?: typeof fetch
  /** Structured-logger hook for a delivery that ultimately failed (best-effort ≠ invisible). */
  onError?: (
    error: unknown,
    context: { workspaceId: string; notificationId: string; type: string },
  ) => void
  /** The same hook for a RUN-LIFECYCLE delivery, whose context names a run rather than a card. */
  onRunEventError?: (
    error: unknown,
    context: { workspaceId: string; runId: string; event: string },
  ) => void
}

/**
 * Build EVERY part of the outbound-webhook feature from one dependency set: the management
 * service (behind the workspace controller), the notification delivery channel (composed into the
 * facade's `CompositeNotificationChannel`) and the run-lifecycle sink (handed to the engine).
 *
 * They exist as one builder because they MUST read the same rows through the same cipher —
 * a facade that wired the service against one repository and the channel against another would
 * present a webhook as configured while delivering nothing, and each facade wiring them
 * separately is exactly how that drift happens. Adding the sink HERE rather than beside each
 * facade's engine wiring is the same rule one layer on: a facade that forgot it would leave run
 * events silently undelivered on that runtime alone, with nothing failing. Both runtimes call
 * this with their own repo.
 */
export function buildNotificationWebhookSupport(deps: NotificationWebhookSupportDependencies): {
  service: NotificationWebhookService
  channel: WebhookNotificationChannel
  runLifecycleSink: WebhookRunLifecycleSink
} {
  return {
    runLifecycleSink: new WebhookRunLifecycleSink({
      notificationWebhookRepository: deps.notificationWebhookRepository,
      secretCipher: deps.secretCipher,
      clock: deps.clock,
      urlSafetyPolicy: deps.urlSafetyPolicy,
      fetchImpl: deps.fetchImpl,
      onError: deps.onRunEventError,
    }),
    service: new NotificationWebhookService({
      notificationWebhookRepository: deps.notificationWebhookRepository,
      secretCipher: deps.secretCipher,
      clock: deps.clock,
      urlSafetyPolicy: deps.urlSafetyPolicy,
    }),
    channel: new WebhookNotificationChannel({
      notificationWebhookRepository: deps.notificationWebhookRepository,
      secretCipher: deps.secretCipher,
      clock: deps.clock,
      urlSafetyPolicy: deps.urlSafetyPolicy,
      fetchImpl: deps.fetchImpl,
      onError: deps.onError,
    }),
  }
}
