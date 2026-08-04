import type { NotificationWebhook, PutNotificationWebhookInput } from '@cat-factory/contracts'
import type {
  Clock,
  NotificationWebhookRecord,
  NotificationWebhookRepository,
  SecretCipher,
  UrlSafetyPolicy,
} from '@cat-factory/kernel'
import { assertSafeNotificationWebhookUrl } from './webhookUrl.js'

// NotificationWebhookService: the management side of the outbound notification webhook — register
// / read / remove the one endpoint a workspace delivers its notifications to. The DELIVERY side is
// `WebhookNotificationChannel`, which reads the same row.
//
// The signing secret is the only interesting part. It is sealed with the deployment `SecretCipher`
// on write and NEVER read back: the projection reports `hasSecret`, so an operator can tell that
// one is configured without the API ever becoming a way to exfiltrate it. A `put` that omits
// `secret` KEEPS the stored one, so editing the URL or the type filter doesn't silently drop
// signing (which would look like it still works, right up until a receiver starts rejecting
// unsigned deliveries).

export interface NotificationWebhookServiceDependencies {
  notificationWebhookRepository: NotificationWebhookRepository
  secretCipher: SecretCipher
  clock: Clock
  /**
   * The deployment's widened endpoint guard, when configured. Absent ⇒ strict public-https. The
   * SAME policy the delivery channel re-applies per redirect hop — they come from one builder for
   * exactly this reason, so an endpoint can never be accepted at write time by a rule the delivery
   * path would then reject (or, far worse, the reverse).
   */
  urlSafetyPolicy?: UrlSafetyPolicy
}

export class NotificationWebhookService {
  constructor(private readonly deps: NotificationWebhookServiceDependencies) {}

  /** The workspace's webhook as exposed to clients, or null when none is registered. */
  async get(workspaceId: string): Promise<NotificationWebhook | null> {
    const record = await this.deps.notificationWebhookRepository.get(workspaceId)
    return record ? toWire(record) : null
  }

  /** Register or update the workspace's webhook. */
  async put(workspaceId: string, input: PutNotificationWebhookInput): Promise<NotificationWebhook> {
    // Reject a private/internal/metadata endpoint HERE, where an operator sees the error, rather
    // than leaving it to fail per-delivery later. The wire schema's `https://` prefix check is the
    // friendly first pass; this is the guard that actually holds (and the same one the delivery
    // path re-runs on every redirect hop).
    assertSafeNotificationWebhookUrl(input.url, this.deps.urlSafetyPolicy)
    const existing = await this.deps.notificationWebhookRepository.get(workspaceId)
    const record: NotificationWebhookRecord = {
      workspaceId,
      url: input.url,
      types: input.types ?? existing?.types ?? [],
      // Omitted `runEvents` KEEPS the current subscription, like every other field here. The
      // default for a brand-new endpoint is NONE: an operator registering a receiver for parked
      // decisions must not silently start getting a lifecycle event per run.
      runEvents: input.runEvents ?? existing?.runEvents ?? [],
      // Same rule as `runEvents`, for the same reason plus a sharper one: this family pages an
      // on-call rotation, so it is never acquired by editing an unrelated field.
      alertEvents: input.alertEvents ?? existing?.alertEvents ?? [],
      enabled: input.enabled ?? existing?.enabled ?? true,
      // Omitted `secret` keeps the stored one; a supplied one rotates it.
      secretSealed: input.secret
        ? await this.deps.secretCipher.encrypt(input.secret)
        : (existing?.secretSealed ?? null),
      updatedAt: this.deps.clock.now(),
    }
    await this.deps.notificationWebhookRepository.put(record)
    return toWire(record)
  }

  /** Remove the workspace's webhook. Idempotent. */
  async remove(workspaceId: string): Promise<void> {
    await this.deps.notificationWebhookRepository.delete(workspaceId)
  }
}

/** Project the persisted record onto the wire shape — the sealed secret becomes a boolean. */
function toWire(record: NotificationWebhookRecord): NotificationWebhook {
  return {
    url: record.url,
    types: record.types,
    runEvents: record.runEvents,
    alertEvents: record.alertEvents,
    enabled: record.enabled,
    hasSecret: record.secretSealed != null,
    updatedAt: record.updatedAt,
  }
}
