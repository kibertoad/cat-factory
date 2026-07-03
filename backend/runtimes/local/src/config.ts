import { loadNodeConfig } from '@cat-factory/node-server'
import type { AppConfig } from '@cat-factory/server'
import { base64urlToBytes } from '@cat-factory/server'
import { resolveHostAlias } from './runtimes/index.js'

// Local mode defaults the auth gate OPEN and can be exposed on a LAN, so a weak
// AUTH_SESSION_SECRET would leave sessions / machine / proxy tokens forgeable. The
// hosted Node loader only enforces this length when gating its OAuth providers; local
// mode must enforce it on the raw secret too. 32 chars matches MIN_SESSION_SECRET_LENGTH
// in the Node loader.
const MIN_SESSION_SECRET_LENGTH = 32
/** The system encryption key must decode to at least this many bytes (AES-256). */
const MIN_ENCRYPTION_KEY_BYTES = 32

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

/**
 * Resolve a mandatory local-mode secret from env, throwing a clear, actionable error when it
 * isn't set. These secrets must be STABLE across restarts — the session secret signs the
 * session JWT (a fresh value each boot invalidates the persisted session and forces a
 * re-login) and the encryption key seals credentials at rest (a fresh value orphans them) — so
 * local mode requires them explicitly rather than auto-generating an unstable per-process
 * value that silently breaks on the next restart. The hosted Node facade requires them too, so
 * this also keeps the facades aligned. `pnpm secrets` (deploy/local) prints both in the right
 * format.
 */
function requireStableSecret(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim()
  if (!value) {
    throw new Error(
      `${name} is required in local mode but is not set. It must stay stable across restarts (a ` +
        `fresh value each boot forces a re-login and orphans encrypted credentials). Generate ` +
        `both secrets with \`pnpm secrets\` in deploy/local and add them to your .env.`,
    )
  }
  // Local mode leaves the auth gate open by default, so a short session secret is a real
  // token-forgery risk if the box is reachable on a LAN — reject it up front rather than
  // running with a guessable HMAC key.
  if (name === 'AUTH_SESSION_SECRET' && value.length < MIN_SESSION_SECRET_LENGTH) {
    throw new Error(
      `AUTH_SESSION_SECRET must be at least ${MIN_SESSION_SECRET_LENGTH} characters (it signs the ` +
        `session/proxy/machine tokens). Generate a strong one with \`pnpm secrets\` in deploy/local.`,
    )
  }
  // Validate the encryption key decodes to a full AES-256 key at config load, so a too-short
  // key fails with a clear message here rather than deep inside the first cipher build.
  if (name === 'ENCRYPTION_KEY') {
    let bytes: Uint8Array
    try {
      bytes = base64urlToBytes(value)
    } catch {
      throw new Error(
        'ENCRYPTION_KEY must be a valid base64-encoded key. Generate one with `pnpm secrets`.',
      )
    }
    if (bytes.length < MIN_ENCRYPTION_KEY_BYTES) {
      throw new Error(
        `ENCRYPTION_KEY must decode to at least ${MIN_ENCRYPTION_KEY_BYTES} bytes (it seals ` +
          `credentials at rest). Generate one with \`pnpm secrets\` in deploy/local.`,
      )
    }
  }
  return value
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
  return {
    ...env,
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
    // The harness (inside the container) posts to `${PUBLIC_URL}/v1`; the runtime's host
    // alias routes back to this service on the host. The docker-family transport
    // publishes that alias on Linux via `--add-host=<alias>:host-gateway`.
    PUBLIC_URL: env.PUBLIC_URL?.trim() || `http://${hostAlias}:${port}`,
    // Assemble the ephemeral-environment module by default so the Tester's "delegate test
    // environments to a provider" opt-in works once a developer registers a provider — the
    // module is inert (and the local default stays host DinD) until they connect one AND
    // flip the toggle, so defaulting it on has no behavioural cost. Set ENVIRONMENTS_ENABLED
    // explicitly to override.
    ENVIRONMENTS_ENABLED: env.ENVIRONMENTS_ENABLED?.trim() || 'true',
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
