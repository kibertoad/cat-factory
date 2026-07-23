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
import {
  DOCS,
  ENV_HELP,
  ENV_VARS_ANCHORS,
  configProblem,
  logger,
  parseDetectionConventions,
  parseNumericEnv,
  requireEncryptionKey,
  requireGitHubAppPrivateKey,
  resolveMachineTokenTtlMs,
  resolvePlatformAlertConfig,
} from '@cat-factory/server'
import { GITLAB_PUBLIC_API_BASE } from '@cat-factory/gitlab'
import {
  parseOtlpHeaders,
  parsePlatformMetricsIntervalMs,
  parsePlatformMetricsWindow,
} from '@cat-factory/observability-otel'
import { DEFAULT_SPEND_PRICING, budgetCapsOverlay, modelCostResolver } from '@cat-factory/spend'

// Translate the Node process environment into the shared AppConfig contract. This is
// the Node analogue of the Worker's `loadConfig(env)`: same SHAPE, different source.
// Integrations (GitHub/documents/tasks/environments/runners/fragment-library) default
// to disabled in this MVP; the core (board/workspaces/pipelines/executions/spend +
// auth) is fully configured from env.

const MIN_SESSION_SECRET_LENGTH = 32
const PRODUCTION_ENVIRONMENTS = new Set(['production', 'prod', 'staging'])

// Parse a numeric env var, warning when a present value is un-parseable rather than
// silently coercing garbage to the caller's default (error-message coverage A8). The
// message lives in the shared server layer so it reads identically on the Worker facade.
const num = parseNumericEnv

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Parse a non-negative retention-day var into ms, falling back to `defaultDays`. Mirrors
 * the Worker's `retentionMs` (`infrastructure/config/utils.ts`) — including the `days >= 0`
 * clamp, so a negative override falls back to the default on both facades rather than
 * yielding a negative window on Node only ("keep the runtimes symmetric").
 */
function retentionMs(name: string, raw: string | undefined, defaultDays: number): number {
  const days = num(name, raw)
  return (days !== undefined && days >= 0 ? days : defaultDays) * DAY_MS
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
  'zeplin',
  'linear',
]

