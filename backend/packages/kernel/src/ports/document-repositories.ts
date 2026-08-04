import type {
  DocKind,
  DocumentLinkRole,
  DocumentOrigin,
  DocumentSourceKind,
} from '../domain/types.js'
import type { DocumentCredentials } from './document-source.js'

// Persistence ports for the document-source integration. The worker implements
// these against D1 (migration 0012); tests can supply in-memory fakes. All rows
// are scoped by workspace and tagged with their `source`, so a single pair of
// tables serves every provider.

/**
 * A workspace's connection to one document source, including its credential bag.
 * Credentials are infrastructure detail (never sent on the wire); they live here
 * so the import path can authenticate against the source for this workspace.
 */
export interface DocumentConnectionRecord {
  workspaceId: string
  source: DocumentSourceKind
  credentials: DocumentCredentials
  /** Human-friendly label for the connection (site URL, workspace name). */
  label: string
  createdAt: number
  /** Set when the workspace disconnects (tombstone). */
  deletedAt: number | null
}

export interface DocumentConnectionRepository {
  /** The workspace's live connection for a source, or null if not connected. */
  getByWorkspace(
    workspaceId: string,
    source: DocumentSourceKind,
  ): Promise<DocumentConnectionRecord | null>
  /** Every live connection the workspace holds, across sources. */
  listByWorkspace(workspaceId: string): Promise<DocumentConnectionRecord[]>
  /** Create or replace the live connection for a (workspace, source). */
  upsert(record: DocumentConnectionRecord): Promise<void>
  /** Tombstone the workspace's connection to a source. */
  softDelete(workspaceId: string, source: DocumentSourceKind, at: number): Promise<void>
}

/**
 * A page projected locally for a workspace. The cached `body` (normalized
 * Markdown) backs both the planner and the agent context injection;
 * `linkedBlockId` records the board block this page is attached to, if any.
 *
 * Keyed by the WIDE {@link DocumentOrigin}, not the connectable
 * {@link DocumentSourceKind}: a row can also hold a body handed to the platform directly
 * (`upload`), which has no provider to re-fetch it from and no page to link back to.
 */
export interface DocumentRecord {
  workspaceId: string
  source: DocumentOrigin
  externalId: string
  title: string
  /** Canonical URL on the source, or EMPTY for an `upload` (see `sourceDocumentSchema.url`). */
  url: string
  excerpt: string
  body: string
  /** FNV-1a digest of `body`, for cheap change detection across re-imports. */
  contentHash: string
  linkedBlockId: string | null
  /**
   * The workspace+`DocKind` link role this document plays, if any (WS1 items 2–4): `template`
   * (its parsed sections override the kind's built-in skeleton — singular per kind) or
   * `exemplar` (a good example the author agents emulate — multi-valued). Null for a plain
   * imported/block-linked document. Paired with {@link docKind}; sits ALONGSIDE `linkedBlockId`
   * (a document can be block-linked OR role-tagged), so the same projection + read path serves both.
   */
  role: DocumentLinkRole | null
  /** The document kind a `role`-tagged link is scoped to (null when the document carries no role). */
  docKind: DocKind | null
  syncedAt: number
  deletedAt: number | null
}

/**
 * A (origin, externalId) pointer to one stored document — the key {@link DocumentRepository.get}
 * resolves a single row by, and the batch methods take a list of. Named explicitly so callers
 * pass typed refs instead of positional origin strings. Mirrors `TaskRef`.
 */
export interface DocumentRef {
  source: DocumentOrigin
  externalId: string
}

