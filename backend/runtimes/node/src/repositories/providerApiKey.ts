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
    enabled: row.enabled !== 0,
    isDefault: row.is_default !== 0,
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
    provider?: ApiKeyProvider,
  ): Promise<ProviderApiKeyRecord[]> {
    const rows = await this.db
      .select()
      .from(providerApiKeys)
      .where(
        and(
          eq(providerApiKeys.scope, scope),
          eq(providerApiKeys.scope_id, scopeId),
          provider ? eq(providerApiKeys.provider, provider) : undefined,
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
          eq(providerApiKeys.enabled, 1),
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
      .where(
        and(scopeMatch(scopes), isNull(providerApiKeys.deleted_at), eq(providerApiKeys.enabled, 1)),
      )
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
      enabled: record.enabled ? 1 : 0,
      is_default: record.isDefault ? 1 : 0,
      deleted_at: record.deletedAt,
    })
  }

  async markLeased(id: string, at: number): Promise<void> {
    await this.db
      .update(providerApiKeys)
      .set({ last_used_at: at })
      .where(eq(providerApiKeys.id, id))
  }

  async leaseLeastUsed(
    scopes: ApiKeyScopeRef[],
    provider: ApiKeyProvider,
    now: number,
    windowMs: number,
  ): Promise<ProviderApiKeyRecord | null> {
    if (scopes.length === 0) return null
    // Pick-and-mark atomically inside one transaction: the winner is selected by the same
    // policy as `chooseToken` — a pinned default (is_default = 1) first, then least
    // rolling-window usage, then least-recently-leased (NULL last_used_at first), then oldest —
    // over the ENABLED keys only, under `FOR UPDATE SKIP LOCKED`, so two concurrent leases
    // never select the same row (the second skips the locked winner and rotates to the next
    // key) — the fix for the non-transactional read→choose→mark race.
    const usage = sql`CASE WHEN ${providerApiKeys.window_started_at} IS NULL
                            OR ${now} - ${providerApiKeys.window_started_at} >= ${windowMs}
                          THEN 0
                          ELSE ${providerApiKeys.input_tokens} + ${providerApiKeys.output_tokens} END`
    return this.db.transaction(async (tx) => {
      const picked = await tx
        .select({ id: providerApiKeys.id })
        .from(providerApiKeys)
        .where(
          and(
            scopeMatch(scopes),
            eq(providerApiKeys.provider, provider),
            isNull(providerApiKeys.deleted_at),
            eq(providerApiKeys.enabled, 1),
          ),
        )
        .orderBy(
          sql`${providerApiKeys.is_default} DESC`,
          sql`${usage} ASC`,
          sql`${providerApiKeys.last_used_at} ASC NULLS FIRST`,
          asc(providerApiKeys.created_at),
        )
        .limit(1)
        .for('update', { skipLocked: true })
      const id = picked[0]?.id
      if (!id) return null
      const rows = await tx
        .update(providerApiKeys)
        .set({ last_used_at: now })
        .where(eq(providerApiKeys.id, id))
        .returning()
      return rows[0] ? rowToRecord(rows[0]) : null
    })
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

  async setEnabled(
    scope: ApiKeyScope,
    scopeId: string,
    id: string,
    enabled: boolean,
  ): Promise<void> {
    await this.db
      .update(providerApiKeys)
      .set({ enabled: enabled ? 1 : 0 })
      .where(
        and(
          eq(providerApiKeys.id, id),
          eq(providerApiKeys.scope, scope),
          eq(providerApiKeys.scope_id, scopeId),
          isNull(providerApiKeys.deleted_at),
        ),
      )
  }

  async setDefault(
    scope: ApiKeyScope,
    scopeId: string,
    provider: ApiKeyProvider,
    id: string | null,
  ): Promise<void> {
    const cols = providerApiKeys
    // Clear the group's default first (at most one per scope+scope_id+provider), then pin it.
    await this.db
      .update(cols)
      .set({ is_default: 0 })
      .where(
        and(
          eq(cols.scope, scope),
          eq(cols.scope_id, scopeId),
          eq(cols.provider, provider),
          isNull(cols.deleted_at),
        ),
      )
    if (id !== null) {
      await this.db
        .update(cols)
        .set({ is_default: 1 })
        .where(
          and(
            eq(cols.id, id),
            eq(cols.scope, scope),
            eq(cols.scope_id, scopeId),
            eq(cols.provider, provider),
            isNull(cols.deleted_at),
          ),
        )
    }
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