// Sources enabled when `DOCUMENT_SOURCES` is unset. Every known source is on by default;
// each is a no-op until a tenant connects it interactively in the UI.
const DEFAULT_DOCUMENT_SOURCES: readonly DocumentSourceKind[] = [...ALL_DOCUMENT_SOURCES]

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
    throw configProblem({ key: 'ENCRYPTION_KEY', ...ENV_HELP.ENCRYPTION_KEY })
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
    throw configProblem({ key: 'ENCRYPTION_KEY', ...ENV_HELP.ENCRYPTION_KEY })
  }
  return {
    enabled: true,
    encryptionKey,
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

/**
 * Cloudflare Workers AI over REST needs BOTH `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`.
 * When exactly one half is set the provider is silently disabled; this returns which var IS set
 * and which is MISSING so the boot warning can name the gap (error-message coverage A10).
 * Undefined when both are set or both are unset — no half-set footgun to warn about.
 */
export function cloudflareCredsHalfSet(
  env: NodeJS.ProcessEnv,
): { set: string; missing: string } | undefined {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim()
  const apiToken = env.CLOUDFLARE_API_TOKEN?.trim()
  if (!!accountId === !!apiToken) return undefined
  return accountId
    ? { set: 'CLOUDFLARE_ACCOUNT_ID', missing: 'CLOUDFLARE_API_TOKEN' }
    : { set: 'CLOUDFLARE_API_TOKEN', missing: 'CLOUDFLARE_ACCOUNT_ID' }
}

/**
 * Deployment-level model capabilities. Direct keys are per-workspace (resolved at run time
 * from the DB pool), so none are known here; Cloudflare Workers AI is opt-in over REST
 * (account id + API token). The per-workspace `/models` endpoint recomputes selectability
 * against each workspace's configured keys + subscriptions. A half-set Cloudflare pair
 * silently disables the provider, so a deployment that set only one reads as "Cloudflare not
 * configured" with no hint the other half is the gap — name the missing half at boot
 * (error-message coverage A10).
 */
function resolveProviderCaps(env: NodeJS.ProcessEnv): ProviderCapabilities {
  const cfAccountId = env.CLOUDFLARE_ACCOUNT_ID?.trim()
  const cfApiToken = env.CLOUDFLARE_API_TOKEN?.trim()
  const cfHalfSet = cloudflareCredsHalfSet(env)
  if (cfHalfSet) {
    logger.warn(
      { ...cfHalfSet, docsUrl: DOCS.envVars(ENV_VARS_ANCHORS.modelProviders) },
      `${cfHalfSet.set} is set but ${cfHalfSet.missing} is missing — Cloudflare Workers AI ` +
        `(over REST) needs both, so it stays DISABLED. Set ${cfHalfSet.missing} too, or unset ` +
        `${cfHalfSet.set}. See ${DOCS.envVars(ENV_VARS_ANCHORS.modelProviders)}.`,
    )
  }
  return {
    directProviders: new Set(),
    subscriptionVendors: new Set(ALL_SUBSCRIPTION_VENDORS),
    cloudflareEnabled: !!(cfAccountId && cfApiToken),
  }
}

/**
 * Agent model routing (default + per-kind overrides + the per-block resolver). Mirrors the
 * Worker's routing: unpinned agents default to Qwen (the Cloudflare flavour when enabled,
 * upgraded to direct DashScope per-workspace by the executor when a Qwen key is configured);
 * the agentic kinds default to GLM-5.2. The two numeric knobs are parsed ONCE (each is read
 * across every config below, and `parseNumericEnv` warns per call, so hoisting collapses a
 * single garbage value to one warning per var — A8).
 */
function buildAgentRouting(
  env: NodeJS.ProcessEnv,
  caps: ProviderCapabilities,
): AppConfig['agents'] {
  const qwenDefault = resolveModelRef('qwen', caps)
  const envTemperature = num('AGENT_DEFAULT_TEMPERATURE', env.AGENT_DEFAULT_TEMPERATURE)
  const envMaxOutputTokens = num('AGENT_MAX_OUTPUT_TOKENS', env.AGENT_MAX_OUTPUT_TOKENS)
  const defaultConfig: AgentModelConfig = {
    ref: {
      provider: env.AGENT_DEFAULT_PROVIDER ?? qwenDefault?.provider ?? 'workers-ai',
      model: env.AGENT_DEFAULT_MODEL ?? qwenDefault?.model ?? '@cf/qwen/qwen3-30b-a3b-fp8',
    },
    temperature: envTemperature ?? 0.4,
    maxOutputTokens: envMaxOutputTokens ?? 5000,
  }
  const agenticDefault: AgentModelConfig = {
    ref: { provider: 'workers-ai', model: '@cf/zai-org/glm-5.2' },
    temperature: envTemperature ?? 0.3,
    maxOutputTokens: envMaxOutputTokens ?? 5000,
  }
  // Companions (reviewer / spec-companion / architect-companion) return their whole
  // verdict — rating + summary + per-item comments — as ONE inline JSON reply. On a
  // reasoning model the <think> tokens share the output budget, so the 5000 cap can
  // truncate the JSON mid-comment, leaving it unparseable. Give companions a larger
  // budget so the verdict fits (mirrors the Worker's routing).
  const companionDefault: AgentModelConfig = {
    ref: { provider: 'workers-ai', model: '@cf/zai-org/glm-5.2' },
    temperature: envTemperature ?? 0.3,
    maxOutputTokens: envMaxOutputTokens ?? 12000,
  }
  // The conflict-resolver clones a PR head with merge conflicts and rewrites the
  // conflicted hunks against the base — a focused, diff-heavy reasoning task. Kimi K2.5
  // (a 1T-param agentic model native on Workers AI, 256K window) handles it better than
  // the small default MoE (mirrors the Worker's routing).
  const conflictResolverDefault: AgentModelConfig = {
    ref: { provider: 'workers-ai', model: '@cf/moonshotai/kimi-k2.5' },
    temperature: envTemperature ?? 0.3,
    maxOutputTokens: envMaxOutputTokens ?? 5000,
  }
  return {
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
  }
}

/**
 * The GitHub App integration config + its boot-time key-shape validation. The App (private key
 * + app id) backs container-agent runs: it mints the short-lived push token the harness
 * clones/pushes with, so the integration enables only when both are present (a partial config
 * doesn't half-enable repo-operating steps). The App key's SHAPE is validated at boot (present
 * + PKCS#8 PEM + decodable body) whenever the App is configured, so a malformed key fails on the
 * misconfigured screen with the openssl conversion remedy instead of opaquely at the first
 * installation-token mint (error-message coverage A3). The privileged tier is validated on the
 * SAME condition `loadPrivilegedApp` activates it (both id AND key present).
 */
function buildGithubConfig(env: NodeJS.ProcessEnv): AppConfig['github'] {
  const githubAppId = env.GITHUB_APP_ID?.trim() ?? ''
  const githubAppConfigured =
    githubAppId !== '' && (env.GITHUB_APP_PRIVATE_KEY?.trim() ?? '') !== ''
  if (githubAppConfigured) requireGitHubAppPrivateKey(env.GITHUB_APP_PRIVATE_KEY)
  const privilegedAppId = env.GITHUB_PRIVILEGED_APP_ID?.trim() ?? ''
  const privilegedAppKey = env.GITHUB_PRIVILEGED_APP_PRIVATE_KEY?.trim() ?? ''
  if (privilegedAppId !== '' && privilegedAppKey !== '') {
    requireGitHubAppPrivateKey(
      env.GITHUB_PRIVILEGED_APP_PRIVATE_KEY,
      'GITHUB_PRIVILEGED_APP_PRIVATE_KEY',
    )
  }
  return {
    enabled: githubAppConfigured,
    appId: env.GITHUB_APP_ID?.trim() ?? '',
    appSlug: env.GITHUB_APP_SLUG?.trim() ?? '',
    apiBase: env.GITHUB_API_BASE?.trim() || 'https://api.github.com',
    setupRedirectUrl: env.GITHUB_SETUP_REDIRECT_URL?.trim() || '/',
    webhookSecret: env.GITHUB_WEBHOOK_SECRET ?? '',
    privilegedApp: loadPrivilegedApp(env),
  }
}

/**
 * Auth config: which login providers are enabled, plus the two fail-fast boot guards. Remote
 * node mode has NO anonymous tier, so a genuinely unconfigured remote deployment refuses to
 * boot rather than silently 503-ing every protected route. GitHub OAuth set with a missing/too-
 * short session secret (and no dev-open fallback) is the same silent-brick footgun. Local mode
 * always enables password login via `applyLocalDefaults`, and the test/CI harnesses opt into
 * AUTH_DEV_OPEN, so neither trips these guards.
 */
/**
 * Resolve the per-provider enablement + credential fields (and validate the two fail-fast
 * config footguns) — the decision-heavy prelude of {@link buildAuthConfig}, extracted so that
 * builder stays within the cyclomatic-complexity budget. Behaviour is byte-identical: the checks,
 * throws, and derivations moved verbatim.
 */
/**
 * The two fail-fast auth boot guards, extracted from {@link resolveNodeAuthEnablement} to keep it
 * within the cyclomatic-complexity budget. Behaviour is byte-identical — the checks, throws, and
 * their order are moved verbatim (`authEnabled` is a pure derivation, so computing it before the
 * first guard changes nothing).
 */
function assertNodeAuthConfigured(params: {
  clientId: string
  clientSecret: string
  sessionSecret: string
  devOpen: boolean
  authEnabled: boolean
}): void {
  const { clientId, clientSecret, sessionSecret, devOpen, authEnabled } = params

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
    throw configProblem({
      key: 'AUTH_SESSION_SECRET',
      summary: ENV_HELP.AUTH_SESSION_SECRET.summary,
      remedy:
        `Must be at least ${MIN_SESSION_SECRET_LENGTH} characters when GitHub OAuth is configured ` +
        `(got ${sessionSecret.length}). ${ENV_HELP.AUTH_SESSION_SECRET.remedy} Or enable AUTH_DEV_OPEN in a non-production ENVIRONMENT.`,
      docsUrl: ENV_HELP.AUTH_SESSION_SECRET.docsUrl,
    })
  }

  if (!authEnabled && !devOpen) {
    throw configProblem({ key: 'AUTH_PROVIDER', ...ENV_HELP.AUTH_PROVIDER })
  }
}

