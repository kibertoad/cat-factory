import type { ConfigProblem } from '@cat-factory/contracts'
import { base64urlToBytes, pkcs8PemToDer } from '../crypto/encoding.js'
import { DOCS, ENV_VARS_ANCHORS } from './docs.js'

export type { ConfigProblem }

/**
 * The system encryption key must decode to at least this many bytes — a full AES-256 key. Matches
 * the invariant {@link WebCryptoSecretCipher} enforces at construction, hoisted here so the same
 * defect fails at config load with an actionable message instead of lazily inside the first cipher.
 */
export const MIN_ENCRYPTION_KEY_BYTES = 32

/**
 * Thrown by a facade's config loader (or its container build) when one or more MANDATORY env
 * vars / bindings are missing or invalid. Unlike a bare `Error`, it carries a STRUCTURED,
 * human-readable list of problems, which lets the boot sequence do two things instead of just
 * dying with a terse message:
 *
 *   1. log a clear, actionable operator message ({@link formatConfigProblems}); and
 *   2. serve the misconfiguration fallback backend ({@link createMisconfiguredApp}) rather than
 *      exiting — so the SPA renders a dedicated "backend misconfigured" screen telling the
 *      developer exactly which variables are missing and how to fill them.
 *
 * A {@link ConfigProblem} NEVER carries a secret value — only the variable's name, meaning, and
 * remedy — so it is safe to both log and surface to the browser.
 */
export class ConfigValidationError extends Error {
  readonly problems: ConfigProblem[]

  constructor(problems: ConfigProblem[]) {
    super(formatConfigProblems(problems))
    this.name = 'ConfigValidationError'
    this.problems = problems
  }
}

export function isConfigValidationError(err: unknown): err is ConfigValidationError {
  return err instanceof ConfigValidationError
}

/** Build a {@link ConfigValidationError} for a single problem (the common case). */
export function configProblem(problem: ConfigProblem): ConfigValidationError {
  return new ConfigValidationError([problem])
}

/** Render the problem list as a multi-line, operator-facing message (used as the Error message). */
export function formatConfigProblems(problems: ConfigProblem[]): string {
  const header =
    problems.length === 1
      ? 'cat-factory cannot start: a mandatory configuration value is missing or invalid.'
      : `cat-factory cannot start: ${problems.length} mandatory configuration values are missing or invalid.`
  const lines = problems.map((p) => {
    const remedy = `  • ${p.key}: ${p.summary}\n    → ${p.remedy}`
    return p.docsUrl ? `${remedy}\n    Docs: ${p.docsUrl}` : remedy
  })
  return [header, ...lines].join('\n')
}

/**
 * The canonical human-readable description of each mandatory env var / binding: what it means and
 * how to fill it. Keeping these here (rather than re-writing the prose at every throw site) unifies
 * the phrasing across the three facades, so `ENCRYPTION_KEY` reads the same whether it's the Node
 * loader, the Worker loader, or local mode that flags it. A throw site spreads the matching entry:
 *
 *   throw configProblem({ key: 'ENCRYPTION_KEY', ...ENV_HELP.ENCRYPTION_KEY })
 *
 * A site with an extra nuance (a length/format detail beyond "missing") overrides `remedy` inline.
 */
