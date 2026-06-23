import type { AgentModelConfig } from '@cat-factory/agents'
import {
  ALL_SUBSCRIPTION_VENDORS,
  type ProviderCapabilities,
  effectiveCatalog,
  resolveModelRef,
} from '@cat-factory/kernel'
import type { DocumentSourceKind, TaskSourceKind } from '@cat-factory/kernel'
import type {
  AppConfig,
  DocumentsConfig,
  PrivilegedAppConfig,
  TasksConfig,
} from '@cat-factory/server'
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

// The privileged App tier (ADR 0005) only activates when both its id and key are
// present; either alone is treated as unconfigured so a half-set env never silently
// authenticates as a misconfigured App. Mirrors the Worker's `loadPrivilegedApp`.
function loadPrivilegedApp(env: NodeJS.ProcessEnv): PrivilegedAppConfig | undefined {
  const appId = env.GITHUB_PRIVILEGED_APP_ID?.trim() ?? ''
  if (appId === '' || !env.GITHUB_PRIVILEGED_APP_PRIVATE_KEY?.trim()) return undefined
  return { appId }
}

// The task sources the Node facade can serve, mirroring the Worker's `ALL_SOURCES`.
// GitHub issues reuse the workspace's installed GitHub App (wired in the container
// only when a GitHub client is available); Jira carries its own per-workspace creds.
const NODE_TASK_SOURCES: readonly TaskSourceKind[] = ['jira', 'github']

const ALL_DOCUMENT_SOURCES: readonly DocumentSourceKind[] = ['confluence', 'notion', 'github']

/** Parse the comma-separated `DOCUMENT_SOURCES` allow-list, defaulting to all. */
function parseDocumentSources(raw: string | undefined): DocumentSourceKind[] {
  const requested = csv(raw).map((s) => s.toLowerCase())
  if (requested.length === 0) return [...ALL_DOCUMENT_SOURCES]
  const selected = ALL_DOCUMENT_SOURCES.filter((s) => requested.includes(s))
  return selected.length > 0 ? selected : [...ALL_DOCUMENT_SOURCES]
}

/**
 * Document-source integration config, mirroring the Worker's `loadDocumentsConfig`:
 * always on (tenants connect Notion/Confluence/GitHub-docs through the UI), with the
 * shared ENCRYPTION_KEY backing per-workspace credential encryption at rest. The
 * planner defaults to LLM mode; the container only wires a model provider when one is
 * configured, so absent that the planner degrades to its deterministic heading parser.
 */