function resolveNodeAuthEnablement(env: NodeJS.ProcessEnv): {
  clientId: string
  clientSecret: string
  sessionSecret: string
  ttlHours: number | undefined
  devOpen: boolean
  testingNoAuth: boolean
  githubEnabled: boolean
  googleClientId: string
  googleClientSecret: string
  googleEnabled: boolean
  passwordEnabled: boolean
  authEnabled: boolean
} {
  const sessionSecret = env.AUTH_SESSION_SECRET?.trim() ?? ''
  const clientId = env.GITHUB_OAUTH_CLIENT_ID?.trim() ?? ''
  const clientSecret = env.GITHUB_OAUTH_CLIENT_SECRET?.trim() ?? ''
  const googleClientId = env.GOOGLE_OAUTH_CLIENT_ID?.trim() ?? ''
  const googleClientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET?.trim() ?? ''
  const environment = env.ENVIRONMENT?.trim().toLowerCase() ?? ''
  const ttlHours = num('AUTH_SESSION_TTL_HOURS', env.AUTH_SESSION_TTL_HOURS)
  const strongSecret = sessionSecret.length >= MIN_SESSION_SECRET_LENGTH
  const githubEnabled = clientId !== '' && clientSecret !== '' && strongSecret
  const googleEnabled = googleClientId !== '' && googleClientSecret !== '' && strongSecret
  const passwordEnabled = env.AUTH_PASSWORD_ENABLED?.trim() === 'true' && strongSecret

  const nonProd = !PRODUCTION_ENVIRONMENTS.has(environment)
  // `TESTING_NO_AUTH` is a stronger `AUTH_DEV_OPEN`: besides leaving the API open it tells the
  // SPA to render the board anonymously (no login gate). The e2e suite opts in; everything else
  // leaves it off. Honoured only outside a production-like ENVIRONMENT, and it implies devOpen.
  const testingNoAuth = env.TESTING_NO_AUTH?.trim() === 'true' && nonProd
  const devOpen = (env.AUTH_DEV_OPEN?.trim() === 'true' || testingNoAuth) && nonProd

  const authEnabled = githubEnabled || googleEnabled || passwordEnabled
  assertNodeAuthConfigured({ clientId, clientSecret, sessionSecret, devOpen, authEnabled })

  return {
    clientId,
    clientSecret,
    sessionSecret,
    ttlHours,
    devOpen,
    testingNoAuth,
    githubEnabled,
    googleClientId,
    googleClientSecret,
    googleEnabled,
    passwordEnabled,
    authEnabled,
  }
}

