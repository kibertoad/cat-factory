import {
  type DirectoryWebhook,
  type DirectoryWebhookDelivery,
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
  type SecretCipher,
  type UrlSafetyPolicy,
  ValidationError,
  describeError,
} from '@cat-factory/kernel'
import { fanOutSignedWebhook } from '../notificationWebhook/signedDelivery.js'
import { assertSafeNotificationWebhookUrl } from '../notificationWebhook/webhookUrl.js'

// Directory webhooks (docs/initiatives/directory-sync.md, slice 4): account-level endpoints that
// receive the directory change feed as signed pushes, so a mirror learns of a change within one
// sweep interval instead of on its next poll.
//
// Delivery is a SWEEP rather than an emission inside each write: the feed already orders every
// directory write across every writer, so one reader of it replaces instrumenting a dozen services.
// Each endpoint keeps the feed position it was delivered through, claimed by compare-and-swap
// BEFORE a push and released after a failed one, so concurrent sweepers never send the same page
// and a failed page is sent again (at-least-once; a receiver dedupes on `deliveryId`). The feed is
// still what guarantees completeness: a receiver that lost a push catches up by polling.

/** HKDF info tag for sealing endpoint signing secrets; distinct from every other sealed secret. */
export const DIRECTORY_WEBHOOK_CIPHER_INFO = 'cat-factory:directory-webhook'

/** Changes per push, the feed's own page ceiling. */
const PUSH_PAGE_SIZE = 100
/** Pushes per endpoint per sweep, so one endpoint far behind cannot starve the others. */
const MAX_PUSHES_PER_SWEEP = 5
/** Endpoints delivered to at once. */
const SWEEP_CONCURRENCY = 4

export interface DirectoryWebhookServiceDependencies {
  repository: DirectoryWebhookRepository
  feed: DirectoryFeedReader
  secretCipher: SecretCipher
  clock: Clock
  urlSafetyPolicy?: UrlSafetyPolicy
  fetchImpl?: typeof fetch
  logger?: Logger
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
    const existing = await this.deps.repository.get(accountId, id)
    const url = input.url ?? existing?.url
    if (!url) {
      throw new ValidationError('A new directory webhook needs a `url`', {
        reason: 'webhook_url_required',
      })
    }
    assertSafeNotificationWebhookUrl(url, this.deps.urlSafetyPolicy)
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
    let endpoints: DirectoryWebhookRecord[]
    try {
      endpoints = await this.deps.repository.listEnabled()
    } catch (error) {
      this.logger.warn('directory webhook sweep could not list endpoints', describeError(error))
      return result
    }
    let next = 0
    const worker = async (): Promise<void> => {
      for (;;) {
        const endpoint = endpoints[next]
        next += 1
        if (!endpoint) return
        await this.deliverTo(endpoint, result)
      }
    }
    await Promise.all(Array.from({ length: Math.min(SWEEP_CONCURRENCY, endpoints.length) }, worker))
    return result
  }

  private async deliverTo(
    endpoint: DirectoryWebhookRecord,
    result: DirectoryWebhookSweepResult,
  ): Promise<void> {
    let from = endpoint.deliveredSeq
    for (let pushes = 0; pushes < MAX_PUSHES_PER_SWEEP; pushes++) {
      try {
        const pushed = await this.pushOnce(endpoint, from)
        if (pushed === null) return
        result.pushed += 1
        from = pushed
      } catch (error) {
        result.failed += 1
        this.logger.warn('directory webhook delivery failed', {
          accountId: endpoint.accountId,
          webhookId: endpoint.id,
          ...describeError(error),
        })
        return
      }
    }
  }

  /**
   * One claimed push starting after `from`. Returns the new position, or null when there was
   * nothing to send or another sweeper holds the claim. Throws after releasing the claim when the
   * push fails, so the same page is offered again next sweep.
   */
  private async pushOnce(endpoint: DirectoryWebhookRecord, from: number): Promise<number | null> {
    const { accountId, id } = endpoint
    const head = await this.deps.feed.headSeq(accountId)
    if (head <= from) return null
    let delivery: DirectoryWebhookDelivery
    let to: number
    try {
      const page = await this.deps.feed.changes(
        { accountId, workspaceIds: null },
        from,
        PUSH_PAGE_SIZE,
      )
      to = page.nextAfter
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
      to = head
      delivery = {
        deliveryId: `${id}:${from}-${to}:resync`,
        sentAt: this.deps.clock.now(),
        accountId,
        event: 'directory.resync_required',
        headSeq: head,
      }
    }
    if (!(await this.deps.repository.advance(accountId, id, from, to))) return null
    try {
      await this.post(endpoint, delivery)
    } catch (error) {
      await this.deps.repository.advance(accountId, id, to, from)
      throw error
    }
    return to
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