export interface DocumentRepository {
  upsert(record: DocumentRecord): Promise<void>
  get(
    workspaceId: string,
    source: DocumentOrigin,
    externalId: string,
  ): Promise<DocumentRecord | null>
  /**
   * Batch-resolve live documents by their {@link DocumentRef}s in ONE chunked-`IN` read per
   * origin — the batch counterpart to {@link get}, so attaching a LIST of documents never
   * becomes a point-read-per-document. Refs that don't resolve are simply absent from the
   * result; order is not guaranteed (callers index the result into a `Map`). Empty input is a
   * no-op. Mirrors `TaskRepository.listByRefs`, which serves the same need for issues.
   */
  listByRefs(workspaceId: string, refs: readonly DocumentRef[]): Promise<DocumentRecord[]>
  /** Every live document imported into the workspace, across sources. */
  listByWorkspace(workspaceId: string): Promise<DocumentRecord[]>
  /**
   * Resolve a single live document by its canonical `url` (trailing-slash tolerant),
   * across sources. Used to resolve a URL named explicitly in a block's description
   * against the imported corpus without scanning every document body.
   */
  getByUrl(workspaceId: string, url: string): Promise<DocumentRecord | null>
  /** Live documents attached to a board block (resolved during execution). */
  listByBlock(workspaceId: string, blockId: string): Promise<DocumentRecord[]>
  /** Attach a document to a board block (or detach with null). */
  linkBlock(
    workspaceId: string,
    source: DocumentOrigin,
    externalId: string,
    blockId: string | null,
  ): Promise<void>
  /**
   * Attach (or with null, detach) SEVERAL documents to one block in one chunked statement per
   * origin — the batch counterpart to {@link linkBlock}.
   *
   * Two callers need it as a batch rather than a loop: a task created with a list of documents
   * links them together, and the rollback that undoes such a creation detaches them together.
   * Both are bounded lists known up front, which is exactly the shape the point method turns
   * into an N+1. Empty input is a no-op. Refs naming no row are silently skipped, so a detach
   * stays idempotent (the rollback re-runs against rows a concurrent delete may already have
   * removed).
   */
  linkBlockMany(
    workspaceId: string,
    refs: readonly DocumentRef[],
    blockId: string | null,
  ): Promise<void>
  /**
   * Detach every document attached to ANY of the given blocks, in one chunked statement.
   *
   * The block-delete cascade's counterpart to {@link linkBlock}'s null form: a delete knows the
   * doomed block ids, not which documents name them, and a document row carries exactly one
   * `linkedBlockId`, so a link left naming a deleted block makes that document look permanently
   * spoken for. Empty input is a no-op; blocks with no attached document are silently skipped.
   */
  detachBlocks(workspaceId: string, blockIds: readonly string[]): Promise<void>
  // ---- Workspace+DocKind role links (WS1 items 2–4) -----------------------
  /**
   * The single live document tagged with `role` for `docKind` (newest wins), or null. Used for
   * the singular `template` override — the outliner/writer prompts and the `doc-quality` gate
   * both resolve the kind's effective template through this.
   */
  getRoleLink(
    workspaceId: string,
    role: DocumentLinkRole,
    docKind: DocKind,
  ): Promise<DocumentRecord | null>
  /** Every live document tagged with `role` for `docKind` (the multi-valued `exemplar` set). */
  listRoleLinks(
    workspaceId: string,
    role: DocumentLinkRole,
    docKind: DocKind,
  ): Promise<DocumentRecord[]>
  /** Every live role-tagged document in the workspace, across roles + kinds (drives the management UI). */
  listRoleLinksByWorkspace(workspaceId: string): Promise<DocumentRecord[]>
  /** Tag a document with a workspace+`DocKind` role (sets `role`/`docKind`, leaving `linkedBlockId` alone). */
  setRole(
    workspaceId: string,
    source: DocumentOrigin,
    externalId: string,
    role: DocumentLinkRole,
    docKind: DocKind,
  ): Promise<void>
  /** Clear a single document's role tag (falls back to the built-in template / drops the exemplar). */
  clearRole(workspaceId: string, source: DocumentOrigin, externalId: string): Promise<void>
  /**
   * Clear the role tag on EVERY document matching (`role`, `docKind`) — used to enforce the
   * singular `template`: the write path clears the prior template for a kind before setting the new one.
   */
  clearRoleForKind(workspaceId: string, role: DocumentLinkRole, docKind: DocKind): Promise<void>
}
