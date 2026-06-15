import type { DocumentSourceKind } from '../domain/types'
import type { DocumentCredentials } from './document-source'

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
 */
export interface DocumentRecord {
  workspaceId: string
  source: DocumentSourceKind
  externalId: string
  title: string
  url: string
  excerpt: string
  body: string
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
