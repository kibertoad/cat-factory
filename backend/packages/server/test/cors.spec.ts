import { describe, expect, it } from 'vitest'
import { parseAllowedOrigins, resolveCorsOrigin } from '../src/http/cors.js'

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

  it('echoes any origin when the allowlist is empty or a wildcard', () => {
    expect(resolveCorsOrigin('https://x.com', undefined)).toBe('https://x.com')
    expect(resolveCorsOrigin('https://x.com', '*')).toBe('https://x.com')
    expect(resolveCorsOrigin('https://x.com', 'https://a.com,*')).toBe('https://x.com')
  })

  it('echoes only an explicitly-listed origin otherwise', () => {
    expect(resolveCorsOrigin('https://a.com', 'https://a.com,https://b.com')).toBe('https://a.com')
    expect(resolveCorsOrigin('https://evil.com', 'https://a.com,https://b.com')).toBeNull()
  })
})
