import { describe, expect, it } from 'vitest'
import { describeThrown, scrubbed, shellQuoted } from '../src/operatorText.ts'

// Three one-liners, and each is pinned here because each has exactly one edge case that undoes the
// point of it: a chain with nothing to say, a URL carrying a credential, and a value holding the
// quote the command is built with.

describe('describeThrown', () => {
  it('reads the WHOLE chain, not the outermost link', () => {
    // The reason nothing in this package rolls its own describer: on Node the outermost link of a
    // transport failure is the contentless `fetch failed`.
    const error = new TypeError('fetch failed', {
      cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8787'), {
        code: 'ECONNREFUSED',
      }),
    })
    expect(describeThrown(error)).toContain('connect ECONNREFUSED 127.0.0.1:8787')
  })

  it('names the absence for a chain that said nothing, rather than rendering empty', () => {
    // `getErrorMessage` answers EMPTY for an error with nothing to say, deliberately, so that a
    // call site's fallback stays reachable. Interpolated bare, that renders `(…)` around nothing.
    expect(describeThrown(new Error(''))).toBe('no reason reported')
  })

  it('reports a non-Error throw as itself, which is a fact worth having', () => {
    expect(describeThrown('the pool is closed')).toBe('the pool is closed')
    expect(describeThrown(null)).toBe('null')
  })
})

describe('scrubbed', () => {
  it('removes a credential a base URL legitimately carries', () => {
    expect(scrubbed('https://svc:hunter2@backend.example.com')).toBe(
      'https://svc:[REDACTED]@backend.example.com',
    )
  })

  it('leaves an ordinary address exactly as it was typed', () => {
    expect(scrubbed('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787')
  })
})

describe('shellQuoted', () => {
  it('quotes as one word, so a path with a space stays one argument', () => {
    expect(shellQuoted('http://127.0.0.1:8787/a b')).toBe(`'http://127.0.0.1:8787/a b'`)
  })

  it('survives the quote it is built with, which would otherwise break the command', () => {
    // POSIX has no escape inside single quotes, so the closing quote is the escape. A remedy whose
    // command does not parse is worse than one with no command: it is offered as the thing to run.
    expect(shellQuoted("it's")).toBe(`'it'\\''s'`)
  })

  it('scrubs as well as quotes, since these commands are printed beside the steps', () => {
    expect(shellQuoted('https://svc:hunter2@backend.example.com/health')).toBe(
      `'https://svc:[REDACTED]@backend.example.com/health'`,
    )
  })
})
