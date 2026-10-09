import type { PublicApiKeyRecord, PublicApiKeyRepository } from '@cat-factory/kernel'
import type { PublicApiScope } from '@cat-factory/contracts'
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import type { DrizzleDb } from '../db/client.js'
import { publicApiKeyWorkspaces, publicApiKeys } from '../db/schema.js'

// Postgres-backed store of the inbound public-API keys and their workspace grants (mirror of D1
// migrations 0034 + 0053 + 0054 + 0081 + 0086 + 0089 + 0108 / D1PublicApiKeyRepository). The
// secret is stored ONLY as a one-way peppered hash: this repo never sees the raw key.

type Row = typeof publicApiKeys.$inferSelect

function rowToRecord(row: Row, grants: string[]): PublicApiKeyRecord {
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

export class DrizzlePublicApiKeyRepository implements PublicApiKeyRepository {
  constructor(private readonly db: DrizzleDb) {}

  async add(record: PublicApiKeyRecord): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.insert(publicApiKeys).values({
        id: record.id,
        account_id: record.accountId,
        all_workspaces: record.workspaceIds === null ? 1 : 0,
        label: record.label,
        scope: record.scope,
        secret_hash: record.secretHash,
        created_by_user_id: record.createdByUserId,
        created_by_key_id: record.createdByKeyId,
        external_identity: record.externalIdentity,
        acts_as_user_id: record.actsAsUserId,
        created_at: record.createdAt,
        last_used_at: record.lastUsedAt,
        revoked_at: record.revokedAt,
      })
      if (record.workspaceIds !== null && record.workspaceIds.length > 0) {
        await tx
          .insert(publicApiKeyWorkspaces)
          .values(record.workspaceIds.map((id) => ({ key_id: record.id, workspace_id: id })))
      }
    })
  }

  async getById(id: string): Promise<PublicApiKeyRecord | null> {
    const rows = await this.db.select().from(publicApiKeys).where(eq(publicApiKeys.id, id)).limit(1)
    const row = rows[0]
    if (!row) return null
    const grants = await this.grantsOf([row.id])
    return rowToRecord(row, grants.get(row.id) ?? [])
  }

  async listByAccount(accountId: string): Promise<PublicApiKeyRecord[]> {
    const rows = await this.db
      .select()
      .from(publicApiKeys)
      .where(and(eq(publicApiKeys.account_id, accountId), isNull(publicApiKeys.revoked_at)))
      .orderBy(desc(publicApiKeys.created_at))
    const grants = await this.grantsOf(rows.map((r) => r.id))
    return rows.map((row) => rowToRecord(row, grants.get(row.id) ?? []))
  }

  async markUsed(id: string, at: number): Promise<void> {
    await this.db.update(publicApiKeys).set({ last_used_at: at }).where(eq(publicApiKeys.id, id))
  }

  async revoke(accountId: string, id: string, at: number): Promise<void> {
    await this.db
      .update(publicApiKeys)
      .set({ revoked_at: at })
      .where(
        and(
          eq(publicApiKeys.id, id),
          eq(publicApiKeys.account_id, accountId),
          isNull(publicApiKeys.revoked_at),
        ),
      )
  }

  async revokeMintedBy(accountId: string, minterId: string, at: number): Promise<void> {
    await this.db
      .update(publicApiKeys)
      .set({ revoked_at: at })
      .where(
        and(
          eq(publicApiKeys.created_by_key_id, minterId),
          eq(publicApiKeys.account_id, accountId),
          isNull(publicApiKeys.revoked_at),
        ),
      )
  }

  /** The workspace grants of each key, in one read. */
  private async grantsOf(keyIds: string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>()
    if (keyIds.length === 0) return out
    const rows = await this.db
      .select()
      .from(publicApiKeyWorkspaces)
      .where(inArray(publicApiKeyWorkspaces.key_id, keyIds))
    for (const row of rows) {
      const list = out.get(row.key_id) ?? []
      list.push(row.workspace_id)
      out.set(row.key_id, list)
    }
    return out
  }
}
