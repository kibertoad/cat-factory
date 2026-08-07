import type {
  DocumentConnectionRepository,
  DocumentSourceKind,
  SealedDocumentConnectionRecord,
} from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'

interface DocumentConnectionRow {
  workspace_id: string
  source: string
  credentials: string
  label: string
  created_at: number
  deleted_at: number | null
}

/**
 * D1-backed store of workspace → document-source connections (migration 0012).
 *
 * Source credentials are third-party secrets and cross this repository as the AES-256-GCM
 * ENVELOPE they are stored as: the seal is the row's value, not an encoding this class hides.
 * Opening it belongs to `createDocumentConnectionStore` (`@cat-factory/integrations`), which is
 * what lets a deployment holding no key for these rows — a mothership-mode node — still read them
 * (it names the row over `/internal/secrets/unseal`). A repository that decrypted could only be
 * called by a key-holder, which is precisely what kept this integration off the persistence RPC.
 */
export class D1DocumentConnectionRepository implements DocumentConnectionRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  private rowToRecord(row: DocumentConnectionRow): SealedDocumentConnectionRecord {
    return {
      workspaceId: row.workspace_id,
      source: row.source as DocumentSourceKind,
      credentialsCipher: row.credentials,
      label: row.label,
      createdAt: row.created_at,
      deletedAt: row.deleted_at,
    }
  }

  async getByWorkspace(
    workspaceId: string,
    source: DocumentSourceKind,
  ): Promise<SealedDocumentConnectionRecord | null> {
    const row = await this.db
      .prepare(
        'SELECT * FROM document_connections WHERE workspace_id = ? AND source = ? AND deleted_at IS NULL',
      )
      .bind(workspaceId, source)
      .first<DocumentConnectionRow>()
    return row ? this.rowToRecord(row) : null
  }

  async listByWorkspace(workspaceId: string): Promise<SealedDocumentConnectionRecord[]> {
    const { results } = await this.db
      .prepare(
        'SELECT * FROM document_connections WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY created_at DESC',
      )
      .bind(workspaceId)
      .all<DocumentConnectionRow>()
    return results.map((row) => this.rowToRecord(row))
  }

  async upsert(record: SealedDocumentConnectionRecord): Promise<void> {
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
        record.credentialsCipher,
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
