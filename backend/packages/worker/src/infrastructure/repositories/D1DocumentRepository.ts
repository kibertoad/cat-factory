import type { DocumentRecord, DocumentRepository, DocumentSourceKind } from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'

interface DocumentRow {
  workspace_id: string
  source: string
  external_id: string
  title: string
  url: string
  excerpt: string
  body: string
  linked_block_id: string | null
  synced_at: number
  deleted_at: number | null
}

function rowToRecord(row: DocumentRow): DocumentRecord {
  return {
    workspaceId: row.workspace_id,
    source: row.source as DocumentSourceKind,
    externalId: row.external_id,
    title: row.title,
    url: row.url,
    excerpt: row.excerpt,
    body: row.body,
    linkedBlockId: row.linked_block_id,
    syncedAt: row.synced_at,
    deletedAt: row.deleted_at,
  }
}

/** D1-backed store of imported document projections, across sources (migration 0012). */
export class D1DocumentRepository implements DocumentRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async upsert(record: DocumentRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO documents
          (workspace_id, source, external_id, title, url, excerpt, body,
           linked_block_id, synced_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT (workspace_id, source, external_id) DO UPDATE SET
           title = excluded.title,
           url = excluded.url,
           excerpt = excluded.excerpt,
           body = excluded.body,
           linked_block_id = excluded.linked_block_id,
           synced_at = excluded.synced_at,
           deleted_at = NULL`,
      )
      .bind(
        record.workspaceId,
        record.source,
        record.externalId,
        record.title,
        record.url,
        record.excerpt,
        record.body,
        record.linkedBlockId,
        record.syncedAt,
      )
      .run()
  }

  async get(
    workspaceId: string,
    source: DocumentSourceKind,
    externalId: string,
  ): Promise<DocumentRecord | null> {
    const row = await this.db
      .prepare(
        'SELECT * FROM documents WHERE workspace_id = ? AND source = ? AND external_id = ? AND deleted_at IS NULL',
      )
      .bind(workspaceId, source, externalId)
      .first<DocumentRow>()
    return row ? rowToRecord(row) : null
  }

  async listByWorkspace(workspaceId: string): Promise<DocumentRecord[]> {
    const { results } = await this.db
      .prepare(
        'SELECT * FROM documents WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY synced_at DESC',
      )
      .bind(workspaceId)
      .all<DocumentRow>()
    return results.map(rowToRecord)
  }

  async listByBlock(workspaceId: string, blockId: string): Promise<DocumentRecord[]> {
    const { results } = await this.db
      .prepare(
        'SELECT * FROM documents WHERE workspace_id = ? AND linked_block_id = ? AND deleted_at IS NULL ORDER BY synced_at DESC',
      )
      .bind(workspaceId, blockId)
      .all<DocumentRow>()
    return results.map(rowToRecord)
  }

  async linkBlock(
    workspaceId: string,
    source: DocumentSourceKind,
    externalId: string,
    blockId: string | null,
  ): Promise<void> {
    await this.db
      .prepare(
        'UPDATE documents SET linked_block_id = ? WHERE workspace_id = ? AND source = ? AND external_id = ?',
      )
      .bind(blockId, workspaceId, source, externalId)
      .run()
  }
}
