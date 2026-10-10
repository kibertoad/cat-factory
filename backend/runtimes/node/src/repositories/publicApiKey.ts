import type { PublicApiKeyRecord, PublicApiKeyRepository } from '@cat-factory/kernel'
import type { PublicApiScope } from '@cat-factory/contracts'
import { and, desc, eq, isNull } from 'drizzle-orm'
import type { DrizzleDb } from '../db/client.js'
import { publicApiKeys } from '../db/schema.js'

// Postgres-backed store of the inbound public-API keys (mirror of D1 migrations 0034 + 0053 +
// 0054 + 0081 + 0086 + 0089 / D1PublicApiKeyRepository, column-for-column, `scope`,
// `created_by_key_id`, `external_identity` and `acts_as_user_id` included). The secret is stored
// ONLY as a one-way peppered hash: this repo never sees the raw key.

type Row = typeof publicApiKeys.$inferSelect

function rowToRecord(row: Row): PublicApiKeyRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    workspaceId: row.workspace_id,
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
    await this.db.insert(publicApiKeys).values({
      id: record.id,
      account_id: record.accountId,
      workspace_id: record.workspaceId,
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
  }

  async getById(id: string): Promise<PublicApiKeyRecord | null> {
    const rows = await this.db.select().from(publicApiKeys).where(eq(publicApiKeys.id, id)).limit(1)
    const row = rows[0]
    return row ? rowToRecord(row) : null
  }

  async listByWorkspace(workspaceId: string): Promise<PublicApiKeyRecord[]> {
    const rows = await this.db
      .select()
      .from(publicApiKeys)
      .where(and(eq(publicApiKeys.workspace_id, workspaceId), isNull(publicApiKeys.revoked_at)))
      .orderBy(desc(publicApiKeys.created_at))
    return rows.map(rowToRecord)
  }

  async markUsed(id: string, at: number): Promise<void> {
    await this.db.update(publicApiKeys).set({ last_used_at: at }).where(eq(publicApiKeys.id, id))
  }

  async revoke(workspaceId: string, id: string, at: number): Promise<void> {
    await this.db
      .update(publicApiKeys)
      .set({ revoked_at: at })
      .where(
        and(
          eq(publicApiKeys.id, id),
          eq(publicApiKeys.workspace_id, workspaceId),
          isNull(publicApiKeys.revoked_at),
        ),
      )
  }

  async revokeMintedBy(workspaceId: string, minterId: string, at: number): Promise<void> {
    // One statement over the minter index, never a list-then-revoke: the set is small, but a
    // read-then-write would let a key minted between the two reads survive the cascade.
    await this.db
      .update(publicApiKeys)
      .set({ revoked_at: at })
      .where(
        and(
          eq(publicApiKeys.created_by_key_id, minterId),
          eq(publicApiKeys.workspace_id, workspaceId),
          isNull(publicApiKeys.revoked_at),
        ),
      )
  }
}
