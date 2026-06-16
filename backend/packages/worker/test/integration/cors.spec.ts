import { describe, expect, it } from 'vitest'
import { parseAllowedOrigins, resolveCorsOrigin } from '../../src/infrastructure/config/cors'

describe('resolveCorsOrigin', () => {
  const FRONTEND = 'https://catfactory.kiberion.com'
  const OTHER = 'https://evil.example.com'

  it('echoes any origin when the allowlist is unset (zero-config provisioning)', () => {
    expect(resolveCorsOrigin(FRONTEND, undefined)).toBe(FRONTEND)
    expect(resolveCorsOrigin(OTHER, '')).toBe(OTHER)
  })

  it('echoes any origin when the allowlist is "*"', () => {
    expect(resolveCorsOrigin(OTHER, '*')).toBe(OTHER)
    expect(resolveCorsOrigin(FRONTEND, ' * ')).toBe(FRONTEND)
  })

  it('echoes only listed origins when an allowlist is configured', () => {
    const configured = `${FRONTEND}, https://staging.example.com`
    expect(resolveCorsOrigin(FRONTEND, configured)).toBe(FRONTEND)
    expect(resolveCorsOrigin('https://staging.example.com', configured)).toBe(
      'https://staging.example.com',
    )
    expect(resolveCorsOrigin(OTHER, configured)).toBeNull()
  })

  it('omits the header for non-browser callers (no Origin)', () => {
    expect(resolveCorsOrigin(undefined, FRONTEND)).toBeNull()
    expect(resolveCorsOrigin(null, undefined)).toBeNull()
  })

  it('parses comma-separated origins, trimming blanks', () => {
    expect(parseAllowedOrigins(' a , , b ,c ')).toEqual(['a', 'b', 'c'])
    expect(parseAllowedOrigins(undefined)).toEqual([])
  })
})
