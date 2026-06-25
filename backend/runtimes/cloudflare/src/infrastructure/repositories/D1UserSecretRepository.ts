import type { UserSecretRecord, UserSecretRepository } from '@cat-factory/kernel'
import type { UserSecretKind } from '@cat-factory/contracts'
import type { D1Database } from '@cloudflare/workers-types'

interface UserSecretRow {
  user_id: string
  kind: string
  label: string
  secret_cipher: string
  metadata_json: string | null
  created_at: number
  updated_at: number
}

function toRecord(row: UserSecretRow): UserSecretRecord {
  return {
    userId: row.user_id,
    kind: row.kind as UserSecretKind,
    label: row.label,
    secretCipher: row.secret_cipher,
    metadataJson: row.metadata_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** D1-backed store of a user's generic secrets (migration 0009). */
export class D1UserSecretRepository implements UserSecretRepository {
  private readonly db: D1Database
  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async listByUser(userId: string): Promise<UserSecretRecord[]> {
    const { results } = await this.db
      .prepare(`SELECT * FROM user_secrets WHERE user_id = ? ORDER BY created_at ASC`)
      .bind(userId)
      .all<UserSecretRow>()
    return (results ?? []).map(toRecord)
  }

  async getByUserKind(userId: string, kind: UserSecretKind): Promise<UserSecretRecord | null> {
    const row = await this.db
      .prepare(`SELECT * FROM user_secrets WHERE user_id = ? AND kind = ?`)
      .bind(userId, kind)
      .first<UserSecretRow>()
    return row ? toRecord(row) : null
  }

  async upsert(record: UserSecretRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO user_secrets
           (user_id, kind, label, secret_cipher, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id, kind) DO UPDATE SET
           label = excluded.label,
           secret_cipher = excluded.secret_cipher,
           metadata_json = excluded.metadata_json,
           updated_at = excluded.updated_at`,
      )
      .bind(
        record.userId,
        record.kind,
        record.label,
        record.secretCipher,
        record.metadataJson,
        record.createdAt,
        record.updatedAt,
      )
      .run()
  }

  async remove(userId: string, kind: UserSecretKind): Promise<void> {
    await this.db
      .prepare(`DELETE FROM user_secrets WHERE user_id = ? AND kind = ?`)
      .bind(userId, kind)
      .run()
  }
}
