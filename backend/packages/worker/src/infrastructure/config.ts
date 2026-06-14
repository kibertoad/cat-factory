import type { AgentKind, ModelOption } from '@cat-factory/contracts'
import {
  type AgentModelConfig,
  type AgentRouting,
  DEFAULT_MODEL_PRICES,
  DEFAULT_MONTHLY_LIMIT_EUR,
  effectiveCatalog,
  type ModelPrice,
  type ModelRef,
  resolveModelRef,
  type SpendPricing,
} from '@cat-factory/core'
import type { Env } from './env'

// Translates the flat, string-typed Worker environment into a structured app
// config — in particular the agent model routing ("which LLM, with what config,
// for what"). Operators tune behaviour entirely through wrangler vars / secrets.

export type ExecutionMode = 'workflow' | 'tick'

export interface AppConfig {
  agents: {
    enabled: boolean
    routing: AgentRouting
    /**
     * Resolve a block's selected model id to a concrete ref, honouring the
     * direct/Cloudflare fallback based on which provider keys are configured.
     */
    resolveBlockModel: (modelId: string | undefined) => ModelRef | undefined
  }
  /** The effective model picker catalog (each model's active flavour). */
  models: ModelOption[]
  execution: {
    /** 'workflow' drives runs durably; 'tick' keeps the legacy polling engine. */
    mode: ExecutionMode
    /** Human-decision park timeout passed to the workflow's waitForEvent. */
    decisionTimeout: string
  }
  /** Pricing + budget for the spend safeguard. */
  spend: SpendPricing
  /** GitHub integration config; `enabled` is false unless a GitHub App is set up. */
  github: GitHubConfig
  /** "Login with GitHub" config; `enabled` is false unless an OAuth app is set up. */
  auth: AuthConfig
  /** Retention windows for the unbounded ledgers/projections (epoch-ms ages). */
  retention: RetentionConfig
}

/**
 * Retention windows in milliseconds for the tables that don't self-limit. A
 * window of 0 disables pruning for that table (and, for commits, disables the
 * backfill horizon too). See docs/storage-and-retention.md.
 */
export interface RetentionConfig {
  tokenUsageMs: number
  rateLimitMs: number
  commitMs: number
}

export interface AuthConfig {
  enabled: boolean
  clientId: string
  clientSecret: string
  sessionSecret: string
  /** REST API base for reading the user (shared with the GitHub integration). */
  apiBase: string
  /** OAuth host (authorize/token endpoints). */
  oauthBase: string
  /** Session token lifetime in milliseconds. */
  sessionTtlMs: number
  /** Fixed post-login landing URL; '' means honour the request-provided one. */
  successRedirectUrl: string
  /** Explicit OAuth redirect_uri; '' means derive it from the request origin. */
  callbackUrl: string
  /** Lowercased GitHub logins permitted to sign in; empty means allow any. */
  allowedLogins: string[]
}

export interface GitHubConfig {
  enabled: boolean
  appId: string
  appSlug: string
  apiBase: string
  /** Browser redirect target after a successful connect (falls back to '/'). */
  setupRedirectUrl: string
}

/**
 * A model's direct flavour activates when its API key env var is present and
 * non-empty. Keys are looked up by name (from the catalog's `keyEnv`).
 */
function directKeyAvailable(env: Env): (keyEnv: string) => boolean {
  const bag = env as unknown as Record<string, string | undefined>
  return (keyEnv) => {
    const value = bag[keyEnv]
    return typeof value === 'string' && value.trim() !== ''
  }
}

