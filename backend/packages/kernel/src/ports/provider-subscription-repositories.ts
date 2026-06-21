// Persistence port for the provider-subscription token pool. A workspace can
// connect one or more subscription credentials per vendor (a Claude
// Pro/Max OAuth token, a ChatGPT Plus/Pro `auth.json` bundle) so the
// Claude Code / Codex harnesses can authenticate inside a per-run container
// without an API key. Rows are scoped by workspace + vendor; the credential is
// stored as opaque ciphertext (see the SecretCipher port) — this record never
// holds the plaintext token.
//
// The pool is leased with usage-aware rotation: each row carries rolling-window
// usage counters that the dispatch path updates after a run, so the least-loaded
// token is preferred (round-robin by lastUsedAt is only the tiebreaker). Both
// runtimes implement this (Cloudflare D1 + Node/local Postgres) so the harness
// behaves identically everywhere.

/** The vendors whose subscription harnesses we support. */
export type SubscriptionVendor = 'claude' | 'codex' | 'glm' | 'kimi' | 'deepseek'

/**
 * One subscription credential in a workspace's pool. `tokenCipher` is the
 * SecretCipher envelope of the raw secret: a `CLAUDE_CODE_OAUTH_TOKEN` string
 * for `claude`, or the full `auth.json` text for `codex`. Usage counters are
 * scoped to the current rolling window (reset when `windowStartedAt` ages out).
 */
export interface ProviderSubscriptionTokenRecord {
  id: string
  workspaceId: string
  vendor: SubscriptionVendor
  label: string
  /** Ciphertext of the credential (SecretCipher envelope). */
  tokenCipher: string
  createdAt: number
  /** When this token was last leased for a job (null = never used). */
  lastUsedAt: number | null
  /** Start of the current rolling usage window (null = no usage recorded yet). */
  windowStartedAt: number | null
  /** Input tokens consumed in the current window. */
  inputTokens: number
  /** Output tokens consumed in the current window. */
  outputTokens: number
  /** Job count in the current window. */
  requestCount: number
  /** Set when the workspace removes the token (tombstone). */
  deletedAt: number | null
}

export interface ProviderSubscriptionTokenRepository {
  /** All live tokens for a workspace + vendor, oldest first. */
  listByVendor(
    workspaceId: string,
    vendor: SubscriptionVendor,
  ): Promise<ProviderSubscriptionTokenRecord[]>
  /** Fetch one live token by id (scoped to the workspace). */
  getById(workspaceId: string, id: string): Promise<ProviderSubscriptionTokenRecord | null>
  /** Insert a new pool token. */
  add(record: ProviderSubscriptionTokenRecord): Promise<void>
  /** Stamp `lastUsedAt` on the leased token (scoped to the workspace). */
  markLeased(workspaceId: string, id: string, at: number): Promise<void>
  /**
   * Fold a completed job's usage into the token's rolling-window counters (scoped to
   * the workspace). When `windowStartedAt` is null or older than `windowMs`, the
   * window resets to `at` and the counters start from this run.
   */
  recordUsage(
    workspaceId: string,
    id: string,
    usage: { inputTokens: number; outputTokens: number },
    at: number,
    windowMs: number,
  ): Promise<void>
  /** Tombstone a token. */
  softDelete(workspaceId: string, id: string, at: number): Promise<void>
}
