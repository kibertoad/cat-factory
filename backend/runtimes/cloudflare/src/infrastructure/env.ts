import type {
  Ai,
  D1Database,
  DurableObjectNamespace,
  Queue,
  Workflow,
} from '@cloudflare/workers-types'
import type { ExecutionContainer } from './containers/ExecutionContainer'
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
  /**
   * Workflows binding that durably drives each "bootstrap repo" run's poll loop
   * (see BootstrapWorkflow). Without it a bootstrap still dispatches but isn't
   * auto-driven — the cron sweep re-drives any job left running.
   */
  BOOTSTRAP_WORKFLOW?: Workflow
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
   * How many consecutive status-read failures the durable driver tolerates before
   * giving up on a job (a busy container can briefly fail to answer a poll without
   * the job itself having failed). Default 6.
   */
  JOB_POLL_FAILURE_TOLERANCE?: string
  /**
   * Durable driver poll cadence for a `ci` step's GitHub check runs (a Workflows
   * sleep duration). CI takes minutes, so coarser than the job poll. Default
   * "30 seconds".
   */
  CI_POLL_INTERVAL?: string
  /**
   * Safety cap on how many times the driver polls CI in one `checking` wait before
   * giving up the gate. Default 120 (≈60 min at the default 30s cadence). The
   * CI-fixer attempt budget is separate (per-task, on the merge preset).
   */
  CI_MAX_POLLS?: string
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
  EXEC_CONTAINER?: DurableObjectNamespace<ExecutionContainer>
  /**
   * Public origin of this Worker, e.g. https://cat-factory.example.workers.dev.
   * Handed to the container so Pi can reach the LLM proxy at `${url}/v1`.
   */
  WORKER_PUBLIC_URL?: string
  /**
   * Age ceiling (minutes) for the instance-level container reaper: the cron sweeper
   * SIGKILLs any per-run container whose first dispatch is older than this. Default
   * 90, hard-clamped to ≥75 so a misconfigured low value can't kill live work (the
   * longest legitimate lifetime is ≈70 min). See config/execution.ts.
   */
  CONTAINER_MAX_AGE_MINUTES?: string

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

  // ---- Inline agent web search (opt-in; design/research kinds) -------------
  // Provider-hosted web search for the INLINE architect/researcher steps (the
  // container/Pi steps configure rpiv-web-tools separately, by provider key). Only
  // takes effect on Anthropic/OpenAI models, which expose a server-executed search.
  /** Truthy (`true`/`1`/`yes`) enables provider web search for the inline design/research kinds. */
  INLINE_WEB_SEARCH_ENABLED?: string
  /**
   * Truthy (`true`/`1`/`yes`) enables the optional consensus-orchestration mechanism:
   * the consensus capability traits are registered (so the pipeline builder offers
   * "Enable Consensus" on eligible steps) and the agent executor is wrapped to run
   * consensus-enabled steps through a multi-model process. Off ⇒ unchanged behaviour.
   */
  CONSENSUS_ENABLED?: string
  /** Comma-separated override of the default `architect,researcher` allow-list. */
  INLINE_WEB_SEARCH_KINDS?: string
  /** Cap on provider web searches per inline run (Anthropic `maxUses`; default 5). */
  INLINE_WEB_SEARCH_MAX_USES?: string

  // ---- Container agent web search (opt-in; the /v1/web-search proxy) -------
  // Backend-held search keys for the CONTAINER agents (coder/ci-fixer/…). The key
  // stays here (next to the model keys); the sandbox reaches search only through the
  // proxy with its session token, so no provider secret enters the container.
  /** Brave Search key — enables the container web-search proxy (the recommended path). */
  WEB_SEARCH_BRAVE_API_KEY?: string
  /** A self-hosted SearXNG base URL the backend reverse-proxies to (alternative to Brave). */
  WEB_SEARCH_SEARXNG_URL?: string
  /** Optional bearer for a SearXNG instance behind an auth proxy. */
  WEB_SEARCH_SEARXNG_API_KEY?: string

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

  // ---- Privileged App tier (see config.ts; ADR 0005, opt-in) --------------
  /**
   * Second GitHub App id carrying `Administration: write`. An org opts in by
   * installing this App; workspaces bound to that installation can create repos
   * directly. When unset, every installation runs on the restricted default App
   * and repo creation stays the manual "create on GitHub" flow.
   */
  GITHUB_PRIVILEGED_APP_ID?: string
  /** Privileged App private key in PKCS#8 PEM (secret). */
  GITHUB_PRIVILEGED_APP_PRIVATE_KEY?: string

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
  /**
   * Comma-separated allowlist of GitHub logins permitted to sign in. Combined
   * with AUTH_ALLOWED_ORGS as an OR allowlist. When BOTH are empty, sign-in is
   * denied to everyone (fail closed) — an operator must name who may enter.
   */
  AUTH_ALLOWED_LOGINS?: string
  /**
   * Comma-separated allowlist of GitHub organization logins whose members may
   * sign in. A user is admitted when they belong to any listed org (membership
   * is read from GitHub at login via the `read:org` scope, requested only when
   * this is set). Combined with AUTH_ALLOWED_LOGINS as an OR allowlist; when
   * BOTH are empty, sign-in is denied to everyone (fail closed).
   */
  AUTH_ALLOWED_ORGS?: string
  /**
   * Local-dev/test ONLY escape hatch: set to 'true' to allow the API to run with
   * auth unconfigured (open). It lives in `.dev.vars` (gitignored) and the test
   * bindings, never in the deployed `wrangler.toml`. In production this is unset,
   * so an unconfigured deployment fails closed instead of serving data openly.
   */
  AUTH_DEV_OPEN?: string
  /** Set 'true' to offer email/password signup + login (needs a strong session secret). */
  AUTH_PASSWORD_ENABLED?: string
  /** Comma-separated email domains allowed to self-signup without an invite. */
  AUTH_ALLOWED_EMAIL_DOMAINS?: string
  /** Google OAuth credentials (login-with-Google); both required to enable it. */
  GOOGLE_OAUTH_CLIENT_ID?: string
  GOOGLE_OAUTH_CLIENT_SECRET?: string
  /** Explicit Google redirect_uri; derived from the request origin when unset. */
  GOOGLE_OAUTH_REDIRECT_URL?: string
  /** Transactional email (invitations): opt-in flag + master key for the per-account API key. */
  EMAIL_ENABLED?: string
  EMAIL_ENCRYPTION_KEY?: string
  /** Public SPA base URL the invite-accept link points at. */
  APP_BASE_URL?: string
  /**
   * Deployment environment marker (e.g. `production`, `staging`, `development`).
   * When set to a production-like value, the AUTH_DEV_OPEN escape hatch is
   * refused even if present — so a leaked dev flag can't re-open a deployed
   * worker. Set `ENVIRONMENT = "production"` in the deployed wrangler.toml.
   */
  ENVIRONMENT?: string

  /**
   * Comma-separated allowlist of browser Origins permitted by CORS (e.g. the
   * SPA's origin, `https://app.example.com`). Each provisioning org sets its own
   * frontend origin(s) here. A single `*` (or leaving this unset) allows any
   * origin — safe because every route is bearer-gated and fails closed, but set
   * it in production to harden. See `config/cors.ts` and `app.ts`.
   */
  CORS_ALLOWED_ORIGINS?: string

  /**
   * Shared master key (base64, ≥32 bytes decoded; a secret) for encrypting every
   * integration's per-workspace credentials at rest. ONE key backs them all: the
   * cipher domain-separates per integration via its HKDF `info` tag, so document,
   * task, environment and runner credentials never share a derived key. The always-on
   * document/task integrations require it and FAIL config load without it; the opt-in
   * environment/runner integrations need it (plus their enable flag) to assemble.
   */
  ENCRYPTION_KEY?: string

  // ---- Document-source integration (see config.ts; always on) -------------
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

  // ---- Task-source integration (see config.ts; always on) -----------------
  /**
   * Comma-separated allow-list of sources to register (e.g. `jira`). Defaults to
   * all known sources when unset.
   */
  TASK_SOURCES?: string

  // ---- Ephemeral environment integration (see config.ts; opt-in) ----------
  /**
   * Enables the environment provider integration ('true'). Per-workspace provider
   * manifests and their (encrypted) secret bundles live in D1, not here. Secrets are
   * sealed with the shared `ENCRYPTION_KEY`.
   */
  ENVIRONMENTS_ENABLED?: string

  // ---- Self-hosted runner pool ("bring your own infra"; opt-in) -----------
  /**
   * Enables routing repo-operating coding jobs (`coder`, `mocker`, `playwright`)
   * to a workspace's own container runner pool instead of Cloudflare Containers
   * ('true'). Per-workspace pool manifests and their (encrypted) scheduler-API
   * secret bundles live in D1, not here. A workspace with a registered pool uses
   * it; workspaces without one fall back to the Cloudflare `EXEC_CONTAINER`
   * binding. Container-based implementation is always on, so when no
   * `EXEC_CONTAINER` binding is present a registered pool is the mandatory runner
   * backend. Requires a configured GitHub App, WORKER_PUBLIC_URL and the session
   * secret, exactly like the Cloudflare container path. Scheduler secrets are sealed
   * with the shared `ENCRYPTION_KEY`.
   */
  RUNNERS_ENABLED?: string

  // ---- Slack notification transport (see config/slack.ts; opt-in) ---------
  /**
   * Enables the Slack notification transport ('true'). The per-account bot token is
   * sealed with the shared `ENCRYPTION_KEY`. The three `SLACK_*` OAuth vars are
   * optional: when all present they enable the "Add to Slack" flow; otherwise an
   * org connects by pasting a bot token.
   */
  SLACK_ENABLED?: string
  SLACK_CLIENT_ID?: string
  SLACK_CLIENT_SECRET?: string
  SLACK_REDIRECT_URL?: string

  // ---- Prompt-fragment library (see config.ts; opt-in; ADR 0006) ----------
  /**
   * Enables the tenant-scoped prompt-fragment library ('true'). Fragments and
   * repo-source linkages live in D1; no encryption key is needed (guidelines are
   * not secrets and repo reads reuse the account's GitHub installation).
   */
  PROMPT_LIBRARY_ENABLED?: string
  /**
   * Relevance selector mode: 'llm' asks the agent model to pick relevant
   * fragments per run; 'deterministic' (default) matches on appliesTo + tags.
   */
  PROMPT_LIBRARY_SELECTOR?: string

  // ---- LLM observability ----------------------------------------------------
  /**
   * Whether the LLM observability sink records the complete prompts sent to the model
   * ('false' to disable). Default true. When disabled the numeric telemetry (tokens,
   * timing, finish reason, counts) is still captured, but the prompt body is stored
   * empty — for deployments that must not retain (potentially sensitive) prompt text.
   */
  LLM_RECORD_PROMPTS?: string

  // ---- Langfuse trace sink (opt-in LLM observability) -----------------------
  /**
   * Opt-in flag for streaming LLM generations (and container tool spans) to Langfuse.
   * Enabled only when 'true' AND both keys below are set. The sink uses Langfuse's
   * fetch-based ingestion API, so it runs unchanged on the Worker runtime.
   */
  LANGFUSE_ENABLED?: string
  /** Langfuse public key (`pk-lf-…`). */
  LANGFUSE_PUBLIC_KEY?: string
  /** Langfuse secret key (`sk-lf-…`); a Worker secret. */
  LANGFUSE_SECRET_KEY?: string
  /** Langfuse host; defaults to Langfuse Cloud when unset. */
  LANGFUSE_BASE_URL?: string

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
  /**
   * Days of `llm_call_metrics` (LLM observability) history to keep. Heavy — full
   * per-call prompt/response — and only useful for recent debugging, so pruned
   * aggressively. Default 3. 0 disables pruning.
   */
  LLM_CALL_METRICS_RETENTION_DAYS?: string
}
