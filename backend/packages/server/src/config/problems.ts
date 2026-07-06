import type { ConfigProblem } from '@cat-factory/contracts'

export type { ConfigProblem }

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
  const lines = problems.map((p) => `  • ${p.key}: ${p.summary}\n    → ${p.remedy}`)
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
  },
  ENCRYPTION_KEY: {
    summary:
      'Master key that seals every per-workspace credential at rest (document/task/runner/Slack integrations, personal subscriptions, observability connections).',
    remedy:
      'Set ENCRYPTION_KEY to a base64-encoded key of at least 32 bytes. Generate one with `pnpm secrets` (deploy/local) or `openssl rand -base64 32`. It must stay STABLE across restarts — a fresh value orphans everything sealed under the previous one.',
  },
  AUTH_SESSION_SECRET: {
    summary:
      'HMAC key that signs the session, proxy, and machine tokens — the whole auth surface trusts it.',
    remedy:
      'Set AUTH_SESSION_SECRET to a random string of at least 32 characters. Generate one with `pnpm secrets` (deploy/local) or `openssl rand -hex 32`. It must stay STABLE across restarts — a fresh value forces every user to re-login.',
  },
  AUTH_PROVIDER: {
    summary:
      'A remote deployment has no anonymous tier, so at least one login provider must be configured or every protected route fails closed.',
    remedy:
      'Enable one of: GitHub OAuth (GITHUB_OAUTH_CLIENT_ID + GITHUB_OAUTH_CLIENT_SECRET), Google OAuth (GOOGLE_OAUTH_CLIENT_ID + GOOGLE_OAUTH_CLIENT_SECRET), or password login (AUTH_PASSWORD_ENABLED=true) — each alongside a 32+ character AUTH_SESSION_SECRET. For local dev or tests, set AUTH_DEV_OPEN=true in a non-production ENVIRONMENT instead.',
  },
  TELEMETRY_DB: {
    summary:
      'The dedicated telemetry D1 database (per-LLM-call metrics + agent-context snapshots) — kept separate from the transactional data so its append-heavy, short-retention writes never contend with domain reads.',
    remedy:
      'Add a `[[d1_databases]]` entry with `binding = "TELEMETRY_DB"` to your wrangler.toml and create the database with `wrangler d1 create`.',
  },
  AGENT_MODELS: {
    summary:
      'Optional per-kind model routing override, supplied as a JSON object mapping an agent kind to `{ "provider", "model" }`.',
    remedy:
      'Either unset AGENT_MODELS to use the built-in routing, or set it to valid JSON where every entry has string "provider" and "model" fields, e.g. `{"coder":{"provider":"workers-ai","model":"@cf/zai-org/glm-5.2"}}`.',
  },
  CONTAINER_EXECUTOR: {
    summary:
      'The repo-operating agent steps (coder, tester, merger, …) need a fully-wired container executor; running them as one-shot LLM calls would silently produce broken results.',
    remedy:
      'Configure a GitHub App (GITHUB_APP_PRIVATE_KEY + GITHUB_APP_ID), WORKER_PUBLIC_URL, AUTH_SESSION_SECRET, and a runner backend (the EXEC_CONTAINER binding, or a registered runner pool with RUNNERS_ENABLED).',
  },
  HARNESS_SHARED_SECRET: {
    summary:
      'Shared secret the orchestrator injects into each agent container and sends on every harness call (the `x-harness-secret` header) so a job container only accepts requests from this service.',
    remedy:
      'Set HARNESS_SHARED_SECRET to a random string of at least 16 characters. Generate one with `pnpm secrets` (deploy/local) or `openssl rand -hex 32`. It must stay STABLE across restarts — a fresh value each boot fails auth against containers still running from before the restart, so re-attach breaks and in-flight runs flap.',
  },
} satisfies Record<string, { summary: string; remedy: string }>

/**
 * Read a mandatory env var, throwing a {@link ConfigValidationError} with a human-readable
 * meaning + remedy when it is missing/blank. `help` defaults to the {@link ENV_HELP} entry for
 * `key` when one exists, so the common case is just `requireEnv(env, 'DATABASE_URL')`.
 */
export function requireEnv(
  env: Record<string, string | undefined>,
  key: string,
  help?: { summary: string; remedy: string },
): string {
  const value = env[key]?.trim()
  if (value) return value
  const meaning = help ?? (ENV_HELP as Record<string, { summary: string; remedy: string }>)[key]
  if (!meaning) {
    throw configProblem({
      key,
      summary: `The mandatory environment variable ${key} is not set.`,
      remedy: `Set ${key} in your environment (or .env) and restart.`,
    })
  }
  throw configProblem({ key, ...meaning })
}
