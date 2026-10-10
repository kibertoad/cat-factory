import { describe, expect, it } from 'vitest'
import {
  CORS_ALLOWED_HEADERS,
  corsOriginFor,
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

describe('corsOriginFor', () => {
  // The credential-free MCP discovery and authorization paths answer ANY browser origin, and the
  // rule lives in the shared CORS layer rather than on a handler because the browser asks first: a
  // `POST /oauth/register` carrying JSON is preflighted, and a preflight is answered before any
  // route runs. That is the shape a per-handler header had, and it read as working, because
  // discovery is a plain GET nobody preflights.

  it('answers any origin on the paths a host reaches before it has a credential', () => {
    // Production settings: an allowlist naming somebody else, and no reflection.
    const denied = ['https://a.example', false] as const
    for (const path of [
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/api/v1/mcp',
      '/.well-known/oauth-authorization-server',
      '/oauth/register',
      '/oauth/token',
      '/oauth/authorize',
    ]) {
      expect(corsOriginFor(path, 'https://claude.ai', ...denied), path).toBe('https://claude.ai')
    }
  })

  it('leaves every other path on the deployment allowlist', () => {
    // Including the surfaces a host reaches AFTER it has one: the exemption is about having no
    // credential yet, so it ends where the credential begins.
    expect(corsOriginFor('/api/v1/mcp', 'https://claude.ai', 'https://a.example', false)).toBeNull()
    expect(
      corsOriginFor('/workspaces/ws_1', 'https://evil.example', 'https://a.example'),
    ).toBeNull()
    expect(corsOriginFor('/api/v1/runs', 'https://a.example', 'https://a.example')).toBe(
      'https://a.example',
    )
  })

  it('does not treat a path that merely starts with the same letters as public', () => {
    // Prefix matching is on SEGMENTS: `/oauthorized` is not `/oauth`, and a sibling route mounted
    // later must not inherit the exemption by spelling.
    expect(corsOriginFor('/oauthorized', 'https://evil.example', 'https://a.example')).toBeNull()
    expect(
      corsOriginFor('/.well-known-other', 'https://evil.example', 'https://a.example'),
    ).toBeNull()
  })

  it('omits the header for a caller with no Origin at all', () => {
    // A non-browser client (every server-side host) is not a CORS case, on a public path or not.
    expect(corsOriginFor('/oauth/token', undefined, 'https://a.example')).toBeNull()
  })
})
