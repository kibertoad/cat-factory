import type { DatabaseSync } from 'node:sqlite'
import type {
  ApiKeyProvider,
  ApiKeyScope,
  ApiKeyScopeRef,
  LocalModelEndpointRecord,
  LocalModelEndpointRepository,
  PersonalSubscriptionRecord,
  PersonalSubscriptionRepository,
  ProviderApiKeyRecord,
  ProviderApiKeyRepository,
  ProviderSubscriptionTokenRecord,
  ProviderSubscriptionTokenRepository,
  SubscriptionActivationRecord,
  SubscriptionActivationRepository,
  SubscriptionVendor,
} from '@cat-factory/kernel'
import type { LocalRunner } from '@cat-factory/contracts'
import { openSqliteDb } from './db.js'

// The mothership-mode LOCAL credential store.
//
// In mothership mode the local node runs NO main database — every org/durable repository
// call is forwarded to the hosted mothership over the persistence RPC (see
// `@cat-factory/server` `persistence/`). The deliberate exception is the agent/model
// CREDENTIALS: they are kept on the developer's machine, sealed with a LOCAL key, so the
// mothership's `ENCRYPTION_KEY` never has to reach the laptop (confirmed product decision 3
// in `docs/initiatives/mothership-mode.md`). This module is their persistence: a file-based
// `node:sqlite` store implementing the `local-sqlite` bucket credential ports —
// `providerApiKeyRepository` (the direct-vendor API-key pool), `localModelEndpointRepository`
// (per-user locally-run model endpoints), and the subscription-credential trio the Claude
// Code / Codex / GLM harnesses lease inside a per-run local container:
// `providerSubscriptionTokenRepository` (the per-workspace pooled subscription tokens),
// `personalSubscriptionRepository` (per-user individual-usage credentials, double-encrypted),
// and `subscriptionActivationRepository` (their short-lived per-run, system-key-only copies).
// All are laptop-local for the same reason the API-key pool is: a subscription token is a
// credential the LOCAL container executor leases and decrypts with the LOCAL key, and it must
// never traverse the machine API to the mothership.
//
// It stores ONLY the sealed `*Cipher` envelopes the service layer hands it (the cipher — and,
// for personal subscriptions, the inner password layer — is applied ABOVE this store, so the
// blob is opaque here), so this layer is crypto-agnostic. The schema mirrors the Drizzle/D1
// columns column-for-column, and each repository mirrors its `Drizzle*` / `D1*` counterpart's
// behaviour exactly (usage-window rotation, lease-least-used ordering, one-live-row-per
// upsert, the createdAt-preserving endpoint upsert) so a mothership-mode node pools, rotates
// and activates credentials identically to a Postgres one.
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

