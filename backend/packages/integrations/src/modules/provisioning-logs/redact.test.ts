import { describe, expect, it } from 'vitest'
import { redactSecrets } from './redact.js'

describe('redactSecrets', () => {
  it('passes through null/empty and credential-free strings unchanged', () => {
    expect(redactSecrets(null)).toBeNull()
    expect(redactSecrets('')).toBe('')
    const clean = 'Container dispatch failed (HTTP 503): no capacity in region us-east'
    expect(redactSecrets(clean)).toBe(clean)
  })

  it('redacts bearer / authorization header echoes but keeps the scheme', () => {
    expect(redactSecrets('401: Authorization: Bearer sk-abcdef0123456789abcd')).not.toContain(
      'sk-abcdef0123456789abcd',
    )
    const out = redactSecrets(
      'request failed with Bearer ghp_0123456789abcdef0123456789abcdef0123',
    )!
    expect(out).toContain('Bearer')
    expect(out).toContain('[REDACTED]')
    expect(out).not.toContain('ghp_0123456789abcdef0123456789abcdef0123')
  })

  it('redacts credentials embedded in a URL but keeps host', () => {
    const out = redactSecrets(
      'fatal: could not push to https://x-access-token:ghs_secrettoken123456@github.com/o/r',
    )!
    expect(out).toContain('github.com/o/r')
    expect(out).toContain('[REDACTED]')
    expect(out).not.toContain('ghs_secrettoken123456')
  })

  it('redacts secret-ish query/JSON params, keeping the key name', () => {
    const out = redactSecrets('GET /v1/models?api_key=abcd1234efgh5678 → 403')!
    expect(out).toContain('api_key')
    expect(out).toContain('[REDACTED]')
    expect(out).not.toContain('abcd1234efgh5678')
    const json = redactSecrets('{"error":"bad","token":"t0psecretvalue123"}')!
    expect(json).toContain('"token"')
    expect(json).not.toContain('t0psecretvalue123')
  })

  it('redacts recognisable standalone token shapes (sk-/ghp_/AKIA/JWT)', () => {
    expect(redactSecrets('key sk-ABCDEFGHIJKLMNOP01234')).not.toContain('sk-ABCDEFGHIJKLMNOP01234')
    expect(redactSecrets('aws AKIAIOSFODNN7EXAMPLE denied')).not.toContain('AKIAIOSFODNN7EXAMPLE')
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc-DEF_123'
    expect(redactSecrets(`token ${jwt} expired`)).not.toContain(jwt)
  })
})
