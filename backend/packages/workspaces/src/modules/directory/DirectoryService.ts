import type {
  DirectoryAccountMembership,
  DirectoryChange,
  DirectoryChangePage,
  DirectoryRepo,
  DirectoryUser,
  DirectoryWorkspace,
  DirectoryWorkspaceMembership,
} from '@cat-factory/contracts'
import {
  ConflictError,
  type DirectoryChangeRecord,
  type DirectoryRepoKey,
  type DirectoryRepository,
  ForbiddenError,
  ValidationError,
  type WorkspaceMembershipKey,
} from '@cat-factory/kernel'

// The public directory read side (docs/initiatives/directory-sync.md): an account's workspaces,
// users, memberships and linked repositories as keyset-paged snapshots, plus the change feed that
// keeps a mirror of them current. The repository answers in SQL; this service owns the rules the
// two runtimes must agree on: which key sees what, when a feed cursor has expired, where a page of
// changes leaves the cursor, and what a snapshot cursor encodes.

/** Who is reading: the key's account and its workspace reach (`null` for every workspace). */
export interface DirectoryReader {
  accountId: string
  workspaceIds: string[] | null
}

export interface SnapshotPage<T> {
  items: T[]
  nextCursor: string | null
  asOfSeq: number
}

export interface DirectoryServiceDependencies {
  directoryRepository: DirectoryRepository
}

/** Page size when the caller names none; the contract caps an explicit one at the same value. */
const DEFAULT_PAGE_SIZE = 100

export class DirectoryService {
  constructor(private readonly deps: DirectoryServiceDependencies) {}

  /**
   * Changes after `after`, each carrying its entity's current state (or `null` once it is gone or
   * outside the reader's reach). Refuses a cursor whose following changes were pruned, and one
   * ahead of the feed (a cursor from another deployment or a reset database), with
   * `cursor_expired`: replaying from either would silently miss changes.
   */
  async changes(
    reader: DirectoryReader,
    after: number,
    limit = DEFAULT_PAGE_SIZE,
  ): Promise<DirectoryChangePage> {
    const repo = this.deps.directoryRepository
    // Read the head FIRST. Every row up to it is committed (commit order equals `seq` order), so
    // a short page can safely advance the cursor to the head without skipping a late commit.
    const head = await repo.headSeq(reader.accountId)
    if (after > head) throw expired()
    if (after < head) {
      const oldest = await repo.oldestSeq(reader.accountId)
      if (oldest !== null && after < oldest - 1) throw expired()
    }
    const rows = await repo.listChanges(reader.accountId, after, head, limit, reader.workspaceIds)
    const changes = await this.hydrate(reader.accountId, rows)
    const nextAfter = rows.length === limit ? rows[rows.length - 1]!.seq : head
    return { changes, nextAfter, headSeq: head }
  }

  workspaces(
    reader: DirectoryReader,
    cursor: string | undefined,
    limit = DEFAULT_PAGE_SIZE,
  ): Promise<SnapshotPage<DirectoryWorkspace>> {
    return this.snapshot(
      reader,
      cursor,
      limit,
      isString,
      (w) => w.id,
      (after) =>
        this.deps.directoryRepository.listWorkspaces(
          reader.accountId,
          after,
          limit,
          reader.workspaceIds,
        ),
    )
  }

  users(
    reader: DirectoryReader,
    cursor: string | undefined,
    limit = DEFAULT_PAGE_SIZE,
  ): Promise<SnapshotPage<DirectoryUser>> {
    requireAccountWide(reader)
    return this.snapshot(
      reader,
      cursor,
      limit,
      isString,
      (u) => u.id,
      (after) => this.deps.directoryRepository.listUsers(reader.accountId, after, limit),
    )
  }

  accountMemberships(
    reader: DirectoryReader,
    cursor: string | undefined,
    limit = DEFAULT_PAGE_SIZE,
  ): Promise<SnapshotPage<DirectoryAccountMembership>> {
    requireAccountWide(reader)
    return this.snapshot(
      reader,
      cursor,
      limit,
      isString,
      (m) => m.userId,
      (after) =>
        this.deps.directoryRepository.listAccountMemberships(reader.accountId, after, limit),
    )
  }

  workspaceMemberships(
    reader: DirectoryReader,
    cursor: string | undefined,
    limit = DEFAULT_PAGE_SIZE,
  ): Promise<SnapshotPage<DirectoryWorkspaceMembership>> {
    return this.snapshot(
      reader,
      cursor,
      limit,
      isMembershipKey,
      (m): WorkspaceMembershipKey => ({ workspaceId: m.workspaceId, userId: m.userId }),
      (after) =>
        this.deps.directoryRepository.listWorkspaceMemberships(
          reader.accountId,
          after,
          limit,
          reader.workspaceIds,
        ),
    )
  }

  repos(
    reader: DirectoryReader,
    cursor: string | undefined,
    limit = DEFAULT_PAGE_SIZE,
  ): Promise<SnapshotPage<DirectoryRepo>> {
    return this.snapshot(
      reader,
      cursor,
      limit,
      isRepoKey,
      (r): DirectoryRepoKey => ({ workspaceId: r.workspaceId, repoId: r.repoId }),
      (after) =>
        this.deps.directoryRepository.listRepos(
          reader.accountId,
          after,
          limit,
          reader.workspaceIds,
        ),
    )
  }

