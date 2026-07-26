import type { NotificationWebhook, PutNotificationWebhookInput } from '@cat-factory/contracts'
import type {
  Clock,
  NotificationWebhookRecord,
  NotificationWebhookRepository,
  SecretCipher,
} from '@cat-factory/kernel'

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
    const existing = await this.deps.notificationWebhookRepository.get(workspaceId)
    const record: NotificationWebhookRecord = {
      workspaceId,
      url: input.url,
      types: input.types ?? existing?.types ?? [],
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
    enabled: record.enabled,
    hasSecret: record.secretSealed != null,
    updatedAt: record.updatedAt,
  }
}
