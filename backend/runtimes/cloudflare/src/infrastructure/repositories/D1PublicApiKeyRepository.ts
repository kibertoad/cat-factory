import type { PublicApiKeyRecord, PublicApiKeyRepository } from '@cat-factory/kernel'
import type { PublicApiScope } from '@cat-factory/contracts'
import type { D1Database } from '@cloudflare/workers-types'
import { chunkForIn } from './chunk'

interface PublicApiKeyRow {
  id: string
  account_id: string
  all_workspaces: number
  label: string
  scope: string
  secret_hash: string
  created_by_user_id: string | null
  created_by_key_id: string | null
  external_identity: string | null
  acts_as_user_id: string | null
  created_at: number
  last_used_at: number | null
  revoked_at: number | null
}

function rowToRecord(row: PublicApiKeyRow, grants: string[]): PublicApiKeyRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    workspaceIds: row.all_workspaces === 1 ? null : [...grants].sort(),
    label: row.label,
    scope: row.scope as PublicApiScope,
    secretHash: row.secret_hash,
    createdByUserId: row.created_by_user_id,
    createdByKeyId: row.created_by_key_id,
    externalIdentity: row.external_identity,
    actsAsUserId: row.acts_as_user_id,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  }
}

/**
 * D1-backed store of the inbound public-API keys and their workspace grants (migrations 0034,
 * 0053, 0054, 0081, 0086, 0089, 0108). The secret is stored ONLY as a one-way peppered hash: this
 * repo never sees the raw key.
 */
export class D1PublicApiKeyRepository implements PublicApiKeyRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async add(record: PublicApiKeyRecord): Promise<void> {
    const grants = (record.workspaceIds ?? []).map((workspaceId) =>
      this.db
        .prepare('INSERT INTO public_api_key_workspaces (key_id, workspace_id) VALUES (?, ?)')
        .bind(record.id, workspaceId),
    )
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO public_api_keys
            (id, account_id, all_workspaces, label, scope, secret_hash, created_by_user_id, created_by_key_id, external_identity, acts_as_user_id, created_at, last_used_at, revoked_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          record.id,
          record.accountId,
          record.workspaceIds === null ? 1 : 0,
          record.label,
          record.scope,
          record.secretHash,
          record.createdByUserId,
          record.createdByKeyId,
          record.externalIdentity,
          record.actsAsUserId,
          record.createdAt,
          record.lastUsedAt,
          record.revokedAt,
        ),
      ...grants,
    ])
  }

  async getById(id: string): Promise<PublicApiKeyRecord | null> {
    const row = await this.db
      .prepare('SELECT * FROM public_api_keys WHERE id = ?')
      .bind(id)
      .first<PublicApiKeyRow>()
    if (!row) return null
    const grants = await this.grantsOf([row.id])
    return rowToRecord(row, grants.get(row.id) ?? [])
  }

  async listByAccount(accountId: string): Promise<PublicApiKeyRecord[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM public_api_keys
          WHERE account_id = ? AND revoked_at IS NULL
          ORDER BY created_at DESC`,
      )
      .bind(accountId)
      .all<PublicApiKeyRow>()
    const rows = results ?? []
    const grants = await this.grantsOf(rows.map((r) => r.id))
    return rows.map((row) => rowToRecord(row, grants.get(row.id) ?? []))
  }

  async markUsed(id: string, at: number): Promise<void> {
    await this.db
      .prepare('UPDATE public_api_keys SET last_used_at = ? WHERE id = ?')
      .bind(at, id)
      .run()
  }

  async revoke(accountId: string, id: string, at: number): Promise<void> {
    await this.db
      .prepare(
        'UPDATE public_api_keys SET revoked_at = ? WHERE id = ? AND account_id = ? AND revoked_at IS NULL',
      )
      .bind(at, id, accountId)
      .run()
  }

  async revokeMintedBy(accountId: string, minterId: string, at: number): Promise<void> {
    await this.db
      .prepare(
        'UPDATE public_api_keys SET revoked_at = ? WHERE created_by_key_id = ? AND account_id = ? AND revoked_at IS NULL',
      )
      .bind(at, minterId, accountId)
      .run()
  }

  /** The workspace grants of each key, chunked under D1's bound-parameter ceiling. */
  private async grantsOf(keyIds: string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>()
    for (const chunk of chunkForIn(keyIds)) {
      const placeholders = chunk.map(() => '?').join(', ')
      const { results } = await this.db
        .prepare(
          `SELECT key_id, workspace_id FROM public_api_key_workspaces WHERE key_id IN (${placeholders})`,
        )
        .bind(...chunk)
        .all<{ key_id: string; workspace_id: string }>()
      for (const row of results ?? []) {
        const list = out.get(row.key_id) ?? []
        list.push(row.workspace_id)
        out.set(row.key_id, list)
      }
    }
    return out
  }
}