function buildAuthConfig(env: NodeJS.ProcessEnv): AppConfig['auth'] {
  const {
    clientId,
    clientSecret,
    sessionSecret,
    ttlHours,
    devOpen,
    testingNoAuth,
    githubEnabled,
    googleClientId,
    googleClientSecret,
    googleEnabled,
    passwordEnabled,
    authEnabled,
  } = resolveNodeAuthEnablement(env)

  return {
    enabled: authEnabled,
    devOpen,
    testingNoAuth,
    githubEnabled,
    clientId,
    clientSecret,
    sessionSecret,
    apiBase: env.GITHUB_API_BASE?.trim() || 'https://api.github.com',
    oauthBase: env.GITHUB_OAUTH_BASE?.trim() || 'https://github.com',
    sessionTtlMs: (ttlHours !== undefined && ttlHours > 0 ? ttlHours : 168) * 60 * 60 * 1000,
    machineTokenTtlMs: resolveMachineTokenTtlMs(env.AUTH_MACHINE_TOKEN_TTL_MS),
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
  }
}

/**
 * Auth-email config. Available whenever an encryption key exists — there is no separate opt-in
 * flag. The per-account provider API key is sealed with that key. The deployment-level `system`
 * sender (auth emails like password reset) is read entirely from env and is independent of the
 * per-account connections, so it loads regardless of `enabled`.
 */
