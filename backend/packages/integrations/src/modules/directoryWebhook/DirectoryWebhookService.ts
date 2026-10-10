import {
  type DirectoryWebhook,
  type DirectoryWebhookDelivery,
  directoryWebhookIdSchema,
  MAX_DIRECTORY_WEBHOOKS_PER_ACCOUNT,
  type PutDirectoryWebhookInput,
} from '@cat-factory/contracts'
import {
  type Clock,
  ConflictError,
  type DirectoryFeedReader,
  type DirectoryWebhookRecord,
  type DirectoryWebhookRepository,
  DomainError,
  type Logger,
  noopLogger,
  type OperationalMetrics,
  type SecretCipher,
  type UrlSafetyPolicy,
  ValidationError,
  describeError,
} from '@cat-factory/kernel'
import * as v from 'valibot'
import { fanOutSignedWebhook } from '../notificationWebhook/signedDelivery.js'
import { assertSafeNotificationWebhookUrl } from '../notificationWebhook/webhookUrl.js'

// Directory webhooks (docs/initiatives/directory-sync.md, slice 4): account-level endpoints that
// receive the directory change feed as signed pushes, so a mirror learns of a change within one
// sweep interval instead of on its next poll.
//
// Delivery is a SWEEP rather than an emission inside each write: the feed already orders every
// directory write across every writer, so one reader of it replaces instrumenting a dozen services.
// Each endpoint keeps the feed position it was delivered through and a lease a sweeper takes
// BEFORE a push. The position moves only after the push succeeds, so concurrent sweepers never send
// overlapping pages, pages arrive in feed order, a failed page is sent again, and a page whose
// sweeper died is sent again once its lease expires (at-least-once; a receiver dedupes on
// `deliveryId`). The feed is
// still what guarantees completeness: a receiver that lost a push catches up by polling.

/** HKDF info tag for sealing endpoint signing secrets; distinct from every other sealed secret. */
export const DIRECTORY_WEBHOOK_CIPHER_INFO = 'cat-factory:directory-webhook'

/** Changes per push, the feed's own page ceiling. */
const PUSH_PAGE_SIZE = 100
/** Pushes per endpoint per sweep, so one endpoint far behind cannot starve the others. */
const MAX_PUSHES_PER_SWEEP = 5
/** Endpoints delivered to at once. */
const SWEEP_CONCURRENCY = 4
/**
 * How long a sweeper holds an endpoint's lease for one push: a feed read plus a signed POST whose
 * budget is a few seconds, with ample margin. A sweeper that dies mid-push blocks the endpoint for
 * at most this long, after which the page is offered again.
 */
const LEASE_MS = 60_000

export interface DirectoryWebhookServiceDependencies {
  repository: DirectoryWebhookRepository
  feed: DirectoryFeedReader
  secretCipher: SecretCipher
  clock: Clock
  urlSafetyPolicy?: UrlSafetyPolicy
  fetchImpl?: typeof fetch
  logger?: Logger
  operationalMetrics?: OperationalMetrics
}

export interface DirectoryWebhookSweepResult {
  pushed: number
  failed: number
}

export class DirectoryWebhookService {
  private readonly logger: Logger

  constructor(private readonly deps: DirectoryWebhookServiceDependencies) {
    this.logger = deps.logger ?? noopLogger
  }

  async list(accountId: string): Promise<DirectoryWebhook[]> {
    return (await this.deps.repository.list(accountId)).map(toWire)
  }

