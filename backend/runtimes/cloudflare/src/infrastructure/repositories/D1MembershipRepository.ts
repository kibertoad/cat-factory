import type { AccountRole, Membership, MembershipRepository } from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'

interface MembershipRow {
  account_id: string
  user_id: string
  roles: string | null
  created_at: number
}

/** Parse the CSV `roles` column into a non-empty role set (defaults to developer). */
function parseRoles(csv: string | null): AccountRole[] {
  const roles = (csv ?? '')
    .split(',')
    .map((r) => r.trim())
    .filter((r): r is AccountRole => r === 'admin' || r === 'developer' || r === 'product')
  return roles.length > 0 ? [...new Set(roles)] : ['developer']
}

function rowToMembership(row: MembershipRow): Membership {
  return {
    accountId: row.account_id,
    userId: row.user_id,
    roles: parseRoles(row.roles),
    createdAt: row.created_at,
  }
}

/** D1-backed store of account memberships (user ↔ account + roles; migration 0043). */
export class D1MembershipRepository implements MembershipRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async listByUser(userId: string): Promise<Membership[]> {
    const { results } = await this.db
      .prepare('SELECT * FROM memberships WHERE user_id = ? ORDER BY created_at ASC')
      .bind(userId)
      .all<MembershipRow>()
    return results.map(rowToMembership)
  }

  async listByAccount(accountId: string): Promise<Membership[]> {
    const { results } = await this.db
      .prepare('SELECT * FROM memberships WHERE account_id = ? ORDER BY created_at ASC')
      .bind(accountId)
      .all<MembershipRow>()
    return results.map(rowToMembership)
  }

  async get(accountId: string, userId: string): Promise<Membership | null> {
    const row = await this.db
      .prepare('SELECT * FROM memberships WHERE account_id = ? AND user_id = ?')
      .bind(accountId, userId)
      .first<MembershipRow>()
    return row ? rowToMembership(row) : null
  }

  async upsert(membership: Membership): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO memberships (account_id, user_id, roles, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (account_id, user_id) DO UPDATE SET roles = excluded.roles`,
      )
      .bind(
        membership.accountId,
        membership.userId,
        membership.roles.join(','),
        membership.createdAt,
      )
      .run()
  }

  async remove(accountId: string, userId: string): Promise<void> {
    await this.db
      .prepare('DELETE FROM memberships WHERE account_id = ? AND user_id = ?')
      .bind(accountId, userId)
      .run()
  }
}