export const ENV_HELP = {
  DATABASE_URL: {
    summary:
      'Postgres connection string — the Node service stores ALL of its state (workspaces, boards, runs, credentials) there.',
    remedy:
      'Set DATABASE_URL to your Postgres URL, e.g. `postgres://user:password@localhost:5432/cat_factory`. In local mode, `docker compose up` in deploy/local starts one and prints the URL.',
    docsUrl: DOCS.envVars(ENV_VARS_ANCHORS.coreServiceNetworking),
  },
  ENCRYPTION_KEY: {
    summary:
      'Master key that seals every per-workspace credential at rest (document/task/runner/Slack integrations, personal subscriptions, observability connections).',
    remedy:
      'Set ENCRYPTION_KEY to a base64-encoded key of at least 32 bytes. Generate one with `pnpm secrets` (deploy/local) or `openssl rand -base64 32`. It must stay STABLE across restarts — a fresh value orphans everything sealed under the previous one.',
    docsUrl: DOCS.envVars(ENV_VARS_ANCHORS.storageRetention),
  },
  AUTH_SESSION_SECRET: {
    summary:
      'HMAC key that signs the session, proxy, and machine tokens — the whole auth surface trusts it.',
    remedy:
      'Set AUTH_SESSION_SECRET to a random string of at least 32 characters. Generate one with `pnpm secrets` (deploy/local) or `openssl rand -hex 32`. It must stay STABLE across restarts — a fresh value forces every user to re-login.',
    docsUrl: DOCS.envVars(ENV_VARS_ANCHORS.authentication),
  },
  AUTH_PROVIDER: {
    summary:
      'A remote deployment has no anonymous tier, so at least one login provider must be configured or every protected route fails closed.',
    remedy:
      'Enable one of: GitHub OAuth (GITHUB_OAUTH_CLIENT_ID + GITHUB_OAUTH_CLIENT_SECRET), Google OAuth (GOOGLE_OAUTH_CLIENT_ID + GOOGLE_OAUTH_CLIENT_SECRET), or password login (AUTH_PASSWORD_ENABLED=true) — each alongside a 32+ character AUTH_SESSION_SECRET. For local dev or tests, set AUTH_DEV_OPEN=true in a non-production ENVIRONMENT instead.',
    docsUrl: DOCS.envVars(ENV_VARS_ANCHORS.authentication),
  },
  DB: {
    summary:
      'The primary D1 database — the Worker stores ALL of its transactional state (workspaces, boards, runs, credentials) there. Without it the first repository call NPEs deep in a request instead of failing at boot.',
    remedy:
      'Add a `[[d1_databases]]` entry with `binding = "DB"` to your wrangler.toml (create the database with `wrangler d1 create` and point `database_id` at it), then re-deploy.',
    docsUrl: DOCS.envVars(ENV_VARS_ANCHORS.storageRetention),
  },
  TELEMETRY_DB: {
    summary:
      'The dedicated telemetry D1 database (per-LLM-call metrics + agent-context snapshots) — kept separate from the transactional data so its append-heavy, short-retention writes never contend with domain reads.',
    remedy:
      'Add a `[[d1_databases]]` entry with `binding = "TELEMETRY_DB"` to your wrangler.toml and create the database with `wrangler d1 create`.',
    docsUrl: DOCS.envVars(ENV_VARS_ANCHORS.storageRetention),
  },
  AGENT_MODELS: {
    summary:
      'Optional per-kind model routing override, supplied as a JSON object mapping an agent kind to `{ "provider", "model" }`.',
    remedy:
      'Either unset AGENT_MODELS to use the built-in routing, or set it to valid JSON where every entry has string "provider" and "model" fields, e.g. `{"coder":{"provider":"workers-ai","model":"@cf/zai-org/glm-5.2"}}`.',
    docsUrl: DOCS.envVars(ENV_VARS_ANCHORS.modelProviders),
  },
  CONTAINER_EXECUTOR: {
    summary:
      'The repo-operating agent steps (coder, tester, merger, …) need a fully-wired container executor; running them as one-shot LLM calls would silently produce broken results.',
    remedy:
      'Configure a GitHub App (GITHUB_APP_PRIVATE_KEY + GITHUB_APP_ID), WORKER_PUBLIC_URL, AUTH_SESSION_SECRET, and a runner backend (the EXEC_CONTAINER binding, or a registered runner pool with RUNNERS_ENABLED).',
    docsUrl: DOCS.envVars(ENV_VARS_ANCHORS.vcsIntegration),
  },
  HARNESS_SHARED_SECRET: {
    summary:
      'Shared secret the orchestrator injects into each agent container and sends on every harness call (the `x-harness-secret` header) so a job container only accepts requests from this service.',
    remedy:
      'Set HARNESS_SHARED_SECRET to a random string of at least 16 characters. Generate one with `pnpm secrets` (deploy/local) or `openssl rand -hex 32`. It must stay STABLE across restarts — a fresh value each boot fails auth against containers still running from before the restart, so re-attach breaks and in-flight runs flap.',
    docsUrl: DOCS.envVars(ENV_VARS_ANCHORS.authentication),
  },
  GITHUB_APP_PRIVATE_KEY: {
    summary:
      "The GitHub App private key the service signs its App JWT with, to mint the short-lived installation tokens the harness clones, pushes, and opens PRs with. Must be a PKCS#8 PEM — Web Crypto (used on both Node and the Worker) cannot import GitHub's default PKCS#1 key.",
    remedy:
      'Set GITHUB_APP_PRIVATE_KEY to the App private key in PKCS#8 PEM form (`-----BEGIN PRIVATE KEY-----`, including the BEGIN/END lines). GitHub issues a PKCS#1 key (`-----BEGIN RSA PRIVATE KEY-----`); convert it once with `openssl pkcs8 -topk8 -nocrypt -in key.pem -out key.pk8.pem` and use the result.',
    docsUrl: DOCS.githubOperations(),
  },
} satisfies Record<string, { summary: string; remedy: string; docsUrl?: string }>

/**
 * Read a mandatory env var, throwing a {@link ConfigValidationError} with a human-readable
 * meaning + remedy when it is missing/blank. `help` defaults to the {@link ENV_HELP} entry for
 * `key` when one exists, so the common case is just `requireEnv(env, 'DATABASE_URL')`.
 */
