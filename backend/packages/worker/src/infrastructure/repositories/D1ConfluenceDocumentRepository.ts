import type { ConfluenceDocumentRecord, ConfluenceDocumentRepository } from '@cat-factory/core'
import type { D1Database } from '@cloudflare/workers-types'

interface ConfluenceDocumentRow {
  workspace_id: string
  page_id: string
  space_key: string
  title: string
  url: string
  version: number
  excerpt: string
  body: string
  linked_block_id: string | null
  synced_at: number
  deleted_at: number | null
}

function rowToRecord(row: ConfluenceDocumentRow): ConfluenceDocumentRecord {
  return {
    workspaceId: row.workspace_id,
    pageId: row.page_id,
    spaceKey: row.space_key,
    title: row.title,
    url: row.url,
    version: row.version,
    excerpt: row.excerpt,
    body: row.body,
    linkedBlockId: row.linked_block_id,
    syncedAt: row.synced_at,
    deletedAt: row.deleted_at,
  }
}

/** D1-backed store of imported Confluence page projections (migration 0005). */
export class D1ConfluenceDocumentRepository implements ConfluenceDocumentRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async upsert(record: ConfluenceDocumentRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO confluence_documents
          (workspace_id, page_id, space_key, title, url, version, excerpt, body,
           linked_block_id, synced_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT (workspace_id, page_id) DO UPDATE SET
           space_key = excluded.space_key,
           title = excluded.title,
           url = excluded.url,
           version = excluded.version,
           excerpt = excluded.excerpt,
           body = excluded.body,
           linked_block_id = excluded.linked_block_id,
           synced_at = excluded.synced_at,
           deleted_at = NULL`,
      )
      .bind(
        record.workspaceId,
        record.pageId,
        record.spaceKey,
        record.title,
        record.url,
        record.version,
        record.excerpt,
        record.body,
        record.linkedBlockId,
        record.syncedAt,
      )
      .run()
  }

  async get(workspaceId: string, pageId: string): Promise<ConfluenceDocumentRecord | null> {
    const row = await this.db
      .prepare(
        'SELECT * FROM confluence_documents WHERE workspace_id = ? AND page_id = ? AND deleted_at IS NULL',
      )
      .bind(workspaceId, pageId)
      .first<ConfluenceDocumentRow>()
    return row ? rowToRecord(row) : null
  }

  async listByWorkspace(workspaceId: string): Promise<ConfluenceDocumentRecord[]> {
    const { results } = await this.db
      .prepare(
        'SELECT * FROM confluence_documents WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY synced_at DESC',
      )
      .bind(workspaceId)
      .all<ConfluenceDocumentRow>()
    return results.map(rowToRecord)
  }

  async listByBlock(workspaceId: string, blockId: string): Promise<ConfluenceDocumentRecord[]> {
    const { results } = await this.db
      .prepare(
        'SELECT * FROM confluence_documents WHERE workspace_id = ? AND linked_block_id = ? AND deleted_at IS NULL ORDER BY synced_at DESC',
      )
      .bind(workspaceId, blockId)
      .all<ConfluenceDocumentRow>()
    return results.map(rowToRecord)
  }

  async linkBlock(workspaceId: string, pageId: string, blockId: string | null): Promise<void> {
    await this.db
      .prepare(
        'UPDATE confluence_documents SET linked_block_id = ? WHERE workspace_id = ? AND page_id = ?',
      )
      .bind(blockId, workspaceId, pageId)
      .run()
  }
}
