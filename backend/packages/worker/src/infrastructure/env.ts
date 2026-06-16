import type {
  Ai,
  D1Database,
  DurableObjectNamespace,
  Queue,
  Workflow,
} from '@cloudflare/workers-types'
import type { ImplementationContainer } from './containers/ImplementationContainer'
import type { WorkspaceEventsHub } from './durable-objects/WorkspaceEventsHub'

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

  // ---- Durable execution (see config.ts) ----------------------------------
  /** Workflows binding that durably drives each run (the only execution path). */
  EXECUTION_WORKFLOW?: Workflow
  /** Optional admission queue; its consumer creates the Workflow instance. */
  EXECUTION_QUEUE?: Queue<ExecutionStartMessage>
  /** How long a run may park on a human decision before expiring, e.g. "24h". */
  DECISION_TIMEOUT?: string
  /**
   * Durable driver poll cadence for async container jobs (a Workflows sleep
   * duration, e.g. "15 seconds"). Default "15 seconds".
   */
  JOB_POLL_INTERVAL?: string
  /**
   * Safety cap on how many times the driver polls one container job before
   * failing the run (the container's own max-duration watchdog should fire
   * first). Default 280 (≈70 min at the default 15s cadence).
   */
  JOB_MAX_POLLS?: string
  /**
   * Per-workspace WebSocket fan-out hub (Durable Object). Pushes execution/board
   * changes to subscribed browsers in real time. When absent, the engine pushes
   * nothing (clients still get state on connect / refresh).
   */
  WORKSPACE_EVENTS?: DurableObjectNamespace<WorkspaceEventsHub>

  // ---- Container-based implementation (see config.ts; opt-in) --------------
  /**
   * Durable Object namespace backing per-run implementation containers. Each run
   * addresses its own instance; the container runs the Pi coding-agent harness.
   */
  IMPL_CONTAINER?: DurableObjectNamespace<ImplementationContainer>
  /**
   * Routes the repo-operating steps (`coder`, `mocker`, `playwright`) to a real
   * sandbox container instead of a single inline LLM call ('true'). Requires the
   * IMPL_CONTAINER binding, a configured GitHub App, a direct OpenAI-compatible
   * provider key, and WORKER_PUBLIC_URL. (Container runs are long; the durable
   * Workflows driver carries them.)
   */
  CONTAINER_IMPL_ENABLED?: string
  /**
   * Public origin of this Worker, e.g. https://cat-factory.example.workers.dev.
   * Handed to the container so Pi can reach the LLM proxy at `${url}/v1`.
   */
  WORKER_PUBLIC_URL?: string

  // ---- Agent LLM configuration (see config.ts) ----------------------------
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
  /** Alibaba DashScope key (provider `qwen`; OpenAI-compatible endpoint). */
  QWEN_API_KEY?: string
  /** DeepSeek API key (provider `deepseek`; OpenAI-compatible endpoint). */
  DEEPSEEK_API_KEY?: string
  /** Moonshot AI key (provider `moonshot`, direct Kimi; OpenAI-compatible). */
  MOONSHOT_API_KEY?: string

  // Optional base-URL overrides for the OpenAI-compatible providers (self-hosted
  // gateway, regional endpoint, or a stub in tests). Default to the public APIs.
  QWEN_BASE_URL?: string
  DEEPSEEK_BASE_URL?: string
  MOONSHOT_BASE_URL?: string
  OPENAI_BASE_URL?: string

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
  /**
   * Comma-separated allowlist of extra origins the post-login `redirect` query
   * may target (e.g. a separately-hosted SPA). The request's own origin is
   * always allowed; anything else is rejected to stop token-leaking redirects.
   */
  AUTH_ALLOWED_REDIRECT_ORIGINS?: string
  /** Override the OAuth redirect_uri when the public URL differs from the origin. */
  AUTH_CALLBACK_URL?: string
  /** Optional comma-separated allowlist of GitHub logins permitted to sign in. */
  AUTH_ALLOWED_LOGINS?: string
  /**
   * Local-dev/test ONLY escape hatch: set to 'true' to allow the API to run with
   * auth unconfigured (open). It lives in `.dev.vars` (gitignored) and the test
   * bindings, never in the deployed `wrangler.toml`. In production this is unset,
   * so an unconfigured deployment fails closed instead of serving data openly.
   */
  AUTH_DEV_OPEN?: string

  // ---- Document-source integration (see config.ts; opt-in) ----------------
  /** Enables the document-source integration ('true'). Per-workspace creds live in D1. */
  DOCUMENTS_ENABLED?: string
  /**
   * Service-level master key (base64, ≥32 bytes decoded) for encrypting the
   * per-workspace source credentials (e.g. Notion/Confluence tokens) at rest.
   * Required when the integration is enabled (secret); without it the feature
   * fails closed rather than persisting credentials in plaintext.
   */
  DOCUMENTS_ENCRYPTION_KEY?: string
  /**
   * Comma-separated allow-list of sources to register (e.g. `confluence,notion`).
   * Defaults to all known sources when unset.
   */
  DOCUMENT_SOURCES?: string
  /**
   * Doc → board planner: 'llm' (default) uses the configured agent model to
   * extract structure; 'headings' forces the deterministic heading parser.
   */
  DOCUMENT_PLANNER?: string

  // ---- Ephemeral environment integration (see config.ts; opt-in) ----------
  /**
   * Enables the environment provider integration ('true'). Per-workspace provider
   * manifests and their (encrypted) secret bundles live in D1, not here.
   */
  ENVIRONMENTS_ENABLED?: string
  /**
   * Service-level master key (base64, ≥32 bytes decoded) for encrypting the
   * per-tenant provider secrets and provisioned-env access creds at rest. The
   * only env secret this feature needs; required when enabled (secret).
   */
  ENVIRONMENTS_ENCRYPTION_KEY?: string

  // ---- Self-hosted runner pool ("bring your own infra"; opt-in) -----------
  /**
   * Enables routing repo-operating coding jobs (`coder`, `mocker`, `playwright`)
   * to a workspace's own container runner pool instead of Cloudflare Containers
   * ('true'). Per-workspace pool manifests and their (encrypted) scheduler-API
   * secret bundles live in D1, not here. Independent of CONTAINER_IMPL_ENABLED: a
   * workspace with a registered pool uses it even when Cloudflare Containers are
   * off; workspaces without one fall back to Cloudflare Containers when those are
   * enabled. Requires a configured GitHub App, WORKER_PUBLIC_URL and the session
   * secret, exactly like the Cloudflare container path.
   */
  RUNNERS_ENABLED?: string
  /**
   * Service-level master key (base64, ≥32 bytes decoded) for encrypting the
   * per-tenant runner-pool scheduler-API secrets at rest. The only env secret
   * this feature needs; required when enabled (secret).
   */
  RUNNERS_ENCRYPTION_KEY?: string

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
}
