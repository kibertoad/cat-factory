import type {
  DocumentConnectionRecord,
  DocumentConnectionRepository,
  DocumentSourceKind,
  SecretCipher,
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

function parseCredentials(json: string): Record<string, string> {
  try {
    const parsed = JSON.parse(json)
    if (parsed && typeof parsed === 'object') return parsed as Record<string, string>
  } catch {
    // A malformed bag is treated as empty; the import path then fails closed.
  }
  return {}
}

/**
 * D1-backed store of workspace → document-source connections (migration 0012).
 *
 * Source credentials (e.g. a Notion/Confluence API token) are third-party
 * secrets, so they are encrypted at rest with the same AES-256-GCM envelope the
 * environments integration uses — never written to D1 in plaintext. A row whose
 * `credentials` column predates encryption (no `v1.` envelope) is still read as
 * legacy plaintext JSON, then re-encrypted on the next write.
 */
export class D1DocumentConnectionRepository implements DocumentConnectionRepository {
  private readonly db: D1Database
  private readonly cipher: SecretCipher

  constructor({ db, cipher }: { db: D1Database; cipher: SecretCipher }) {
    this.db = db
    this.cipher = cipher
  }

  /** Decode the stored credential blob, decrypting the envelope when present. */
  private async decodeCredentials(stored: string): Promise<Record<string, string>> {
    // Legacy plaintext rows (written before encryption) lack the envelope tag.
    if (!stored.startsWith('v1.')) return parseCredentials(stored)
    try {
      return parseCredentials(await this.cipher.decrypt(stored))
    } catch {
      // Wrong key / corrupt envelope: fail closed with an empty bag so the
      // import path errors rather than leaking a decrypt exception.
      return {}
    }
  }

  private async rowToRecord(row: DocumentConnectionRow): Promise<DocumentConnectionRecord> {
    return {
      workspaceId: row.workspace_id,
      source: row.source as DocumentSourceKind,
      credentials: await this.decodeCredentials(row.credentials),
      label: row.label,
      createdAt: row.created_at,
      deletedAt: row.deleted_at,
    }
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
    return row ? this.rowToRecord(row) : null
  }

  async listByWorkspace(workspaceId: string): Promise<DocumentConnectionRecord[]> {
    const { results } = await this.db
      .prepare(
        'SELECT * FROM document_connections WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY created_at DESC',
      )
      .bind(workspaceId)
      .all<DocumentConnectionRow>()
    return Promise.all(results.map((row) => this.rowToRecord(row)))
  }

  async upsert(record: DocumentConnectionRecord): Promise<void> {
    // A workspace has a single live connection per source: clear any prior
    // binding (live or tombstoned) before inserting, so reconnecting can't
    // collide on the (workspace_id, source) primary key.
    await this.db
      .prepare('DELETE FROM document_connections WHERE workspace_id = ? AND source = ?')
      .bind(record.workspaceId, record.source)
      .run()
    const credentials = await this.cipher.encrypt(JSON.stringify(record.credentials))
    await this.db
      .prepare(
        `INSERT INTO document_connections
          (workspace_id, source, credentials, label, created_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, NULL)`,
      )
      .bind(record.workspaceId, record.source, credentials, record.label, record.createdAt)
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
