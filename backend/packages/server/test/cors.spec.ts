import { describe, expect, it } from 'vitest'
import { corsReflectsWhenUnset, parseAllowedOrigins, resolveCorsOrigin } from '../src/http/cors.js'

describe('parseAllowedOrigins', () => {
  it('splits, trims and drops empties', () => {
    expect(parseAllowedOrigins(' https://a.com , https://b.com ,, ')).toEqual([
      'https://a.com',
      'https://b.com',
    ])
    expect(parseAllowedOrigins(undefined)).toEqual([])
    expect(parseAllowedOrigins('')).toEqual([])
  })
})

describe('resolveCorsOrigin', () => {
  it('omits the header for a non-browser caller (no Origin)', () => {
    expect(resolveCorsOrigin(null, 'https://a.com')).toBeNull()
    expect(resolveCorsOrigin(undefined, undefined)).toBeNull()
  })

  it('echoes any origin for an explicit wildcard, regardless of environment', () => {
    expect(resolveCorsOrigin('https://x.com', '*')).toBe('https://x.com')
    expect(resolveCorsOrigin('https://x.com', 'https://a.com,*')).toBe('https://x.com')
    expect(resolveCorsOrigin('https://x.com', '*', false)).toBe('https://x.com')
  })

  it('reflects an unset allowlist only when reflectWhenUnset (non-production)', () => {
    // Default (dev) reflects; production (reflectWhenUnset=false) default-denies.
    expect(resolveCorsOrigin('https://x.com', undefined)).toBe('https://x.com')
    expect(resolveCorsOrigin('https://x.com', undefined, true)).toBe('https://x.com')
    expect(resolveCorsOrigin('https://x.com', undefined, false)).toBeNull()
    expect(resolveCorsOrigin('https://x.com', '', false)).toBeNull()
  })

  it('echoes only an explicitly-listed origin otherwise', () => {
    expect(resolveCorsOrigin('https://a.com', 'https://a.com,https://b.com')).toBe('https://a.com')
    expect(resolveCorsOrigin('https://evil.com', 'https://a.com,https://b.com')).toBeNull()
    // A configured allowlist is enforced even in a "reflect when unset" (dev) context.
    expect(resolveCorsOrigin('https://evil.com', 'https://a.com', true)).toBeNull()
  })
})

describe('corsReflectsWhenUnset', () => {
  it('reflects ONLY for explicitly-recognised development environments', () => {
    for (const dev of ['test', 'dev', 'development', 'local', 'testing', 'e2e', 'DEV', ' Test ']) {
      expect(corsReflectsWhenUnset(dev), dev).toBe(true)
    }
    // Unset, unknown, and production all default-deny (fail safe): a deployment that sets
    // neither ENVIRONMENT nor CORS_ALLOWED_ORIGINS must NOT reflect an arbitrary origin.
    for (const nonDev of ['', undefined, 'production', 'prod', 'staging', 'PROD', 'unknown']) {
      expect(corsReflectsWhenUnset(nonDev), String(nonDev)).toBe(false)
    }
  })
})
