import { DatabaseSync } from 'node:sqlite'
import type {
  ApiKeyProvider,
  ApiKeyScope,
  ApiKeyScopeRef,
  LocalModelEndpointRecord,
  LocalModelEndpointRepository,
  ProviderApiKeyRecord,
  ProviderApiKeyRepository,
} from '@cat-factory/kernel'
import type { LocalRunner } from '@cat-factory/contracts'

// The mothership-mode LOCAL credential store.
//
// In mothership mode the local node runs NO main database — every org/durable repository
// call is forwarded to the hosted mothership over the persistence RPC (see
// `@cat-factory/server` `persistence/`). The deliberate exception is the agent/model
// CREDENTIALS: they are kept on the developer's machine, sealed with a LOCAL key, so the
// mothership's `ENCRYPTION_KEY` never has to reach the laptop (confirmed product decision 3
// in `docs/initiatives/mothership-mode.md`). This module is their persistence: a file-based
// `node:sqlite` store implementing the two `local-sqlite` bucket ports —
// `providerApiKeyRepository` (the direct-vendor API-key pool) and `localModelEndpointRepository`
// (per-user locally-run model endpoints).
//
// It stores ONLY the sealed `keyCipher` / `apiKeyCipher` envelopes the service layer hands
// it (the cipher itself is wired at composition time with the local key), so this layer is
// crypto-agnostic. The schema mirrors the Drizzle/D1 columns column-for-column, and the
// repositories mirror `DrizzleProviderApiKeyRepository` / `DrizzleLocalModelEndpointRepository`
// behaviour exactly (usage-window rotation, lease-least-used ordering, upsert preserving
// `createdAt`) so a mothership-mode node pools and rotates keys identically to a Postgres one.
//
// `node:sqlite`'s `DatabaseSync` is synchronous and single-process, so `leaseLeastUsed`'s
// select-then-mark is inherently atomic: no other JavaScript runs between the two statements,
// which is exactly the race the Postgres repo guards with `FOR UPDATE SKIP LOCKED`. The port
// methods return Promises (to honour the async interface) but execute synchronously.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS provider_api_keys (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  label TEXT NOT NULL,
  key_cipher TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  window_started_at INTEGER,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  request_count INTEGER NOT NULL DEFAULT 0,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS provider_api_keys_pool
  ON provider_api_keys (scope, scope_id, provider, deleted_at);

