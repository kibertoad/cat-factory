import type { AgentKind, BlockType, FragmentOwnerKind } from '../domain/types.js'

// ---------------------------------------------------------------------------
// Persistence ports for the prompt-fragment library (ADR 0006). The worker
// implements these against D1 (migration 0020); tests can supply fakes. Rows are
// scoped by an (ownerKind, ownerId) pair — an account id or a workspace id — so
// the same table backs both tenancy tiers, and carry a tombstone (`deletedAt`)
// so a tier can suppress an inherited or removed-upstream fragment.
// ---------------------------------------------------------------------------

/** The `appliesTo` hints, retained as the deterministic-selection fallback. */
export interface FragmentAppliesTo {
  blockTypes?: BlockType[]
  agentKinds?: AgentKind[]
}

/** A persisted managed fragment row at one tier (see ADR 0006 §2). */
export interface PromptFragmentRecord {
  /** Stable, globally-unique id (a slug, or `src:<sourceId>:<path>` for sourced). */
  fragmentId: string
  ownerKind: FragmentOwnerKind
  ownerId: string
  version: string
  title: string
  category: string | null
  /** One-line description; fed to the relevance selector. */
  summary: string
  /** The guidance folded into the system prompt. */
  body: string
  appliesTo: FragmentAppliesTo | null
  tags: string[] | null
  /** Provenance, when sourced from a repo (null for hand-authored). */
  sourceId: string | null
  sourcePath: string | null
  sourceSha: string | null
  createdAt: number
  updatedAt: number
  /** Tombstone: suppresses an inherited fragment, or marks one removed upstream. */
  deletedAt: number | null
}

export interface PromptFragmentRepository {
  /**
   * Fragments owned by `(ownerKind, ownerId)`. Excludes tombstones by default;
   * pass `includeDeleted` for the catalog merge, which must see suppressions.
   */
  listByOwner(
    ownerKind: FragmentOwnerKind,
    ownerId: string,
    includeDeleted?: boolean,
  ): Promise<PromptFragmentRecord[]>
  get(
    ownerKind: FragmentOwnerKind,
    ownerId: string,
    fragmentId: string,
  ): Promise<PromptFragmentRecord | null>
  upsert(record: PromptFragmentRecord): Promise<void>
  softDelete(
    ownerKind: FragmentOwnerKind,
    ownerId: string,
    fragmentId: string,
    at: number,
  ): Promise<void>
  /** Live fragments produced by a given source, for resync diffing/tombstoning. */
  listBySource(sourceId: string): Promise<PromptFragmentRecord[]>
}

/** A repo a tier links as a source of Markdown guideline files (ADR 0006 §3). */
export interface FragmentSourceRecord {
  id: string
  ownerKind: FragmentOwnerKind
  ownerId: string
  repoOwner: string
  repoName: string
  gitRef: string
  dirPath: string
  /** Digest of the source tree at the last successful sync; powers "changed?". */
  lastSyncedSha: string | null
  lastSyncedAt: number | null
  createdAt: number
  deletedAt: number | null
}

export interface FragmentSourceRepository {
  listByOwner(ownerKind: FragmentOwnerKind, ownerId: string): Promise<FragmentSourceRecord[]>
  get(id: string): Promise<FragmentSourceRecord | null>
  upsert(record: FragmentSourceRecord): Promise<void>
  updateSyncState(id: string, lastSyncedSha: string, lastSyncedAt: number): Promise<void>
  softDelete(id: string, at: number): Promise<void>
}
