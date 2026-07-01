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

// The always-on task-source integration makes `loadNodeConfig` require ENCRYPTION_KEY
// or it throws at config load — supply it in every env that builds a container.
const ENCRYPTION_KEY = Buffer.alloc(32).toString('base64')

const AUTH_ENABLED: NodeJS.ProcessEnv = {
  GITHUB_OAUTH_CLIENT_ID: 'client-id',
  GITHUB_OAUTH_CLIENT_SECRET: 'client-secret',
  AUTH_SESSION_SECRET: 'x'.repeat(32),
  ENVIRONMENT: 'production', // disables the dev-open escape hatch
  ENCRYPTION_KEY,
}

const AUTH_UNCONFIGURED: NodeJS.ProcessEnv = {
  ENVIRONMENT: 'production', // no OAuth creds, no dev-open → fail closed
  ENCRYPTION_KEY,
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

  it('refuses to boot when auth is unconfigured and dev-open is off', () => {
    // Production shape: no creds, no dev-open hatch. Remote node mode has no anonymous
    // tier, so loadNodeConfig fails fast at boot rather than starting a 503-only app that
    // looks broken instead of misconfigured (see config.ts).
    expect(() => makeApp(AUTH_UNCONFIGURED)).toThrow(/anonymous access/i)
  })

  // Symmetric with the Worker's auth.spec: a hosted deployment advertises the PAT-login
  // providers so a user can sign in with their own PAT (GitHub always; GitLab when a GitLab
  // connection is configured). "Keep the runtimes symmetric" — both facades wire vcsIdentity.
  it('advertises GitHub PAT login on a hosted deployment', async () => {
    const call = makeApp(AUTH_ENABLED)
    const res = await call('GET', '/auth/config')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { patLogin?: { providers: string[] } }
    expect(body.patLogin?.providers).toEqual(['github'])
  })

  it('adds GitLab to the PAT-login providers when GITLAB_TOKEN is configured', async () => {
    const call = makeApp({ ...AUTH_ENABLED, GITLAB_TOKEN: 'glpat-test-token' })
    const res = await call('GET', '/auth/config')
    const body = (await res.json()) as { patLogin?: { providers: string[] } }
    expect(body.patLogin?.providers).toEqual(['github', 'gitlab'])
  })
})
