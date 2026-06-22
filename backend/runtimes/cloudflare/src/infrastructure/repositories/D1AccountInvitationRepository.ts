import type {
  AccountInvitationRecord,
  AccountInvitationRepository,
  InvitationStatus,
} from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'

interface InvitationRow {
  id: string
  account_id: string
  email: string
  role: string
  token_hash: string
  invited_by: string
  status: string
  expires_at: number
  created_at: number
}

function rowToInvitation(row: InvitationRow): AccountInvitationRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    email: row.email,
    role: row.role === 'owner' ? 'owner' : 'member',
    tokenHash: row.token_hash,
    invitedBy: row.invited_by,
    status: row.status as InvitationStatus,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  }
}

/** D1-backed store of account invitations (email-based org onboarding). */
export class D1AccountInvitationRepository implements AccountInvitationRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async create(record: AccountInvitationRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO account_invitations
           (id, account_id, email, role, token_hash, invited_by, status, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        record.id,
        record.accountId,
        record.email,
        record.role,
        record.tokenHash,
        record.invitedBy,
        record.status,
        record.expiresAt,
        record.createdAt,
      )
      .run()
  }

  async get(id: string): Promise<AccountInvitationRecord | null> {
    const row = await this.db
      .prepare('SELECT * FROM account_invitations WHERE id = ?')
      .bind(id)
      .first<InvitationRow>()
    return row ? rowToInvitation(row) : null
  }

  async findByTokenHash(tokenHash: string): Promise<AccountInvitationRecord | null> {
    const row = await this.db
      .prepare('SELECT * FROM account_invitations WHERE token_hash = ?')
      .bind(tokenHash)
      .first<InvitationRow>()
    return row ? rowToInvitation(row) : null
  }

  async listByAccount(accountId: string): Promise<AccountInvitationRecord[]> {
    const { results } = await this.db
      .prepare('SELECT * FROM account_invitations WHERE account_id = ? ORDER BY created_at DESC')
      .bind(accountId)
      .all<InvitationRow>()
    return results.map(rowToInvitation)
  }

  async setStatus(id: string, status: InvitationStatus): Promise<void> {
    await this.db
      .prepare('UPDATE account_invitations SET status = ? WHERE id = ?')
      .bind(status, id)
      .run()
  }
}
