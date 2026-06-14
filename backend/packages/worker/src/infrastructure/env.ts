import type { Ai, D1Database, Queue, Workflow } from '@cloudflare/workers-types'

/** Message enqueued to bound the rate at which durable runs are started. */
export interface ExecutionStartMessage {
  workspaceId: string
  executionId: string
}

/**
 * Work enqueued on GITHUB_SYNC_QUEUE so the webhook endpoint can ack fast and
 * apply projection updates asynchronously. A discriminated union: verified
 * webhook deliveries, and targeted repo resyncs (from the cron reconciler / the
 * on-demand resync endpoint).
 */
export type GitHubSyncMessage =
  | { kind: 'webhook'; eventName: string; payload: unknown }
  | { kind: 'resync-repo'; workspaceId: string; repoGithubId: number }

/** Bindings and vars available to the Worker (declared in wrangler.toml). */
export interface Env {
  DB: D1Database

  /** Cloudflare Workers AI binding (optional; used when provider = workers-ai). */
  AI?: Ai

  // ---- Durable execution (see config.ts; only used in workflow mode) ------
  /** Workflows binding that durably drives each run. */
  EXECUTION_WORKFLOW?: Workflow
  /** Optional admission queue; its consumer creates the Workflow instance. */
  EXECUTION_QUEUE?: Queue<ExecutionStartMessage>
  /** 'workflow' = durable, server-driven runs; 'tick' (default) = legacy polling. */
  EXECUTION_MODE?: string
  /** How long a run may park on a human decision before expiring, e.g. "24h". */
  DECISION_TIMEOUT?: string

  // ---- Agent LLM configuration (see config.ts) ----------------------------
  AGENTS_ENABLED?: string
  AGENT_DEFAULT_PROVIDER?: string
  AGENT_DEFAULT_MODEL?: string
  AGENT_DEFAULT_TEMPERATURE?: string
  AGENT_MAX_OUTPUT_TOKENS?: string
  /** JSON: per-kind overrides, e.g. {"architect":{"provider":"openai","model":"gpt-4o"}}. */
  AGENT_MODELS?: string

  // ---- Spend safeguard (see config.ts) ------------------------------------
  /** Monthly token budget, in SPEND_CURRENCY. Default ~100. */
  SPEND_MONTHLY_LIMIT?: string
  /** ISO 4217 currency for the budget and prices. Default 'EUR'. */
  SPEND_CURRENCY?: string
  /**
   * JSON map of `provider:model` (or bare `provider`) → per-1M-token price,
   * e.g. {"openai:gpt-4o":{"inputPerMillion":2.3,"outputPerMillion":9.2}}.
   * Merged over the built-in defaults.
   */
  SPEND_MODEL_PRICES?: string

  // ---- Provider credentials -----------------------------------------------
  OPENAI_API_KEY?: string
  ANTHROPIC_API_KEY?: string

  // ---- GitHub integration (see config.ts; opt-in) -------------------------
  /** GitHub App id (numeric). Presence enables the integration. */
  GITHUB_APP_ID?: string
  /** GitHub App slug, used to build the install URL. */
  GITHUB_APP_SLUG?: string
  /** GitHub REST API base; defaults to https://api.github.com. */
  GITHUB_API_BASE?: string
  /** Where to redirect the browser after a successful connect. */
  GITHUB_SETUP_REDIRECT_URL?: string
  /** App private key in PKCS#8 PEM (secret). */
  GITHUB_APP_PRIVATE_KEY?: string
  /** Webhook signing secret (secret). */
  GITHUB_WEBHOOK_SECRET?: string
  /** Queue carrying webhook deliveries / resync jobs to the async consumer. */
  GITHUB_SYNC_QUEUE?: Queue<GitHubSyncMessage>
  /** Workflow that performs durable full-repo backfills. */
  GITHUB_BACKFILL_WORKFLOW?: Workflow

  // ---- Authentication (see config.ts; opt-in "Login with GitHub") ---------
  /** OAuth client id (a GitHub App's or a classic OAuth App's). Enables login. */
  GITHUB_OAUTH_CLIENT_ID?: string
  /** OAuth client secret (secret). */
  GITHUB_OAUTH_CLIENT_SECRET?: string
  /** OAuth host; defaults to https://github.com (override for GitHub Enterprise). */
  GITHUB_OAUTH_BASE?: string
  /** HMAC secret used to sign session tokens + the OAuth state nonce (secret). */
  AUTH_SESSION_SECRET?: string
  /** Session lifetime in hours; defaults to 168 (7 days). */
  AUTH_SESSION_TTL_HOURS?: string
  /** Fixed post-login landing URL (the SPA). Recommended in production. */
  AUTH_SUCCESS_REDIRECT_URL?: string
  /** Override the OAuth redirect_uri when the public URL differs from the origin. */
  AUTH_CALLBACK_URL?: string
  /** Optional comma-separated allowlist of GitHub logins permitted to sign in. */
  AUTH_ALLOWED_LOGINS?: string

  // ---- Storage retention (see config.ts and docs/storage-and-retention.md) -
  /**
   * Days of `token_usage` ledger history to keep. The spend budget only reads the
   * current period, so this is generous by default for reporting. Default ~395
   * (13 months, for year-over-year). 0 disables pruning.
   */
  TOKEN_USAGE_RETENTION_DAYS?: string
  /**
   * Days of `github_rate_limits` telemetry to keep. Only recent headroom matters,
   * so this is aggressive. Default 7. 0 disables pruning.
   */
  GITHUB_RATE_LIMIT_RETENTION_DAYS?: string
  /**
   * Days of `github_commits` projection history to keep. Also bounds the initial
   * backfill window so a large/monorepo connect can't insert full history in one
   * step. Default 90. 0 disables pruning and backfills the full history.
   */
  GITHUB_COMMIT_RETENTION_DAYS?: string

  /** When set, seeds a deterministic RNG (used by integration tests). */
  RNG_SEED?: string
}
