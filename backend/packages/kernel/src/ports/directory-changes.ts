import type {
  DirectoryAccountMembership,
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
  /** The account's lowest retained `seq`, or null when it has no rows. */
  oldestSeq(accountId: string): Promise<number | null>
  /**
   * Delete feed rows recorded before `before` (epoch ms), keeping each account's newest row: that
   * row is what the next `seq` continues from, so pruning it would reissue sequence numbers.
   * Returns the number of rows deleted.
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
