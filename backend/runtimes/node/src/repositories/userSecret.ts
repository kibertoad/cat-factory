import type { UserSecretRecord, UserSecretRepository } from '@cat-factory/kernel'
import type { UserSecretKind } from '@cat-factory/contracts'
import { and, asc, eq } from 'drizzle-orm'
import type { DrizzleDb } from '../db/client.js'
import { userSecrets } from '../db/schema.js'

// Postgres-backed store for a user's generic secrets (mirror of D1 migration 0009 /
// D1UserSecretRepository), keyed by (user_id, kind).

type Row = typeof userSecrets.$inferSelect

function toRecord(row: Row): UserSecretRecord {
  return {
    userId: row.user_id,
    kind: row.kind as UserSecretKind,
    label: row.label,
    secretCipher: row.secret_cipher,
    metadataJson: row.metadata_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class DrizzleUserSecretRepository implements UserSecretRepository {
  constructor(private readonly db: DrizzleDb) {}

  async listByUser(userId: string): Promise<UserSecretRecord[]> {
    const rows = await this.db
      .select()
      .from(userSecrets)
      .where(eq(userSecrets.user_id, userId))
      .orderBy(asc(userSecrets.created_at))
    return rows.map(toRecord)
  }

  async getByUserKind(userId: string, kind: UserSecretKind): Promise<UserSecretRecord | null> {
    const rows = await this.db
      .select()
      .from(userSecrets)
      .where(and(eq(userSecrets.user_id, userId), eq(userSecrets.kind, kind)))
      .limit(1)
    return rows[0] ? toRecord(rows[0]) : null
  }

  async upsert(record: UserSecretRecord): Promise<void> {
    await this.db
      .insert(userSecrets)
      .values({
        user_id: record.userId,
        kind: record.kind,
        label: record.label,
        secret_cipher: record.secretCipher,
        metadata_json: record.metadataJson,
        created_at: record.createdAt,
        updated_at: record.updatedAt,
      })
      .onConflictDoUpdate({
        target: [userSecrets.user_id, userSecrets.kind],
        set: {
          label: record.label,
          secret_cipher: record.secretCipher,
          metadata_json: record.metadataJson,
          updated_at: record.updatedAt,
        },
      })
  }

  async remove(userId: string, kind: UserSecretKind): Promise<void> {
    await this.db
      .delete(userSecrets)
      .where(and(eq(userSecrets.user_id, userId), eq(userSecrets.kind, kind)))
  }
}
