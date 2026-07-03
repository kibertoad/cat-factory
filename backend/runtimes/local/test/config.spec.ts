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
