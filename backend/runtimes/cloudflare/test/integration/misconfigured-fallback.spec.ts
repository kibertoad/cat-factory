import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { createApp } from '../../src/app'
import { FakeAgentExecutor } from '../fakes/FakeAgentExecutor'

// When a mandatory binding / var is missing, `buildContainer` throws a `ConfigValidationError` and
// the Worker's per-request middleware serves the misconfiguration FALLBACK instead of 500-ing, so
// the SPA can render its dedicated "backend misconfigured" screen. This suite pins the wiring that
// only the assembled facade exercises (the shared response builder itself is unit-tested in
// @cat-factory/server): the boot handshake still succeeds, and — critically — the error stays
// readable cross-origin even when CORS_ALLOWED_ORIGINS is unset in a production ENVIRONMENT (the
// normal cors() path default-denies there, which would otherwise hide the screen precisely when
// the deployment is most broken).

const BASE = 'https://cat-factory.test'
const ORIGIN = 'https://app.cat-factory.test'

// A production env with NO CORS allow-list AND a missing mandatory binding (ENCRYPTION_KEY, which
// the always-on document/task integrations require) — the worst case the reflect-origin fix covers.
const BROKEN_PROD_ENV = {
  ...env,
  ENVIRONMENT: 'production',
  CORS_ALLOWED_ORIGINS: undefined,
  ENCRYPTION_KEY: undefined,
} as typeof env

function fetchBroken(path: string, init: { method?: string; origin?: string } = {}) {
  const app = createApp({ overrides: { agentExecutor: new FakeAgentExecutor() } })
  const headers = init.origin ? { origin: init.origin } : undefined
  return app.fetch(
    new Request(`${BASE}${path}`, { method: init.method ?? 'GET', headers }),
    BROKEN_PROD_ENV,
  )
}

describe('Worker misconfiguration fallback', () => {
  it('serves the problem list on /auth/config as an auth-disabled config', async () => {
    const res = await fetchBroken('/auth/config', { origin: ORIGIN })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      enabled: boolean
      misconfigured?: { problems: { key: string }[] }
    }
    expect(body.enabled).toBe(false)
    expect(body.misconfigured?.problems.map((p) => p.key)).toContain('ENCRYPTION_KEY')
  })

  it('reflects the caller origin even with CORS unset in production (so the SPA can read it)', async () => {
    // Without the explicit reflect in app.ts, resolveCorsOrigin(origin, undefined, false) returns
    // null here and the browser would drop the response — defeating the whole feature.
    const res = await fetchBroken('/auth/config', { origin: ORIGIN })
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN)
  })

  it('keeps /health at 200 with a misconfigured status (no orchestrator crash-loop)', async () => {
    const res = await fetchBroken('/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'misconfigured' })
  })

  it('503s every other route with the structured problem list', async () => {
    const res = await fetchBroken('/workspaces')
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error: { code: string; problems: { key: string }[] } }
    expect(body.error.code).toBe('backend_misconfigured')
    expect(body.error.problems.map((p) => p.key)).toContain('ENCRYPTION_KEY')
  })
})
