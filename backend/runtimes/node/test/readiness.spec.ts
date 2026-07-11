import { NoopBootstrapRunner, NoopWorkRunner } from '@cat-factory/kernel'
import { FakeAgentExecutor } from '@cat-factory/conformance'
import { describe, expect, it, vi } from 'vitest'
import { buildNodeContainer } from '../src/container.js'
import { createDbClient } from '../src/db/client.js'
import { createApp } from '../src/server.js'
import { checkReadiness } from '../src/readiness.js'

// `/health` is liveness (always 200); `/ready` is readiness — it drains when the Postgres pool
// dies, pg-boss stops, or shutdown begins. Two layers of test: the pure verdict (`checkReadiness`),
// and the Node-facade glue (`createApp` mounts `/ready`, public, with the right status code).

describe('checkReadiness', () => {
  const okPing = async () => {}

  it('is ready when the pool round-trips and pg-boss is running', async () => {
    const report = await checkReadiness({ ping: okPing, pgBossHealthy: () => true })
    expect(report.ready).toBe(true)
    expect(report.checks.database).toEqual({ ok: true })
    expect(report.checks.pgBoss).toEqual({ ok: true })
  })

  it('is not ready — with the failure detail — when the pool probe throws', async () => {
    const report = await checkReadiness({
      ping: () => Promise.reject(new Error('connection refused')),
      pgBossHealthy: () => true,
    })
    expect(report.ready).toBe(false)
    expect(report.checks.database).toEqual({ ok: false, error: 'connection refused' })
    // pg-boss is still probed and reported healthy — the report names WHICH dependency failed.
    expect(report.checks.pgBoss).toEqual({ ok: true })
  })

  it('is not ready when pg-boss has stopped', async () => {
    const report = await checkReadiness({ ping: okPing, pgBossHealthy: () => false })
    expect(report.ready).toBe(false)
    expect(report.checks.database).toEqual({ ok: true })
    expect(report.checks.pgBoss).toEqual({ ok: false, error: 'pg-boss not running' })
  })

  it('draining short-circuits: not ready, downstream probes skipped', async () => {
    const ping = vi.fn(okPing)
    const pgBossHealthy = vi.fn(() => true)
    const report = await checkReadiness({ ping, pgBossHealthy, isDraining: () => true })
    expect(report.ready).toBe(false)
    expect(report.checks).toEqual({ shutdown: { ok: false, error: 'draining' } })
    // A SIGTERM'd node reports not-ready immediately — the DB/boss probes are irrelevant to the drain.
    expect(ping).not.toHaveBeenCalled()
    expect(pgBossHealthy).not.toHaveBeenCalled()
  })

  it('bounds a wedged pool probe with a timeout instead of hanging', async () => {
    const report = await checkReadiness({
      ping: () => new Promise<void>(() => {}), // never resolves
      pgBossHealthy: () => true,
      timeoutMs: 10,
    })
    expect(report.ready).toBe(false)
    expect(report.checks.database!.ok).toBe(false)
    expect(report.checks.database!.error).toMatch(/timed out/)
  })
})

const BASE = 'https://cat-factory.test'
const ENCRYPTION_KEY = Buffer.alloc(32).toString('base64')
// Auth ON (production shape) so the `/ready` public-before-the-gate assertion is meaningful.
const AUTH_ENABLED: NodeJS.ProcessEnv = {
  GITHUB_OAUTH_CLIENT_ID: 'client-id',
  GITHUB_OAUTH_CLIENT_SECRET: 'client-secret',
  AUTH_SESSION_SECRET: 'x'.repeat(32),
  ENVIRONMENT: 'production',
  ENCRYPTION_KEY,
}

function makeApp(readiness?: Parameters<typeof createApp>[2]) {
  const { db } = createDbClient('postgres://unused:unused@127.0.0.1:5432/unused')
  const container = buildNodeContainer({
    db,
    env: AUTH_ENABLED,
    overrides: {
      agentExecutor: new FakeAgentExecutor(),
      workRunner: new NoopWorkRunner(),
      bootstrapRunner: new NoopBootstrapRunner(),
    },
  })
  const app = createApp(container, AUTH_ENABLED, readiness)
  return (path: string) => app.fetch(new Request(`${BASE}${path}`, { method: 'GET' }))
}

describe('Node /ready wiring', () => {
  it('serves 200 when the probe reports ready — public, no auth', async () => {
    const call = makeApp({
      readiness: async () => ({ ready: true, checks: { database: { ok: true } } }),
    })
    const res = await call('/ready')
    // 200 (not 401) proves it sits BEFORE the auth gate, like `/health`.
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ready', checks: { database: { ok: true } } })
  })

  it('serves 503 when the probe reports not ready', async () => {
    const call = makeApp({
      readiness: async () => ({ ready: false, checks: { database: { ok: false, error: 'down' } } }),
    })
    const res = await call('/ready')
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({
      status: 'not_ready',
      checks: { database: { ok: false, error: 'down' } },
    })
  })

  it('falls back to a bare ready when no probe is wired (embedded / mothership)', async () => {
    const res = await makeApp()('/ready')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ready', checks: {} })
  })
})
