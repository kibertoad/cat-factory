import type {
  DocumentConnectionRecord,
  DocumentConnectionRepository,
  DocumentSourceKind,
} from '@cat-factory/core'
import type { D1Database } from '@cloudflare/workers-types'

interface DocumentConnectionRow {
  workspace_id: string
  source: string
  credentials: string
  label: string
  created_at: number
  deleted_at: number | null
}

function rowToRecord(row: DocumentConnectionRow): DocumentConnectionRecord {
  let credentials: Record<string, string> = {}
  try {
    const parsed = JSON.parse(row.credentials)
    if (parsed && typeof parsed === 'object') credentials = parsed as Record<string, string>
  } catch {
    // A malformed bag is treated as empty; the import path then fails closed.
  }
  return {
    workspaceId: row.workspace_id,
    source: row.source as DocumentSourceKind,
    credentials,
    label: row.label,
    createdAt: row.created_at,
    deletedAt: row.deleted_at,
  }
}

/** D1-backed store of workspace → document-source connections (migration 0012). */
export class D1DocumentConnectionRepository implements DocumentConnectionRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async getByWorkspace(
    workspaceId: string,
    source: DocumentSourceKind,
  ): Promise<DocumentConnectionRecord | null> {
    const row = await this.db
      .prepare(
        'SELECT * FROM document_connections WHERE workspace_id = ? AND source = ? AND deleted_at IS NULL',
      )
      .bind(workspaceId, source)
      .first<DocumentConnectionRow>()
    return row ? rowToRecord(row) : null
  }

  async listByWorkspace(workspaceId: string): Promise<DocumentConnectionRecord[]> {
    const { results } = await this.db
      .prepare(
        'SELECT * FROM document_connections WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY created_at DESC',
      )
      .bind(workspaceId)
      .all<DocumentConnectionRow>()
    return results.map(rowToRecord)
  }

  async upsert(record: DocumentConnectionRecord): Promise<void> {
    // A workspace has a single live connection per source: clear any prior
    // binding (live or tombstoned) before inserting, so reconnecting can't
    // collide on the (workspace_id, source) primary key.
    await this.db
      .prepare('DELETE FROM document_connections WHERE workspace_id = ? AND source = ?')
      .bind(record.workspaceId, record.source)
      .run()
    await this.db
      .prepare(
        `INSERT INTO document_connections
          (workspace_id, source, credentials, label, created_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, NULL)`,
      )
      .bind(
        record.workspaceId,
        record.source,
        JSON.stringify(record.credentials),
        record.label,
        record.createdAt,
      )
      .run()
  }

  async softDelete(workspaceId: string, source: DocumentSourceKind, at: number): Promise<void> {
    await this.db
      .prepare(
        'UPDATE document_connections SET deleted_at = ? WHERE workspace_id = ? AND source = ? AND deleted_at IS NULL',
      )
      .bind(at, workspaceId, source)
      .run()
  }
}
