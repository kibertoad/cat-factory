import type { DocumentSourceKind } from '../domain/types.js'
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
 * A **user's personal** connection to a document source whose credential authenticates
 * as an individual rather than a workspace (a per-user PAT — Claude Design). Same shape
 * as a workspace connection but keyed by `userId`, so each member supplies their own and
 * it is never shared. The provider whose `descriptor.credentialScope === 'user'` routes
 * here instead of {@link DocumentConnectionRepository}; everything downstream (import,
 * the cached `documents` projection) is unchanged. Mirrors the per-user precedent of
 * `local_model_endpoints` / `personal_subscriptions`.
 */
export interface UserDocumentConnectionRecord {
  userId: string
  source: DocumentSourceKind
  credentials: DocumentCredentials
  /** Human-friendly label for the connection. */
  label: string
  createdAt: number
  /** Set when the user disconnects (tombstone). */
  deletedAt: number | null
}

export interface UserDocumentConnectionRepository {
  /** The user's live personal connection for a source, or null if not connected. */
  getByUser(
    userId: string,
    source: DocumentSourceKind,
  ): Promise<UserDocumentConnectionRecord | null>
  /** Every live personal connection the user holds, across sources. */
  listByUser(userId: string): Promise<UserDocumentConnectionRecord[]>
  /** Create or replace the user's live personal connection for a source. */
  upsert(record: UserDocumentConnectionRecord): Promise<void>
  /** Tombstone the user's personal connection to a source. */
  softDelete(userId: string, source: DocumentSourceKind, at: number): Promise<void>
}

/**
 * A page projected locally for a workspace. The cached `body` (normalized
 * Markdown) backs both the planner and the agent context injection;
 * `linkedBlockId` records the board block this page is attached to, if any.
 */
export interface DocumentRecord {
  workspaceId: string
  source: DocumentSourceKind
  externalId: string
  title: string
  url: string
  excerpt: string
  body: string
  /** FNV-1a digest of `body`, for cheap change detection across re-imports. */
  contentHash: string
  linkedBlockId: string | null
  syncedAt: number
  deletedAt: number | null
}

export interface DocumentRepository {
  upsert(record: DocumentRecord): Promise<void>
  get(
    workspaceId: string,
    source: DocumentSourceKind,
    externalId: string,
  ): Promise<DocumentRecord | null>
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
    source: DocumentSourceKind,
    externalId: string,
    blockId: string | null,
  ): Promise<void>
}
