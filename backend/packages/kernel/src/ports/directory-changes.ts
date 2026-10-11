import type {
  DirectoryAccountMembership,
  DirectoryChangePage,
  DirectoryEntityType,
  DirectoryRepo,
  DirectoryUser,
  DirectoryWorkspace,
  DirectoryWorkspaceMembership,
} from '@cat-factory/contracts'

// ---------------------------------------------------------------------------
// The directory: an account's workspaces, users, memberships and linked repositories as an
// external system mirrors them, plus the ordered change feed that keeps the mirror current.
// Design: docs/initiatives/directory-sync.md.
//
// The feed records WHICH entity changed and never its state; a reader hydrates the current state
// through the `get*` methods and serves an entity that no longer exists as a deletion. That is what
// lets hard-deleted rows (users, memberships) be published without soft-delete columns, and what
// makes a duplicate feed row harmless.
//
// There is deliberately no append method. A feed row is written by the repository that performs
// the directory write, inside the same transaction (Postgres) or batch (D1), so no writer can
// change the directory without the feed seeing it.
//
// `workspaceIds` on a read is the calling key's reach: `null` for every workspace in the account,
// otherwise only rows of those workspaces are returned. Every read is bounded to `accountId`.
// ---------------------------------------------------------------------------

export interface DirectoryChangeRecord {
  accountId: string
  /**
   * Strictly increasing per account, and assigned so that commit order equals `seq` order: a
   * reader that has seen `seq` N will never later observe a newly committed row below N.
   */
  seq: number
  entityType: DirectoryEntityType
  /** The board the entity belongs to; null for account-level entities (user, account membership). */
  workspaceId: string | null
  /** User id, workspace id, or the repo's provider id as a decimal string. */
  entityId: string
  /** Epoch ms. */
  at: number
}

/** A workspace membership's key. */
export interface WorkspaceMembershipKey {
  workspaceId: string
  userId: string
}

/** A linked repository's key: the board and the provider's repository id. */
export interface DirectoryRepoKey {
  workspaceId: string
  repoId: number
}

export interface DirectoryRepository {
  /**
   * Changes with `afterSeq < seq <= upToSeq`, ascending, at most `limit`. With a workspace reach,
   * only `workspace`, `workspace_membership` and `repo` changes of those workspaces.
   */
  listChanges(
    accountId: string,
    afterSeq: number,
    upToSeq: number,
    limit: number,
    workspaceIds: string[] | null,
  ): Promise<DirectoryChangeRecord[]>
  /** The account's highest assigned `seq`, or 0 when nothing was ever recorded. */
  headSeq(accountId: string): Promise<number>
  /** `headSeq` for many accounts in one read; an account with no rows maps to 0. */
  headSeqs(accountIds: string[]): Promise<Map<string, number>>
  /** The account's lowest retained `seq`, or null when it has no rows. */
  oldestSeq(accountId: string): Promise<number | null>
  /**
   * Delete each account's feed rows up to its newest row recorded before `before` (epoch ms), so
   * what remains is always a contiguous `seq` suffix and the reader's oldest-row check sees every
   * gap. Keeps each account's newest row: that row is what the next `seq` continues from, so
   * pruning it would reissue sequence numbers. Returns the number of rows deleted.
   */
  pruneChanges(before: number): Promise<number>

  /** Keyset snapshot pages, ascending by key, strictly after `after`. */
  listWorkspaces(
    accountId: string,
    after: string | null,
    limit: number,
    workspaceIds: string[] | null,
  ): Promise<DirectoryWorkspace[]>
  /** Users holding a membership in the account. */
  listUsers(accountId: string, after: string | null, limit: number): Promise<DirectoryUser[]>
  listAccountMemberships(
    accountId: string,
    after: string | null,
    limit: number,
  ): Promise<DirectoryAccountMembership[]>
  listWorkspaceMemberships(
    accountId: string,
    after: WorkspaceMembershipKey | null,
    limit: number,
    workspaceIds: string[] | null,
  ): Promise<DirectoryWorkspaceMembership[]>
  /** Linked, non-tombstoned repositories. */
  listRepos(
    accountId: string,
    after: DirectoryRepoKey | null,
    limit: number,
    workspaceIds: string[] | null,
  ): Promise<DirectoryRepo[]>

