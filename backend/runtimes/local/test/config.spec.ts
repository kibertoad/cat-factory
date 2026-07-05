import { corsReflectsWhenUnset } from '@cat-factory/server'
import { describe, expect, it } from 'vitest'
import { applyLocalDefaults } from '../src/config.js'

// Local mode REQUIRES the two crypto secrets (AUTH_SESSION_SECRET, ENCRYPTION_KEY) — they must
// stay stable across restarts (a fresh session secret invalidates the persisted session and
// forces a re-login; a fresh encryption key orphans credentials sealed at rest), so the loader
// throws loudly when either is missing instead of auto-generating an unstable per-process value.
// A complete set of secrets to satisfy the happy-path cases.
const SECRETS = {
  AUTH_SESSION_SECRET: 'a'.repeat(64),
  ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
}

describe('[local] applyLocalDefaults secrets', () => {
  it('passes the configured secrets through unchanged', () => {
    const env = applyLocalDefaults({ ...SECRETS })
    expect(env.AUTH_SESSION_SECRET).toBe(SECRETS.AUTH_SESSION_SECRET)
    expect(env.ENCRYPTION_KEY).toBe(SECRETS.ENCRYPTION_KEY)
  })

  it('throws when AUTH_SESSION_SECRET is missing', () => {
    expect(() => applyLocalDefaults({ ENCRYPTION_KEY: SECRETS.ENCRYPTION_KEY })).toThrow(
      /AUTH_SESSION_SECRET is required/,
    )
  })

  it('throws when ENCRYPTION_KEY is missing', () => {
    expect(() => applyLocalDefaults({ AUTH_SESSION_SECRET: SECRETS.AUTH_SESSION_SECRET })).toThrow(
      /ENCRYPTION_KEY is required/,
    )
  })

  it('treats a blank secret as missing', () => {
    expect(() => applyLocalDefaults({ ...SECRETS, AUTH_SESSION_SECRET: '   ' })).toThrow(
      /AUTH_SESSION_SECRET is required/,
    )
  })

  it('rejects a too-short AUTH_SESSION_SECRET (local mode defaults the gate open)', () => {
    expect(() => applyLocalDefaults({ ...SECRETS, AUTH_SESSION_SECRET: 'short' })).toThrow(
      /at least 32 characters/,
    )
    // Exactly 32 is accepted.
    expect(() =>
      applyLocalDefaults({ ...SECRETS, AUTH_SESSION_SECRET: 'a'.repeat(32) }),
    ).not.toThrow()
  })

  it('rejects an ENCRYPTION_KEY that decodes to fewer than 32 bytes', () => {
    expect(() =>
      applyLocalDefaults({ ...SECRETS, ENCRYPTION_KEY: Buffer.alloc(16).toString('base64') }),
    ).toThrow(/at least 32 bytes/)
  })

  it('rejects an ENCRYPTION_KEY that is not valid base64', () => {
    expect(() => applyLocalDefaults({ ...SECRETS, ENCRYPTION_KEY: '%%%not-base64%%%' })).toThrow(
      /valid base64/,
    )
  })
})

describe('[local] applyLocalDefaults CORS / ENVIRONMENT', () => {
  it('defaults ENVIRONMENT to `local` so an unset CORS allow-list reflects the SPA origin', () => {
    const env = applyLocalDefaults({ ...SECRETS })
    // `local` is a recognised development value, so `corsReflectsWhenUnset` is true and the
    // server reflects the requesting origin instead of default-denying — no manual
    // CORS_ALLOWED_ORIGINS needed for the local SPA.
    expect(env.ENVIRONMENT).toBe('local')
    expect(corsReflectsWhenUnset(env.ENVIRONMENT)).toBe(true)
  })

  it('honours an explicit ENVIRONMENT (explicit wins)', () => {
    const env = applyLocalDefaults({ ...SECRETS, ENVIRONMENT: 'staging' })
    expect(env.ENVIRONMENT).toBe('staging')
  })

  it('leaves an explicit CORS_ALLOWED_ORIGINS untouched', () => {
    const env = applyLocalDefaults({ ...SECRETS, CORS_ALLOWED_ORIGINS: 'http://localhost:4000' })
    expect(env.CORS_ALLOWED_ORIGINS).toBe('http://localhost:4000')
  })
})

describe('[local] applyLocalDefaults web search', () => {
  it('defaults WEB_SEARCH_SEARXNG_URL to the local SearXNG on by default', () => {
    const env = applyLocalDefaults({ ...SECRETS })
    expect(env.WEB_SEARCH_SEARXNG_URL).toBe('http://localhost:8080')
  })

  it('honours an explicit WEB_SEARCH_SEARXNG_URL (idempotent — explicit wins)', () => {
    const env = applyLocalDefaults({ ...SECRETS, WEB_SEARCH_SEARXNG_URL: 'http://searxng:9000' })
    expect(env.WEB_SEARCH_SEARXNG_URL).toBe('http://searxng:9000')
  })

  it('omits the default when LOCAL_WEB_SEARCH is an off-value', () => {
    for (const off of ['off', 'false', '0', 'no', 'none', 'disabled']) {
      const env = applyLocalDefaults({ ...SECRETS, LOCAL_WEB_SEARCH: off })
      expect(env.WEB_SEARCH_SEARXNG_URL).toBeUndefined()
    }
  })

  it('still passes an explicit URL through even when the default is disabled', () => {
    // Disabling only skips the DEFAULT; an operator who set the URL explicitly keeps it.
    const env = applyLocalDefaults({
      ...SECRETS,
      LOCAL_WEB_SEARCH: 'off',
      WEB_SEARCH_SEARXNG_URL: 'http://searxng:9000',
    })
    expect(env.WEB_SEARCH_SEARXNG_URL).toBe('http://searxng:9000')
  })
})