function buildEmailConfig(env: NodeJS.ProcessEnv): AppConfig['email'] {
  const appBaseUrl = env.APP_BASE_URL?.trim() || env.AUTH_SUCCESS_REDIRECT_URL?.trim() || ''
  const system = loadSystemEmailSender(env)
  const encryptionKey = env.ENCRYPTION_KEY?.trim()
  return encryptionKey
    ? { enabled: true, encryptionKey, appBaseUrl, system }
    : { enabled: false, appBaseUrl, system }
}

/**
 * Ephemeral-environment provider integration (a tenant rolls its own environment-management
 * API): assembles from the shared ENCRYPTION_KEY that seals per-tenant credentials at rest, with
 * no separate enable flag, mirroring the Worker.
 */
function buildEnvironmentsConfig(env: NodeJS.ProcessEnv): AppConfig['environments'] {
  const detectionConventions = parseDetectionConventions(env.ENVIRONMENTS_DETECTION_CONVENTIONS)
  return {
    encryptionKey: env.ENCRYPTION_KEY?.trim(),
    // Trusted-adapter escape hatch: permit an in-house env platform on an
    // internal/VPN host (otherwise the strict public-https guard rejects it).
    allowUrlHosts: csv(env.ENVIRONMENTS_ALLOW_URL_HOSTS),
    allowHttpUrls: env.ENVIRONMENTS_ALLOW_HTTP_URLS === 'true',
    // Additive house-convention extensions to provisioning detection (JSON object).
    ...(detectionConventions ? { detectionConventions } : {}),
  }
}

/**
 * Self-hosted runner pools encrypt their scheduler credentials at rest; opt-in via the presence
 * of an ENCRYPTION_KEY, sealed with that shared key (mirroring the Worker).
 */
function buildRunnersConfig(env: NodeJS.ProcessEnv): AppConfig['runners'] {
  const runnersEncryptionKey = env.ENCRYPTION_KEY?.trim() ?? ''
  return runnersEncryptionKey
    ? {
        enabled: true,
        encryptionKey: runnersEncryptionKey,
        allowUrlHosts: csv(env.RUNNERS_ALLOW_URL_HOSTS),
        allowHttpUrls: env.RUNNERS_ALLOW_HTTP_URLS === 'true',
      }
    : { enabled: false }
}

/** Retention windows (ms) for the append-heavy telemetry/log tables. */
function buildRetentionConfig(env: NodeJS.ProcessEnv): AppConfig['retention'] {
  return {
    tokenUsageMs: retentionMs('TOKEN_USAGE_RETENTION_DAYS', env.TOKEN_USAGE_RETENTION_DAYS, 395),
    rateLimitMs: retentionMs(
      'GITHUB_RATE_LIMIT_RETENTION_DAYS',
      env.GITHUB_RATE_LIMIT_RETENTION_DAYS,
      7,
    ),
    commitMs: retentionMs('GITHUB_COMMIT_RETENTION_DAYS', env.GITHUB_COMMIT_RETENTION_DAYS, 90),
    // Heavy full per-call prompt/response; pruned aggressively (default 3 days).
    llmCallMetricsMs: retentionMs(
      'LLM_CALL_METRICS_RETENTION_DAYS',
      env.LLM_CALL_METRICS_RETENTION_DAYS,
      3,
    ),
    // High-churn provisioning event log; pruned aggressively (default 14 days).
    provisioningLogMs: retentionMs(
      'PROVISIONING_LOG_RETENTION_DAYS',
      env.PROVISIONING_LOG_RETENTION_DAYS,
      14,
    ),
    // Resolved (acted/dismissed) notifications; generous default of 90 days. Open
    // cards (the actionable inbox) are never pruned.
    notificationsMs: retentionMs(
      'NOTIFICATION_RETENTION_DAYS',
      env.NOTIFICATION_RETENTION_DAYS,
      90,
    ),
  }
}