  /**
   * Batched hydration of the entities a page of changes names, each bounded to the account. An
   * absent key is an entity that no longer exists there (or, for a user, no longer belongs to it).
   */
  getWorkspaces(accountId: string, ids: string[]): Promise<DirectoryWorkspace[]>
  getUsers(accountId: string, ids: string[]): Promise<DirectoryUser[]>
  getAccountMemberships(accountId: string, userIds: string[]): Promise<DirectoryAccountMembership[]>
  getWorkspaceMemberships(
    accountId: string,
    keys: WorkspaceMembershipKey[],
  ): Promise<DirectoryWorkspaceMembership[]>
  getRepos(accountId: string, keys: DirectoryRepoKey[]): Promise<DirectoryRepo[]>
}

/**
 * The read the directory webhook sweeper needs: the same pages `GET /api/v1/directory/changes`
 * serves, so a push and a poll can never disagree about what a change carries.
 */
export interface DirectoryFeedReader {
  headSeq(accountId: string): Promise<number>
  /** Each account's newest feed position in one read; an account with no rows maps to 0. */
  headSeqs(accountIds: string[]): Promise<Map<string, number>>
  /** Throws a `ConflictError` with reason `cursor_expired` when `after` is out of the feed. */
  changes(
    reader: { accountId: string; workspaceIds: string[] | null },
    after: number,
    limit?: number,
  ): Promise<DirectoryChangePage>
}

/** A registered directory webhook endpoint. */
export interface DirectoryWebhookRecord {
  accountId: string
  id: string
  url: string
  enabled: boolean
  /** The signing secret sealed under the deployment key, or null for an unsigned endpoint. */
  secretSealed: string | null
  /** The feed position delivered through. Owned by the sweeper (`claim`/`complete`) once the row exists. */
  deliveredSeq: number
  updatedAt: number
}

export interface DirectoryWebhookRepository {
  /** The account's endpoints, ordered by id. */
  list(accountId: string): Promise<DirectoryWebhookRecord[]>
  get(accountId: string, id: string): Promise<DirectoryWebhookRecord | null>
  /**
   * Insert or update an endpoint. An update writes `url`, `enabled`, `secretSealed` and
   * `updatedAt` and leaves `deliveredSeq` to the sweeper. A NEW endpoint is admitted only while the
   * account holds fewer than `limit`, checked atomically with the insert in the store.
   */
  put(record: DirectoryWebhookRecord, limit: number): Promise<'stored' | 'limit_reached'>
  delete(accountId: string, id: string): Promise<void>
  /** Every enabled endpoint across accounts, for the delivery sweep. */
  listEnabled(): Promise<DirectoryWebhookRecord[]>
  /**
   * Take the endpoint's delivery lease under `token` when no live lease is held (none, or one whose
   * `leaseUntil` is at or before `now`) and the endpoint is enabled. Returns the position to deliver
   * after, or null when another sweeper holds the lease or the endpoint is gone or disabled. The
   * lease is what keeps two sweepers from pushing the same or overlapping pages, and its expiry is
   * what lets a page whose sweeper died mid-push be offered again.
   */
  claim(
    accountId: string,
    id: string,
    token: string,
    now: number,
    leaseUntil: number,
  ): Promise<number | null>
  /**
   * After a successful push: set `deliveredSeq` to `toSeq` and drop the lease, only while `token`
   * still holds it. False when the lease expired and was taken over, in which case the next holder
   * sends the page again.
   */
  complete(accountId: string, id: string, token: string, toSeq: number): Promise<boolean>
  /** After a failed push: drop the lease without moving `deliveredSeq`, only while `token` holds it. */
  release(accountId: string, id: string, token: string): Promise<void>
}
