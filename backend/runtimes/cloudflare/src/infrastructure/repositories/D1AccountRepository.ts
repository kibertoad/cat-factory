import type {
  AccountRecord,
  AccountRepository,
  AccountSettingsPatch,
  CloudProvider,
} from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'
import { chunkForIn } from './chunk'

interface AccountRow {
  id: string
  type: string
  name: string
  github_account_login: string | null
  owner_user_id: string | null
  created_at: number
  default_cloud_provider: string | null
  spend_monthly_limit: number | null
}

function rowToAccount(row: AccountRow): AccountRecord {
  return {
    id: row.id,
    type: row.type === 'org' ? 'org' : 'personal',
    name: row.name,
    githubAccountLogin: row.github_account_login,
    ownerUserId: row.owner_user_id,
    createdAt: row.created_at,
    ...(row.default_cloud_provider
      ? { defaultCloudProvider: row.default_cloud_provider as CloudProvider }
      : {}),
    ...(row.spend_monthly_limit != null ? { spendMonthlyLimit: row.spend_monthly_limit } : {}),
  }
}

/** D1-backed store of accounts (the tenants that own workspaces; migration 0017). */
export class D1AccountRepository implements AccountRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async get(id: string): Promise<AccountRecord | null> {
    const row = await this.db
      .prepare('SELECT * FROM accounts WHERE id = ?')
      .bind(id)
      .first<AccountRow>()
    return row ? rowToAccount(row) : null
  }

  async listByIds(ids: string[]): Promise<AccountRecord[]> {
    if (ids.length === 0) return []
    const out: AccountRecord[] = []
    // Chunk the IN list to stay under D1's bound-parameter limit.
    for (const chunk of chunkForIn(ids)) {
      const placeholders = chunk.map(() => '?').join(', ')
      const { results } = await this.db
        .prepare(`SELECT * FROM accounts WHERE id IN (${placeholders})`)
        .bind(...chunk)
        .all<AccountRow>()
      for (const row of results ?? []) out.push(rowToAccount(row))
    }
    return out
  }

  async create(account: AccountRecord): Promise<void> {
    await this.db
      .prepare(
        'INSERT INTO accounts (id, type, name, github_account_login, owner_user_id, created_at, default_cloud_provider, spend_monthly_limit) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(
        account.id,
        account.type,
        account.name,
        account.githubAccountLogin,
        account.ownerUserId,
        account.createdAt,
        account.defaultCloudProvider ?? null,
        account.spendMonthlyLimit ?? null,
      )
      .run()
  }

  async ensurePersonal(account: AccountRecord): Promise<AccountRecord> {
    // Atomic get-or-create: `INSERT OR IGNORE` no-ops when a personal account already exists
    // for this owner (the partial unique index `idx_accounts_personal` arbitrates), so
    // concurrent first-sign-in callers converge on the one surviving row instead of racing to
    // a duplicate-key error. Re-select to return whichever row won.
    await this.db
      .prepare(
        'INSERT OR IGNORE INTO accounts (id, type, name, github_account_login, owner_user_id, created_at, default_cloud_provider, spend_monthly_limit) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(
        account.id,
        account.type,
        account.name,
        account.githubAccountLogin,
        account.ownerUserId,
        account.createdAt,
        account.defaultCloudProvider ?? null,
        account.spendMonthlyLimit ?? null,
      )
      .run()
    const row = await this.findPersonalByUser(account.ownerUserId ?? '')
    if (!row) {
      throw new Error(
        `ensurePersonal: personal account missing after insert for ${account.ownerUserId}`,
      )
    }
    return row
  }

  async rename(id: string, name: string): Promise<void> {
    await this.db.prepare('UPDATE accounts SET name = ? WHERE id = ?').bind(name, id).run()
  }

  async updateSettings(id: string, patch: AccountSettingsPatch): Promise<void> {
    if ('defaultCloudProvider' in patch) {
      await this.db
        .prepare('UPDATE accounts SET default_cloud_provider = ? WHERE id = ?')
        .bind(patch.defaultCloudProvider ?? null, id)
        .run()
    }
    if ('spendMonthlyLimit' in patch) {
      await this.db
        .prepare('UPDATE accounts SET spend_monthly_limit = ? WHERE id = ?')
        .bind(patch.spendMonthlyLimit ?? null, id)
        .run()
    }
  }

  async findPersonalByUser(userId: string): Promise<AccountRecord | null> {
    const row = await this.db
      .prepare("SELECT * FROM accounts WHERE type = 'personal' AND owner_user_id = ?")
      .bind(userId)
      .first<AccountRow>()
    return row ? rowToAccount(row) : null
  }
}
