import type { Ai, D1Database, Queue, Workflow } from '@cloudflare/workers-types'

/** Message enqueued to bound the rate at which durable runs are started. */
export interface ExecutionStartMessage {
  workspaceId: string
  executionId: string
}

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

  // ---- Provider credentials -----------------------------------------------
  OPENAI_API_KEY?: string
  ANTHROPIC_API_KEY?: string

  /** When set, seeds a deterministic RNG (used by integration tests). */
  RNG_SEED?: string
}
