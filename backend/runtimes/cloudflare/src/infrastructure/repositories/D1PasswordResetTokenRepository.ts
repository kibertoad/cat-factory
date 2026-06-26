import type {
  PasswordResetTokenRecord,
  PasswordResetTokenRepository,
  PasswordResetTokenStatus,
} from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'

interface PasswordResetTokenRow {
  id: string
  user_id: string
  token_hash: string
  status: string
  expires_at: number
  created_at: number
}

function rowToRecord(row: PasswordResetTokenRow): PasswordResetTokenRecord {
  return {
    id: row.id,
    userId: row.user_id,
    tokenHash: row.token_hash,
    status: row.status as PasswordResetTokenStatus,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  }
}

/** D1-backed store of password-reset tokens ("forgot my password"). */
export class D1PasswordResetTokenRepository implements PasswordResetTokenRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async create(record: PasswordResetTokenRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO password_reset_tokens
           (id, user_id, token_hash, status, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        record.id,
        record.userId,
        record.tokenHash,
        record.status,
        record.expiresAt,
        record.createdAt,
      )
      .run()
  }

  async findByTokenHash(tokenHash: string): Promise<PasswordResetTokenRecord | null> {
    const row = await this.db
      .prepare('SELECT * FROM password_reset_tokens WHERE token_hash = ?')
      .bind(tokenHash)
      .first<PasswordResetTokenRow>()
    return row ? rowToRecord(row) : null
  }

  async listPendingByUser(userId: string): Promise<PasswordResetTokenRecord[]> {
    const { results } = await this.db
      .prepare(
        "SELECT * FROM password_reset_tokens WHERE user_id = ? AND status = 'pending' ORDER BY created_at DESC",
      )
      .bind(userId)
      .all<PasswordResetTokenRow>()
    return results.map(rowToRecord)
  }

  async setStatus(id: string, status: PasswordResetTokenStatus): Promise<void> {
    await this.db
      .prepare('UPDATE password_reset_tokens SET status = ? WHERE id = ?')
      .bind(status, id)
      .run()
  }

  async deleteExpired(before: number): Promise<number> {
    const result = await this.db
      .prepare('DELETE FROM password_reset_tokens WHERE expires_at < ?')
      .bind(before)
      .run()
    return result.meta.changes ?? 0
  }
}
