import { describe, expect, it } from 'vitest'
import { createMisconfiguredApp } from '../src/config/misconfiguredApp.js'
import {
  ConfigValidationError,
  ENV_HELP,
  configProblem,
  formatConfigProblems,
  isConfigValidationError,
  requireEnv,
} from '../src/config/problems.js'

// The misconfiguration fallback backend: when a facade can't boot because a mandatory env var /
// binding is missing, it serves THIS instead of dying, so the SPA can render a dedicated error
// screen. These assertions pin the two guarantees that matter: the SPA's boot handshake keeps
// working (so it branches to the screen), and the payload never leaks a secret.
const PROBLEMS = [{ key: 'DATABASE_URL', ...ENV_HELP.DATABASE_URL }]

describe('ConfigValidationError', () => {
  it('carries the structured problems and a human-readable multi-line message', () => {
    const err = new ConfigValidationError(PROBLEMS)
    expect(isConfigValidationError(err)).toBe(true)
    expect(err.problems).toEqual(PROBLEMS)
    expect(err.message).toContain('DATABASE_URL')
    expect(err.message).toContain(ENV_HELP.DATABASE_URL.remedy)
  })

  it('isConfigValidationError rejects a plain Error', () => {
    expect(isConfigValidationError(new Error('nope'))).toBe(false)
  })

  it('formatConfigProblems summarises the count for multiple problems', () => {
    const msg = formatConfigProblems([
      { key: 'A', summary: 's', remedy: 'r' },
      { key: 'B', summary: 's', remedy: 'r' },
    ])
    expect(msg).toContain('2 mandatory configuration values')
  })
})

describe('requireEnv', () => {
  it('returns a set value, trimmed', () => {
    expect(requireEnv({ DATABASE_URL: '  postgres://x  ' }, 'DATABASE_URL')).toBe('postgres://x')
  })

  it('throws a ConfigValidationError with the known ENV_HELP meaning when missing', () => {
    try {
      requireEnv({}, 'DATABASE_URL')
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(isConfigValidationError(err)).toBe(true)
      expect((err as ConfigValidationError).problems[0]).toEqual({
        key: 'DATABASE_URL',
        ...ENV_HELP.DATABASE_URL,
      })
    }
  })

  it('treats a blank value as missing', () => {
    expect(() => requireEnv({ X: '   ' }, 'X')).toThrow(ConfigValidationError)
  })
})

describe('createMisconfiguredApp', () => {
  const app = createMisconfiguredApp(PROBLEMS)

  it('serves the problem list on /auth/config as an auth-disabled config', async () => {
    const res = await app.request('http://x/auth/config', {
      headers: { origin: 'http://localhost:3000' },
    })
    expect(res.status).toBe(200)
    // Reflects the caller's origin so the SPA can read it cross-origin.
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:3000')
    const body = (await res.json()) as {
      enabled: boolean
      misconfigured: { problems: typeof PROBLEMS }
    }
    expect(body.enabled).toBe(false)
    expect(body.misconfigured.problems).toEqual(PROBLEMS)
  })

  it('reports misconfigured on /health but stays 200 (no crash-loop)', async () => {
    const res = await app.request('http://x/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'misconfigured' })
  })

  it('503s every other route with the structured problem list', async () => {
    const res = await app.request('http://x/workspaces')
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error: { code: string; problems: typeof PROBLEMS } }
    expect(body.error.code).toBe('backend_misconfigured')
    expect(body.error.problems).toEqual(PROBLEMS)
  })

  it('a problem exposes ONLY the key/summary/remedy fields (never a secret value)', () => {
    // The structural guarantee: a ConfigProblem is a fixed, non-secret shape. Even if a loader tried
    // to attach a raw value, the type + this shape would keep it out of the wire payload.
    const problem = configProblem(PROBLEMS[0]!).problems[0]!
    expect(Object.keys(problem).sort()).toEqual(['key', 'remedy', 'summary'])
  })
})