CREATE TABLE IF NOT EXISTS provider_subscription_tokens (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  vendor TEXT NOT NULL,
  label TEXT NOT NULL,
  token_cipher TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  window_started_at INTEGER,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  request_count INTEGER NOT NULL DEFAULT 0,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS provider_subscription_tokens_pool
  ON provider_subscription_tokens (workspace_id, vendor, deleted_at);

CREATE TABLE IF NOT EXISTS personal_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  vendor TEXT NOT NULL,
  label TEXT NOT NULL,
  token_cipher TEXT NOT NULL,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_used_at INTEGER,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS personal_subscriptions_user
  ON personal_subscriptions (user_id, vendor, deleted_at);

CREATE TABLE IF NOT EXISTS subscription_activations (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  vendor TEXT NOT NULL,
  token_cipher TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  UNIQUE (execution_id, user_id, vendor)
);
`

/** Open (creating if absent) the local credential SQLite database and ensure its schema. */
export function openLocalCredentialDb(path: string): DatabaseSync {
  return openSqliteDb(path, SCHEMA)
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
// provider_subscription_tokens (per-workspace pooled subscription credentials)
// ---------------------------------------------------------------------------

interface SubscriptionTokenRow {
  id: string
  workspace_id: string
  vendor: string
  label: string
  token_cipher: string
  created_at: number
  last_used_at: number | null
  window_started_at: number | null
  input_tokens: number
  output_tokens: number
  request_count: number
  deleted_at: number | null
}

function subscriptionTokenRowToRecord(row: SubscriptionTokenRow): ProviderSubscriptionTokenRecord {
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

const SUBSCRIPTION_TOKEN_COLUMNS =
  'id, workspace_id, vendor, label, token_cipher, created_at, last_used_at, ' +
  'window_started_at, input_tokens, output_tokens, request_count, deleted_at'

/**
 * The per-workspace subscription-token pool over `node:sqlite` — the local-sqlite mirror of
 * `DrizzleProviderSubscriptionTokenRepository` / `D1ProviderSubscriptionTokenRepository`
 * (unlike the API-key pool there is no `leaseLeastUsed` here — the least-loaded pick lives in
 * `ProviderSubscriptionService`, which reads `listByVendor` then `markLeased`).
 */
export class SqliteProviderSubscriptionTokenRepository implements ProviderSubscriptionTokenRepository {
  constructor(private readonly db: DatabaseSync) {}

  async listByVendor(
    workspaceId: string,
    vendor: SubscriptionVendor,
  ): Promise<ProviderSubscriptionTokenRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT ${SUBSCRIPTION_TOKEN_COLUMNS} FROM provider_subscription_tokens
         WHERE workspace_id = ? AND vendor = ? AND deleted_at IS NULL
         ORDER BY created_at ASC`,
      )
      .all(workspaceId, vendor) as unknown as SubscriptionTokenRow[]
    return rows.map(subscriptionTokenRowToRecord)
  }

  async getById(workspaceId: string, id: string): Promise<ProviderSubscriptionTokenRecord | null> {
    const row = this.db
      .prepare(
        `SELECT ${SUBSCRIPTION_TOKEN_COLUMNS} FROM provider_subscription_tokens
         WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL
         LIMIT 1`,
      )
      .get(id, workspaceId) as unknown as SubscriptionTokenRow | undefined
    return row ? subscriptionTokenRowToRecord(row) : null
  }

  async add(record: ProviderSubscriptionTokenRecord): Promise<void> {
    // Force `deleted_at` NULL on insert (matching the D1/Drizzle repos) — a tombstone is only
    // ever set later by `softDelete`, never carried in at birth.
    this.db
      .prepare(
        `INSERT INTO provider_subscription_tokens
           (${SUBSCRIPTION_TOKEN_COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        record.id,
        record.workspaceId,
        record.vendor,
        record.label,
        record.tokenCipher,
        record.createdAt,
        record.lastUsedAt,
        record.windowStartedAt,
        record.inputTokens,
        record.outputTokens,
        record.requestCount,
      )
  }

  async markLeased(workspaceId: string, id: string, at: number): Promise<void> {
    this.db
      .prepare(
        'UPDATE provider_subscription_tokens SET last_used_at = ? WHERE id = ? AND workspace_id = ?',
      )
      .run(at, id, workspaceId)
  }

  async recordUsage(
    workspaceId: string,
    id: string,
    usage: { inputTokens: number; outputTokens: number },
    at: number,
    windowMs: number,
  ): Promise<void> {
    // One atomic statement (no read-modify-write), mirroring the Drizzle/D1 repos: keep the
    // window's counters while it is still active, else reset it to `at` and start from this
    // call. Named parameters so the repeated `:at`/`:windowMs` bind once and can't drift.
    const active = '(window_started_at IS NOT NULL AND :at - window_started_at < :windowMs)'
    this.db
      .prepare(
        `UPDATE provider_subscription_tokens SET
           window_started_at = CASE WHEN ${active} THEN window_started_at ELSE :at END,
           input_tokens = CASE WHEN ${active} THEN input_tokens ELSE 0 END + :inTokens,
           output_tokens = CASE WHEN ${active} THEN output_tokens ELSE 0 END + :outTokens,
           request_count = CASE WHEN ${active} THEN request_count ELSE 0 END + 1
         WHERE id = :id AND workspace_id = :workspaceId`,
      )
      .run({
        at,
        windowMs,
        inTokens: usage.inputTokens,
        outTokens: usage.outputTokens,
        id,
        workspaceId,
      })
  }

  async softDelete(workspaceId: string, id: string, at: number): Promise<void> {
    this.db
      .prepare(
        `UPDATE provider_subscription_tokens SET deleted_at = ?
         WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL`,
      )
      .run(at, id, workspaceId)
  }
}

// ---------------------------------------------------------------------------
// personal_subscriptions (per-user individual-usage credentials, double-encrypted)
// ---------------------------------------------------------------------------

interface PersonalSubscriptionRow {
  id: string
  user_id: string
  vendor: string
  label: string
  token_cipher: string
  expires_at: number | null
  created_at: number
  updated_at: number
  last_used_at: number | null
  deleted_at: number | null
}

function personalSubscriptionRowToRecord(row: PersonalSubscriptionRow): PersonalSubscriptionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    vendor: row.vendor as SubscriptionVendor,
    label: row.label,
    tokenCipher: row.token_cipher,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
    deletedAt: row.deleted_at,
  }
}

const PERSONAL_SUBSCRIPTION_COLUMNS =
  'id, user_id, vendor, label, token_cipher, expires_at, created_at, updated_at, ' +
  'last_used_at, deleted_at'

/**
 * Per-user individual-usage subscriptions over `node:sqlite` — the local-sqlite mirror of
 * `DrizzlePersonalSubscriptionRepository` / `D1PersonalSubscriptionRepository`. The stored
 * `tokenCipher` is DOUBLE-encrypted (`system.encrypt(personal.seal(token, password))`) by
 * `PersonalSubscriptionService`; this store only ever sees the opaque outer blob, so the
 * password never touches the laptop's disk. `upsert` keeps one live row per (user, vendor).
 */
export class SqlitePersonalSubscriptionRepository implements PersonalSubscriptionRepository {
  constructor(private readonly db: DatabaseSync) {}

  async getByUserVendor(
    userId: string,
    vendor: SubscriptionVendor,
  ): Promise<PersonalSubscriptionRecord | null> {
    const row = this.db
      .prepare(
        `SELECT ${PERSONAL_SUBSCRIPTION_COLUMNS} FROM personal_subscriptions
         WHERE user_id = ? AND vendor = ? AND deleted_at IS NULL
         LIMIT 1`,
      )
      .get(userId, vendor) as unknown as PersonalSubscriptionRow | undefined
    return row ? personalSubscriptionRowToRecord(row) : null
  }

  async listByUser(userId: string): Promise<PersonalSubscriptionRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT ${PERSONAL_SUBSCRIPTION_COLUMNS} FROM personal_subscriptions
         WHERE user_id = ? AND deleted_at IS NULL
         ORDER BY created_at ASC`,
      )
      .all(userId) as unknown as PersonalSubscriptionRow[]
    return rows.map(personalSubscriptionRowToRecord)
  }

  async upsert(record: PersonalSubscriptionRecord): Promise<void> {
    // One live row per (user, vendor): tombstone any OTHER live row first, then upsert by id —
    // exactly the D1/Drizzle two-statement sequence.
    this.db
      .prepare(
        `UPDATE personal_subscriptions SET deleted_at = ?
         WHERE user_id = ? AND vendor = ? AND deleted_at IS NULL AND id != ?`,
      )
      .run(record.updatedAt, record.userId, record.vendor, record.id)
    this.db
      .prepare(
        `INSERT INTO personal_subscriptions (${PERSONAL_SUBSCRIPTION_COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT (id) DO UPDATE SET
           label = excluded.label,
           token_cipher = excluded.token_cipher,
           expires_at = excluded.expires_at,
           updated_at = excluded.updated_at,
           deleted_at = NULL`,
      )
      .run(
        record.id,
        record.userId,
        record.vendor,
        record.label,
        record.tokenCipher,
        record.expiresAt,
        record.createdAt,
        record.updatedAt,
        record.lastUsedAt,
      )
  }

  async markUsed(userId: string, vendor: SubscriptionVendor, at: number): Promise<void> {
    this.db
      .prepare(
        `UPDATE personal_subscriptions SET last_used_at = ?
         WHERE user_id = ? AND vendor = ? AND deleted_at IS NULL`,
      )
      .run(at, userId, vendor)
  }

  async softDelete(userId: string, vendor: SubscriptionVendor, at: number): Promise<void> {
    this.db
      .prepare(
        `UPDATE personal_subscriptions SET deleted_at = ?
         WHERE user_id = ? AND vendor = ? AND deleted_at IS NULL`,
      )
      .run(at, userId, vendor)
  }

  async listExpiring(now: number, before: number): Promise<PersonalSubscriptionRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT ${PERSONAL_SUBSCRIPTION_COLUMNS} FROM personal_subscriptions
         WHERE deleted_at IS NULL AND expires_at IS NOT NULL
           AND expires_at >= ? AND expires_at <= ?
         ORDER BY expires_at ASC`,
      )
      .all(now, before) as unknown as PersonalSubscriptionRow[]
    return rows.map(personalSubscriptionRowToRecord)
  }
}

// ---------------------------------------------------------------------------
// subscription_activations (short-lived, system-key-only per-run copies)
// ---------------------------------------------------------------------------

interface SubscriptionActivationRow {
  id: string
  execution_id: string
  user_id: string
  vendor: string
  token_cipher: string
  created_at: number
  expires_at: number
}

function subscriptionActivationRowToRecord(
  row: SubscriptionActivationRow,
): SubscriptionActivationRecord {
  return {
    id: row.id,
    executionId: row.execution_id,
    userId: row.user_id,
    vendor: row.vendor as SubscriptionVendor,
    tokenCipher: row.token_cipher,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  }
}

const SUBSCRIPTION_ACTIVATION_COLUMNS =
  'id, execution_id, user_id, vendor, token_cipher, created_at, expires_at'

/**
 * Per-run personal-credential activations over `node:sqlite` — the local-sqlite mirror of
 * `DrizzleSubscriptionActivationRepository` / `D1SubscriptionActivationRepository`. A row is a
 * system-key-only re-encryption of the raw token scoped to one execution, minted when the user
 * supplies their password at start/retry so the async local container steps of THAT run can use
 * it without the user present; it is deleted when the run reaches a terminal state (and the TTL
 * sweep is the backstop). Kept LOCAL because it is decrypted by the LOCAL container executor.
 */
export class SqliteSubscriptionActivationRepository implements SubscriptionActivationRepository {
  constructor(private readonly db: DatabaseSync) {}

  async get(
    executionId: string,
    userId: string,
    vendor: SubscriptionVendor,
    now: number,
  ): Promise<SubscriptionActivationRecord | null> {
    const row = this.db
      .prepare(
        `SELECT ${SUBSCRIPTION_ACTIVATION_COLUMNS} FROM subscription_activations
         WHERE execution_id = ? AND user_id = ? AND vendor = ? AND expires_at > ?
         LIMIT 1`,
      )
      .get(executionId, userId, vendor, now) as unknown as SubscriptionActivationRow | undefined
    return row ? subscriptionActivationRowToRecord(row) : null
  }

  async upsert(record: SubscriptionActivationRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO subscription_activations (${SUBSCRIPTION_ACTIVATION_COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (execution_id, user_id, vendor) DO UPDATE SET
           token_cipher = excluded.token_cipher,
           created_at = excluded.created_at,
           expires_at = excluded.expires_at`,
      )
      .run(
        record.id,
        record.executionId,
        record.userId,
        record.vendor,
        record.tokenCipher,
        record.createdAt,
        record.expiresAt,
      )
  }

  async refresh(
    executionId: string,
    userId: string,
    vendor: SubscriptionVendor,
    expiresAt: number,
  ): Promise<void> {
    this.db
      .prepare(
        `UPDATE subscription_activations SET expires_at = ?
         WHERE execution_id = ? AND user_id = ? AND vendor = ?`,
      )
      .run(expiresAt, executionId, userId, vendor)
  }

  async deleteByExecution(executionId: string): Promise<void> {
    this.db.prepare('DELETE FROM subscription_activations WHERE execution_id = ?').run(executionId)
  }

  async deleteExpired(now: number): Promise<number> {
    const res = this.db
      .prepare('DELETE FROM subscription_activations WHERE expires_at <= ?')
      .run(now)
    return Number(res.changes)
  }
}

// ---------------------------------------------------------------------------
// Store factory
// ---------------------------------------------------------------------------

/** The local-sqlite credential repositories plus a handle to close the underlying db. */
export interface LocalCredentialStore {
  providerApiKeyRepository: ProviderApiKeyRepository
  localModelEndpointRepository: LocalModelEndpointRepository
  providerSubscriptionTokenRepository: ProviderSubscriptionTokenRepository
  personalSubscriptionRepository: PersonalSubscriptionRepository
  subscriptionActivationRepository: SubscriptionActivationRepository
  close(): void
}

/**
 * Open the local credential store at `path` (e.g. a file under the developer's config dir,
 * or `:memory:` in tests) and expose the `local-sqlite` credential repositories over it.
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
    providerSubscriptionTokenRepository: new SqliteProviderSubscriptionTokenRepository(db),
    personalSubscriptionRepository: new SqlitePersonalSubscriptionRepository(db),
    subscriptionActivationRepository: new SqliteSubscriptionActivationRepository(db),
    close: () => db.close(),
  }
}
