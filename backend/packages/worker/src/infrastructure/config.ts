import type { AgentKind } from '@cat-factory/contracts'
import {
  type AgentModelConfig,
  type AgentRouting,
  DEFAULT_MODEL_PRICES,
  DEFAULT_MONTHLY_LIMIT_EUR,
  type ModelPrice,
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
  }
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

export function loadConfig(env: Env): AppConfig {
  const defaultConfig: AgentModelConfig = {
    ref: {
      provider: env.AGENT_DEFAULT_PROVIDER ?? 'workers-ai',
      model: env.AGENT_DEFAULT_MODEL ?? '@cf/meta/llama-3.1-8b-instruct',
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
    },
    execution: {
      // Default to 'tick' so behaviour is unchanged until an operator opts in,
      // mirroring the AGENTS_ENABLED default-off convention.
      mode: env.EXECUTION_MODE === 'workflow' ? 'workflow' : 'tick',
      decisionTimeout: env.DECISION_TIMEOUT?.trim() || '24 hours',
    },
    spend: loadSpendPricing(env),
    github: loadGitHubConfig(env),
    auth: loadAuthConfig(env),
  }
}