/**
 * Optional Langfuse trace sink: off unless `LANGFUSE_ENABLED=true` AND both keys are present (a
 * half-configured sink silently does nothing). Mirrors the Worker mapping.
 */
function buildLangfuseConfig(env: NodeJS.ProcessEnv): AppConfig['langfuse'] {
  return {
    enabled:
      env.LANGFUSE_ENABLED?.trim() === 'true' &&
      !!env.LANGFUSE_PUBLIC_KEY?.trim() &&
      !!env.LANGFUSE_SECRET_KEY?.trim(),
    publicKey: env.LANGFUSE_PUBLIC_KEY?.trim(),
    secretKey: env.LANGFUSE_SECRET_KEY?.trim(),
    baseUrl: env.LANGFUSE_BASE_URL?.trim() || undefined,
  }
}

/**
 * Optional OpenTelemetry OTLP exporter: off unless `OTEL_ENABLED=true` AND an endpoint is set (a
 * half-configured exporter silently does nothing, like every other opt-in integration). On Node
 * this uses the official @opentelemetry/* SDK (see container.ts).
 */
function buildOtelConfig(env: NodeJS.ProcessEnv): AppConfig['otel'] {
  const otelEnabled =
    env.OTEL_ENABLED?.trim() === 'true' && !!env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim()
  return {
    enabled: otelEnabled,
    endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() || undefined,
    headers: parseOtlpHeaders(env.OTEL_EXPORTER_OTLP_HEADERS),
    serviceName: env.OTEL_SERVICE_NAME?.trim() || undefined,
    platformMetrics: {
      // A further opt-in on top of the base exporter (adds recurring DB rollup load).
      enabled: otelEnabled && env.OTEL_PLATFORM_METRICS?.trim() === 'true',
      intervalMs: parsePlatformMetricsIntervalMs(env.OTEL_PLATFORM_METRICS_INTERVAL_MS),
      window: parsePlatformMetricsWindow(env.OTEL_PLATFORM_METRICS_WINDOW),
    },
  }
}

/**
 * Execution engine timing knobs (durable poll/CI intervals + container max age), each defaulting
 * to the Worker's values.
 */
function buildExecutionConfig(env: NodeJS.ProcessEnv): AppConfig['execution'] {
  return {
    decisionTimeout: env.DECISION_TIMEOUT?.trim() || '24 hours',
    jobPollInterval: env.JOB_POLL_INTERVAL?.trim() || '15 seconds',
    jobMaxPolls: num('JOB_MAX_POLLS', env.JOB_MAX_POLLS) ?? 280,
    jobPollFailureTolerance: num('JOB_POLL_FAILURE_TOLERANCE', env.JOB_POLL_FAILURE_TOLERANCE) ?? 6,
    ciPollInterval: env.CI_POLL_INTERVAL?.trim() || '30 seconds',
    ciMaxPolls: num('CI_MAX_POLLS', env.CI_MAX_POLLS) ?? 120,
    containerMaxAgeMs:
      Math.max(75, num('CONTAINER_MAX_AGE_MINUTES', env.CONTAINER_MAX_AGE_MINUTES) ?? 90) * 60_000,
  }
}

