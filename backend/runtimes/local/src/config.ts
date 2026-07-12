import { loadNodeConfig } from '@cat-factory/node-server'
import type { AppConfig, ConfigProblem } from '@cat-factory/server'
import { ENV_HELP, configProblem, requireEncryptionKey, requireEnv } from '@cat-factory/server'
import { isOffValue } from './envFlags.js'
import { resolveHostAlias } from './runtimes/index.js'

// The one-shot fix we advertise whenever local mode can't boot for a missing/invalid mandatory
// value: the bootstrap CLI's `env` subcommand generates a ready-to-run local-mode `.env` with ALL
// required values (the three crypto secrets in the server's formats, DATABASE_URL, a minted VCS
// PAT) in a single step, so a developer never has to satisfy each variable below by hand. It is a
// genuinely local-only differentiator (it writes a LOCAL `.env`), so the shared Node/Worker
// remedies deliberately do NOT mention it.
const LOCAL_ENV_CLI_COMMAND = 'npx @cat-factory/cli env'

/**
 * The synthetic "generate the whole .env" problem prepended to a local-mode misconfiguration list,
 * advertising the {@link LOCAL_ENV_CLI_COMMAND} one-shot fix ahead of the per-variable remedies
 * (which stay as the manual fallback). Its `key` reads as a filename rather than an env-var name on
 * purpose — it is not one variable but the file that carries them all.
 */
export const LOCAL_ENV_CLI_PROBLEM: ConfigProblem = {
  key: '.env',
  summary:
    'Local mode needs a few crypto secrets and a Postgres DATABASE_URL. You can generate them all at once instead of setting each variable below by hand.',
  remedy: `Run \`${LOCAL_ENV_CLI_COMMAND}\` to write a ready-to-run local-mode .env (every required value, gitignored) into the current directory, then restart.`,
}

/**
 * Prepend the {@link LOCAL_ENV_CLI_PROBLEM} advertisement to a local-mode misconfiguration list so
 * the one-step `.env` generator is offered above the individual per-variable remedies. Applied at
 * every point local mode surfaces a {@link ConfigValidationError} — both the secrets validated here
 * (via `applyLocalDefaults`) and DATABASE_URL validated in the reused Node boot. Idempotent: never
 * adds a second copy when the advertisement is already present.
 */
export function withLocalEnvCliAdvice(problems: ConfigProblem[]): ConfigProblem[] {
  if (problems.some((p) => p.key === LOCAL_ENV_CLI_PROBLEM.key)) return problems
  return [LOCAL_ENV_CLI_PROBLEM, ...problems]
}

// Local mode defaults the auth gate OPEN and can be exposed on a LAN, so a weak
// AUTH_SESSION_SECRET would leave sessions / machine / proxy tokens forgeable. The
// hosted Node loader only enforces this length when gating its OAuth providers; local
// mode must enforce it on the raw secret too. 32 chars matches MIN_SESSION_SECRET_LENGTH
// in the Node loader.
const MIN_SESSION_SECRET_LENGTH = 32
// The harness inbound-auth secret gates every call between this service and its agent
// containers, and local mode may be reachable on a LAN — so reject a trivially-guessable value.
const MIN_HARNESS_SECRET_LENGTH = 16

// Local mode is a single developer running the whole product on their own machine.
// It reuses the Node facade's config loader verbatim and only changes the defaults
// that would otherwise force cloud-style setup:
//   - the auth gate defaults OPEN (no GitHub OAuth app to register) — never in a
//     production ENVIRONMENT (`loadNodeConfig` enforces that);
//   - PUBLIC_URL defaults to `host.docker.internal:<PORT>` so a job's container can
//     reach this service's LLM proxy from inside Docker.
// Every default is overridable: setting the corresponding env var wins. The two crypto
// secrets (AUTH_SESSION_SECRET, ENCRYPTION_KEY) are the exception — they are REQUIRED, not
// defaulted (see `requireStableSecret`).

const DEFAULT_PORT = '8787'

// The self-hosted SearXNG the local docker-compose runs, reached by THIS host process (the
// orchestrator runs on the host and hits the compose-published port; agent containers never
// touch it — they go through the backend web-search proxy). The Node facade builds a TRUSTED
// upstream from `WEB_SEARCH_SEARXNG_URL`, so a loopback URL is permitted (it bypasses the
// account-URL SSRF guard). See `createDefaultWebSearchUpstream` in @cat-factory/server.
const DEFAULT_LOCAL_SEARXNG_URL = 'http://localhost:8080'

/**
 * Resolve a mandatory local-mode secret from env, throwing a clear, actionable error when it
 * isn't set. These secrets must be STABLE across restarts:
 *   - the session secret signs the session JWT (a fresh value each boot invalidates the
 *     persisted session and forces a re-login);
 *   - the encryption key seals credentials at rest (a fresh value orphans them);
 *   - the harness shared secret authenticates every call between this service and its agent
 *     containers (a fresh per-process value fails auth against a container still running from
 *     before a restart, so re-attach breaks and in-flight runs flap).
 * So local mode requires them explicitly rather than auto-generating an unstable per-process
 * value that silently breaks on the next restart. `pnpm secrets` (deploy/local) prints all
 * three in the right format.
 */
