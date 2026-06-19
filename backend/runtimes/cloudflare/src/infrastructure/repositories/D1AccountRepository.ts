import type { AccountRecord, AccountRepository } from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'

interface AccountRow {
  id: string
  type: string
  name: string
  github_account_login: string | null
  created_at: number
}

function rowToAccount(row: AccountRow): AccountRecord {
  return {
    id: row.id,
    type: row.type === 'org' ? 'org' : 'personal',
    name: row.name,
    githubAccountLogin: row.github_account_login,
    createdAt: row.created_at,
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

  async create(account: AccountRecord): Promise<void> {
    await this.db
      .prepare(
        'INSERT INTO accounts (id, type, name, github_account_login, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .bind(account.id, account.type, account.name, account.githubAccountLogin, account.createdAt)
      .run()
  }

  async rename(id: string, name: string): Promise<void> {
    await this.db.prepare('UPDATE accounts SET name = ? WHERE id = ?').bind(name, id).run()
  }

  async findPersonalByLogin(login: string): Promise<AccountRecord | null> {
    const row = await this.db
      .prepare("SELECT * FROM accounts WHERE type = 'personal' AND github_account_login = ?")
      .bind(login)
      .first<AccountRow>()
    return row ? rowToAccount(row) : null
  }
}
