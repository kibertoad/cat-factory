import { describe, expect, it } from 'vitest'
import {
  CORS_ALLOWED_HEADERS,
  corsReflectsWhenUnset,
  parseAllowedOrigins,
  resolveCorsOrigin,
} from '../src/http/cors.js'

describe('CORS_ALLOWED_HEADERS', () => {
  it('carries every header a cross-origin client of this backend actually sends', () => {
    // Pinned as a SET rather than by membership: a header dropped from here fails in the browser
    // only, on one client, with a message that names CORS rather than the request that broke — so
    // the list is worth a test that refuses a silent removal.
    expect([...CORS_ALLOWED_HEADERS].sort()).toEqual([
      'Authorization',
      'Content-Type',
      'Mcp-Protocol-Version',
      'X-Connection-Id',
      'X-Personal-Password',
      'X-Request-Id',
    ])
  })

  it('admits the MCP protocol header, which arrives only AFTER a successful handshake', () => {
    // The failure this prevents is the confusing one: a Streamable HTTP client sends no
    // `Mcp-Protocol-Version` on `initialize` and one on everything after it, so an endpoint missing
    // it from the allow-list negotiates perfectly from a browser origin and then has every real
    // call dropped. Matched case-insensitively because that is how a preflight compares.
    const lowered = CORS_ALLOWED_HEADERS.map((header) => header.toLowerCase())
    expect(lowered).toContain('mcp-protocol-version')
    // …and the session header is deliberately absent: the hosted endpoint is stateless and mints no
    // session id, so a client never holds one to send back. Listing it would advertise a mode that
    // does not exist.
    expect(lowered).not.toContain('mcp-session-id')
  })
})

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
