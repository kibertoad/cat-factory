import type { DirectoryEntityType } from '@cat-factory/contracts'

// ---------------------------------------------------------------------------
// The directory change feed: an append-only, per-account ordered record of WHICH directory entity
// changed. It never carries the entity's state; a reader hydrates the current state at read time
// and serves an entity that no longer exists as a deletion. That is what lets hard-deleted rows
// (users, memberships) be published without soft-delete columns, and what makes a duplicate row
// harmless. Design: docs/initiatives/directory-sync.md.
//
// There is deliberately no append method. A row is written by the repository that performs the
// directory write, inside the same transaction (Postgres) or batch (D1), so no writer can change
// the directory without the feed seeing it.
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

export interface DirectoryChangeRepository {
  /** Changes with `seq > afterSeq`, ascending, at most `limit`. */
  listAfter(accountId: string, afterSeq: number, limit: number): Promise<DirectoryChangeRecord[]>
  /** The account's highest assigned `seq`, or 0 when nothing was ever recorded. */
  headSeq(accountId: string): Promise<number>
}
