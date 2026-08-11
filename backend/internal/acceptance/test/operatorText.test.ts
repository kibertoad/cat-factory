import { describe, expect, it } from 'vitest'
import {
  describeThrown,
  perPersonPrefixInvocation,
  resumeInvocation,
  scrubbed,
  shellQuoted,
} from '../src/operatorText.ts'

// Each of these is pinned here because each has exactly one edge case that undoes the point of it: a
// chain with nothing to say, a URL carrying a credential, a value holding the quote the command is
// built with, and a command printed in a shell that cannot parse it.

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

// Both of these render a command for the shell that will RECEIVE it. Asserted per platform rather
// than against `process.platform`, so the Windows form is covered by the Linux CI lane that would
// otherwise never see it, and the POSIX form stays covered when the suite is run from Windows.
describe('resumeInvocation', () => {
  it('carries the id as an inline prefix on POSIX', () => {
    expect(resumeInvocation('20260809175530', 'linux')).toBe(
      `ACCEPTANCE_RUN_ID='20260809175530' pnpm --filter @cat-factory/acceptance run acceptance`,
    )
  })

  it('assigns before the command on Windows, where an inline prefix is not a command at all', () => {
    // PowerShell reads `ACCEPTANCE_RUN_ID=latest pnpm …` as the name of a command to look up and
    // answers CommandNotFoundException, so the POSIX form is a remedy that cannot be pasted.
    expect(resumeInvocation('latest', 'win32')).toBe(
      `$env:ACCEPTANCE_RUN_ID = 'latest'; pnpm --filter @cat-factory/acceptance run acceptance`,
    )
  })

  it('separates the assignment with `;`, since PowerShell 5.1 cannot parse `&&`', () => {
    expect(resumeInvocation('latest', 'win32')).not.toContain('&&')
  })

  it('quotes each shell the way that shell escapes, for an id holding a quote', () => {
    // Neither dialect escapes inside single quotes: POSIX ends and reopens them, PowerShell doubles
    // the quote. A run id should never hold one, which is exactly why nothing would catch this.
    expect(resumeInvocation("it's", 'linux')).toContain(`ACCEPTANCE_RUN_ID='it'\\''s'`)
    expect(resumeInvocation("it's", 'win32')).toContain(`$env:ACCEPTANCE_RUN_ID = 'it''s'`)
  })
})

describe('perPersonPrefixInvocation', () => {
  it('substitutes the username the way each shell spells it', () => {
    expect(perPersonPrefixInvocation('cf-acc', 'linux')).toBe(
      'export ACCEPTANCE_NAME_PREFIX="cf-acc-$(whoami)"',
    )
    expect(perPersonPrefixInvocation('cf-acc', 'win32')).toBe(
      '$env:ACCEPTANCE_NAME_PREFIX = "cf-acc-$env:USERNAME"',
    )
  })
})
