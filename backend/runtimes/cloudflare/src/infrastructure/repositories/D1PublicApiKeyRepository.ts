import type { PublicApiKeyRecord, PublicApiKeyRepository } from '@cat-factory/kernel'
import type { PublicApiScope } from '@cat-factory/contracts'
import type { D1Database } from '@cloudflare/workers-types'

interface PublicApiKeyRow {
  id: string
  account_id: string
  workspace_id: string
  label: string
  scope: string
  secret_hash: string
  created_by_user_id: string | null
  created_at: number
  last_used_at: number | null
  revoked_at: number | null
}

function rowToRecord(row: PublicApiKeyRow): PublicApiKeyRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    workspaceId: row.workspace_id,
    label: row.label,
    scope: row.scope as PublicApiScope,
    secretHash: row.secret_hash,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  }
}

/** D1-backed store of the inbound public-API keys (migration 0034). */
export class D1PublicApiKeyRepository implements PublicApiKeyRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async add(record: PublicApiKeyRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO public_api_keys
          (id, account_id, workspace_id, label, scope, secret_hash, created_by_user_id, created_at, last_used_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        record.id,
        record.accountId,
        record.workspaceId,
        record.label,
        record.scope,
        record.secretHash,
        record.createdByUserId,
        record.createdAt,
        record.lastUsedAt,
        record.revokedAt,
      )
      .run()
  }

  async getById(id: string): Promise<PublicApiKeyRecord | null> {
    const row = await this.db
      .prepare('SELECT * FROM public_api_keys WHERE id = ?')
      .bind(id)
      .first<PublicApiKeyRow>()
    return row ? rowToRecord(row) : null
  }

  async listByWorkspace(workspaceId: string): Promise<PublicApiKeyRecord[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM public_api_keys
          WHERE workspace_id = ? AND revoked_at IS NULL
          ORDER BY created_at DESC`,
      )
      .bind(workspaceId)
      .all<PublicApiKeyRow>()
    return (results ?? []).map(rowToRecord)
  }

  async markUsed(id: string, at: number): Promise<void> {
    await this.db
      .prepare('UPDATE public_api_keys SET last_used_at = ? WHERE id = ?')
      .bind(at, id)
      .run()
  }

  async revoke(workspaceId: string, id: string, at: number): Promise<void> {
    await this.db
      .prepare(
        'UPDATE public_api_keys SET revoked_at = ? WHERE id = ? AND workspace_id = ? AND revoked_at IS NULL',
      )
      .bind(at, id, workspaceId)
      .run()
  }
}
