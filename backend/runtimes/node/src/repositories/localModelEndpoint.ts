import type { LocalModelEndpointRecord, LocalModelEndpointRepository } from '@cat-factory/kernel'
import type { LocalRunner } from '@cat-factory/contracts'
import { and, asc, eq } from 'drizzle-orm'
import type { DrizzleDb } from '../db/client.js'
import { localModelEndpoints } from '../db/schema.js'

// Postgres-backed store for a user's locally-run model endpoints (mirror of D1
// migration 0002 / D1LocalModelEndpointRepository), keyed by (user_id, provider).

type Row = typeof localModelEndpoints.$inferSelect

function toRecord(row: Row): LocalModelEndpointRecord {
  return {
    userId: row.user_id,
    provider: row.provider as LocalRunner,
    label: row.label,
    baseUrl: row.base_url,
    apiKeyCipher: row.api_key_cipher,
    models: parseModels(row.models),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function parseModels(json: string): string[] {
  try {
    const parsed = JSON.parse(json)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

export class DrizzleLocalModelEndpointRepository implements LocalModelEndpointRepository {
  constructor(private readonly db: DrizzleDb) {}

  async listByUser(userId: string): Promise<LocalModelEndpointRecord[]> {
    const rows = await this.db
      .select()
      .from(localModelEndpoints)
      .where(eq(localModelEndpoints.user_id, userId))
      .orderBy(asc(localModelEndpoints.created_at))
    return rows.map(toRecord)
  }

  async getByUserProvider(
    userId: string,
    provider: LocalRunner,
  ): Promise<LocalModelEndpointRecord | null> {
    const rows = await this.db
      .select()
      .from(localModelEndpoints)
      .where(
        and(eq(localModelEndpoints.user_id, userId), eq(localModelEndpoints.provider, provider)),
      )
      .limit(1)
    return rows[0] ? toRecord(rows[0]) : null
  }

  async upsert(record: LocalModelEndpointRecord): Promise<void> {
    await this.db
      .insert(localModelEndpoints)
      .values({
        user_id: record.userId,
        provider: record.provider,
        label: record.label,
        base_url: record.baseUrl,
        api_key_cipher: record.apiKeyCipher,
        models: JSON.stringify(record.models),
        created_at: record.createdAt,
        updated_at: record.updatedAt,
      })
      .onConflictDoUpdate({
        target: [localModelEndpoints.user_id, localModelEndpoints.provider],
        set: {
          label: record.label,
          base_url: record.baseUrl,
          api_key_cipher: record.apiKeyCipher,
          models: JSON.stringify(record.models),
          updated_at: record.updatedAt,
        },
      })
  }

  async remove(userId: string, provider: LocalRunner): Promise<void> {
    await this.db
      .delete(localModelEndpoints)
      .where(
        and(eq(localModelEndpoints.user_id, userId), eq(localModelEndpoints.provider, provider)),
      )
  }
}
