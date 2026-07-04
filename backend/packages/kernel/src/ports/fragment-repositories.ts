import type {
  AgentKind,
  BlockType,
  DocumentSourceKind,
  FragmentOwnerKind,
  FragmentTier,
} from '../domain/types.js'

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
  /**
   * Provenance, when the body is a **living** external document (a Confluence/
   * Notion page or a GitHub file). Both null for hand-authored / repo-sourced /
   * built-in fragments. When set, `body` is the last-resolved snapshot and the
   * engine re-resolves the source at run time (TTL-gated, see {@link resolvedAt}).
   */
  docSource: DocumentSourceKind | null
  docExternalId: string | null
  /**
   * The workspace whose stored document-source connection re-resolves this fragment
   * at run time. For a workspace-tier link this is the owning workspace; for an
   * account-tier link it is the workspace chosen at link time (credentials are
   * per-workspace), so every consuming workspace re-reads through the same
   * connection rather than its own. Null for non-document fragments (and pre-existing
   * document rows, which fall back to the run's own workspace).
   */
  docViaWorkspaceId: string | null
  /** When the document-backed body was last resolved from the source; null otherwise. */
  resolvedAt: number | null
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

/**
 * A fragment after the three tiers are merged, carrying its winning tier — the
 * unit of the resolved tenant catalog every agent run selects from. Lives in
 * kernel (rather than the library service package) so the caching seam can name
 * the fragment-catalog cache's value type without depending on the service layer.
 */
export interface ResolvedCatalogEntry {
  id: string
  version: string
  title: string
  category: string | null
  summary: string
  body: string
  appliesTo: FragmentAppliesTo | null
  tags: string[] | null
  source: { sourceId: string; path: string; sha: string } | null
  /** Living document provenance (Confluence/Notion/GitHub), when document-backed. */
  documentRef: { source: DocumentSourceKind; externalId: string } | null
  /** The workspace whose connection re-resolves a document-backed body at run time. */
  docViaWorkspaceId: string | null
  /** When the document-backed body was last resolved (epoch ms); null otherwise. */
  resolvedAt: number | null
  tier: FragmentTier
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
  /**
   * Sha of the most recent commit that touched the source directory at the last
   * successful sync; powers the lightweight "changed?" check (compare against the
   * repo's current head commit for the dir). Null before the first sync.
   *
   * NOTE: the physical column is still named `last_synced_sha` in both stores — it
   * now holds a commit sha rather than the former tree-listing digest.
   */
  lastSyncedCommit: string | null
  lastSyncedAt: number | null
  createdAt: number
  deletedAt: number | null
}

export interface FragmentSourceRepository {
  listByOwner(ownerKind: FragmentOwnerKind, ownerId: string): Promise<FragmentSourceRecord[]>
  get(id: string): Promise<FragmentSourceRecord | null>
  upsert(record: FragmentSourceRecord): Promise<void>
  updateSyncState(id: string, lastSyncedCommit: string | null, lastSyncedAt: number): Promise<void>
  softDelete(id: string, at: number): Promise<void>
}