export function loadNodeConfig(env: NodeJS.ProcessEnv): AppConfig {
  // Validate the system encryption key up front: present, valid base64, and decoding to a full
  // AES-256 key. It is effectively mandatory (the always-on document/task integrations below seal
  // credentials at rest under it), so a missing/malformed key fails here with an actionable message
  // rather than lazily inside the first cipher build (a bare "must decode to at least 32 bytes" or
  // an opaque `atob` error). Mirrors the Worker's `loadConfig` and local mode's secret validation.
  requireEncryptionKey(env.ENCRYPTION_KEY)

  const caps = resolveProviderCaps(env)

  // The deployment-level BASE pricing (built-in table + the fallback currency/monthly-limit
  // a workspace inherits when it sets no budget of its own). The per-workspace budget moved
  // out of env (`SPEND_*`) onto the workspace settings row; the spend service overlays it.
  // The operator env caps (`BUDGET_MAX_MONTHLY_PER_ACCOUNT` / `BUDGET_MAX_MONTHLY_PER_USER`)
  // ceiling the account/user budget tiers — see docs/environment-variables.md.
  const spend = {
    ...DEFAULT_SPEND_PRICING,
    ...budgetCapsOverlay(
      num('BUDGET_MAX_MONTHLY_PER_ACCOUNT', env.BUDGET_MAX_MONTHLY_PER_ACCOUNT),
      num('BUDGET_MAX_MONTHLY_PER_USER', env.BUDGET_MAX_MONTHLY_PER_USER),
    ),
  }

  const slackEncryptionKey = env.ENCRYPTION_KEY?.trim() ?? ''
  // Slack notification transport: opt-in (SLACK_ENABLED), the per-account bot token
  // sealed with the shared ENCRYPTION_KEY. OAuth credentials moved out of env into
  // per-account settings (sealed), resolved dynamically at connect time.
  const slackEnabled = env.SLACK_ENABLED?.trim() === 'true'

  return {
    agents: buildAgentRouting(env, caps),
    // Surface each model's informational list cost in the picker (from spend pricing).
    models: effectiveCatalog(caps, modelCostResolver(spend)),
    execution: buildExecutionConfig(env),
    spend,
    github: buildGithubConfig(env),
    gitlab: loadGitLabConfig(env),
    auth: buildAuthConfig(env),
    email: buildEmailConfig(env),
    // Document-source integration: the providers (Confluence/Notion/GitHub-docs) are
    // the shared `@cat-factory/integrations` fetch shells, wired in the container
    // exactly like the Worker's `selectDocumentsDeps`. Always on (the shared
    // ENCRYPTION_KEY backs credential encryption at rest).
    documents: loadDocumentsConfig(env),
    tasks: loadTasksConfig(env),
    environments: buildEnvironmentsConfig(env),
    runners: buildRunnersConfig(env),
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
    retention: buildRetentionConfig(env),
    // Prompt-fragment library (ADR 0006): on by default, opt OUT with
    // `PROMPT_LIBRARY_ENABLED=false`. Needs no encryption key (fragments are not
    // secrets) and its tables ship in the base schema. Mirrors the Worker's
    // mapping; `PROMPT_LIBRARY_SELECTOR=llm` ranks per run, else the deterministic
    // tag matcher (which also backs the `llm` selector's graceful fallback).
    fragmentLibrary: {
      enabled: env.PROMPT_LIBRARY_ENABLED?.trim() !== 'false',
      selector: env.PROMPT_LIBRARY_SELECTOR?.trim() === 'llm' ? 'llm' : 'deterministic',
    },
    // Recording the complete prompts is on by default; opt out with
    // `LLM_RECORD_PROMPTS=false` to keep the numeric telemetry but drop the prompt body.
    observability: { recordPrompts: env.LLM_RECORD_PROMPTS?.trim() !== 'false' },
    langfuse: buildLangfuseConfig(env),
    otel: buildOtelConfig(env),
    // Platform-health alerting: a periodic sweep raises a `platform_health` notification when
    // the deployment's own run health crosses a threshold. Opt-in (`PLATFORM_ALERTS=true`);
    // independent of the OTel exporter (it fans out through the notification channel seam).
    platformAlerts: resolvePlatformAlertConfig({
      enabled: env.PLATFORM_ALERTS?.trim() === 'true',
      window: env.PLATFORM_ALERTS_WINDOW,
      intervalMs: env.PLATFORM_ALERTS_INTERVAL_MS,
      minRuns: env.PLATFORM_ALERTS_MIN_RUNS,
      maxFailureRate: env.PLATFORM_ALERTS_MAX_FAILURE_RATE,
      maxP99Minutes: env.PLATFORM_ALERTS_MAX_P99_MINUTES,
      maxBacklog: env.PLATFORM_ALERTS_MAX_BACKLOG,
    }),
  }
}