export function requireEnv(
  env: Record<string, string | undefined>,
  key: string,
  help?: { summary: string; remedy: string; docsUrl?: string },
): string {
  const value = env[key]?.trim()
  if (value) return value
  const meaning =
    help ?? (ENV_HELP as Record<string, { summary: string; remedy: string; docsUrl?: string }>)[key]
  if (!meaning) {
    throw configProblem({
      key,
      summary: `The mandatory environment variable ${key} is not set.`,
      remedy: `Set ${key} in your environment (or .env) and restart.`,
    })
  }
  throw configProblem({ key, ...meaning })
}

/**
 * Validate the system `ENCRYPTION_KEY` at config load and return the trimmed value: present, valid
 * base64, and decoding to a full AES-256 key ({@link MIN_ENCRYPTION_KEY_BYTES}). Without this the
 * same defects fail lazily and opaquely deep inside the FIRST cipher build — a bare
 * `encryption key must decode to at least 32 bytes`, or (for a non-base64 value) an `atob`
 * `InvalidCharacterError` — instead of on the misconfigured screen at boot. Shared across the three
 * facades so a malformed key reads identically whether it's the Node loader, the Worker loader, or
 * local mode that flags it. Every facade requires the key (the always-on document/task integrations
 * seal credentials at rest under it), so a missing value is a boot failure too.
 */
export function requireEncryptionKey(value: string | undefined): string {
  const key = value?.trim()
  if (!key) {
    throw configProblem({ key: 'ENCRYPTION_KEY', ...ENV_HELP.ENCRYPTION_KEY })
  }
  let bytes: Uint8Array
  try {
    bytes = base64urlToBytes(key)
  } catch {
    throw configProblem({
      key: 'ENCRYPTION_KEY',
      summary: ENV_HELP.ENCRYPTION_KEY.summary,
      remedy: `ENCRYPTION_KEY is not valid base64. ${ENV_HELP.ENCRYPTION_KEY.remedy}`,
      docsUrl: ENV_HELP.ENCRYPTION_KEY.docsUrl,
    })
  }
  if (bytes.length < MIN_ENCRYPTION_KEY_BYTES) {
    throw configProblem({
      key: 'ENCRYPTION_KEY',
      summary: ENV_HELP.ENCRYPTION_KEY.summary,
      remedy: `ENCRYPTION_KEY decodes to only ${bytes.length} byte(s); it must decode to at least ${MIN_ENCRYPTION_KEY_BYTES} bytes. ${ENV_HELP.ENCRYPTION_KEY.remedy}`,
      docsUrl: ENV_HELP.ENCRYPTION_KEY.docsUrl,
    })
  }
  return key
}

/**
 * Validate a GitHub App private key at config load and return the trimmed value: present, a PKCS#8
 * PEM (not the PKCS#1 key GitHub hands out), with a base64 body that decodes. Without this the
 * defect surfaces lazily at the FIRST installation-token mint — deep in a pipeline, long after
 * boot — as an opaque `crypto.subtle.importKey` rejection or an `atob` `InvalidCharacterError`.
 * Shared across the facades (the key backs the App JWT the same way on Node and the Worker) so a
 * malformed key reads identically. Callers pass the value only when the App is otherwise
 * configured (an unset key simply disables the App); `varKey` names the specific var so the
 * default and privileged App keys report against their own names.
 */
export function requireGitHubAppPrivateKey(
  value: string | undefined,
  varKey = 'GITHUB_APP_PRIVATE_KEY',
): string {
  const help = ENV_HELP.GITHUB_APP_PRIVATE_KEY
  const problem = (remedy: string) =>
    configProblem({ key: varKey, summary: help.summary, remedy, docsUrl: help.docsUrl })
  const pem = value?.trim()
  if (!pem) throw problem(help.remedy)
  if (/BEGIN RSA PRIVATE KEY/.test(pem)) {
    throw problem(
      `${varKey} is a PKCS#1 key (\`-----BEGIN RSA PRIVATE KEY-----\`), which Web Crypto cannot ` +
        'import. Convert it once with `openssl pkcs8 -topk8 -nocrypt -in key.pem -out key.pk8.pem` ' +
        'and use the resulting `-----BEGIN PRIVATE KEY-----` file.',
    )
  }
  if (!/-----BEGIN PRIVATE KEY-----/.test(pem) || !/-----END PRIVATE KEY-----/.test(pem)) {
    throw problem(
      `${varKey} is not a PKCS#8 PEM — the \`-----BEGIN PRIVATE KEY-----\`/\`-----END PRIVATE KEY-----\` ` +
        `boundary lines are missing. ${help.remedy}`,
    )
  }
  try {
    // Structurally decode the body: catches a truncated or mangled base64 payload that would
    // otherwise reach `crypto.subtle.importKey` unvalidated and reject opaquely at first mint.
    pkcs8PemToDer(pem)
  } catch {
    throw problem(
      `${varKey} has PKCS#8 boundary lines but its body is not valid base64 — the key was likely ` +
        `truncated or mangled on the way into the environment (e.g. newlines lost). ${help.remedy}`,
    )
  }
  return pem
}