CREATE TABLE IF NOT EXISTS local_model_endpoints (
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  label TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_key_cipher TEXT,
  models TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, provider)
);
`

/** Open (creating if absent) the local credential SQLite database and ensure its schema. */
export function openLocalCredentialDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path)
  // WAL keeps readers and the single writer from blocking each other; the busy timeout
  // absorbs a brief lock contention (e.g. an OS sync) instead of throwing SQLITE_BUSY.
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec(SCHEMA)
  return db
}

// ---------------------------------------------------------------------------
// provider_api_keys
// ---------------------------------------------------------------------------

interface ApiKeyRow {
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

function apiKeyRowToRecord(row: ApiKeyRow): ProviderApiKeyRecord {
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

const API_KEY_COLUMNS =
  'id, scope, scope_id, provider, label, key_cipher, created_at, last_used_at, ' +
  'window_started_at, input_tokens, output_tokens, request_count, deleted_at'

/** Build an `(scope = ? AND scope_id = ?) OR …` predicate plus its flattened params. */
function scopeMatch(scopes: ApiKeyScopeRef[]): { sql: string; params: string[] } {
  const sql = scopes.map(() => '(scope = ? AND scope_id = ?)').join(' OR ')
  const params = scopes.flatMap((s) => [s.scope, s.scopeId])
  return { sql: `(${sql})`, params }
}

export class SqliteProviderApiKeyRepository implements ProviderApiKeyRepository {
  constructor(private readonly db: DatabaseSync) {}

  async listByScope(
    scope: ApiKeyScope,
    scopeId: string,
    provider?: ApiKeyProvider,
  ): Promise<ProviderApiKeyRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT ${API_KEY_COLUMNS} FROM provider_api_keys
         WHERE scope = ? AND scope_id = ?
           ${provider ? 'AND provider = ?' : ''}
           AND deleted_at IS NULL
         ORDER BY created_at ASC`,
      )
      .all(...(provider ? [scope, scopeId, provider] : [scope, scopeId])) as unknown as ApiKeyRow[]
    return rows.map(apiKeyRowToRecord)
  }

  async listForPool(
    scopes: ApiKeyScopeRef[],
    provider: ApiKeyProvider,
  ): Promise<ProviderApiKeyRecord[]> {
    if (scopes.length === 0) return []
    const match = scopeMatch(scopes)
    const rows = this.db
      .prepare(
        `SELECT ${API_KEY_COLUMNS} FROM provider_api_keys
         WHERE ${match.sql} AND provider = ? AND deleted_at IS NULL
         ORDER BY created_at ASC`,
      )
      .all(...match.params, provider) as unknown as ApiKeyRow[]
    return rows.map(apiKeyRowToRecord)
  }

  async listConfiguredProviders(scopes: ApiKeyScopeRef[]): Promise<ApiKeyProvider[]> {
    if (scopes.length === 0) return []
    const match = scopeMatch(scopes)
    const rows = this.db
      .prepare(
        `SELECT DISTINCT provider FROM provider_api_keys
         WHERE ${match.sql} AND deleted_at IS NULL`,
      )
      .all(...match.params) as unknown as { provider: string }[]
    return rows.map((r) => r.provider as ApiKeyProvider)
  }

  async getById(
    scope: ApiKeyScope,
    scopeId: string,
    id: string,
  ): Promise<ProviderApiKeyRecord | null> {
    const row = this.db
      .prepare(
        `SELECT ${API_KEY_COLUMNS} FROM provider_api_keys
         WHERE id = ? AND scope = ? AND scope_id = ? AND deleted_at IS NULL
         LIMIT 1`,
      )
      .get(id, scope, scopeId) as unknown as ApiKeyRow | undefined
    return row ? apiKeyRowToRecord(row) : null
  }

  async add(record: ProviderApiKeyRecord): Promise<void> {
    // A newly added key is always live, so `deleted_at` is forced NULL on insert (matching the
    // D1 repo) — a tombstone is only ever set later by `softDelete`, never carried in at birth.
    this.db
      .prepare(
        `INSERT INTO provider_api_keys
           (${API_KEY_COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
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
  }

  async markLeased(id: string, at: number): Promise<void> {
    this.db.prepare('UPDATE provider_api_keys SET last_used_at = ? WHERE id = ?').run(at, id)
  }

  async leaseLeastUsed(
    scopes: ApiKeyScopeRef[],
    provider: ApiKeyProvider,
    now: number,
    windowMs: number,
  ): Promise<ProviderApiKeyRecord | null> {
    if (scopes.length === 0) return null
    const match = scopeMatch(scopes)
    // Mirror `chooseToken` / the Drizzle repo: rolling-window usage ASC, then
    // least-recently-leased (NULL last_used_at first — SQLite sorts NULLs first in ASC, but
    // be explicit), then oldest-created. Synchronous select-then-mark is atomic here (no
    // interleaving), so no `FOR UPDATE` analogue is needed.
    const usage = `CASE WHEN window_started_at IS NULL OR ? - window_started_at >= ?
                        THEN 0 ELSE input_tokens + output_tokens END`
    const picked = this.db
      .prepare(
        `SELECT id FROM provider_api_keys
         WHERE ${match.sql} AND provider = ? AND deleted_at IS NULL
         ORDER BY (${usage}) ASC, last_used_at ASC NULLS FIRST, created_at ASC
         LIMIT 1`,
      )
      .get(...match.params, provider, now, windowMs) as { id: string } | undefined
    const id = picked?.id
    if (!id) return null
    this.db.prepare('UPDATE provider_api_keys SET last_used_at = ? WHERE id = ?').run(now, id)
    const row = this.db
      .prepare(`SELECT ${API_KEY_COLUMNS} FROM provider_api_keys WHERE id = ?`)
      .get(id) as unknown as ApiKeyRow | undefined
    return row ? apiKeyRowToRecord(row) : null
  }

  async recordUsage(
    id: string,
    usage: { inputTokens: number; outputTokens: number },
    at: number,
    windowMs: number,
  ): Promise<void> {
    // One atomic statement (no read-modify-write), mirroring the Drizzle/D1 repos: keep the
    // window's counters when it is still active, else reset it to `at` and start from this
    // call. Named parameters so the repeated `:at`/`:windowMs` bind once and can't drift.
    const active = '(window_started_at IS NOT NULL AND :at - window_started_at < :windowMs)'
    this.db
      .prepare(
        `UPDATE provider_api_keys SET
           window_started_at = CASE WHEN ${active} THEN window_started_at ELSE :at END,
           input_tokens = CASE WHEN ${active} THEN input_tokens ELSE 0 END + :inTokens,
           output_tokens = CASE WHEN ${active} THEN output_tokens ELSE 0 END + :outTokens,
           request_count = CASE WHEN ${active} THEN request_count ELSE 0 END + 1
         WHERE id = :id`,
      )
      .run({
        at,
        windowMs,
        inTokens: usage.inputTokens,
        outTokens: usage.outputTokens,
        id,
      })
  }

  async softDelete(scope: ApiKeyScope, scopeId: string, id: string, at: number): Promise<void> {
    this.db
      .prepare(
        `UPDATE provider_api_keys SET deleted_at = ?
         WHERE id = ? AND scope = ? AND scope_id = ? AND deleted_at IS NULL`,
      )
      .run(at, id, scope, scopeId)
  }
}

// ---------------------------------------------------------------------------
// local_model_endpoints
// ---------------------------------------------------------------------------

interface LocalEndpointRow {
  user_id: string
  provider: string
  label: string
  base_url: string
  api_key_cipher: string | null
  models: string
  created_at: number
  updated_at: number
}

function endpointRowToRecord(row: LocalEndpointRow): LocalModelEndpointRecord {
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

const ENDPOINT_COLUMNS =
  'user_id, provider, label, base_url, api_key_cipher, models, created_at, updated_at'

export class SqliteLocalModelEndpointRepository implements LocalModelEndpointRepository {
  constructor(private readonly db: DatabaseSync) {}

  async listByUser(userId: string): Promise<LocalModelEndpointRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT ${ENDPOINT_COLUMNS} FROM local_model_endpoints
         WHERE user_id = ? ORDER BY created_at ASC`,
      )
      .all(userId) as unknown as LocalEndpointRow[]
    return rows.map(endpointRowToRecord)
  }

  async getByUserProvider(
    userId: string,
    provider: LocalRunner,
  ): Promise<LocalModelEndpointRecord | null> {
    const row = this.db
      .prepare(
        `SELECT ${ENDPOINT_COLUMNS} FROM local_model_endpoints
         WHERE user_id = ? AND provider = ? LIMIT 1`,
      )
      .get(userId, provider) as unknown as LocalEndpointRow | undefined
    return row ? endpointRowToRecord(row) : null
  }

  async upsert(record: LocalModelEndpointRecord): Promise<void> {
    // Mirror the Drizzle upsert: on conflict, PRESERVE the original `created_at` (only the
    // mutable fields + `updated_at` are overwritten).
    this.db
      .prepare(
        `INSERT INTO local_model_endpoints (${ENDPOINT_COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id, provider) DO UPDATE SET
           label = excluded.label,
           base_url = excluded.base_url,
           api_key_cipher = excluded.api_key_cipher,
           models = excluded.models,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.userId,
        record.provider,
        record.label,
        record.baseUrl,
        record.apiKeyCipher,
        JSON.stringify(record.models),
        record.createdAt,
        record.updatedAt,
      )
  }

  async remove(userId: string, provider: LocalRunner): Promise<void> {
    this.db
      .prepare('DELETE FROM local_model_endpoints WHERE user_id = ? AND provider = ?')
      .run(userId, provider)
  }
}

// ---------------------------------------------------------------------------
// Store factory
// ---------------------------------------------------------------------------

/** The local-sqlite credential repositories plus a handle to close the underlying db. */
export interface LocalCredentialStore {
  providerApiKeyRepository: ProviderApiKeyRepository
  localModelEndpointRepository: LocalModelEndpointRepository
  close(): void
}

/**
 * Open the local credential store at `path` (e.g. a file under the developer's config dir,
 * or `:memory:` in tests) and expose the two `local-sqlite` repositories over it.
 *
 * This holds ONLY credentials, never org/durable state — that all lives on the mothership.
 * The secrets it stores are already sealed by the caller with the LOCAL key, so the
 * mothership's `ENCRYPTION_KEY` need never reach this machine.
 */
export function createLocalCredentialStore(path: string): LocalCredentialStore {
  const db = openLocalCredentialDb(path)
  return {
    providerApiKeyRepository: new SqliteProviderApiKeyRepository(db),
    localModelEndpointRepository: new SqliteLocalModelEndpointRepository(db),
    close: () => db.close(),
  }
}
