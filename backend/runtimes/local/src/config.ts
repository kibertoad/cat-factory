import { randomBytes } from 'node:crypto'
import { loadNodeConfig } from '@cat-factory/node-server'
import type { AppConfig } from '@cat-factory/server'

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
  return {
    ...env,
    // `|| 'true'` (not `??`) so an explicit empty `AUTH_DEV_OPEN=` still defaults open,
    // consistent with the other fields here; set `AUTH_DEV_OPEN=false` to close the gate.
    AUTH_DEV_OPEN: env.AUTH_DEV_OPEN?.trim() || 'true',
    // Stable within a process; only signs short-lived proxy tokens for local jobs.
    AUTH_SESSION_SECRET: env.AUTH_SESSION_SECRET?.trim() || randomBytes(32).toString('hex'),
    // The shared key backing credential encryption at rest (document/task/runner/slack
    // integrations, personal subscriptions). `loadNodeConfig` requires it, so generate a
    // per-process key when absent — enough to boot and run a pipeline. Set ENCRYPTION_KEY
    // explicitly to keep encrypted-at-rest credentials decryptable across restarts.
    ENCRYPTION_KEY: env.ENCRYPTION_KEY?.trim() || randomBytes(32).toString('base64'),
    // The harness (inside Docker) posts to `${PUBLIC_URL}/v1`; host.docker.internal
    // routes back to this service on the host. The transport publishes the gateway
    // host alias on Linux via `--add-host`.
    PUBLIC_URL: env.PUBLIC_URL?.trim() || `http://host.docker.internal:${port}`,
  }
}

/** The shared {@link AppConfig} with local-mode defaults applied. */
export function loadLocalConfig(env: NodeJS.ProcessEnv): AppConfig {
  return loadNodeConfig(applyLocalDefaults(env))
}