function loadDocumentsConfig(env: NodeJS.ProcessEnv): DocumentsConfig {
  const encryptionKey = env.ENCRYPTION_KEY?.trim()
  if (!encryptionKey) {
    throw new Error(
      'ENCRYPTION_KEY is required: the document-source integration (Notion, Confluence, …) ' +
        'encrypts per-workspace source credentials at rest. Set it to a base64-encoded key of ' +
        'at least 32 bytes.',
    )
  }
  return {
    enabled: true,
    sources: parseDocumentSources(env.DOCUMENT_SOURCES),
    planner: env.DOCUMENT_PLANNER?.trim() === 'headings' ? 'headings' : 'llm',
    encryptionKey,
  }
}

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
  // Deployment-level capabilities: direct keys are per-workspace (resolved at run time
  // from the DB pool), so none are known here; Cloudflare Workers AI is opt-in over
  // REST (account id + API token). The per-workspace `/models` endpoint recomputes
  // selectability against each workspace's configured keys + subscriptions.
  const caps: ProviderCapabilities = {
    directProviders: new Set(),
    subscriptionVendors: new Set(ALL_SUBSCRIPTION_VENDORS),
    cloudflareEnabled: !!(env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN),
  }

  // Default unpinned agents to Qwen (the Cloudflare flavour when enabled, upgraded to
  // direct DashScope per-workspace by the executor when a Qwen key is configured); the
  // agentic kinds default to GLM-5.2 — mirroring the Worker's routing.
  const qwenDefault = resolveModelRef('qwen', caps)
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
  // Companions (reviewer / spec-companion / architect-companion) return their whole
  // verdict — rating + summary + per-item comments — as ONE inline JSON reply. On a
  // reasoning model the <think> tokens share the output budget, so the 5000 cap can
  // truncate the JSON mid-comment, leaving it unparseable. Give companions a larger
  // budget so the verdict fits (mirrors the Worker's routing).
  const companionDefault: AgentModelConfig = {
    ref: { provider: 'workers-ai', model: '@cf/zai-org/glm-5.2' },
    temperature: num(env.AGENT_DEFAULT_TEMPERATURE) ?? 0.3,
    maxOutputTokens: num(env.AGENT_MAX_OUTPUT_TOKENS) ?? 12000,
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
  const googleClientId = env.GOOGLE_OAUTH_CLIENT_ID?.trim() ?? ''
  const googleClientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET?.trim() ?? ''
  const environment = env.ENVIRONMENT?.trim().toLowerCase() ?? ''
  const ttlHours = num(env.AUTH_SESSION_TTL_HOURS)
  const strongSecret = sessionSecret.length >= MIN_SESSION_SECRET_LENGTH
  const githubEnabled = clientId !== '' && clientSecret !== '' && strongSecret
  const googleEnabled = googleClientId !== '' && googleClientSecret !== '' && strongSecret
  const passwordEnabled = env.AUTH_PASSWORD_ENABLED?.trim() === 'true' && strongSecret

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
        byKind: {
          architect: agenticDefault,
          coder: agenticDefault,
          reviewer: companionDefault,
          'spec-companion': companionDefault,
          'architect-companion': companionDefault,
        },
      },
      resolveBlockModel: (modelId) => resolveModelRef(modelId, caps),
    },
    // Surface each model's informational list cost in the picker (from spend pricing).
    models: effectiveCatalog(caps, modelCostResolver(spend)),
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
      privilegedApp: loadPrivilegedApp(env),
    },
    auth: {
      enabled: githubEnabled || googleEnabled || passwordEnabled,
      devOpen,
      githubEnabled,
      clientId,
      clientSecret,
      sessionSecret,
      apiBase: env.GITHUB_API_BASE?.trim() || 'https://api.github.com',
      oauthBase: env.GITHUB_OAUTH_BASE?.trim() || 'https://github.com',
      sessionTtlMs: (ttlHours !== undefined && ttlHours > 0 ? ttlHours : 168) * 60 * 60 * 1000,
      successRedirectUrl: env.AUTH_SUCCESS_REDIRECT_URL?.trim() || '',
      callbackUrl: env.AUTH_CALLBACK_URL?.trim() || '',
      passwordEnabled,
      ...(googleEnabled
        ? {
            google: {
              clientId: googleClientId,
              clientSecret: googleClientSecret,
              redirectUrl: env.GOOGLE_OAUTH_REDIRECT_URL?.trim() || '',
            },
          }
        : {}),
      allowedEmailDomains: csv(env.AUTH_ALLOWED_EMAIL_DOMAINS).map((d) => d.toLowerCase()),
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
    email:
      env.EMAIL_ENABLED?.trim() === 'true' && env.ENCRYPTION_KEY?.trim()
        ? {
            enabled: true,
            encryptionKey: env.ENCRYPTION_KEY.trim(),
            appBaseUrl: env.APP_BASE_URL?.trim() || env.AUTH_SUCCESS_REDIRECT_URL?.trim() || '',
          }
        : {
            enabled: false,
            appBaseUrl: env.APP_BASE_URL?.trim() || env.AUTH_SUCCESS_REDIRECT_URL?.trim() || '',
          },
    // Document-source integration: the providers (Confluence/Notion/GitHub-docs) are
    // the shared `@cat-factory/integrations` fetch shells, wired in the container
    // exactly like the Worker's `selectDocumentsDeps`. Always on (the shared
    // ENCRYPTION_KEY backs credential encryption at rest).
    documents: loadDocumentsConfig(env),
    tasks: loadTasksConfig(env),
    // Ephemeral-environment provider integration: opt-in (a tenant rolls its own
    // environment-management API), gated on ENVIRONMENTS_ENABLED + the shared
    // ENCRYPTION_KEY (credentials are encrypted at rest), mirroring the Worker.
    environments:
      env.ENVIRONMENTS_ENABLED === 'true' && env.ENCRYPTION_KEY?.trim()
        ? { enabled: true, encryptionKey: env.ENCRYPTION_KEY.trim() }
        : { enabled: false },
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
    // Datadog post-release-health: opt-in (`DATADOG_ENABLED=true`) + the shared
    // ENCRYPTION_KEY (the per-workspace API/app keys are sealed at rest). Mirrors the Worker.
    datadog:
      env.DATADOG_ENABLED === 'true' && env.ENCRYPTION_KEY?.trim()
        ? { enabled: true, encryptionKey: env.ENCRYPTION_KEY.trim() }
        : { enabled: false },
    // Optional incident enrichment (annotate, never re-alert): deployment-level creds.
    incidentEnrichment: {
      ...(env.PAGERDUTY_API_TOKEN?.trim() && env.PAGERDUTY_FROM_EMAIL?.trim()
        ? {
            pagerDuty: {
              apiToken: env.PAGERDUTY_API_TOKEN.trim(),
              fromEmail: env.PAGERDUTY_FROM_EMAIL.trim(),
            },
          }
        : {}),
      ...(env.INCIDENTIO_API_KEY?.trim()
        ? { incidentIo: { apiKey: env.INCIDENTIO_API_KEY.trim() } }
        : {}),
    },
    retention: {
      tokenUsageMs: (num(env.TOKEN_USAGE_RETENTION_DAYS) ?? 395) * 24 * 60 * 60 * 1000,
      rateLimitMs: (num(env.GITHUB_RATE_LIMIT_RETENTION_DAYS) ?? 7) * 24 * 60 * 60 * 1000,
      commitMs: (num(env.GITHUB_COMMIT_RETENTION_DAYS) ?? 90) * 24 * 60 * 60 * 1000,
      // Heavy full per-call prompt/response; pruned aggressively (default 3 days).
      llmCallMetricsMs: (num(env.LLM_CALL_METRICS_RETENTION_DAYS) ?? 3) * 24 * 60 * 60 * 1000,
    },
    // Prompt-fragment library (ADR 0006): opt-in (`PROMPT_LIBRARY_ENABLED=true`),
    // needs no encryption key (fragments are not secrets). Mirrors the Worker's
    // mapping; `PROMPT_LIBRARY_SELECTOR=llm` ranks per run, else the deterministic
    // tag matcher (which also backs the `llm` selector's graceful fallback).
    fragmentLibrary: {
      enabled: env.PROMPT_LIBRARY_ENABLED?.trim() === 'true',
      selector: env.PROMPT_LIBRARY_SELECTOR?.trim() === 'llm' ? 'llm' : 'deterministic',
    },
    // Recording the complete prompts is on by default; opt out with
    // `LLM_RECORD_PROMPTS=false` to keep the numeric telemetry but drop the prompt body.
    observability: { recordPrompts: env.LLM_RECORD_PROMPTS?.trim() !== 'false' },
    // Optional Langfuse trace sink: off unless `LANGFUSE_ENABLED=true` AND both keys are
    // present (a half-configured sink silently does nothing). Mirrors the Worker mapping.
    langfuse: {
      enabled:
        env.LANGFUSE_ENABLED?.trim() === 'true' &&
        !!env.LANGFUSE_PUBLIC_KEY?.trim() &&
        !!env.LANGFUSE_SECRET_KEY?.trim(),
      publicKey: env.LANGFUSE_PUBLIC_KEY?.trim(),
      secretKey: env.LANGFUSE_SECRET_KEY?.trim(),
      baseUrl: env.LANGFUSE_BASE_URL?.trim() || undefined,
    },
  }
}
