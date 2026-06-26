import type { AccountSettingsRecord, AccountSettingsRepository } from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'

interface AccountSettingsRow {
  account_id: string
  config: string
  secrets_cipher: string | null
  summary: string
  created_at: number
  updated_at: number
}

function rowToRecord(row: AccountSettingsRow): AccountSettingsRecord {
  return {
    accountId: row.account_id,
    config: row.config,
    secretsCipher: row.secrets_cipher,
    summary: row.summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Per-account (deployment-wide) settings (migration 0014). One row per account; a
 * missing row means all defaults. `config` + `summary` are non-secret JSON; the ONE
 * sealed `secrets_cipher` blob is encrypted/decrypted by the caller. Mirrors the
 * email-connection per-account shape.
 */
export class D1AccountSettingsRepository implements AccountSettingsRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async getByAccount(accountId: string): Promise<AccountSettingsRecord | null> {
    const row = await this.db
      .prepare('SELECT * FROM account_settings WHERE account_id = ?')
      .bind(accountId)
      .first<AccountSettingsRow>()
    return row ? rowToRecord(row) : null
  }

  async upsert(record: AccountSettingsRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO account_settings (account_id, config, secrets_cipher, summary, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (account_id) DO UPDATE SET
           config = excluded.config,
           secrets_cipher = excluded.secrets_cipher,
           summary = excluded.summary,
           updated_at = excluded.updated_at`,
      )
      .bind(
        record.accountId,
        record.config,
        record.secretsCipher,
        record.summary,
        record.createdAt,
        record.updatedAt,
      )
      .run()
  }

  async listAll(): Promise<AccountSettingsRecord[]> {
    const { results } = await this.db
      .prepare('SELECT * FROM account_settings')
      .all<AccountSettingsRow>()
    return (results ?? []).map(rowToRecord)
  }
}
