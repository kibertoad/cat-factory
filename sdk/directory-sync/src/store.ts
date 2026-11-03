import type {
  DirectoryAccountMembership,
  DirectoryChange,
  DirectoryRepo,
  DirectoryUser,
  DirectoryWorkspace,
  DirectoryWorkspaceMembership,
} from '@cat-factory/sdk'

/** The five entity kinds a directory holds. */
export type DirectoryEntityType = DirectoryChange['entityType']

/** The entity a type carries. */
export interface DirectoryEntities {
  workspace: DirectoryWorkspace
  user: DirectoryUser
  account_membership: DirectoryAccountMembership
  workspace_membership: DirectoryWorkspaceMembership
  repo: DirectoryRepo
}

/**
 * One entity's state as of a feed position: what a store writes. `entity` is `null` when the
 * entity no longer exists (or is out of the key's reach), which the store records as a deletion.
 */
export type DirectoryRecord = {
  [T in DirectoryEntityType]: {
    entityType: T
    /** Stable per entity: see {@link entityKey}. */
    key: string
    /** The feed position this state is current as of. */
    seq: number
    entity: DirectoryEntities[T] | null
  }
}[DirectoryEntityType]

/**
 * Where a synced directory lives: implement this over your own database.
 *
 * Correctness rests on ONE rule, which every method below relies on: `apply` skips a record only
 * when the store already holds a STRICTLY newer `seq` for that key, and keeps a deletion's `seq` (a
 * tombstone) so a late, older upsert cannot resurrect the entity. An equal `seq` overwrites: both
 * writes carry state that was current when read, and a reconciliation repairing drift writes at
 * the position the store already holds. With that,
 * pushes and polls may arrive in any order and any number of times and the store still converges.
 * `MemoryDirectoryStore` is a complete reference.
 */
export interface DirectoryStore {
  /** The feed position this store has applied through, or null before the first sync. */
  getCursor(): Promise<number | null>
  setCursor(seq: number): Promise<void>
  /** Write one entity's state, unless the store holds a strictly newer `seq` for the same key. */
  apply(record: DirectoryRecord): Promise<void>
  /** The keys of every entity of this type the store currently holds (tombstones excluded). */
  listKeys(entityType: DirectoryEntityType): Promise<string[]>
}

/** The stable key of an entity: its id, or the board and the id for per-workspace entities. */
export function entityKey(
  change: Pick<DirectoryChange, 'entityType' | 'workspaceId' | 'entityId'>,
): string {
  return change.entityType === 'workspace_membership' || change.entityType === 'repo'
    ? `${change.workspaceId ?? ''}/${change.entityId}`
    : change.entityId
}

/** A change from the feed or a push, as the record a store writes. */
export function recordOf(change: DirectoryChange): DirectoryRecord {
  return {
    entityType: change.entityType,
    key: entityKey(change),
    seq: change.seq,
    entity: change.entity,
  } as DirectoryRecord
}

/** An in-memory {@link DirectoryStore}: for tests, prototypes, and as the reference to copy. */
export class MemoryDirectoryStore implements DirectoryStore {
  #cursor: number | null = null
  readonly #rows = new Map<DirectoryEntityType, Map<string, { seq: number; entity: unknown }>>()

  async getCursor(): Promise<number | null> {
    return this.#cursor
  }

  async setCursor(seq: number): Promise<void> {
    this.#cursor = seq
  }

  async apply(record: DirectoryRecord): Promise<void> {
    const rows = this.#table(record.entityType)
    const held = rows.get(record.key)
    if (held && held.seq > record.seq) return
    // A deletion is kept as a tombstone carrying its `seq`, never dropped: dropping it would let an
    // older upsert arriving later bring the entity back.
    rows.set(record.key, { seq: record.seq, entity: record.entity })
  }

  async listKeys(entityType: DirectoryEntityType): Promise<string[]> {
    return [...this.#table(entityType)].filter(([, row]) => row.entity !== null).map(([key]) => key)
  }

  /** Every live entity of a type, keyed by {@link entityKey}. */
  entities<T extends DirectoryEntityType>(entityType: T): Map<string, DirectoryEntities[T]> {
    const out = new Map<string, DirectoryEntities[T]>()
    for (const [key, row] of this.#table(entityType)) {
      if (row.entity !== null) out.set(key, row.entity as DirectoryEntities[T])
    }
    return out
  }

  #table(entityType: DirectoryEntityType) {
    let rows = this.#rows.get(entityType)
    if (!rows) {
      rows = new Map()
      this.#rows.set(entityType, rows)
    }
    return rows
  }
}