function requireStableSecret(env: NodeJS.ProcessEnv, name: string): string {
  // The encryption key's presence + base64 + AES-256-length validation is the shared, facade-wide
  // invariant, so delegate it verbatim (identical message on Node, local, and the Worker) rather
  // than re-implementing it here. The two length-only secrets below are local-mode-specific.
  if (name === 'ENCRYPTION_KEY') {
    return requireEncryptionKey(env.ENCRYPTION_KEY)
  }
  // Presence + trim + the ENV_HELP meaning/remedy come from the shared `requireEnv` (both these
  // vars have an ENV_HELP entry whose remedy already points at `pnpm secrets` in deploy/local), so
  // a missing/blank secret reports identically across the Node, local, and Worker facades. Local
  // mode then layers its extra length invariant below.
  const value = requireEnv(env, name)
  // Local mode leaves the auth gate open by default, so a short session secret is a real
  // token-forgery risk if the box is reachable on a LAN — reject it up front rather than
  // running with a guessable HMAC key.
  if (name === 'AUTH_SESSION_SECRET' && value.length < MIN_SESSION_SECRET_LENGTH) {
    throw configProblem({
      key: 'AUTH_SESSION_SECRET',
      summary: ENV_HELP.AUTH_SESSION_SECRET.summary,
      remedy: `Must be at least ${MIN_SESSION_SECRET_LENGTH} characters (got ${value.length}). Generate a strong one with \`pnpm secrets\` in deploy/local.`,
      docsUrl: ENV_HELP.AUTH_SESSION_SECRET.docsUrl,
    })
  }
  // Reject a too-short harness secret: local mode may be reachable on a LAN and this value is
  // the only auth between the service and its agent containers.
  if (name === 'HARNESS_SHARED_SECRET' && value.length < MIN_HARNESS_SECRET_LENGTH) {
    throw configProblem({
      key: 'HARNESS_SHARED_SECRET',
      summary: ENV_HELP.HARNESS_SHARED_SECRET.summary,
      remedy: `Must be at least ${MIN_HARNESS_SECRET_LENGTH} characters (got ${value.length}). Generate a strong one with \`pnpm secrets\` in deploy/local.`,
      docsUrl: ENV_HELP.HARNESS_SHARED_SECRET.docsUrl,
    })
  }
  return value
}

/**
 * Read + validate the mandatory {@link HARNESS_SHARED_SECRET}, throwing the same loud config
 * error as the other required secrets when it's missing/blank/too-short. The runner transport
 * factories call this so the secret is a genuinely REQUIRED constructor argument — the transports
 * never invent a random per-process value (which would break re-attach across a restart). Safe to
 * call on env already run through {@link applyLocalDefaults} (idempotent revalidation).
 */
export function requireHarnessSharedSecret(env: NodeJS.ProcessEnv): string {
  return requireStableSecret(env, 'HARNESS_SHARED_SECRET')
}

/**
 * Apply local-mode env defaults onto a copy of {@link env}. Idempotent: an explicitly
 * set value is always preserved, so calling it twice (loader + container) is safe.
 */