  /**
   * One snapshot page. The first page captures the feed head as `asOfSeq` BEFORE reading, and the
   * cursor carries it, so every page of one walk reports the same watermark and a replay from it
   * covers anything that changed while the walk was in progress.
   */
  private async snapshot<T, K>(
    reader: DirectoryReader,
    cursor: string | undefined,
    limit: number,
    isKey: (value: unknown) => value is K,
    keyOf: (item: T) => K,
    list: (after: K | null) => Promise<T[]>,
  ): Promise<SnapshotPage<T>> {
    const position =
      cursor === undefined
        ? { asOf: await this.deps.directoryRepository.headSeq(reader.accountId), after: null }
        : decodeSnapshotCursor(cursor, isKey)
    const items = await list(position.after)
    const last = items[items.length - 1]
    const nextCursor =
      items.length === limit && last !== undefined
        ? encodeSnapshotCursor(position.asOf, keyOf(last))
        : null
    return { items, nextCursor, asOfSeq: position.asOf }
  }

  /** Attach each change's current entity, in one batched read per entity type. */
  private async hydrate(
    accountId: string,
    rows: DirectoryChangeRecord[],
  ): Promise<DirectoryChange[]> {
    const repo = this.deps.directoryRepository
    const ofType = (type: DirectoryChangeRecord['entityType']) =>
      rows.filter((r) => r.entityType === type)
    const unique = <T>(values: T[], key: (v: T) => string) => [
      ...new Map(values.map((v) => [key(v), v])).values(),
    ]
    const membershipKeys = unique(
      ofType('workspace_membership').map((r) => ({
        workspaceId: r.workspaceId ?? '',
        userId: r.entityId,
      })),
      (k) => `${k.workspaceId}\u0000${k.userId}`,
    )
    const repoKeys = unique(
      ofType('repo').map((r) => ({ workspaceId: r.workspaceId ?? '', repoId: Number(r.entityId) })),
      (k) => `${k.workspaceId}\u0000${k.repoId}`,
    )
    const ids = (type: DirectoryChangeRecord['entityType']) => [
      ...new Set(ofType(type).map((r) => r.entityId)),
    ]
    const [workspaces, users, accountMemberships, workspaceMemberships, repos] = await Promise.all([
      repo.getWorkspaces(accountId, ids('workspace')),
      repo.getUsers(accountId, ids('user')),
      repo.getAccountMemberships(accountId, ids('account_membership')),
      repo.getWorkspaceMemberships(accountId, membershipKeys),
      repo.getRepos(accountId, repoKeys),
    ])
    const byWorkspace = new Map(workspaces.map((w) => [w.id, w]))
    const byUser = new Map(users.map((u) => [u.id, u]))
    const byAccountMembership = new Map(accountMemberships.map((m) => [m.userId, m]))
    const byWorkspaceMembership = new Map(
      workspaceMemberships.map((m) => [`${m.workspaceId}\u0000${m.userId}`, m]),
    )
    const byRepo = new Map(repos.map((r) => [`${r.workspaceId}\u0000${r.repoId}`, r]))

    return rows.map((row): DirectoryChange => {
      const base = {
        seq: row.seq,
        at: row.at,
        workspaceId: row.workspaceId,
        entityId: row.entityId,
      }
      const scoped = `${row.workspaceId ?? ''}\u0000${row.entityId}`
      switch (row.entityType) {
        case 'workspace':
          return { ...base, entityType: 'workspace', entity: byWorkspace.get(row.entityId) ?? null }
        case 'user':
          return { ...base, entityType: 'user', entity: byUser.get(row.entityId) ?? null }
        case 'account_membership':
          return {
            ...base,
            entityType: 'account_membership',
            entity: byAccountMembership.get(row.entityId) ?? null,
          }
        case 'workspace_membership':
          return {
            ...base,
            entityType: 'workspace_membership',
            entity: byWorkspaceMembership.get(scoped) ?? null,
          }
        case 'repo':
          return { ...base, entityType: 'repo', entity: byRepo.get(scoped) ?? null }
        default:
          return unreachable(row.entityType)
      }
    })
  }
}

function expired(): ConflictError {
  return new ConflictError(
    'The directory changes after this cursor are no longer kept; reconcile from a snapshot',
    'cursor_expired',
  )
}

function requireAccountWide(reader: DirectoryReader): void {
  if (reader.workspaceIds !== null) {
    throw new ForbiddenError(
      'Users and account memberships are account-wide; this key is limited to some workspaces',
      { reason: 'account_scope_required' },
    )
  }
}

function unreachable(value: never): never {
  throw new Error(`Unhandled directory entity type: ${String(value)}`)
}

const isString = (value: unknown): value is string => typeof value === 'string' && value !== ''

function isMembershipKey(value: unknown): value is WorkspaceMembershipKey {
  const key = value as WorkspaceMembershipKey | null
  return typeof key?.workspaceId === 'string' && typeof key.userId === 'string'
}

function isRepoKey(value: unknown): value is DirectoryRepoKey {
  const key = value as DirectoryRepoKey | null
  return typeof key?.workspaceId === 'string' && Number.isSafeInteger(key.repoId)
}

/** A snapshot cursor: base64url JSON of the walk's watermark and the last key served. */
function encodeSnapshotCursor(asOf: number, key: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify({ a: asOf, k: key }))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function decodeSnapshotCursor<K>(
  cursor: string,
  isKey: (value: unknown) => value is K,
): { asOf: number; after: K } {
  let parsed: { a?: unknown; k?: unknown }
  try {
    const binary = atob(cursor.replace(/-/g, '+').replace(/_/g, '/'))
    parsed = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (ch) => ch.charCodeAt(0))))
  } catch {
    throw invalidCursor()
  }
  if (typeof parsed.a !== 'number' || !Number.isSafeInteger(parsed.a) || !isKey(parsed.k)) {
    throw invalidCursor()
  }
  return { asOf: parsed.a, after: parsed.k }
}

function invalidCursor(): ValidationError {
  return new ValidationError('This cursor was not issued by this listing', {
    reason: 'invalid_cursor',
  })
}