  /**
   * Register or edit an endpoint. A new one starts at the feed's current head: it receives what
   * changes from now on, and its receiver bootstraps the past from the snapshots.
   */
  async put(
    accountId: string,
    id: string,
    input: PutDirectoryWebhookInput,
  ): Promise<DirectoryWebhook> {
    assertValidWebhookId(id)
    const existing = await this.deps.repository.get(accountId, id)
    const url = input.url ?? existing?.url
    if (!url) {
      throw new ValidationError('A new directory webhook needs a `url`', {
        reason: 'webhook_url_required',
      })
    }
    // Guarded on a SUPPLIED url only, as the notification webhooks are: a stored url was vouched for
    // when it was set, and re-checking it would let a narrowed allow-list block the disable or
    // secret rotation an operator makes in response. Delivery re-applies the guard on every push.
    if (input.url !== undefined)
      assertSafeNotificationWebhookUrl(input.url, this.deps.urlSafetyPolicy)
    const record: DirectoryWebhookRecord = {
      accountId,
      id,
      url,
      enabled: input.enabled ?? existing?.enabled ?? true,
      secretSealed:
        input.secret === undefined
          ? (existing?.secretSealed ?? null)
          : await this.deps.secretCipher.encrypt(input.secret),
      deliveredSeq: existing?.deliveredSeq ?? (await this.deps.feed.headSeq(accountId)),
      updatedAt: this.deps.clock.now(),
    }
    const outcome = await this.deps.repository.put(record, MAX_DIRECTORY_WEBHOOKS_PER_ACCOUNT)
    if (outcome === 'limit_reached') {
      throw new ConflictError(
        `An account may register at most ${MAX_DIRECTORY_WEBHOOKS_PER_ACCOUNT} directory webhooks; remove one first`,
        'webhook_limit_reached',
        { limit: MAX_DIRECTORY_WEBHOOKS_PER_ACCOUNT },
      )
    }
    return toWire((await this.deps.repository.get(accountId, id)) ?? record)
  }

  async delete(accountId: string, id: string): Promise<void> {
    await this.deps.repository.delete(accountId, id)
  }

  /** Push whatever each enabled endpoint has not been sent yet. Never throws. */
  async deliverPending(): Promise<DirectoryWebhookSweepResult> {
    const result: DirectoryWebhookSweepResult = { pushed: 0, failed: 0 }
    let due: { endpoint: DirectoryWebhookRecord; head: number }[]
    try {
      const endpoints = await this.deps.repository.listEnabled()
      const heads = await this.deps.feed.headSeqs([...new Set(endpoints.map((e) => e.accountId))])
      // The listed position is a hint that saves a lease write for an endpoint already at the head;
      // the position actually delivered after is the one `claim` returns.
      due = endpoints
        .map((endpoint) => ({ endpoint, head: heads.get(endpoint.accountId) ?? 0 }))
        .filter(({ endpoint, head }) => head > endpoint.deliveredSeq)
    } catch (error) {
      this.logger.warn('directory webhook sweep could not list endpoints', describeError(error))
      return result
    }
    let next = 0
    const worker = async (): Promise<void> => {
      for (;;) {
        const item = due[next]
        next += 1
        if (!item) return
        await this.deliverTo(item.endpoint, item.head, result)
      }
    }
    await Promise.all(Array.from({ length: Math.min(SWEEP_CONCURRENCY, due.length) }, worker))
    return result
  }

  private async deliverTo(
    endpoint: DirectoryWebhookRecord,
    head: number,
    result: DirectoryWebhookSweepResult,
  ): Promise<void> {
    let knownHead = head
    for (let pushes = 0; pushes < MAX_PUSHES_PER_SWEEP; pushes++) {
      try {
        const pushed = await this.pushOnce(endpoint, knownHead)
        if (pushed === null) return
        result.pushed += 1
        if (!pushed.more) return
        knownHead = pushed.headSeq
      } catch (error) {
        result.failed += 1
        this.logger.warn('directory webhook delivery failed', {
          accountId: endpoint.accountId,
          webhookId: endpoint.id,
          ...describeError(error),
        })
        // The channel is the only dimension: account and webhook ids are unbounded.
        this.deps.operationalMetrics?.increment('notification.delivery_failed', {
          channel: 'directory_webhook',
        })
        return
      }
    }
  }

