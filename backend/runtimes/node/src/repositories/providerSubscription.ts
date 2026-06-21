import type {
  ProviderSubscriptionTokenRecord,
  ProviderSubscriptionTokenRepository,
  SubscriptionVendor,
} from '@cat-factory/kernel'
import { and, asc, eq, isNull } from 'drizzle-orm'
import type { DrizzleDb } from '../db/client.js'
import { providerSubscriptionTokens } from '../db/schema.js'

// Postgres-backed store of a workspace's subscription token pool (mirror of D1
// migration 0035 / D1ProviderSubscriptionTokenRepository), column-for-column so
// behaviour matches across stores.

type Row = typeof providerSubscriptionTokens.$inferSelect

function rowToRecord(row: Row): ProviderSubscriptionTokenRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    vendor: row.vendor as SubscriptionVendor,
    label: row.label,
    tokenCipher: row.token_cipher,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    windowStartedAt: row.window_started_at,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    requestCount: row.request_count,
    deletedAt: row.deleted_at,
  }
}

export class DrizzleProviderSubscriptionTokenRepository implements ProviderSubscriptionTokenRepository {
  constructor(private readonly db: DrizzleDb) {}

  async listByVendor(
    workspaceId: string,
    vendor: SubscriptionVendor,
  ): Promise<ProviderSubscriptionTokenRecord[]> {
    const rows = await this.db
      .select()
      .from(providerSubscriptionTokens)
      .where(
        and(
          eq(providerSubscriptionTokens.workspace_id, workspaceId),
          eq(providerSubscriptionTokens.vendor, vendor),
          isNull(providerSubscriptionTokens.deleted_at),
        ),
      )
      .orderBy(asc(providerSubscriptionTokens.created_at))
    return rows.map(rowToRecord)
  }

  async getById(workspaceId: string, id: string): Promise<ProviderSubscriptionTokenRecord | null> {
    const rows = await this.db
      .select()
      .from(providerSubscriptionTokens)
      .where(
        and(
          eq(providerSubscriptionTokens.id, id),
          eq(providerSubscriptionTokens.workspace_id, workspaceId),
          isNull(providerSubscriptionTokens.deleted_at),
        ),
      )
      .limit(1)
    const row = rows[0]
    return row ? rowToRecord(row) : null
  }

  async add(record: ProviderSubscriptionTokenRecord): Promise<void> {
    await this.db.insert(providerSubscriptionTokens).values({
      id: record.id,
      workspace_id: record.workspaceId,
      vendor: record.vendor,
      label: record.label,
      token_cipher: record.tokenCipher,
      created_at: record.createdAt,
      last_used_at: record.lastUsedAt,
      window_started_at: record.windowStartedAt,
      input_tokens: record.inputTokens,
      output_tokens: record.outputTokens,
      request_count: record.requestCount,
      deleted_at: record.deletedAt,
    })
  }

  async markLeased(id: string, at: number): Promise<void> {
    await this.db
      .update(providerSubscriptionTokens)
      .set({ last_used_at: at })
      .where(eq(providerSubscriptionTokens.id, id))
  }

  async recordUsage(
    id: string,
    usage: { inputTokens: number; outputTokens: number },
    at: number,
    windowMs: number,
  ): Promise<void> {
    const rows = await this.db
      .select()
      .from(providerSubscriptionTokens)
      .where(eq(providerSubscriptionTokens.id, id))
      .limit(1)
    const row = rows[0]
    if (!row) return
    const windowActive = row.window_started_at != null && at - row.window_started_at < windowMs
    await this.db
      .update(providerSubscriptionTokens)
      .set({
        window_started_at: windowActive ? row.window_started_at : at,
        input_tokens: (windowActive ? row.input_tokens : 0) + usage.inputTokens,
        output_tokens: (windowActive ? row.output_tokens : 0) + usage.outputTokens,
        request_count: (windowActive ? row.request_count : 0) + 1,
      })
      .where(eq(providerSubscriptionTokens.id, id))
  }

  async softDelete(workspaceId: string, id: string, at: number): Promise<void> {
    await this.db
      .update(providerSubscriptionTokens)
      .set({ deleted_at: at })
      .where(
        and(
          eq(providerSubscriptionTokens.id, id),
          eq(providerSubscriptionTokens.workspace_id, workspaceId),
          isNull(providerSubscriptionTokens.deleted_at),
        ),
      )
  }
}
