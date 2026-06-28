import { randomBytes } from 'node:crypto'
import { loadNodeConfig } from '@cat-factory/node-server'
import type { AppConfig } from '@cat-factory/server'
import { resolveHostAlias } from './runtimes/index.js'

// Local mode is a single developer running the whole product on their own machine.
// It reuses the Node facade's config loader verbatim and only changes the defaults
// that would otherwise force cloud-style setup:
//   - the auth gate defaults OPEN (no GitHub OAuth app to register) — never in a
//     production ENVIRONMENT (`loadNodeConfig` enforces that);
//   - a session secret is generated if absent (it only signs the short-lived LLM-proxy
//     tokens the local container uses; a per-process value is fine for dev);
//   - PUBLIC_URL defaults to `host.docker.internal:<PORT>` so a job's container can
//     reach this service's LLM proxy from inside Docker.
// Every default is overridable: setting the corresponding env var wins.

const DEFAULT_PORT = '8787'

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
    // The auto-generated session secret below is strong enough to satisfy the gate.
    AUTH_PASSWORD_ENABLED: env.AUTH_PASSWORD_ENABLED?.trim() || 'true',
    // Local accounts are created freely (no invite / email-domain gate) — it's the
    // developer's own machine. Hosted facades leave this off (invite/domain-gated signup).
    AUTH_OPEN_SIGNUP: env.AUTH_OPEN_SIGNUP?.trim() || 'true',
    // Stable within a process; only signs short-lived proxy tokens for local jobs.
    AUTH_SESSION_SECRET: env.AUTH_SESSION_SECRET?.trim() || randomBytes(32).toString('hex'),
    // The shared key backing credential encryption at rest (document/task/runner/slack
    // integrations, personal subscriptions). `loadNodeConfig` requires it, so generate a
    // per-process key when absent — enough to boot and run a pipeline. Set ENCRYPTION_KEY
    // explicitly to keep encrypted-at-rest credentials decryptable across restarts.
    ENCRYPTION_KEY: env.ENCRYPTION_KEY?.trim() || randomBytes(32).toString('base64'),
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
  }
}

/** The shared {@link AppConfig} with local-mode defaults applied. */
export function loadLocalConfig(env: NodeJS.ProcessEnv): AppConfig {
  return loadNodeConfig(applyLocalDefaults(env))
}
