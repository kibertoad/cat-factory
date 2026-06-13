// Persistence ports for the Confluence integration. The worker implements these
// against D1 (migration 0005); tests can supply in-memory fakes. All rows are
// scoped by workspace, mirroring the board and GitHub repositories.

/**
 * A workspace's connection to a Confluence Cloud site, including the API token.
 * The token is infrastructure detail (never sent on the wire); it lives here so
 * the import path can authenticate against the site for this workspace.
 */
export interface ConfluenceConnectionRecord {
  workspaceId: string
  baseUrl: string
  accountEmail: string
  apiToken: string
  createdAt: number
  /** Set when the workspace disconnects (tombstone). */
  deletedAt: number | null
}

export interface ConfluenceConnectionRepository {
  /** The workspace's live connection, or null if not connected. */
  getByWorkspace(workspaceId: string): Promise<ConfluenceConnectionRecord | null>
  /** Create or replace the live connection for a workspace. */
  upsert(record: ConfluenceConnectionRecord): Promise<void>
  /** Tombstone the workspace's connection. */
  softDelete(workspaceId: string, at: number): Promise<void>
}

/**
 * A Confluence page projected locally for a workspace. The cached `body` (full
 * storage-format XHTML) backs both the planner and the agent context injection;
 * `linkedBlockId` records the board block this page is attached to, if any.
 */
export interface ConfluenceDocumentRecord {
  workspaceId: string
  pageId: string
  spaceKey: string
  title: string
  url: string
  version: number
  excerpt: string
  body: string
  linkedBlockId: string | null
  syncedAt: number
  deletedAt: number | null
}

export interface ConfluenceDocumentRepository {
  upsert(record: ConfluenceDocumentRecord): Promise<void>
  get(workspaceId: string, pageId: string): Promise<ConfluenceDocumentRecord | null>
  /** Every live document imported into the workspace. */
  listByWorkspace(workspaceId: string): Promise<ConfluenceDocumentRecord[]>
  /** Live documents attached to a board block (resolved during execution). */
  listByBlock(workspaceId: string, blockId: string): Promise<ConfluenceDocumentRecord[]>
  /** Attach a document to a board block (or detach with null). */
  linkBlock(workspaceId: string, pageId: string, blockId: string | null): Promise<void>
}
