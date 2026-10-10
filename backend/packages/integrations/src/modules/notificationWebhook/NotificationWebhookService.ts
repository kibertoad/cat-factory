import {
  MAX_NOTIFICATION_WEBHOOKS_PER_WORKSPACE,
  type NotificationWebhook,
  notificationWebhookIdSchema,
  type PutNotificationWebhookInput,
} from '@cat-factory/contracts'
import type {
  Clock,
  NotificationWebhookRecord,
  NotificationWebhookRepository,
  SecretCipher,
  UrlSafetyPolicy,
} from '@cat-factory/kernel'
import { ConflictError, ValidationError } from '@cat-factory/kernel'
import * as v from 'valibot'
import { assertSafeNotificationWebhookUrl } from './webhookUrl.js'

// NotificationWebhookService: the management side of the outbound notification webhooks — register
// / read / remove the endpoints a workspace delivers its notifications to. The DELIVERY side is
// `WebhookNotificationChannel` and the two sinks beside it, which read the same rows.
//
// Endpoints are addressed by a CALLER-CHOSEN id. The singular routes address the reserved
// `default` id, so the collection and the original one-endpoint surface are two views of one
// store rather than two stores to keep in step.
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

  /** One endpoint as exposed to clients, or null when nothing is registered under that id. */
  async get(workspaceId: string, id: string): Promise<NotificationWebhook | null> {
    const record = await this.deps.notificationWebhookRepository.get(workspaceId, id)
    return record ? toWire(record) : null
  }

  /** Every endpoint the workspace has registered, ordered by id. */
  async list(workspaceId: string): Promise<NotificationWebhook[]> {
    const records = await this.deps.notificationWebhookRepository.list(workspaceId)
    return records.map(toWire)
  }

  /** Register or update one endpoint. */
  async put(
    workspaceId: string,
    id: string,
    input: PutNotificationWebhookInput,
  ): Promise<NotificationWebhook> {
    // Validated HERE rather than in the path-param schema, so the two management surfaces and any
    // later caller share one rule and one machine-readable `reason`. A malformed id on a READ is
    // left alone: it simply matches nothing, and answering "no such endpoint" is both true and
    // the answer the caller was going to act on anyway.
    assertValidWebhookId(id)
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
    // Read for the keep-on-omit merge ONLY. The cap is not decided here: a count read now and
    // acted on a statement later binds nothing, because two enrolments racing each other would
    // both see room. `put` takes the limit and admits or refuses under it atomically, which is the
    // only place the two can be one step. This read can therefore be stale about the count without
    // costing anything, which it always could have been.
    const existing = await this.deps.notificationWebhookRepository.get(workspaceId, id)
    // Keep-on-omit needs something to keep. Refusing here is what keeps the rule uniform across
    // every field without letting a body that names no endpoint store a half-registered row.
    const url = input.url ?? existing?.url
    if (url === undefined) {
      throw new ValidationError(
        `No webhook is registered under \`${id}\` in this workspace, so \`url\` is required to register one`,
        { reason: 'webhook_url_required' },
      )
    }
    const record: NotificationWebhookRecord = {
      workspaceId,
      id,
      // A registration that names no label gets the id, which is the only value here that is
      // already meaningful to whoever chose it. Defaulting to the URL would put a receiver's
      // address in every operator-facing list, and defaulting to a blank renders as a gap.
      name: input.name ?? existing?.name ?? id,
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
    // The cap bounds only what CREATES an endpoint: replacing one that already exists is admitted
    // even on a workspace at (or, after a lowered cap, over) the limit, because disabling and
    // deleting are exactly the edits an operator makes to get back under it. The store decides
    // that under its own lock and reports which happened; this layer only chooses the status.
    const outcome = await this.deps.notificationWebhookRepository.put(
      record,
      MAX_NOTIFICATION_WEBHOOKS_PER_WORKSPACE,
    )
    if (outcome === 'limit_reached') {
      throw new ConflictError(
        `This workspace already has ${MAX_NOTIFICATION_WEBHOOKS_PER_WORKSPACE} notification webhooks registered`,
        'webhook_limit_reached',
        { limit: MAX_NOTIFICATION_WEBHOOKS_PER_WORKSPACE },
      )
    }
    return toWire(record)
  }

  /** Remove one endpoint. Idempotent, and never touches a sibling. */
  async remove(workspaceId: string, id: string): Promise<void> {
    await this.deps.notificationWebhookRepository.delete(workspaceId, id)
  }
}

/**
 * Refuse an id that is not a lowercase slug. The id is a path segment on both management surfaces
 * and an operator reads it beside the endpoint's URL, so the shape is part of the contract rather
 * than a storage detail. Derived from the contracts' own schema, so the rule the API documents and
 * the rule the service enforces cannot drift apart.
 */
function assertValidWebhookId(id: string): void {
  const parsed = v.safeParse(notificationWebhookIdSchema, id)
  if (!parsed.success) {
    throw new ValidationError(parsed.issues[0]?.message ?? 'Invalid webhook id', {
      reason: 'invalid_webhook_id',
    })
  }
}

/** Project the persisted record onto the wire shape — the sealed secret becomes a boolean. */
function toWire(record: NotificationWebhookRecord): NotificationWebhook {
  return {
    id: record.id,
    name: record.name,
    url: record.url,
    types: record.types,
    runEvents: record.runEvents,
    alertEvents: record.alertEvents,
    enabled: record.enabled,
    hasSecret: record.secretSealed != null,
    updatedAt: record.updatedAt,
  }
}
