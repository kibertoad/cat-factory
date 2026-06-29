import type { AgentModelConfig } from '@cat-factory/agents'
import {
  ALL_SUBSCRIPTION_VENDORS,
  type ProviderCapabilities,
  effectiveCatalog,
  resolveModelRef,
} from '@cat-factory/kernel'
import type { DocumentSourceKind } from '@cat-factory/kernel'
import type {
  AppConfig,
  DocumentsConfig,
  EmailConfig,
  GitLabConfig,
  PrivilegedAppConfig,
  TasksConfig,
} from '@cat-factory/server'
import { GITLAB_PUBLIC_API_BASE } from '@cat-factory/gitlab'
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

/**
 * Opt-in GitLab VCS provider config (single-token model, mirroring local-mode's PAT).
 * Enabled as soon as a `GITLAB_TOKEN` is present; the token is read from env at wiring time,
 * so this carries only the non-secret address + the webhook secret. Mirrors the Worker's
 * `loadGitLabConfig` (per "keep the runtimes symmetric").
 */
function loadGitLabConfig(env: NodeJS.ProcessEnv): GitLabConfig | undefined {
  const token = env.GITLAB_TOKEN?.trim()
  if (!token) return undefined
  return {
    enabled: true,
    apiBase: env.GITLAB_API_BASE?.trim() || GITLAB_PUBLIC_API_BASE,
    connectionId: env.GITLAB_CONNECTION_ID?.trim() || 'gitlab',
    webhookSecret: env.GITLAB_WEBHOOK_SECRET ?? '',
  }
}

// Every source this facade knows how to wire — the validation set an explicit
// `DOCUMENT_SOURCES` entry is checked against.
const ALL_DOCUMENT_SOURCES: readonly DocumentSourceKind[] = [
  'confluence',
  'notion',
  'github',
  'figma',
  'linear',
  'claude-design',
]

// Sources enabled when `DOCUMENT_SOURCES` is unset. Claude Design is intentionally
// NOT on by default: its credentialed project-read API is provisional (the read is
// still claude.ai-login-bound, no per-user service token yet), so connecting it today
// can't fetch. It must be opted in explicitly via `DOCUMENT_SOURCES=…,claude-design`
// once the API is real, rather than exposing a non-functional connector to every tenant.
const DEFAULT_DOCUMENT_SOURCES: readonly DocumentSourceKind[] = [
  'confluence',
  'notion',
  'github',
  'figma',
  'linear',
]

/** Parse the comma-separated `DOCUMENT_SOURCES` allow-list, defaulting to the on-by-default set. */
function parseDocumentSources(raw: string | undefined): DocumentSourceKind[] {
  const requested = csv(raw).map((s) => s.toLowerCase())
  if (requested.length === 0) return [...DEFAULT_DOCUMENT_SOURCES]
  const selected = ALL_DOCUMENT_SOURCES.filter((s) => requested.includes(s))
  return selected.length > 0 ? selected : [...DEFAULT_DOCUMENT_SOURCES]
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
 * Jira is always registered; GitHub Issues registers when a GitHub client is wired.
 * Which sources a workspace OFFERS is the per-workspace toggle (task_source_settings).
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
  // Linear OAuth app credentials (the "Connect with Linear" task-source flow). Present
  // only when id+secret are both set; absent ⇒ only the manual API-key paste is offered.
  const linearClientId = env.LINEAR_OAUTH_CLIENT_ID?.trim()
  const linearClientSecret = env.LINEAR_OAUTH_CLIENT_SECRET?.trim()
  const linearOAuth =
    linearClientId && linearClientSecret
      ? {
          clientId: linearClientId,
          clientSecret: linearClientSecret,
          redirectUrl: env.LINEAR_OAUTH_REDIRECT_URL?.trim() ?? '',
        }
      : undefined
  return {
    enabled: true,
    encryptionKey,
    linearOAuth,
  }
}

/**
 * The deployment-level system sender for auth emails (password reset), read entirely
 * from env. Present only when the provider, From address, and API key are all set.
 */
