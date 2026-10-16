import type { AccountRunnerPoolRecord, AccountRunnerPoolRepository } from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'
import { chunkForIn } from './chunk'

interface AccountRunnerPoolRow {
  account_id: string
  kind: string
  provider_id: string
  label: string
  base_url: string
  config_json: string
  secrets_cipher: string
  created_at: number
}

function rowToRecord(row: AccountRunnerPoolRow): AccountRunnerPoolRecord {
  return {
    accountId: row.account_id,
    kind: row.kind,
    providerId: row.provider_id,
    label: row.label,
    baseUrl: row.base_url,
    configJson: row.config_json,
    secretsCipher: row.secrets_cipher,
    createdAt: row.created_at,
  }
}

/** D1-backed store of account → runner-pool rows (migration 0108). */
export class D1AccountRunnerPoolRepository implements AccountRunnerPoolRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async getByAccount(accountId: string): Promise<AccountRunnerPoolRecord | null> {
    const row = await this.db
      .prepare('SELECT * FROM account_runner_pools WHERE account_id = ?')
      .bind(accountId)
      .first<AccountRunnerPoolRow>()
    return row ? rowToRecord(row) : null
  }

  async listByAccounts(accountIds: string[]): Promise<AccountRunnerPoolRecord[]> {
    const out: AccountRunnerPoolRecord[] = []
    for (const chunk of chunkForIn(accountIds)) {
      const placeholders = chunk.map(() => '?').join(', ')
      const { results } = await this.db
        .prepare(`SELECT * FROM account_runner_pools WHERE account_id IN (${placeholders})`)
        .bind(...chunk)
        .all<AccountRunnerPoolRow>()
      for (const row of results ?? []) out.push(rowToRecord(row))
    }
    return out
  }

  async insertIfAbsent(record: AccountRunnerPoolRecord): Promise<boolean> {
    const result = await this.db
      .prepare(
        `INSERT INTO account_runner_pools
          (account_id, kind, provider_id, label, base_url, config_json, secrets_cipher, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id) DO NOTHING`,
      )
      .bind(
        record.accountId,
        record.kind,
        record.providerId,
        record.label,
        record.baseUrl,
        record.configJson,
        record.secretsCipher,
        record.createdAt,
      )
      .run()
    return (result.meta?.changes ?? 0) > 0
  }
}
