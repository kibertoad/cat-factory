import type { AgentModelConfig } from '@cat-factory/agents'
import { effectiveCatalog, resolveModelRef } from '@cat-factory/kernel'
import type { TaskSourceKind } from '@cat-factory/kernel'
import type { AppConfig, TasksConfig } from '@cat-factory/server'
import { DEFAULT_SPEND_PRICING, modelCostResolver } from '@cat-factory/spend'

// Translate the Node process environment into the shared AppConfig contract. This is
// the Node analogue of the Worker's `loadConfig(env)`: same SHAPE, different source.
// Integrations (GitHub/documents/tasks/environments/runners/fragment-library) default
// to disabled in this MVP; the core (board/workspaces/pipelines/executions/spend +
// auth) is fully configured from env.

const MIN_SESSION_SECRET_LENGTH = 32
const PRODUCTION_ENVIRONMENTS = new Set(['production', 'prod', 'staging'])

function num(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

function csv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

// Node only ships the runtime-neutral Jira provider today; GitHub Issues need the
// per-tenant GitHub App installation infra, wired separately.
const NODE_TASK_SOURCES: readonly TaskSourceKind[] = ['jira']

/**
 * Task-source integration config, mirroring the Worker's `loadTasksConfig`: always on
 * (tenants connect their own trackers through the UI, so there is no enable flag), with
 * a mandatory encryption key so credentials are never stored in plaintext. The key is
 * missing → fail loudly at config load rather than silently disabling the feature.
 * `TASK_SOURCES` narrows the registered providers (defaults to all Node-supported ones).
 */
function loadTasksConfig(env: NodeJS.ProcessEnv): TasksConfig {
  // The shared ENCRYPTION_KEY backs every integration (the cipher domain-separates per
  // integration via its HKDF `info`, so one key safely backs them all).
  const encryptionKey = env.ENCRYPTION_KEY?.trim()
  if (!encryptionKey) {
    throw new Error(
      'ENCRYPTION_KEY is required: the task-source integration (Jira, …) encrypts ' +
        'per-workspace source credentials at rest. Set it to a base64-encoded key of at ' +
        'least 32 bytes.',
    )
  }
  const requested = csv(env.TASK_SOURCES).map((s) => s.toLowerCase())
  const sources =
    requested.length > 0
      ? NODE_TASK_SOURCES.filter((s) => requested.includes(s))
      : [...NODE_TASK_SOURCES]
  return {
    enabled: true,
    sources: sources.length > 0 ? sources : [...NODE_TASK_SOURCES],
    encryptionKey,
  }
}

export function loadNodeConfig(env: NodeJS.ProcessEnv): AppConfig {
  const isDirectAvailable = (keyEnv: string): boolean => !!env[keyEnv]

  // Default unpinned agents to Qwen (direct DashScope when keyed, else its Cloudflare
  // flavour); the agentic kinds default to GLM-5.2 — mirroring the Worker's routing.
  const qwenDefault = resolveModelRef('qwen', isDirectAvailable)
  const defaultConfig: AgentModelConfig = {
    ref: {
      provider: env.AGENT_DEFAULT_PROVIDER ?? qwenDefault?.provider ?? 'workers-ai',
      model: env.AGENT_DEFAULT_MODEL ?? qwenDefault?.model ?? '@cf/qwen/qwen3-30b-a3b-fp8',
    },
    temperature: num(env.AGENT_DEFAULT_TEMPERATURE) ?? 0.4,
    maxOutputTokens: num(env.AGENT_MAX_OUTPUT_TOKENS) ?? 5000,
  }
  const agenticDefault: AgentModelConfig = {
    ref: { provider: 'workers-ai', model: '@cf/zai-org/glm-5.2' },
    temperature: num(env.AGENT_DEFAULT_TEMPERATURE) ?? 0.3,
    maxOutputTokens: num(env.AGENT_MAX_OUTPUT_TOKENS) ?? 5000,
  }

  const sessionSecret = env.AUTH_SESSION_SECRET?.trim() ?? ''
  // The GitHub App (private key + app id) backs container-agent runs: it mints the
  // short-lived push token the harness clones/pushes with. Enable the integration
  // only when both are present (the container executor also requires it — see
  // container.ts), so a partial config doesn't half-enable repo-operating steps.
  const githubAppId = env.GITHUB_APP_ID?.trim() ?? ''
  const githubAppConfigured =
    githubAppId !== '' && (env.GITHUB_APP_PRIVATE_KEY?.trim() ?? '') !== ''
  // Self-hosted runner pools encrypt their scheduler credentials at rest; opt-in via
  // the enable flag, sealed with the shared ENCRYPTION_KEY (mirroring the Worker).
  const runnersEncryptionKey = env.ENCRYPTION_KEY?.trim() ?? ''
  // Slack notification transport: opt-in (SLACK_ENABLED), the per-account bot token
  // sealed with the shared ENCRYPTION_KEY. OAuth credentials are optional (manual
  // bot-token onboarding works without them); when set they enable "Add to Slack".
  const slackEnabled = env.SLACK_ENABLED?.trim() === 'true'
  const slackEncryptionKey = env.ENCRYPTION_KEY?.trim() ?? ''
  const slackClientId = env.SLACK_CLIENT_ID?.trim() ?? ''
  const slackClientSecret = env.SLACK_CLIENT_SECRET?.trim() ?? ''
  const slackRedirectUrl = env.SLACK_REDIRECT_URL?.trim() ?? ''
  const slackOAuth =
    slackClientId && slackClientSecret && slackRedirectUrl
      ? { clientId: slackClientId, clientSecret: slackClientSecret, redirectUrl: slackRedirectUrl }
      : undefined
  const clientId = env.GITHUB_OAUTH_CLIENT_ID?.trim() ?? ''
  const clientSecret = env.GITHUB_OAUTH_CLIENT_SECRET?.trim() ?? ''
  const environment = env.ENVIRONMENT?.trim().toLowerCase() ?? ''
  const ttlHours = num(env.AUTH_SESSION_TTL_HOURS)

  const devOpen = env.AUTH_DEV_OPEN?.trim() === 'true' && !PRODUCTION_ENVIRONMENTS.has(environment)

  // Fail fast on the silent-brick footgun: OAuth credentials are set (so real auth is
  // intended) but the session secret is missing/too short, which would disable the auth
  // gate and — with no dev-open fallback — make it fail closed, 503-ing every protected
  // route with no hint why. Refuse to boot with a clear message instead.
  if (
    clientId !== '' &&
    clientSecret !== '' &&
    sessionSecret.length < MIN_SESSION_SECRET_LENGTH &&
    !devOpen
  ) {
    throw new Error(
      `AUTH_SESSION_SECRET must be at least ${MIN_SESSION_SECRET_LENGTH} characters when GitHub OAuth is configured ` +
        `(got ${sessionSecret.length}). Set a longer secret or enable AUTH_DEV_OPEN in a non-production environment.`,
    )
  }

  const spend = {
    ...DEFAULT_SPEND_PRICING,
    currency: env.SPEND_CURRENCY?.trim() || DEFAULT_SPEND_PRICING.currency,
    monthlyLimit: num(env.SPEND_MONTHLY_LIMIT) ?? DEFAULT_SPEND_PRICING.monthlyLimit,
  }

  return {
    agents: {
      routing: {
        default: defaultConfig,
        byKind: { architect: agenticDefault, coder: agenticDefault, reviewer: agenticDefault },
      },
      resolveBlockModel: (modelId) => resolveModelRef(modelId, isDirectAvailable),
    },
    // Surface each model's informational list cost in the picker (from spend pricing).
    models: effectiveCatalog(isDirectAvailable, modelCostResolver(spend)),
    execution: {
      decisionTimeout: env.DECISION_TIMEOUT?.trim() || '24 hours',
      jobPollInterval: env.JOB_POLL_INTERVAL?.trim() || '15 seconds',
      jobMaxPolls: num(env.JOB_MAX_POLLS) ?? 280,
      jobPollFailureTolerance: num(env.JOB_POLL_FAILURE_TOLERANCE) ?? 6,
      ciPollInterval: env.CI_POLL_INTERVAL?.trim() || '30 seconds',
      ciMaxPolls: num(env.CI_MAX_POLLS) ?? 120,
      containerMaxAgeMs: Math.max(75, num(env.CONTAINER_MAX_AGE_MINUTES) ?? 90) * 60_000,
    },
    spend,
    github: {
      enabled: githubAppConfigured,
      appId: env.GITHUB_APP_ID?.trim() ?? '',
      appSlug: env.GITHUB_APP_SLUG?.trim() ?? '',
      apiBase: env.GITHUB_API_BASE?.trim() || 'https://api.github.com',
      setupRedirectUrl: env.GITHUB_SETUP_REDIRECT_URL?.trim() || '/',
      webhookSecret: env.GITHUB_WEBHOOK_SECRET ?? '',
    },
    auth: {
      enabled:
        clientId !== '' && clientSecret !== '' && sessionSecret.length >= MIN_SESSION_SECRET_LENGTH,
      devOpen,
      clientId,
      clientSecret,
      sessionSecret,
      apiBase: env.GITHUB_API_BASE?.trim() || 'https://api.github.com',
      oauthBase: env.GITHUB_OAUTH_BASE?.trim() || 'https://github.com',
      sessionTtlMs: (ttlHours !== undefined && ttlHours > 0 ? ttlHours : 168) * 60 * 60 * 1000,
      successRedirectUrl: env.AUTH_SUCCESS_REDIRECT_URL?.trim() || '',
      callbackUrl: env.AUTH_CALLBACK_URL?.trim() || '',
      allowedLogins: csv(env.AUTH_ALLOWED_LOGINS).map((l) => l.toLowerCase()),
      allowedOrgs: csv(env.AUTH_ALLOWED_ORGS).map((o) => o.toLowerCase()),
      allowedRedirectOrigins: csv(env.AUTH_ALLOWED_REDIRECT_ORIGINS).map((o) => {
        try {
          return new URL(o).origin
        } catch {
          return o
        }
      }),
    },
    // The Node facade does not ship document-source providers yet (Notion/Confluence
    // fetchers live only in the Worker infra), so documents stays off here — and,
    // unlike tasks, requires no encryption key. Wiring Node document providers is the
    // remaining symmetry follow-up; until then this facade serves task sources only.
    documents: { enabled: false, sources: [], planner: 'headings' },
    tasks: loadTasksConfig(env),
    environments: { enabled: false },
    runners: runnersEncryptionKey
      ? { enabled: true, encryptionKey: runnersEncryptionKey }
      : { enabled: false },
    slack:
      slackEnabled && slackEncryptionKey
        ? {
            enabled: true,
            encryptionKey: slackEncryptionKey,
            ...(slackOAuth ? { oauth: slackOAuth } : {}),
          }
        : { enabled: false },
    retention: {
      tokenUsageMs: (num(env.TOKEN_USAGE_RETENTION_DAYS) ?? 395) * 24 * 60 * 60 * 1000,
      rateLimitMs: (num(env.GITHUB_RATE_LIMIT_RETENTION_DAYS) ?? 7) * 24 * 60 * 60 * 1000,
      commitMs: (num(env.GITHUB_COMMIT_RETENTION_DAYS) ?? 90) * 24 * 60 * 60 * 1000,
      // Heavy full per-call prompt/response; pruned aggressively (default 3 days).
      llmCallMetricsMs: (num(env.LLM_CALL_METRICS_RETENTION_DAYS) ?? 3) * 24 * 60 * 60 * 1000,
    },
    fragmentLibrary: { enabled: false, selector: 'deterministic' },
    // Recording the complete prompts is on by default; opt out with
    // `LLM_RECORD_PROMPTS=false` to keep the numeric telemetry but drop the prompt body.
    observability: { recordPrompts: env.LLM_RECORD_PROMPTS?.trim() !== 'false' },
  }
}
