// Persistence port for the direct-provider API-key pool. Unlike subscription
// tokens (Claude Code / Codex harness credentials, scoped per workspace+vendor),
// these are raw vendor API keys (OpenAI/Anthropic/Qwen/DeepSeek/Moonshot) that
// authenticate the LLM proxy + inline model calls. They are onboarded via the UI
// and stored encrypted in the DB (a SecretCipher envelope — never plaintext),
// replacing the old deployment-env onboarding.
//
// A key is stored at one of three SCOPES — account, workspace, or user. When a
// run in a workspace needs a provider key, the candidate pool is the UNION of the
// workspace's keys, its owning account's keys, and the run initiator's own user
// keys; the least-loaded key wins (usage-aware rotation, identical to the
// subscription pool). Both runtimes implement this (Cloudflare D1 + Node/local
// Postgres) so behaviour is identical everywhere.

/** The scope a stored API key belongs to. */
export type ApiKeyScope = 'account' | 'workspace' | 'user'

/** The direct providers that own a poolable API key (NOT subscription vendors). */
export type ApiKeyProvider =
  | 'openai'
  | 'anthropic'
  | 'qwen'
  | 'deepseek'
  | 'moonshot'
  | 'openrouter'
  | 'litellm'

/** A (scope, scopeId) pair — the addressing of a pool segment. */
export interface ApiKeyScopeRef {
  scope: ApiKeyScope
  /** The workspace id, account id, or `usr_*` user id, per scope. */
  scopeId: string
}

/**
 * One API key in a scope's pool. `keyCipher` is the SecretCipher envelope of the
 * raw vendor key. Usage counters are scoped to the current rolling window (reset
 * when `windowStartedAt` ages out), mirroring the subscription pool.
 */
export interface ProviderApiKeyRecord {
  id: string
  scope: ApiKeyScope
  /** workspace id | account id | `usr_*` user id, per `scope`. */
  scopeId: string
  provider: ApiKeyProvider
  label: string
  /** Ciphertext of the raw API key (SecretCipher envelope). */
  keyCipher: string
  createdAt: number
  /** When this key was last leased (null = never used). */
  lastUsedAt: number | null
  /** Start of the current rolling usage window (null = no usage recorded yet). */
  windowStartedAt: number | null
  inputTokens: number
  outputTokens: number
  requestCount: number
  /** Set when the key is removed (tombstone). */
  deletedAt: number | null
}

export interface ProviderApiKeyRepository {
  /**
   * All live keys for one (scope, scopeId), oldest first. Filtered to a single
   * `provider` when given, else every provider in the scope (one query, not N).
   */
  listByScope(
    scope: ApiKeyScope,
    scopeId: string,
    provider?: ApiKeyProvider,
  ): Promise<ProviderApiKeyRecord[]>
  /**
   * All live keys for one provider across MANY scope segments — the merged-pool
   * read used by lease(). Returns rows from every matching (scope, scopeId).
   */
  listForPool(scopes: ApiKeyScopeRef[], provider: ApiKeyProvider): Promise<ProviderApiKeyRecord[]>
  /** Distinct providers that have ≥1 live key across the given scope segments. */
  listConfiguredProviders(scopes: ApiKeyScopeRef[]): Promise<ApiKeyProvider[]>
  /** Fetch one live key by id (scoped to its segment). */
  getById(scope: ApiKeyScope, scopeId: string, id: string): Promise<ProviderApiKeyRecord | null>
  /** Insert a new key. */
  add(record: ProviderApiKeyRecord): Promise<void>
  /**
   * Stamp `lastUsedAt` on the leased key. Keyed by ROW ID alone: a leased row may
   * belong to any of the three scopes merged at lease time, so there is no single
   * scope to filter by. Ids are opaque (`apikey_*`) and never exposed cross-tenant.
   */
  markLeased(id: string, at: number): Promise<void>
  /**
   * Fold a completed call's usage into the key's rolling-window counters (keyed by
   * row id, see markLeased). When `windowStartedAt` is null or older than
   * `windowMs`, the window resets to `at` and the counters start from this call.
   */
  recordUsage(
    id: string,
    usage: { inputTokens: number; outputTokens: number },
    at: number,
    windowMs: number,
  ): Promise<void>
  /** Tombstone a key (scoped to its segment). */
  softDelete(scope: ApiKeyScope, scopeId: string, id: string, at: number): Promise<void>
}
