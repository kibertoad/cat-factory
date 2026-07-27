import { describe, expect, it } from 'vitest'
import {
  balanceFences,
  capList,
  cell,
  inline,
  MAX_CELL_CHARS,
  MAX_LIST_ITEMS,
  MAX_PROSE_CHARS,
  prose,
} from './host-markdown.logic.js'

// The hazards below are not theoretical: a task title, a tester summary and a provisioner's
// stderr all reach the PR body verbatim, and the host acts on what it finds there.

describe('inert text', () => {
  it('defuses an @mention so the report cannot notify a real account', () => {
    expect(inline('cc @octocat please')).toBe('cc &#64;octocat please')
  })

  it('defuses a #issue reference so the report cannot cross-link an unrelated issue', () => {
    expect(inline('see #42')).toBe('see &#35;42')
  })

  it("defuses a closing keyword so merging the PR cannot close someone else's issue", () => {
    // `closes #42` in a PR BODY closes issue 42 on merge — the escape above already breaks the
    // `#N` form; this is the URL form, where nothing in the reference itself is escapable.
    const out = inline('This closes https://github.com/acme/api/issues/42 as well')
    expect(out).not.toMatch(/\bcloses\s+https/i)
    expect(out).toContain('&#99;loses https://github.com/acme/api/issues/42')
  })

  it('leaves an ordinary # or @ that is not a reference alone', () => {
    expect(inline('grade A# and email a@ b')).toBe('grade A# and email a@ b')
  })

  it('leaves inline code spans alone (the host does not auto-link inside them)', () => {
    // Escaping here would show the reader a literal `&#35;` instead of the shebang.
    expect(inline('use `#!/bin/sh` here')).toBe('use `#!/bin/sh` here')
  })
})

describe('cell', () => {
  it('escapes a pipe so a value cannot open a new column', () => {
    expect(cell('a|b')).toBe('a\\|b')
  })

  it('folds newlines so a multi-line value cannot terminate the table row', () => {
    // A raw newline ends the row and spills the rest into the document as loose prose — the
    // exact way a multi-line deploy error used to shred the environments table.
    expect(cell('deploy failed:\nline two\nline three')).toBe(
      'deploy failed:<br>line two<br>line three',
    )
  })

  it('caps a runaway value', () => {
    const out = cell('x'.repeat(MAX_CELL_CHARS * 3))
    expect(out.length).toBeLessThan(MAX_CELL_CHARS + 60)
    expect(out).toContain('truncated')
  })
})

describe('prose', () => {
  it('closes a code fence the agent left open', () => {
    // An unbalanced fence would otherwise swallow every section rendered after it — including
    // the fenced JSON block that IS the report's machine-readable contract.
    const out = prose('output was:\n```\nnpm test')
    expect(balanceFences(out)).toBe(out)
    expect(out.split('\n').filter((l) => l.startsWith('```'))).toHaveLength(2)
  })

  it('leaves a balanced fence — and its contents — exactly as written', () => {
    const input = 'Ran:\n```sh\nnpm test --grep "#42"\n```\nAll good.'
    expect(prose(input)).toBe(input)
  })

  it('still defuses references outside the fence', () => {
    const out = prose('```\n#42\n```\nfixes #7')
    expect(out).toContain('#42') // inside the fence: untouched
    expect(out).toContain('&#35;7') // outside: defused
  })

  it('caps and closes a fence left open by the cut', () => {
    const out = prose(`\`\`\`\n${'x'.repeat(MAX_PROSE_CHARS * 2)}`)
    expect(out.length).toBeLessThan(MAX_PROSE_CHARS + 200)
    expect(balanceFences(out)).toBe(out)
  })

  it('normalises CRLF so a Windows-authored summary renders as written', () => {
    expect(prose('one\r\ntwo')).toBe('one\ntwo')
  })
})

describe('capList', () => {
  it('reports what it dropped rather than shortening silently', () => {
    const { items, dropped } = capList(Array.from({ length: MAX_LIST_ITEMS + 12 }, (_, i) => i))
    expect(items).toHaveLength(MAX_LIST_ITEMS)
    expect(dropped).toBe(12)
  })

  it('passes a list within budget through untouched', () => {
    expect(capList([1, 2, 3])).toEqual({ items: [1, 2, 3], dropped: 0 })
  })
})