export function applyLocalDefaults(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const port = env.PORT?.trim() || DEFAULT_PORT
  // The host alias the harness uses to reach this service depends on the runtime:
  // `host.docker.internal` (Docker/Podman/OrbStack), `host.lima.internal` (Colima), or
  // the vmnet gateway (Apple). An explicit LOCAL_HARNESS_HOST_ALIAS / PUBLIC_URL wins.
  const hostAlias = resolveHostAlias(env)
  // On by default: point the backend web-search proxy at the local docker-compose SearXNG so
  // agents get web search with zero per-account key entry. `LOCAL_WEB_SEARCH=off` skips this
  // auto-default (with no explicit URL set, WEB_SEARCH_SEARXNG_URL is then absent → the Node
  // facade builds no upstream → the tool isn't advertised and the proxy degrades to empty). Per
  // this loader's "explicit env always wins" contract, an operator-set WEB_SEARCH_SEARXNG_URL is
  // preserved regardless (via `...env`).
  const webSearchDisabled = isOffValue(env.LOCAL_WEB_SEARCH)
  return {
    ...env,
    ...(webSearchDisabled
      ? {}
      : {
          WEB_SEARCH_SEARXNG_URL: env.WEB_SEARCH_SEARXNG_URL?.trim() || DEFAULT_LOCAL_SEARXNG_URL,
        }),
    // Label this deployment as the `local` environment. It stays non-production (so the
    // auth gate may default open, below), and it makes `@cat-factory/server`'s CORS policy
    // REFLECT the requesting origin when `CORS_ALLOWED_ORIGINS` is unset (`local` is a
    // recognised development value in `corsReflectsWhenUnset`). Without this the server
    // default-DENIES CORS on an unset allow-list, so the SPA on :3000 fails with "blocked by
    // CORS policy / can't reach backend" — a no-brainer for a single-developer local box.
    // Auth is a bearer header (credentials mode off), so reflecting any origin here is safe.
    // Set `CORS_ALLOWED_ORIGINS` to pin specific origins, or `ENVIRONMENT` to override.
    ENVIRONMENT: env.ENVIRONMENT?.trim() || 'local',
    // `|| 'true'` (not `??`) so an explicit empty `AUTH_DEV_OPEN=` still defaults open,
    // consistent with the other fields here; set `AUTH_DEV_OPEN=false` to close the gate.
    // devOpen keeps the API open for unauthenticated reads (and the test harness), but a
    // real developer now signs in (PAT or password) to get an identity — anonymous can't
    // store per-user credentials (personal subscriptions, own keys). See the login flow.
    AUTH_DEV_OPEN: env.AUTH_DEV_OPEN?.trim() || 'true',
    // Offer email/password sign-in alongside the source-control PAT login, so a developer
    // without a PAT can still create a local account. This makes auth "enabled" (the SPA
    // then requires sign-in), which is the point — anonymous local use is a half-product.
    AUTH_PASSWORD_ENABLED: env.AUTH_PASSWORD_ENABLED?.trim() || 'true',
    // Local accounts are created freely (no invite / email-domain gate) — it's the
    // developer's own machine. Hosted facades leave this off (invite/domain-gated signup).
    AUTH_OPEN_SIGNUP: env.AUTH_OPEN_SIGNUP?.trim() || 'true',
    // Signs the SPA session JWT (and short-lived proxy tokens for local jobs). REQUIRED and
    // must be stable: a fresh value each boot invalidates the persisted session and forces a
    // re-login (the original "re-enter the PAT every restart" bug). Generate with `pnpm
    // secrets` in deploy/local.
    AUTH_SESSION_SECRET: requireStableSecret(env, 'AUTH_SESSION_SECRET'),
    // The shared key backing credential encryption at rest (document/task/runner/slack
    // integrations, personal subscriptions). REQUIRED and must be stable: a fresh value each
    // boot orphans every credential sealed under the previous one. Generate with `pnpm secrets`
    // in deploy/local.
    ENCRYPTION_KEY: requireStableSecret(env, 'ENCRYPTION_KEY'),
    // Inbound-auth secret injected into every agent container and sent on each harness call.
    // REQUIRED and must be stable: the local runner transports otherwise mint a RANDOM
    // per-process value, so after a restart polls against a container still running from before
    // fail auth — the run flaps instead of re-attaching (docs/race-condition-audit-2026-07.md).
    // Generate with `pnpm secrets` in deploy/local.
    HARNESS_SHARED_SECRET: requireStableSecret(env, 'HARNESS_SHARED_SECRET'),
    // The harness (inside the container) posts to `${PUBLIC_URL}/v1`; the runtime's host
    // alias routes back to this service on the host. The docker-family transport
    // publishes that alias on Linux via `--add-host=<alias>:host-gateway`.
    PUBLIC_URL: env.PUBLIC_URL?.trim() || `http://${hostAlias}:${port}`,
    // The ephemeral-environment module assembles from the shared ENCRYPTION_KEY (always set
    // in local mode), so the Tester's "delegate test environments to a provider" opt-in is
    // available once a developer registers a provider. The module is inert (and the local
    // default stays host DinD) until they connect one, so its always-on assembly has no
    // behavioural cost.
    // A local k3s preview environment is reached over http at a loopback/LAN host (a
    // localhost NodePort, or a Traefik ingress host like `app.127.0.0.1.nip.io` /
    // `myapp.localhost`). The strict public-https URL guard would reject the URL the
    // provider returns, so local mode widens the ENVIRONMENT URL policy to permit http +
    // the common local host suffixes. Hosted facades keep the strict default. Add more
    // hosts via ENVIRONMENTS_ALLOW_URL_HOSTS; this only widens the ENV integration's guard.
    ENVIRONMENTS_ALLOW_HTTP_URLS: env.ENVIRONMENTS_ALLOW_HTTP_URLS?.trim() || 'true',
    ENVIRONMENTS_ALLOW_URL_HOSTS:
      env.ENVIRONMENTS_ALLOW_URL_HOSTS?.trim() ||
      'localhost,127.0.0.1,host.docker.internal,.localhost,.local,.nip.io,.sslip.io',
  }
}

/** The shared {@link AppConfig} with local-mode defaults applied. */
export function loadLocalConfig(env: NodeJS.ProcessEnv): AppConfig {
  return loadNodeConfig(applyLocalDefaults(env))
}
