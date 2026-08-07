import * as v from 'valibot'
import { describe, expect, it } from 'vitest'
import { createHeadlessPublicApiKeySchema } from './public-api-keys.js'

// The headless mint body. What is worth pinning is the ONE field with a rule a caller can trip
// over: `externalIdentity` is opaque, so validation is the only thing standing between an
// integrator's text and every surface that later echoes it.

const parse = (body: unknown) => v.safeParse(createHeadlessPublicApiKeySchema, body)

describe('createHeadlessPublicApiKeySchema.externalIdentity', () => {
  it('takes the shapes an external system actually sends, and is optional', () => {
    for (const identity of ['os-user:42', 'ada@example.com', 'tenant/7#svc', 'ある人']) {
      const result = parse({ label: 'k', externalIdentity: identity })
      expect(result.success).toBe(true)
      expect(result.output?.externalIdentity).toBe(identity)
    }
    // Absent is the common case (a key that acts for the integration itself), and it stays
    // absent rather than acquiring a default: only a caller can name an identity we cannot
    // resolve.
    const omitted = parse({ label: 'k' })
    expect(omitted.success).toBe(true)
    expect(omitted.output?.externalIdentity).toBeUndefined()
  })

  it('refuses a break the surfaces that echo it would render', () => {
    // A newline, a CRLF, a NUL, a DEL, and the three exotic breaks. Each is a value an
    // integrator could send by accident (an unstripped line off a file or a header) and each
    // would land in a log line or a table row the platform composes downstream.
    for (const bad of [
      'a\nb',
      'a\r\nb',
      'a\u0000b',
      'a\u007fb',
      'a\u0085b',
      'a\u2028b',
      'a\u2029b',
    ]) {
      expect(parse({ label: 'k', externalIdentity: bad }).success).toBe(false)
    }
  })

  it('refuses an empty or over-long identity, trimming first', () => {
    // Trimmed before the length checks, so whitespace alone is the empty string it really is
    // rather than a stored identity that renders as nothing.
    expect(parse({ label: 'k', externalIdentity: '   ' }).success).toBe(false)
    expect(parse({ label: 'k', externalIdentity: '' }).success).toBe(false)
    expect(parse({ label: 'k', externalIdentity: `  ${'x'.repeat(200)}  ` }).success).toBe(true)
    expect(parse({ label: 'k', externalIdentity: 'x'.repeat(201) }).success).toBe(false)
  })

  it('still refuses the `admin` rung beside it', () => {
    // The new field must not have widened the body: the mint chain stays one link long.
    expect(parse({ label: 'k', scope: 'admin', externalIdentity: 'os-user:42' }).success).toBe(
      false,
    )
  })
})
