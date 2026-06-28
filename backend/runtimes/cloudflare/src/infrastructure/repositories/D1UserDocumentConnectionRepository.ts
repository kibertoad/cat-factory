import type {
  DocumentSourceKind,
  SecretCipher,
  UserDocumentConnectionRecord,
  UserDocumentConnectionRepository,
} from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'

interface UserDocumentConnectionRow {
  user_id: string
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
 * D1-backed store of user → personal document-source connections (migration 0019), the
 * per-user analogue of {@link D1DocumentConnectionRepository}. Used for sources whose
 * `descriptor.credentialScope === 'user'` (Claude Design). The PAT is encrypted at rest
 * with the same AES-256-GCM envelope as the workspace store — never plaintext.
 */
export class D1UserDocumentConnectionRepository implements UserDocumentConnectionRepository {
  private readonly db: D1Database
  private readonly cipher: SecretCipher

  constructor({ db, cipher }: { db: D1Database; cipher: SecretCipher }) {
    this.db = db
    this.cipher = cipher
  }

  private async decodeCredentials(stored: string): Promise<Record<string, string>> {
    if (!stored.startsWith('v1.')) return parseCredentials(stored)
    try {
      return parseCredentials(await this.cipher.decrypt(stored))
    } catch {
      // Wrong key / corrupt envelope: fail closed with an empty bag.
      return {}
    }
  }

  private async rowToRecord(row: UserDocumentConnectionRow): Promise<UserDocumentConnectionRecord> {
    return {
      userId: row.user_id,
      source: row.source as DocumentSourceKind,
      credentials: await this.decodeCredentials(row.credentials),
      label: row.label,
      createdAt: row.created_at,
      deletedAt: row.deleted_at,
    }
  }

  async getByUser(
    userId: string,
    source: DocumentSourceKind,
  ): Promise<UserDocumentConnectionRecord | null> {
    const row = await this.db
      .prepare(
        'SELECT * FROM user_document_connections WHERE user_id = ? AND source = ? AND deleted_at IS NULL',
      )
      .bind(userId, source)
      .first<UserDocumentConnectionRow>()
    return row ? this.rowToRecord(row) : null
  }

  async listByUser(userId: string): Promise<UserDocumentConnectionRecord[]> {
    const { results } = await this.db
      .prepare(
        'SELECT * FROM user_document_connections WHERE user_id = ? AND deleted_at IS NULL ORDER BY created_at DESC',
      )
      .bind(userId)
      .all<UserDocumentConnectionRow>()
    return Promise.all(results.map((row) => this.rowToRecord(row)))
  }

  async upsert(record: UserDocumentConnectionRecord): Promise<void> {
    // A user has a single live connection per source: clear any prior binding (live or
    // tombstoned) before inserting, so reconnecting can't collide on the (user_id, source)
    // primary key.
    await this.db
      .prepare('DELETE FROM user_document_connections WHERE user_id = ? AND source = ?')
      .bind(record.userId, record.source)
      .run()
    const credentials = await this.cipher.encrypt(JSON.stringify(record.credentials))
    await this.db
      .prepare(
        `INSERT INTO user_document_connections
          (user_id, source, credentials, label, created_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, NULL)`,
      )
      .bind(record.userId, record.source, credentials, record.label, record.createdAt)
      .run()
  }

  async softDelete(userId: string, source: DocumentSourceKind, at: number): Promise<void> {
    await this.db
      .prepare(
        'UPDATE user_document_connections SET deleted_at = ? WHERE user_id = ? AND source = ? AND deleted_at IS NULL',
      )
      .bind(at, userId, source)
      .run()
  }
}
