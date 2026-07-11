import { describe, expect, it } from 'vitest'
import { createMisconfiguredApp } from '../src/config/misconfiguredApp.js'
import {
  ConfigValidationError,
  ENV_HELP,
  MIN_ENCRYPTION_KEY_BYTES,
  configProblem,
  formatConfigProblems,
  isConfigValidationError,
  requireEncryptionKey,
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

  it('formatConfigProblems appends a Docs line when a problem carries a docsUrl', () => {
    const withDoc = formatConfigProblems([
      { key: 'A', summary: 's', remedy: 'r', docsUrl: 'https://example.test/docs#a' },
    ])
    expect(withDoc).toContain('Docs: https://example.test/docs#a')
    // ...and omits the Docs line entirely when there is no link.
    expect(formatConfigProblems([{ key: 'B', summary: 's', remedy: 'r' }])).not.toContain('Docs:')
  })

  it('every ENV_HELP entry carries a documentation link', () => {
    for (const [key, help] of Object.entries(ENV_HELP)) {
      expect(help.docsUrl, `${key} should link docs`).toMatch(
        /^https:\/\/github\.com\/kibertoad\/cat-factory\/blob\/main\//,
      )
    }
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

describe('requireEncryptionKey', () => {
  // A valid base64 key that decodes to a full AES-256 key (the minimum accepted).
  const validKey = Buffer.alloc(MIN_ENCRYPTION_KEY_BYTES).toString('base64')

  it('returns the trimmed key when it is valid base64 of at least 32 bytes', () => {
    expect(requireEncryptionKey(`  ${validKey}  `)).toBe(validKey)
  })

  it('throws the ENCRYPTION_KEY problem when missing or blank', () => {
    for (const value of [undefined, '', '   ']) {
      try {
        requireEncryptionKey(value)
        expect.unreachable('should have thrown')
      } catch (err) {
        expect(isConfigValidationError(err)).toBe(true)
        expect((err as ConfigValidationError).problems[0]).toEqual({
          key: 'ENCRYPTION_KEY',
          ...ENV_HELP.ENCRYPTION_KEY,
        })
      }
    }
  })

  it('throws a base64-naming problem for a non-base64 value', () => {
    try {
      requireEncryptionKey('%%%not-base64%%%')
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(isConfigValidationError(err)).toBe(true)
      const problem = (err as ConfigValidationError).problems[0]!
      expect(problem.key).toBe('ENCRYPTION_KEY')
      expect(problem.remedy).toMatch(/valid base64/)
      expect(problem.docsUrl).toBe(ENV_HELP.ENCRYPTION_KEY.docsUrl)
    }
  })

  it('throws a length problem for a key that decodes to fewer than 32 bytes', () => {
    try {
      requireEncryptionKey(Buffer.alloc(16).toString('base64'))
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(isConfigValidationError(err)).toBe(true)
      const problem = (err as ConfigValidationError).problems[0]!
      expect(problem.key).toBe('ENCRYPTION_KEY')
      expect(problem.remedy).toMatch(/at least 32 bytes/)
    }
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

  it('a problem exposes ONLY the non-secret key/summary/remedy/docsUrl fields (never a secret value)', () => {
    // The structural guarantee: a ConfigProblem is a fixed, non-secret shape (the optional docsUrl is
    // a public documentation link, not a secret). Even if a loader tried to attach a raw value, the
    // type + this shape would keep it out of the wire payload.
    const problem = configProblem(PROBLEMS[0]!).problems[0]!
    expect(Object.keys(problem).sort()).toEqual(['docsUrl', 'key', 'remedy', 'summary'])
  })
})