function num(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

function parseModelOverrides(
  raw: string | undefined,
): Partial<Record<AgentKind, AgentModelConfig>> {
  if (!raw || raw.trim() === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('AGENT_MODELS is not valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null) return {}

  const out: Partial<Record<AgentKind, AgentModelConfig>> = {}
  for (const [kind, value] of Object.entries(parsed as Record<string, Record<string, unknown>>)) {
    const provider = value.provider
    const model = value.model
    if (typeof provider !== 'string' || typeof model !== 'string') {
      throw new Error(`AGENT_MODELS.${kind} requires string "provider" and "model"`)
    }
    out[kind] = {
      ref: { provider, model },
      temperature: typeof value.temperature === 'number' ? value.temperature : undefined,
      maxOutputTokens:
        typeof value.maxOutputTokens === 'number' ? value.maxOutputTokens : undefined,
      system: typeof value.system === 'string' ? value.system : undefined,
    }
  }
  return out
}

function parsePriceOverrides(raw: string | undefined): Record<string, ModelPrice> {
  if (!raw || raw.trim() === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('SPEND_MODEL_PRICES is not valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null) return {}

  const out: Record<string, ModelPrice> = {}
  for (const [key, value] of Object.entries(parsed as Record<string, Record<string, unknown>>)) {
    const input = value.inputPerMillion
    const output = value.outputPerMillion
    if (typeof input !== 'number' || typeof output !== 'number') {
      throw new Error(
        `SPEND_MODEL_PRICES.${key} requires numeric "inputPerMillion" and "outputPerMillion"`,
      )
    }
    out[key] = { inputPerMillion: input, outputPerMillion: output }
  }
  return out
}

function loadGitHubConfig(env: Env): GitHubConfig {
  // Enabled when the App id and both secrets are present; the integration is
  // entirely opt-in, matching the AGENTS_ENABLED default-off convention.
  const appId = env.GITHUB_APP_ID?.trim() ?? ''
  const enabled = appId !== '' && !!env.GITHUB_APP_PRIVATE_KEY && !!env.GITHUB_WEBHOOK_SECRET
  return {
    enabled,
    appId,
    appSlug: env.GITHUB_APP_SLUG?.trim() ?? '',
    apiBase: env.GITHUB_API_BASE?.trim() || 'https://api.github.com',
    setupRedirectUrl: env.GITHUB_SETUP_REDIRECT_URL?.trim() || '/',
  }
}

function loadAuthConfig(env: Env): AuthConfig {
  // Enabled when the OAuth credentials and the session secret are all present,
  // mirroring the GitHub-integration / AGENTS_ENABLED default-off convention.
  const clientId = env.GITHUB_OAUTH_CLIENT_ID?.trim() ?? ''
  const clientSecret = env.GITHUB_OAUTH_CLIENT_SECRET?.trim() ?? ''
  const sessionSecret = env.AUTH_SESSION_SECRET?.trim() ?? ''
  const ttlHours = num(env.AUTH_SESSION_TTL_HOURS)
  return {
    enabled: clientId !== '' && clientSecret !== '' && sessionSecret !== '',
    clientId,
    clientSecret,
    sessionSecret,
    apiBase: env.GITHUB_API_BASE?.trim() || 'https://api.github.com',
    oauthBase: env.GITHUB_OAUTH_BASE?.trim() || 'https://github.com',
    sessionTtlMs: (ttlHours !== undefined && ttlHours > 0 ? ttlHours : 168) * 60 * 60 * 1000,
    successRedirectUrl: env.AUTH_SUCCESS_REDIRECT_URL?.trim() || '',
    callbackUrl: env.AUTH_CALLBACK_URL?.trim() || '',
    allowedLogins: (env.AUTH_ALLOWED_LOGINS ?? '')
      .split(',')
      .map((login) => login.trim().toLowerCase())
      .filter(Boolean),
  }
}

function loadSpendPricing(env: Env): SpendPricing {
  const limit = num(env.SPEND_MONTHLY_LIMIT)
  return {
    currency: env.SPEND_CURRENCY?.trim() || 'EUR',
    monthlyLimit: limit !== undefined && limit >= 0 ? limit : DEFAULT_MONTHLY_LIMIT_EUR,
    // Operator overrides win over the built-in defaults, per key.
    prices: { ...DEFAULT_MODEL_PRICES, ...parsePriceOverrides(env.SPEND_MODEL_PRICES) },
    defaultPrice: { inputPerMillion: 0.14, outputPerMillion: 0.55 },
  }
}

const DAY_MS = 24 * 60 * 60 * 1000

/** Parse a non-negative retention-day var into ms, falling back to `defaultDays`. */
function retentionMs(raw: string | undefined, defaultDays: number): number {
  const days = num(raw)
  return (days !== undefined && days >= 0 ? days : defaultDays) * DAY_MS
}

function loadRetentionConfig(env: Env): RetentionConfig {
  return {
    // ~13 months: generous, since the spend budget only reads the current period.
    tokenUsageMs: retentionMs(env.TOKEN_USAGE_RETENTION_DAYS, 395),
    // Aggressive: pure telemetry whose only consumer cares about recent headroom.
    rateLimitMs: retentionMs(env.GITHUB_RATE_LIMIT_RETENTION_DAYS, 7),
    // Caps the commits projection and bounds the initial backfill to the same age.
    commitMs: retentionMs(env.GITHUB_COMMIT_RETENTION_DAYS, 90),
  }
}

export function loadConfig(env: Env): AppConfig {
  const isDirectAvailable = directKeyAvailable(env)

  // Default unpinned agents/blocks to the Qwen model (its active flavour: direct
  // DashScope when QWEN_API_KEY is set, else the Cloudflare Workers AI variant).
  // An operator can still pin a specific provider/model via the env vars.
  const qwenDefault = resolveModelRef('qwen', isDirectAvailable)
  const defaultConfig: AgentModelConfig = {
    ref: {
      provider: env.AGENT_DEFAULT_PROVIDER ?? qwenDefault?.provider ?? 'workers-ai',
      model: env.AGENT_DEFAULT_MODEL ?? qwenDefault?.model ?? '@cf/qwen/qwen3-30b-a3b-fp8',
    },
    temperature: num(env.AGENT_DEFAULT_TEMPERATURE) ?? 0.4,
    maxOutputTokens: num(env.AGENT_MAX_OUTPUT_TOKENS) ?? 512,
  }

  return {
    agents: {
      enabled: env.AGENTS_ENABLED === 'true',
      routing: {
        default: defaultConfig,
        byKind: parseModelOverrides(env.AGENT_MODELS),
      },
      resolveBlockModel: (modelId) => resolveModelRef(modelId, isDirectAvailable),
    },
    models: effectiveCatalog(isDirectAvailable),
    execution: {
      // Default to 'tick' so behaviour is unchanged until an operator opts in,
      // mirroring the AGENTS_ENABLED default-off convention.
      mode: env.EXECUTION_MODE === 'workflow' ? 'workflow' : 'tick',
      decisionTimeout: env.DECISION_TIMEOUT?.trim() || '24 hours',
    },
    spend: loadSpendPricing(env),
    github: loadGitHubConfig(env),
    auth: loadAuthConfig(env),
    retention: loadRetentionConfig(env),
  }
}
