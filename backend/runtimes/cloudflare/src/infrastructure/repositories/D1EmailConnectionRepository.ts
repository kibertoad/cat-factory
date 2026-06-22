import type {
  EmailConnectionRecord,
  EmailConnectionRepository,
  EmailProviderKind,
} from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'

interface EmailConnectionRow {
  account_id: string
  provider: string
  from_address: string
  api_key_cipher: string
  created_at: number
  updated_at: number
  deleted_at: number | null
}

function rowToRecord(row: EmailConnectionRow): EmailConnectionRecord {
  return {
    accountId: row.account_id,
    provider: row.provider as EmailProviderKind,
    fromAddress: row.from_address,
    apiKeyCipher: row.api_key_cipher,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  }
}

/** D1-backed per-account email-sender connection (sealed provider API key). */
export class D1EmailConnectionRepository implements EmailConnectionRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async getByAccount(accountId: string): Promise<EmailConnectionRecord | null> {
    const row = await this.db
      .prepare('SELECT * FROM email_connections WHERE account_id = ?')
      .bind(accountId)
      .first<EmailConnectionRow>()
    return row ? rowToRecord(row) : null
  }

  async upsert(record: EmailConnectionRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO email_connections
           (account_id, provider, from_address, api_key_cipher, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (account_id) DO UPDATE SET
           provider = excluded.provider,
           from_address = excluded.from_address,
           api_key_cipher = excluded.api_key_cipher,
           updated_at = excluded.updated_at,
           deleted_at = excluded.deleted_at`,
      )
      .bind(
        record.accountId,
        record.provider,
        record.fromAddress,
        record.apiKeyCipher,
        record.createdAt,
        record.updatedAt,
        record.deletedAt,
      )
      .run()
  }

  async softDelete(accountId: string, at: number): Promise<void> {
    await this.db
      .prepare('UPDATE email_connections SET deleted_at = ?, updated_at = ? WHERE account_id = ?')
      .bind(at, at, accountId)
      .run()
  }
}
