import * as v from 'valibot'
import { describe, expect, it } from 'vitest'
import {
  createHeadlessPublicApiKeySchema,
  publicApiExternalIdentitySchema,
} from './public-api-keys.js'

// The headless mint body. What is worth pinning is the ONE field with a rule a caller can trip
// over: `externalIdentity` is opaque, so validation is the only thing standing between an
// integrator's text and every surface that later echoes it.

// Two doors on purpose. `accepted` PARSES, so a success case reads the value off a typed output
// instead of narrowing a `safeParse` union at every assertion (which is what made this file fail
// `tsc` while passing vitest: on the failure arm of that union `output` is not the body's shape).
// `admits` only ever asks the boolean, which is the whole question a refusal case has.
const accepted = (body: unknown) => v.parse(createHeadlessPublicApiKeySchema, body)
const admits = (body: unknown) => v.safeParse(createHeadlessPublicApiKeySchema, body).success

describe('createHeadlessPublicApiKeySchema.externalIdentity', () => {
  it('takes the shapes an external system actually sends, and is optional', () => {
    for (const identity of ['os-user:42', 'ada@example.com', 'tenant/7#svc', 'ある人']) {
      expect(accepted({ label: 'k', externalIdentity: identity }).externalIdentity).toBe(identity)
    }
    // Absent is the common case (a key that acts for the integration itself), and it stays
    // absent rather than acquiring a default: only a caller can name an identity we cannot
    // resolve.
    expect(accepted({ label: 'k' }).externalIdentity).toBeUndefined()
  })

  it('refuses a break the surfaces that echo it would render', () => {
    // A newline, a CRLF, a NUL, a DEL, and the exotic breaks. Each is a value an integrator could
    // send by accident (an unstripped line off a file or a header) and each would land in a log
    // line or a table row the platform composes downstream.
    //
    // The C1 block is walked in FULL rather than sampled at U+0085 (NEL), because C1 is the half
    // of the rule an enumerated class silently loses: every member here was accepted, stored and
    // echoed while the message beside the schema said it was refused as a control character.
    const c1 = Array.from({ length: 0x20 }, (_, i) => String.fromCharCode(0x80 + i))
    for (const bad of [
      'a\nb',
      'a\r\nb',
      'a\u0000b',
      'a\u001fb',
      'a\u007fb',
      'a\u2028b',
      'a\u2029b',
      ...c1.map((ch) => `a${ch}b`),
    ]) {
      expect(admits({ label: 'k', externalIdentity: bad })).toBe(false)
    }
  })

  it('keeps the published pattern portable to the flavours the SDKs are generated for', () => {
    // The `pattern` this schema emits into `docs/openapi.json` is fed to third-party codegen and
    // validators, and Go's RE2 and PCRE both REJECT a `\uHHHH` escape outright rather than
    // mis-parsing it, so shipping one breaks a consumer's whole client rather than one field.
    // Asserted on the regex SOURCE, which is the string that ships, and derived from the schema
    // itself so a future member cannot be added in the unportable spelling without failing here.
    // The pipe's `regex` action is the only member that becomes a wire `pattern`, so read the
    // class off the schema rather than restating it: this pins what SHIPS, not a copy of it.
    const patterns = publicApiExternalIdentitySchema.pipe
      .filter((action) => action.type === 'regex')
      .map((action) => action.requirement.source)
    expect(patterns).toHaveLength(1)
    for (const pattern of patterns) {
      expect(pattern).not.toMatch(/\\u/)
      expect(pattern).not.toMatch(/\\p\{/)
      // Positive half: the class is spelled the way every flavour reads, and it is the C1 range
      // (not one sampled member) that the enumerated spelling used to lose.
      expect(pattern).toContain('\\x80-\\x9f')
    }
  })

  it('refuses an empty or over-long identity, trimming first', () => {
    // Trimmed before the length checks, so whitespace alone is the empty string it really is
    // rather than a stored identity that renders as nothing.
    expect(admits({ label: 'k', externalIdentity: '   ' })).toBe(false)
    expect(admits({ label: 'k', externalIdentity: '' })).toBe(false)
    expect(admits({ label: 'k', externalIdentity: `  ${'x'.repeat(200)}  ` })).toBe(true)
    expect(admits({ label: 'k', externalIdentity: 'x'.repeat(201) })).toBe(false)
  })

  it('still refuses the `admin` rung beside it', () => {
    // The new field must not have widened the body: the mint chain stays one link long.
    expect(admits({ label: 'k', scope: 'admin', externalIdentity: 'os-user:42' })).toBe(false)
  })
})
