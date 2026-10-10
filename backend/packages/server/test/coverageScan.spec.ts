import { describe, expect, it } from 'vitest'
import { stripComments } from './coverageScan.js'

// The coverage specs assert that a file PASSES a literal. `stripComments` is what makes that
// assertion mean something other than "the file mentions the literal somewhere", so its own
// behaviour is pinned here: a guard whose reading of the source is wrong fails in the same silent
// direction as the bugs it was written to catch.

describe('stripComments', () => {
  it('drops a line comment and keeps the code beside it', () => {
    const code = stripComments("start(x, { intakeOrigin: 'tracker' }) // intakeOrigin: 'schedule'")
    expect(code).toContain("intakeOrigin: 'tracker'")
    expect(code).not.toContain("'schedule'")
  })

  it('drops a JSDoc block that names the very literal the call site must pass', () => {
    // Verbatim the shape that defeated the first version of `intakeOrigin.coverage.spec.ts`.
    const source = [
      '/**',
      " *  - **`intakeOrigin: 'tracker'`**, the question the clarification loop asks.",
      ' */',
      'async firePerTicket() {',
      '  await this.executionService.start(ws, id, pid, { initiatedBy: null })',
      '}',
    ].join('\n')
    expect(stripComments(source)).not.toContain('intakeOrigin')
  })

  it('leaves a `//` inside a string literal alone', () => {
    const code = stripComments("const u = 'https://example.test/x'; const o = { a: 1 }")
    expect(code).toContain("'https://example.test/x'")
    expect(code).toContain('{ a: 1 }')
  })

  it('keeps an escaped quote from ending a string early', () => {
    const code = stripComments("const s = 'it\\'s fine' // gone\nconst t = 2")
    expect(code).toContain("'it\\'s fine'")
    expect(code).not.toContain('gone')
    expect(code).toContain('const t = 2')
  })

  it('strips a comment inside a template interpolation but not the template text', () => {
    const code = stripComments('const s = `a // b ${x /* gone */ + 1} c`')
    expect(code).toContain('a // b ')
    expect(code).toContain('c`')
    expect(code).not.toContain('gone')
  })

  it('returns to code after a template closes, so a later comment still goes', () => {
    const code = stripComments('const s = `t` // dropped\nconst n = 1')
    expect(code).not.toContain('dropped')
    expect(code).toContain('const n = 1')
  })

  it('separates the tokens a block comment sat between', () => {
    expect(stripComments('a/* x */b')).toBe('a b')
  })

  it('survives an unterminated block comment without swallowing the rest as code', () => {
    expect(stripComments('const a = 1\n/* never closed')).toBe('const a = 1\n ')
  })
})
