import { NoopBootstrapRunner, NoopWorkRunner } from '@cat-factory/kernel'
import { FakeAgentExecutor } from '@cat-factory/conformance'
import { describe, expect, it } from 'vitest'
import { buildNodeContainer } from '../src/container.js'
import { createDbClient } from '../src/db/client.js'
import { createApp } from '../src/server.js'

// Exercise the shared default-deny auth gate (mountAuthGate) on the real Node app —
// the security-critical path the conformance suite can't cover because it runs with
// AUTH_DEV_OPEN. These assertions need no Postgres: an unauthenticated request is
// rejected at the gate before any repository query, and the container is built lazily
// (the pg Pool only connects on first query), so the suite runs anywhere.

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

describe('Node auth gate (mountAuthGate)', () => {
  const call = makeApp(AUTH_ENABLED)

  it('allows the public health probe', async () => {
    expect((await call('GET', '/health')).status).toBe(200)
  })

  it('rejects a protected route with no session (default-deny → 401)', async () => {
    expect((await call('GET', '/workspaces')).status).toBe(401)
    expect((await call('POST', '/workspaces')).status).toBe(401)
    expect((await call('GET', '/workspaces/ws_x/blocks')).status).toBe(401)
  })

  it('bypasses the gate for public prefixes (/auth, /v1, /github)', async () => {
    // The gate lets these through; the router then handles them (200/404/…), but it is
    // never the gate's 401/503 — proving the prefix is public.
    for (const path of ['/auth/anything', '/v1/anything', '/github/anything']) {
      const status = (await call('GET', path)).status
      expect(status).not.toBe(401)
      expect(status).not.toBe(503)
    }
  })

  it('gates a non-WebSocket request to the event-stream path', async () => {
    // The WS-upgrade bypass is narrow: only a real `Upgrade: websocket` handshake is
    // let through (it can't be simulated via fetch — `Upgrade`/`Connection` are
    // forbidden request headers undici strips). A plain GET stays default-deny.
    expect((await call('GET', '/workspaces/ws_x/events')).status).toBe(401)
  })

  it('fails closed (503) when auth is unconfigured and dev-open is off', async () => {
    const closed = makeApp(AUTH_UNCONFIGURED)
    expect((await closed('GET', '/workspaces')).status).toBe(503)
    // Public routes still work even when auth is unconfigured.
    expect((await closed('GET', '/health')).status).toBe(200)
  })
})
