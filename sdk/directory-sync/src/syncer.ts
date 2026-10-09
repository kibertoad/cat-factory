import {
  type CatFactoryClient,
  CatFactoryApiError,
  type DirectoryAccountMembership,
  type DirectoryRepo,
  type DirectoryUser,
  type DirectoryWebhookDelivery,
  type DirectoryWorkspace,
  type DirectoryWorkspaceMembership,
} from '@cat-factory/sdk'
import { verifyDelivery } from '@cat-factory/webhooks'
import {
  type DirectoryEntityType,
  type DirectoryRecord,
  type DirectoryStore,
  entityKey,
  recordOf,
} from './store.ts'

/** The part of a client the syncer calls. A `CatFactoryClient` built with your key satisfies it. */
export type DirectoryClient = Pick<CatFactoryClient, 'directory'>

export interface DirectorySyncerOptions {
  client: DirectoryClient
  store: DirectoryStore
  /** The signing secret registered with the directory webhook. Needed only to receive pushes. */
  webhookSecret?: string
  /** Changes per feed request and items per snapshot page (1 to 100). Default 100. */
  pageSize?: number
  /** The clock the push timestamp window is checked against. Default `Date.now`. */
  now?: () => number
}

export interface SyncResult {
  /** Records written to the store (an older record the store refused still counts). */
  applied: number
  /** The store's cursor after the call. */
  cursor: number
  /** Whether the call fell back to (or was) a full reconciliation. */
  reconciled: boolean
}

export type DeliveryResult =
  | { ok: true; event: DirectoryWebhookDelivery['event']; sync: SyncResult }
  | { ok: false; reason: string }

const SNAPSHOTS: readonly {
  entityType: DirectoryEntityType
  /** Reading it needs a key that reaches every workspace. */
  accountWide: boolean
}[] = [
  { entityType: 'workspace', accountWide: false },
  { entityType: 'user', accountWide: true },
  { entityType: 'account_membership', accountWide: true },
  { entityType: 'workspace_membership', accountWide: false },
  { entityType: 'repo', accountWide: false },
]

/**
 * Keeps a {@link DirectoryStore} in sync with a cat-factory account's directory.
 *
 * - `catchUp()` follows the change feed from the store's cursor; call it on a timer (every few
 *   minutes is plenty) and on startup. With no cursor yet, or one the feed no longer covers, it
 *   reconciles first.
 * - `reconcile()` walks every snapshot, writes what it finds, deletes what the store holds that
 *   the source no longer does, then follows the feed from the snapshot's position. Run it daily as
 *   a drift check, or whenever you suspect the store was edited behind the syncer's back.
 * - `handleDelivery()` / `handleRequest()` take a directory webhook push: verify, apply, then
 *   catch up, so a lost push costs nothing but the latency.
 *
 * Calls on one syncer never interleave: each waits for the previous one, so a push arriving during
 * a reconciliation is applied after it rather than racing it.
 */
export class DirectorySyncer {
  readonly #client: DirectoryClient
  readonly #store: DirectoryStore
  readonly #webhookSecret: string | undefined
  readonly #pageSize: number
  readonly #now: () => number
  #queue: Promise<unknown> = Promise.resolve()

  constructor(options: DirectorySyncerOptions) {
    this.#client = options.client
    this.#store = options.store
    this.#webhookSecret = options.webhookSecret
    this.#pageSize = options.pageSize ?? 100
    this.#now = options.now ?? Date.now
  }

  /** Follow the change feed from the store's cursor to the head. */
  catchUp(): Promise<SyncResult> {
    return this.#serial(() => this.#catchUp(0, false))
  }

  /** Rebuild the store from the snapshots, then follow the feed from where they were taken. */
  reconcile(): Promise<SyncResult> {
    return this.#serial(() => this.#reconcile())
  }

  /** Take one push given its headers and its RAW body text (verify before parsing). */
  handleDelivery(headers: Headers, rawBody: string): Promise<DeliveryResult> {
    return this.#serial(async (): Promise<DeliveryResult> => {
      if (this.#webhookSecret === undefined) {
        throw new Error('DirectorySyncer: pass `webhookSecret` to receive directory webhook pushes')
      }
      const verdict = await verifyDelivery(headers, rawBody, this.#webhookSecret, this.#now())
      if (!verdict.ok) return { ok: false, reason: verdict.reason }
      const delivery = JSON.parse(rawBody) as DirectoryWebhookDelivery
      if (delivery.event === 'directory.resync_required') {
        return { ok: true, event: delivery.event, sync: await this.#reconcile() }
      }
      let applied = 0
      for (const change of delivery.changes) {
        await this.#store.apply(recordOf(change))
        applied += 1
      }
      // The push is the fast path; the feed is the guarantee. Catching up from the stored cursor
      // advances it past what the push carried and fills whatever an earlier lost push skipped.
      const sync = await this.#catchUp(applied, false)
      return { ok: true, event: delivery.event, sync }
    })
  }

  /** {@link handleDelivery} over a Fetch API request, answered with the status to return. */
  async handleRequest(request: Request): Promise<Response> {
    const result = await this.handleDelivery(request.headers, await request.text())
    return result.ok
      ? new Response(null, { status: 204 })
      : new Response(result.reason, { status: 401 })
  }

