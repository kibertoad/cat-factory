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
        'INSERT INTO accounts (id, type, name, github_account_login, owner_user_id, created_at, default_cloud_provider) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(
        account.id,
        account.type,
        account.name,
        account.githubAccountLogin,
        account.ownerUserId,
        account.createdAt,
        account.defaultCloudProvider ?? null,
      )
      .run()
  }

  async rename(id: string, name: string): Promise<void> {
    await this.db.prepare('UPDATE accounts SET name = ? WHERE id = ?').bind(name, id).run()
  }

  async updateSettings(id: string, patch: AccountSettingsPatch): Promise<void> {
    if (!('defaultCloudProvider' in patch)) return
    await this.db
      .prepare('UPDATE accounts SET default_cloud_provider = ? WHERE id = ?')
      .bind(patch.defaultCloudProvider ?? null, id)
      .run()
  }

  async findPersonalByUser(userId: string): Promise<AccountRecord | null> {
    const row = await this.db
      .prepare("SELECT * FROM accounts WHERE type = 'personal' AND owner_user_id = ?")
      .bind(userId)
      .first<AccountRow>()
    return row ? rowToAccount(row) : null
  }
}
