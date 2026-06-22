import type {
  ApiKeyProvider,
  ApiKeyScope,
  ApiKeyScopeRef,
  ProviderApiKeyRecord,
  ProviderApiKeyRepository,
} from '@cat-factory/kernel'
import { and, asc, eq, isNull, or, sql } from 'drizzle-orm'
import type { DrizzleDb } from '../db/client.js'
import { providerApiKeys } from '../db/schema.js'

// Postgres-backed store of the direct-provider API-key pool (mirror of D1
// migration 0042 / D1ProviderApiKeyRepository), column-for-column.

type Row = typeof providerApiKeys.$inferSelect

function rowToRecord(row: Row): ProviderApiKeyRecord {
  return {
    id: row.id,
    scope: row.scope as ApiKeyScope,
    scopeId: row.scope_id,
    provider: row.provider as ApiKeyProvider,
    label: row.label,
    keyCipher: row.key_cipher,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    windowStartedAt: row.window_started_at,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    requestCount: row.request_count,
    deletedAt: row.deleted_at,
  }
}

/** OR-predicate matching any of the given (scope, scopeId) segments. */
function scopeMatch(scopes: ApiKeyScopeRef[]) {
  return or(
    ...scopes.map((s) =>
      and(eq(providerApiKeys.scope, s.scope), eq(providerApiKeys.scope_id, s.scopeId)),
    ),
  )
}

export class DrizzleProviderApiKeyRepository implements ProviderApiKeyRepository {
  constructor(private readonly db: DrizzleDb) {}

  async listByScope(
    scope: ApiKeyScope,
    scopeId: string,
    provider: ApiKeyProvider,
  ): Promise<ProviderApiKeyRecord[]> {
    const rows = await this.db
      .select()
      .from(providerApiKeys)
      .where(
        and(
          eq(providerApiKeys.scope, scope),
          eq(providerApiKeys.scope_id, scopeId),
          eq(providerApiKeys.provider, provider),
          isNull(providerApiKeys.deleted_at),
        ),
      )
      .orderBy(asc(providerApiKeys.created_at))
    return rows.map(rowToRecord)
  }

  async listForPool(
    scopes: ApiKeyScopeRef[],
    provider: ApiKeyProvider,
  ): Promise<ProviderApiKeyRecord[]> {
    if (scopes.length === 0) return []
    const rows = await this.db
      .select()
      .from(providerApiKeys)
      .where(
        and(
          scopeMatch(scopes),
          eq(providerApiKeys.provider, provider),
          isNull(providerApiKeys.deleted_at),
        ),
      )
      .orderBy(asc(providerApiKeys.created_at))
    return rows.map(rowToRecord)
  }

  async listConfiguredProviders(scopes: ApiKeyScopeRef[]): Promise<ApiKeyProvider[]> {
    if (scopes.length === 0) return []
    const rows = await this.db
      .selectDistinct({ provider: providerApiKeys.provider })
      .from(providerApiKeys)
      .where(and(scopeMatch(scopes), isNull(providerApiKeys.deleted_at)))
    return rows.map((r) => r.provider as ApiKeyProvider)
  }

  async getById(
    scope: ApiKeyScope,
    scopeId: string,
    id: string,
  ): Promise<ProviderApiKeyRecord | null> {
    const rows = await this.db
      .select()
      .from(providerApiKeys)
      .where(
        and(
          eq(providerApiKeys.id, id),
          eq(providerApiKeys.scope, scope),
          eq(providerApiKeys.scope_id, scopeId),
          isNull(providerApiKeys.deleted_at),
        ),
      )
      .limit(1)
    const row = rows[0]
    return row ? rowToRecord(row) : null
  }

  async add(record: ProviderApiKeyRecord): Promise<void> {
    await this.db.insert(providerApiKeys).values({
      id: record.id,
      scope: record.scope,
      scope_id: record.scopeId,
      provider: record.provider,
      label: record.label,
      key_cipher: record.keyCipher,
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
      .update(providerApiKeys)
      .set({ last_used_at: at })
      .where(eq(providerApiKeys.id, id))
  }

  async recordUsage(
    id: string,
    usage: { inputTokens: number; outputTokens: number },
    at: number,
    windowMs: number,
  ): Promise<void> {
    // A single atomic statement (no read-modify-write) — mirrors the D1 repo and
    // the subscription pool. Keyed by row id alone (the leased key may belong to
    // any scope segment merged at lease time).
    const cols = providerApiKeys
    const active = sql`(${cols.window_started_at} IS NOT NULL AND ${at} - ${cols.window_started_at} < ${windowMs})`
    await this.db
      .update(cols)
      .set({
        window_started_at: sql`CASE WHEN ${active} THEN ${cols.window_started_at} ELSE ${at} END`,
        input_tokens: sql`CASE WHEN ${active} THEN ${cols.input_tokens} ELSE 0 END + ${usage.inputTokens}`,
        output_tokens: sql`CASE WHEN ${active} THEN ${cols.output_tokens} ELSE 0 END + ${usage.outputTokens}`,
        request_count: sql`CASE WHEN ${active} THEN ${cols.request_count} ELSE 0 END + 1`,
      })
      .where(eq(cols.id, id))
  }

  async softDelete(scope: ApiKeyScope, scopeId: string, id: string, at: number): Promise<void> {
    await this.db
      .update(providerApiKeys)
      .set({ deleted_at: at })
      .where(
        and(
          eq(providerApiKeys.id, id),
          eq(providerApiKeys.scope, scope),
          eq(providerApiKeys.scope_id, scopeId),
          isNull(providerApiKeys.deleted_at),
        ),
      )
  }
}
