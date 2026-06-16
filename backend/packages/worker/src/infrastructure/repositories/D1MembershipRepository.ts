import type { Membership, MembershipRepository } from '@cat-factory/core'
import type { D1Database } from '@cloudflare/workers-types'

interface MembershipRow {
  account_id: string
  user_id: number
  role: string
  created_at: number
}

function rowToMembership(row: MembershipRow): Membership {
  return {
    accountId: row.account_id,
    userId: row.user_id,
    role: row.role === 'owner' ? 'owner' : 'member',
    createdAt: row.created_at,
  }
}

/** D1-backed store of account memberships (user ↔ account + role; migration 0017). */
export class D1MembershipRepository implements MembershipRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async listByUser(userId: number): Promise<Membership[]> {
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

  async get(accountId: string, userId: number): Promise<Membership | null> {
    const row = await this.db
      .prepare('SELECT * FROM memberships WHERE account_id = ? AND user_id = ?')
      .bind(accountId, userId)
      .first<MembershipRow>()
    return row ? rowToMembership(row) : null
  }

  async upsert(membership: Membership): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO memberships (account_id, user_id, role, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (account_id, user_id) DO UPDATE SET role = excluded.role`,
      )
      .bind(membership.accountId, membership.userId, membership.role, membership.createdAt)
      .run()
  }

  async remove(accountId: string, userId: number): Promise<void> {
    await this.db
      .prepare('DELETE FROM memberships WHERE account_id = ? AND user_id = ?')
      .bind(accountId, userId)
      .run()
  }
}
