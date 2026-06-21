import type {
  ProviderSubscriptionTokenRecord,
  ProviderSubscriptionTokenRepository,
  SubscriptionVendor,
} from '@cat-factory/kernel'
import { and, asc, eq, isNull, sql } from 'drizzle-orm'
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

  async markLeased(workspaceId: string, id: string, at: number): Promise<void> {
    await this.db
      .update(providerSubscriptionTokens)
      .set({ last_used_at: at })
      .where(
        and(
          eq(providerSubscriptionTokens.id, id),
          eq(providerSubscriptionTokens.workspace_id, workspaceId),
        ),
      )
  }

  async recordUsage(
    workspaceId: string,
    id: string,
    usage: { inputTokens: number; outputTokens: number },
    at: number,
    windowMs: number,
  ): Promise<void> {
    // A single atomic statement (no read-modify-write) so two jobs finishing on the
    // same token can't lose each other's counters — mirrors the D1 repository. The
    // window-active test is evaluated against the row's pre-update values in every
    // branch: a stale window resets to `at` and counts from this run; an active one
    // accumulates.
    const cols = providerSubscriptionTokens
    const active = sql`(${cols.window_started_at} IS NOT NULL AND ${at} - ${cols.window_started_at} < ${windowMs})`
    await this.db
      .update(cols)
      .set({
        window_started_at: sql`CASE WHEN ${active} THEN ${cols.window_started_at} ELSE ${at} END`,
        input_tokens: sql`CASE WHEN ${active} THEN ${cols.input_tokens} ELSE 0 END + ${usage.inputTokens}`,
        output_tokens: sql`CASE WHEN ${active} THEN ${cols.output_tokens} ELSE 0 END + ${usage.outputTokens}`,
        request_count: sql`CASE WHEN ${active} THEN ${cols.request_count} ELSE 0 END + 1`,
      })
      .where(and(eq(cols.id, id), eq(cols.workspace_id, workspaceId)))
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
