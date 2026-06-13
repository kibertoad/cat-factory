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

  /** When set, seeds a deterministic RNG (used by integration tests). */
  RNG_SEED?: string
}
