import type {
  ApiKeyProvider,
  ApiKeyScope,
  ApiKeyScopeRef,
  ProviderApiKeyRecord,
  ProviderApiKeyRepository,
} from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'

interface ProviderApiKeyRow {
  id: string
  scope: string
  scope_id: string
  provider: string
  label: string
  key_cipher: string
  created_at: number
  last_used_at: number | null
  window_started_at: number | null
  input_tokens: number
  output_tokens: number
  request_count: number
  deleted_at: number | null
}

function rowToRecord(row: ProviderApiKeyRow): ProviderApiKeyRecord {
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

/** D1-backed store of the direct-provider API-key pool (migration 0042). */
export class D1ProviderApiKeyRepository implements ProviderApiKeyRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async listByScope(
    scope: ApiKeyScope,
    scopeId: string,
    provider?: ApiKeyProvider,
  ): Promise<ProviderApiKeyRecord[]> {
    const providerFilter = provider ? ' AND provider = ?' : ''
    const binds = provider ? [scope, scopeId, provider] : [scope, scopeId]
    const { results } = await this.db
      .prepare(
        `SELECT * FROM provider_api_keys
          WHERE scope = ? AND scope_id = ?${providerFilter} AND deleted_at IS NULL
          ORDER BY created_at ASC`,
      )
      .bind(...binds)
      .all<ProviderApiKeyRow>()
    return (results ?? []).map(rowToRecord)
  }

  async listForPool(
    scopes: ApiKeyScopeRef[],
    provider: ApiKeyProvider,
  ): Promise<ProviderApiKeyRecord[]> {
    if (scopes.length === 0) return []
    const pairs = scopes.map(() => '(scope = ? AND scope_id = ?)').join(' OR ')
    const binds: string[] = []
    for (const s of scopes) binds.push(s.scope, s.scopeId)
    binds.push(provider)
    const { results } = await this.db
      .prepare(
        `SELECT * FROM provider_api_keys
          WHERE (${pairs}) AND provider = ? AND deleted_at IS NULL
          ORDER BY created_at ASC`,
      )
      .bind(...binds)
      .all<ProviderApiKeyRow>()
    return (results ?? []).map(rowToRecord)
  }

  async listConfiguredProviders(scopes: ApiKeyScopeRef[]): Promise<ApiKeyProvider[]> {
    if (scopes.length === 0) return []
    const pairs = scopes.map(() => '(scope = ? AND scope_id = ?)').join(' OR ')
    const binds: string[] = []
    for (const s of scopes) binds.push(s.scope, s.scopeId)
    const { results } = await this.db
      .prepare(
        `SELECT DISTINCT provider FROM provider_api_keys
          WHERE (${pairs}) AND deleted_at IS NULL`,
      )
      .bind(...binds)
      .all<{ provider: string }>()
    return (results ?? []).map((r) => r.provider as ApiKeyProvider)
  }

  async getById(
    scope: ApiKeyScope,
    scopeId: string,
    id: string,
  ): Promise<ProviderApiKeyRecord | null> {
    const row = await this.db
      .prepare(
        'SELECT * FROM provider_api_keys WHERE id = ? AND scope = ? AND scope_id = ? AND deleted_at IS NULL',
      )
      .bind(id, scope, scopeId)
      .first<ProviderApiKeyRow>()
    return row ? rowToRecord(row) : null
  }

  async add(record: ProviderApiKeyRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO provider_api_keys
          (id, scope, scope_id, provider, label, key_cipher, created_at, last_used_at,
           window_started_at, input_tokens, output_tokens, request_count, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .bind(
        record.id,
        record.scope,
        record.scopeId,
        record.provider,
        record.label,
        record.keyCipher,
        record.createdAt,
        record.lastUsedAt,
        record.windowStartedAt,
        record.inputTokens,
        record.outputTokens,
        record.requestCount,
      )
      .run()
  }

  async markLeased(id: string, at: number): Promise<void> {
    await this.db
      .prepare('UPDATE provider_api_keys SET last_used_at = ? WHERE id = ?')
      .bind(at, id)
      .run()
  }

  async recordUsage(
    id: string,
    usage: { inputTokens: number; outputTokens: number },
    at: number,
    windowMs: number,
  ): Promise<void> {
    // A single atomic statement (no read-modify-write) — mirrors the subscription
    // repo. Keyed by row id alone: a leased key may belong to any scope segment.
    const active = '(window_started_at IS NOT NULL AND ? - window_started_at < ?)'
    await this.db
      .prepare(
        `UPDATE provider_api_keys
          SET window_started_at = CASE WHEN ${active} THEN window_started_at ELSE ? END,
              input_tokens      = CASE WHEN ${active} THEN input_tokens  ELSE 0 END + ?,
              output_tokens     = CASE WHEN ${active} THEN output_tokens ELSE 0 END + ?,
              request_count     = CASE WHEN ${active} THEN request_count ELSE 0 END + 1
          WHERE id = ?`,
      )
      .bind(
        at,
        windowMs,
        at,
        at,
        windowMs,
        usage.inputTokens,
        at,
        windowMs,
        usage.outputTokens,
        at,
        windowMs,
        id,
      )
      .run()
  }

  async softDelete(scope: ApiKeyScope, scopeId: string, id: string, at: number): Promise<void> {
    await this.db
      .prepare(
        'UPDATE provider_api_keys SET deleted_at = ? WHERE id = ? AND scope = ? AND scope_id = ? AND deleted_at IS NULL',
      )
      .bind(at, id, scope, scopeId)
      .run()
  }
}
