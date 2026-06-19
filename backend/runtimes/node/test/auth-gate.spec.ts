import { NoopBootstrapRunner, NoopWorkRunner } from '@cat-factory/kernel'
import { FakeAgentExecutor } from '@cat-factory/conformance'
import { describe, expect, it } from 'vitest'
import { buildNodeContainer } from '../src/container.js'
import { createDbClient } from '../src/db/client.js'
import { createApp } from '../src/server.js'

// Smoke-test that the real Node app wires the shared auth gate (mountAuthGate) over a
// config derived from the process env — the security-critical path the conformance
// suite can't cover because it runs with AUTH_DEV_OPEN. The gate's own behaviour is
// unit-tested in @cat-factory/server; here we only confirm the Node-facade glue. No
// Postgres needed: an unauthenticated request is rejected at the gate before any
// repository query, and the container is built lazily (the pg Pool connects on first
// query), so the suite runs anywhere.

const BASE = 'https://cat-factory.test'

const AUTH_ENABLED: NodeJS.ProcessEnv = {
  GITHUB_OAUTH_CLIENT_ID: 'client-id',
  GITHUB_OAUTH_CLIENT_SECRET: 'client-secret',
  AUTH_SESSION_SECRET: 'x'.repeat(32),
  ENVIRONMENT: 'production', // disables the dev-open escape hatch
}

const AUTH_UNCONFIGURED: NodeJS.ProcessEnv = {
  ENVIRONMENT: 'production', // no OAuth creds, no dev-open → fail closed
}

function makeApp(env: NodeJS.ProcessEnv) {
  const { db } = createDbClient('postgres://unused:unused@127.0.0.1:5432/unused')
  const container = buildNodeContainer({
    db,
    env,
    overrides: {
      agentExecutor: new FakeAgentExecutor(),
      workRunner: new NoopWorkRunner(),
      bootstrapRunner: new NoopBootstrapRunner(),
    },
  })
  const app = createApp(container, env)
  return (method: string, path: string, headers?: Record<string, string>) =>
    app.fetch(new Request(`${BASE}${path}`, { method, headers }))
}

// The gate's own logic (every public prefix, the WS-upgrade bypass, the authz branch)
// is covered exhaustively by @cat-factory/server's `authGate.spec.ts`. This file proves
// only the Node-facade-specific glue that suite can't: `createApp` actually mounts the
// gate, and `loadNodeConfig` derives `auth.enabled`/`devOpen` from the process env.
describe('Node auth gate wiring', () => {
  it('mounts the gate over a configured env: protected → 401, /health stays public', async () => {
    // Reaching 401 (not 503) proves loadNodeConfig derived auth.enabled from the
    // OAuth creds + 32-char session secret, and that createApp wired mountAuthGate.
    const call = makeApp(AUTH_ENABLED)
    expect((await call('GET', '/workspaces')).status).toBe(401)
    expect((await call('GET', '/health')).status).toBe(200)
  })

  it('fails closed (503) when auth is unconfigured and dev-open is off', async () => {
    // Production shape: no creds, no dev-open hatch → loadNodeConfig leaves auth
    // disabled and the gate refuses rather than serving protected data openly.
    const closed = makeApp(AUTH_UNCONFIGURED)
    expect((await closed('GET', '/workspaces')).status).toBe(503)
  })
})