  async #catchUp(alreadyApplied: number, reconciled: boolean): Promise<SyncResult> {
    let cursor = await this.#store.getCursor()
    if (cursor === null) return this.#reconcile(alreadyApplied)
    let applied = alreadyApplied
    for (;;) {
      let page
      try {
        page = await this.#client.directory.listChanges({ after: cursor, limit: this.#pageSize })
      } catch (error) {
        // Once: a reconciliation that is itself told its fresh cursor expired has a feed with a
        // retention shorter than one snapshot walk, which retrying cannot fix.
        if (isCursorExpired(error) && !reconciled) return this.#reconcile(applied)
        throw error
      }
      for (const change of page.changes) {
        await this.#store.apply(recordOf(change))
        applied += 1
      }
      cursor = page.nextAfter
      await this.#store.setCursor(cursor)
      if (cursor >= page.headSeq || page.changes.length === 0) {
        return { applied, cursor, reconciled }
      }
    }
  }

  async #reconcile(alreadyApplied = 0): Promise<SyncResult> {
    let applied = alreadyApplied
    let from: number | null = null
    for (const { entityType, accountWide } of SNAPSHOTS) {
      let walk
      try {
        walk = await this.#walk(entityType)
      } catch (error) {
        // A key limited to some workspaces cannot read the account-wide entities: it mirrors
        // what it can reach, and that is not an error.
        if (accountWide && isReason(error, 'account_scope_required')) continue
        throw error
      }
      for (const record of walk.records) {
        await this.#store.apply(record)
        applied += 1
      }
      for (const key of await this.#store.listKeys(entityType)) {
        if (walk.keys.has(key)) continue
        await this.#store.apply(tombstone(entityType, key, walk.asOfSeq))
        applied += 1
      }
      from = from === null ? walk.asOfSeq : Math.min(from, walk.asOfSeq)
    }
    // Replaying from the EARLIEST snapshot position is what makes the walk safe while the directory
    // keeps changing: anything that moved during it is replayed, and a replayed change older than a
    // snapshot record is refused by the store's per-entity `seq`.
    await this.#store.setCursor(from ?? 0)
    return this.#catchUp(applied, true)
  }

  /** Every page of one snapshot, with the watermark its first page reported. */
  async #walk(entityType: DirectoryEntityType) {
    const records: DirectoryRecord[] = []
    const keys = new Set<string>()
    let asOfSeq = 0
    let cursor: string | undefined
    for (let first = true; ; first = false) {
      const page = await this.#page(entityType, cursor)
      if (first) asOfSeq = page.asOfSeq
      for (const item of page.items) {
        const record = snapshotRecord(entityType, item, asOfSeq)
        records.push(record)
        keys.add(record.key)
      }
      if (page.nextCursor === null) break
      cursor = page.nextCursor
    }
    return { records, keys, asOfSeq }
  }

  #page(entityType: DirectoryEntityType, cursor: string | undefined) {
    const query = { limit: this.#pageSize, ...(cursor === undefined ? {} : { cursor }) }
    const directory = this.#client.directory
    switch (entityType) {
      case 'workspace':
        return directory.listWorkspaces(query)
      case 'user':
        return directory.listUsers(query)
      case 'account_membership':
        return directory.listAccountMemberships(query)
      case 'workspace_membership':
        return directory.listWorkspaceMemberships(query)
      case 'repo':
        return directory.listRepos(query)
    }
  }

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(work, work)
    this.#queue = run.catch(() => undefined)
    return run
  }
}

/** A snapshot item as the record a store writes, current as of the walk's watermark. */
function snapshotRecord(
  entityType: DirectoryEntityType,
  item: unknown,
  seq: number,
): DirectoryRecord {
  switch (entityType) {
    case 'workspace': {
      const entity = item as DirectoryWorkspace
      return { entityType, key: entity.id, seq, entity }
    }
    case 'user': {
      const entity = item as DirectoryUser
      return { entityType, key: entity.id, seq, entity }
    }
    case 'account_membership': {
      const entity = item as DirectoryAccountMembership
      return { entityType, key: entity.userId, seq, entity }
    }
    case 'workspace_membership': {
      const entity = item as DirectoryWorkspaceMembership
      const key = entityKey({
        entityType,
        workspaceId: entity.workspaceId,
        entityId: entity.userId,
      })
      return { entityType, key, seq, entity }
    }
    case 'repo': {
      const entity = item as DirectoryRepo
      const key = entityKey({
        entityType,
        workspaceId: entity.workspaceId,
        entityId: String(entity.repoId),
      })
      return { entityType, key, seq, entity }
    }
  }
}

/** The deletion a reconciliation writes for an entity the source no longer has. */
function tombstone(entityType: DirectoryEntityType, key: string, seq: number): DirectoryRecord {
  return { entityType, key, seq, entity: null } as DirectoryRecord
}

function isReason(error: unknown, reason: string): boolean {
  return (
    error instanceof CatFactoryApiError &&
    (error.details as { reason?: unknown } | undefined)?.reason === reason
  )
}

function isCursorExpired(error: unknown): boolean {
  return isReason(error, 'cursor_expired')
}