  /**
   * One push under the endpoint's lease. Returns whether the feed holds more after the page, or
   * null when another sweeper holds the lease or there was nothing to send. Throws after dropping
   * the lease when the push fails, leaving the position where it was, so the same page is offered
   * again next sweep.
   */
  private async pushOnce(
    endpoint: DirectoryWebhookRecord,
    head: number,
  ): Promise<{ more: boolean; headSeq: number } | null> {
    const { accountId, id } = endpoint
    const token = globalThis.crypto.randomUUID()
    const now = this.deps.clock.now()
    const from = await this.deps.repository.claim(accountId, id, token, now, now + LEASE_MS)
    if (from === null) return null
    if (from >= head) {
      await this.release(endpoint, token)
      return null
    }
    let to = head
    let more = false
    let headSeq = head
    try {
      let delivery: DirectoryWebhookDelivery
      try {
        const page = await this.deps.feed.changes(
          { accountId, workspaceIds: null },
          from,
          PUSH_PAGE_SIZE,
        )
        to = page.nextAfter
        more = page.nextAfter < page.headSeq
        headSeq = page.headSeq
        delivery = {
          deliveryId: `${id}:${from}-${to}`,
          sentAt: this.deps.clock.now(),
          accountId,
          event: 'directory.changed',
          changes: page.changes,
          nextAfter: page.nextAfter,
          headSeq: page.headSeq,
        }
      } catch (error) {
        if (!isCursorExpired(error)) throw error
        // The endpoint fell further behind than the feed keeps. Resume from the head and say so,
        // rather than pushing a page that silently starts after a gap.
        delivery = {
          deliveryId: `${id}:${from}-${to}:resync`,
          sentAt: this.deps.clock.now(),
          accountId,
          event: 'directory.resync_required',
          headSeq: head,
        }
      }
      await this.post(endpoint, delivery)
    } catch (error) {
      await this.release(endpoint, token)
      throw error
    }
    if (!(await this.deps.repository.complete(accountId, id, token, to))) {
      // The push outlived its lease and another sweeper took over, so that sweeper sends this page
      // again: a duplicate the receiver drops on `deliveryId`.
      this.logger.warn('directory webhook lease expired during a push', {
        accountId,
        webhookId: id,
        from,
        to,
      })
      return null
    }
    return { more, headSeq }
  }

  /**
   * Drop the lease after a failed push. A release that throws leaves the lease to expire, after
   * which the page is offered again; it is logged and never replaces the push's own error.
   */
  private async release(endpoint: DirectoryWebhookRecord, token: string): Promise<void> {
    try {
      await this.deps.repository.release(endpoint.accountId, endpoint.id, token)
    } catch (error) {
      this.logger.warn('directory webhook lease release failed; it expires on its own', {
        accountId: endpoint.accountId,
        webhookId: endpoint.id,
        ...describeError(error),
      })
    }
  }

  private async post(
    endpoint: DirectoryWebhookRecord,
    delivery: DirectoryWebhookDelivery,
  ): Promise<void> {
    let failure: unknown = null
    await fanOutSignedWebhook(
      {
        secretCipher: this.deps.secretCipher,
        clock: this.deps.clock,
        ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
        ...(this.deps.urlSafetyPolicy ? { urlSafetyPolicy: this.deps.urlSafetyPolicy } : {}),
      },
      [{ id: endpoint.id, url: endpoint.url, secretSealed: endpoint.secretSealed }],
      { payload: JSON.stringify(delivery), sentAt: delivery.sentAt },
      (error) => {
        failure = error
      },
    )
    if (failure !== null) throw failure
  }
}

/** Refuse an id that is not a lowercase slug, derived from the contract's own schema. */
function assertValidWebhookId(id: string): void {
  const parsed = v.safeParse(directoryWebhookIdSchema, id)
  if (!parsed.success) {
    throw new ValidationError(parsed.issues[0]?.message ?? 'Invalid webhook id', {
      reason: 'invalid_webhook_id',
    })
  }
}

function isCursorExpired(error: unknown): boolean {
  return (
    error instanceof DomainError &&
    (error.details as { reason?: unknown } | undefined)?.reason === 'cursor_expired'
  )
}

function toWire(record: DirectoryWebhookRecord): DirectoryWebhook {
  return {
    id: record.id,
    url: record.url,
    enabled: record.enabled,
    hasSecret: record.secretSealed !== null,
    deliveredSeq: record.deliveredSeq,
    updatedAt: record.updatedAt,
  }
}
