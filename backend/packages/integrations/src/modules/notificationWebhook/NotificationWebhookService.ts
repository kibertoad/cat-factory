import type { NotificationWebhook, PutNotificationWebhookInput } from '@cat-factory/contracts'
import type {
  Clock,
  NotificationWebhookRecord,
  NotificationWebhookRepository,
  SecretCipher,
  UrlSafetyPolicy,
} from '@cat-factory/kernel'
import { ValidationError } from '@cat-factory/kernel'
import { assertSafeNotificationWebhookUrl } from './webhookUrl.js'

// NotificationWebhookService: the management side of the outbound notification webhook — register
// / read / remove the one endpoint a workspace delivers its notifications to. The DELIVERY side is
// `WebhookNotificationChannel`, which reads the same row.
//
// `put` is keep-on-omit in EVERY field, including the url: a body states what changes, and what it
// leaves out is left alone. That is what lets an integration subscribe to a new event family
// without restating configuration it never meant to touch, which is also the failure it prevents.
// Editing the type filter must not silently drop signing (that looks like it still works, right up
// until a receiver starts rejecting unsigned deliveries), and adding a subscription must not
// re-assert a url the caller cached before someone else rotated the endpoint.
//
// The signing secret is the only field with more to it. It is sealed with the deployment
// `SecretCipher` on write and NEVER read back: the projection reports `hasSecret`, so an operator
// can tell that one is configured without the API ever becoming a way to exfiltrate it.

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
    //
    // Guarded on the SUPPLIED url only, and before the read, so a bad endpoint is refused without
    // touching the store. A url the body omits is not input entering the system, it is a value
    // this service already vouched for; re-running the guard over it would let a later NARROWING
    // of the deployment's allow-list block the unrelated edits (unsubscribing, disabling) an
    // operator makes to react to exactly that. Deliveries to a now-forbidden endpoint stop
    // regardless, because the delivery path re-applies the guard per hop.
    if (input.url !== undefined) {
      assertSafeNotificationWebhookUrl(input.url, this.deps.urlSafetyPolicy)
    }
    const existing = await this.deps.notificationWebhookRepository.get(workspaceId)
    // Keep-on-omit needs something to keep. Refusing here is what keeps the rule uniform across
    // every field without letting a body that names no endpoint store a half-registered row.
    const url = input.url ?? existing?.url
    if (url === undefined) {
      throw new ValidationError(
        'No webhook is registered for this workspace, so `url` is required to register one',
        { reason: 'webhook_url_required' },
      )
    }
    const record: NotificationWebhookRecord = {
      workspaceId,
      url,
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