function loadSystemEmailSender(env: NodeJS.ProcessEnv): EmailConfig['system'] {
  const provider = env.EMAIL_SYSTEM_PROVIDER?.trim()
  const from = env.EMAIL_SYSTEM_FROM?.trim()
  const apiKey = env.EMAIL_SYSTEM_API_KEY?.trim()
  if ((provider === 'sendgrid' || provider === 'resend') && from && apiKey) {
    return { provider, from, apiKey }
  }
  return undefined
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
  // The conflict-resolver clones a PR head with merge conflicts and rewrites the
  // conflicted hunks against the base — a focused, diff-heavy reasoning task. Kimi K2.5
  // (a 1T-param agentic model native on Workers AI, 256K window) handles it better than
  // the small default MoE (mirrors the Worker's routing).
  const conflictResolverDefault: AgentModelConfig = {
    ref: { provider: 'workers-ai', model: '@cf/moonshotai/kimi-k2.5' },
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
  // Slack app OAuth credentials moved out of env into per-account settings (sealed),
  // resolved dynamically at connect time — see AccountSettingsService.
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

  // The deployment-level BASE pricing (built-in table + the fallback currency/monthly-limit
  // a workspace inherits when it sets no budget of its own). The per-workspace budget moved
  // out of env (`SPEND_*`) onto the workspace settings row; the spend service overlays it.
  const spend = DEFAULT_SPEND_PRICING

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
          'conflict-resolver': conflictResolverDefault,
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
    gitlab: loadGitLabConfig(env),
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
      // Open (un-gated) signup is a local-mode convenience; hosted defaults stay
      // invite/email-domain-gated. `applyLocalDefaults` flips it on for local mode.
      openSignup: env.AUTH_OPEN_SIGNUP?.trim() === 'true',
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
    // Email is available whenever an encryption key exists — there is no separate opt-in
    // flag. The per-account provider API key is sealed with that key. The deployment-level
    // `system` sender (auth emails like password reset) is read entirely from env and is
    // independent of the per-account connections, so it loads regardless of `enabled`.
    email: env.ENCRYPTION_KEY?.trim()
      ? {
          enabled: true,
          encryptionKey: env.ENCRYPTION_KEY.trim(),
          appBaseUrl: env.APP_BASE_URL?.trim() || env.AUTH_SUCCESS_REDIRECT_URL?.trim() || '',
          system: loadSystemEmailSender(env),
        }
      : {
          enabled: false,
          appBaseUrl: env.APP_BASE_URL?.trim() || env.AUTH_SUCCESS_REDIRECT_URL?.trim() || '',
          system: loadSystemEmailSender(env),
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
        ? {
            enabled: true,
            encryptionKey: env.ENCRYPTION_KEY.trim(),
            // Trusted-adapter escape hatch: permit an in-house env platform on an
            // internal/VPN host (otherwise the strict public-https guard rejects it).
            allowUrlHosts: csv(env.ENVIRONMENTS_ALLOW_URL_HOSTS),
            allowHttpUrls: env.ENVIRONMENTS_ALLOW_HTTP_URLS === 'true',
          }
        : { enabled: false },
    runners: runnersEncryptionKey
      ? {
          enabled: true,
          encryptionKey: runnersEncryptionKey,
          allowUrlHosts: csv(env.RUNNERS_ALLOW_URL_HOSTS),
          allowHttpUrls: env.RUNNERS_ALLOW_HTTP_URLS === 'true',
        }
      : { enabled: false },
    slack:
      slackEnabled && slackEncryptionKey
        ? { enabled: true, encryptionKey: slackEncryptionKey }
        : { enabled: false },
    // Observability post-release-health: opt-in (`OBSERVABILITY_ENABLED=true`) + the
    // shared ENCRYPTION_KEY (the per-workspace provider credentials are sealed at rest).
    // Mirrors the Worker. Incident-enrichment credentials (PagerDuty / incident.io) moved
    // out of env into a per-workspace sealed row.
    releaseHealth:
      env.OBSERVABILITY_ENABLED === 'true' && env.ENCRYPTION_KEY?.trim()
        ? { enabled: true, encryptionKey: env.ENCRYPTION_KEY.trim() }
        : { enabled: false },
    retention: {
      tokenUsageMs: (num(env.TOKEN_USAGE_RETENTION_DAYS) ?? 395) * 24 * 60 * 60 * 1000,
      rateLimitMs: (num(env.GITHUB_RATE_LIMIT_RETENTION_DAYS) ?? 7) * 24 * 60 * 60 * 1000,
      commitMs: (num(env.GITHUB_COMMIT_RETENTION_DAYS) ?? 90) * 24 * 60 * 60 * 1000,
      // Heavy full per-call prompt/response; pruned aggressively (default 3 days).
      llmCallMetricsMs: (num(env.LLM_CALL_METRICS_RETENTION_DAYS) ?? 3) * 24 * 60 * 60 * 1000,
      // High-churn provisioning event log; pruned aggressively (default 14 days).
      provisioningLogMs: (num(env.PROVISIONING_LOG_RETENTION_DAYS) ?? 14) * 24 * 60 * 60 * 1000,
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
