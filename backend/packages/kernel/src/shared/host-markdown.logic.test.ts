import { describe, expect, it } from 'vitest'
import {
  balanceFences,
  boundOutput,
  capList,
  cell,
  cellLink,
  codeCell,
  dropOpenFence,
  inline,
  inlineCode,
  link,
  MAX_CELL_CHARS,
  MAX_LIST_ITEMS,
  MAX_PROSE_CHARS,
  outputBlock,
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

// The CAPTURED-OUTPUT helpers. What these assert is one property in four spellings: a log that
// the platform did not write cannot escape the container the platform put it in. A test runner,
// a linter and a compiler all print backticks as a matter of course, so every one of these was
// a real spill waiting on the right assertion message.

describe('outputBlock', () => {
  it('sizes the fence past the longest backtick run the output carries', () => {
    // A fixed ``` fence closes on the log's own run, spilling the rest of the log, every section
    // rendered below it, and the machine-readable JSON block into the body as prose.
    const block = outputBlock('error in ```const x = 1``` at line 3')
    expect(block.startsWith('````\n')).toBe(true)
    expect(block.endsWith('\n````')).toBe(true)
    // The whole log survives inside the block rather than half of it becoming markdown.
    expect(block).toContain('```const x = 1```')
  })

  it('stays ahead of a run longer than the fence it would normally use', () => {
    const block = outputBlock('a `````` b')
    expect(block.split('\n')[0]).toBe('```````')
  })

  it('opens and closes with the same fence when the output has no backticks at all', () => {
    expect(outputBlock('plain failure')).toBe('```\nplain failure\n```')
  })

  it('normalises CRLF and drops trailing blank lines so the closer sits tight', () => {
    expect(outputBlock('one\r\ntwo\n\n\n')).toBe('```\none\ntwo\n```')
  })
})

describe('boundOutput', () => {
  it('keeps the END of a long log, where the failure is actually reported', () => {
    const text = `${'x'.repeat(50)}THE ASSERTION`
    const bounded = boundOutput(text, 20)
    // A prefix cut would discard exactly the half a reviewer opened the report for.
    expect(bounded.text.endsWith('THE ASSERTION')).toBe(true)
    expect(bounded.text).toHaveLength(20)
    expect(bounded).toMatchObject({ dropped: text.length - 20, total: text.length })
  })

  it('reports a clean zero for a log already inside the budget', () => {
    expect(boundOutput('short', 20)).toEqual({ text: 'short', dropped: 0, total: 5 })
  })

  it('treats a log exactly at the budget as uncut', () => {
    expect(boundOutput('12345', 5).dropped).toBe(0)
  })
})

describe('codeCell / inlineCode', () => {
  it('sizes the span past a backtick the value carries', () => {
    // The inline twin of the fence hazard: a hand-written `` `${cell(v)}` `` closes early and
    // spills the tail into the row as prose, where the auto-link triggers are live again.
    expect(inlineCode('pnpm why `pkg`')).toBe('`` pnpm why `pkg` ``')
  })

  it('pads BOTH sides when a value touches a backtick, since one side alone is not stripped', () => {
    // CommonMark removes a single leading and trailing space only when the span has both, so a
    // one-sided pad would reach the reader as a visible space.
    expect(inlineCode('`quoted`')).toBe('`` `quoted` ``')
    expect(inlineCode('trailing`')).toBe('`` trailing` ``')
    expect(inlineCode('no ticks')).toBe('`no ticks`')
  })

  it('escapes a pipe for a TABLE cell but not outside one', () => {
    // In a table the parser splits the row before inline parsing, so `\|` reaches the span as a
    // literal pipe. Outside one nothing splits, and a backslash escape is not honoured inside a
    // code span, so the same escape would reach the reader as the two characters it is.
    expect(codeCell('a | b')).toBe('`a \\| b`')
    expect(inlineCode('a | b')).toBe('`a | b`')
  })

  it('folds newlines to spaces rather than cell’s <br>, which a span renders literally', () => {
    expect(inlineCode('one\ntwo')).toBe('`one two`')
  })

  it('caps to the cell budget like its plain-text siblings', () => {
    expect(codeCell('x'.repeat(MAX_CELL_CHARS * 2)).length).toBeGreaterThan(MAX_CELL_CHARS)
    expect(inlineCode('y'.repeat(MAX_CELL_CHARS * 2))).toContain('truncated')
  })

  it('renders an empty value as nothing rather than a stray pair of ticks', () => {
    expect(inlineCode('')).toBe('')
    expect(codeCell('')).toBe('')
  })
})

describe('dropOpenFence', () => {
  it('removes a block a hard cut landed inside, back to the line that opened it', () => {
    // The budget backstop cannot use `balanceFences`: closing ADDS characters to text already
    // over the limit, by an amount sized to the longest run in the block.
    const cut = dropOpenFence('## Report\n\ntext\n\n```\nhalf a log that never')
    expect(cut).toBe('## Report\n\ntext')
    expect(cut.length).toBeLessThan('## Report\n\ntext\n\n```\nhalf a log that never'.length)
  })

  it('leaves a document whose fences all close alone', () => {
    const balanced = '## Report\n\n```\nwhole log\n```\n\nmore'
    expect(dropOpenFence(balanced)).toBe(balanced)
  })

  it('leaves fence-free text untouched', () => {
    expect(dropOpenFence('no fences here')).toBe('no fences here')
  })
})

describe('link / cellLink', () => {
  it('links an http(s) target and escapes the label', () => {
    expect(link('#7', 'https://github.test/o/r/pull/7')).toBe(
      '[&#35;7](https://github.test/o/r/pull/7)',
    )
  })

  it('renders the label alone when there is no target', () => {
    expect(link('#7', null)).toBe('&#35;7')
    expect(link('#7', undefined)).toBe('&#35;7')
    expect(link('#7', '')).toBe('&#35;7')
  })

  it('refuses a target that would break out of the link syntax', () => {
    // `)` closes the target early: everything after it, including whatever the caller wrote
    // next, lands in the document as prose.
    expect(link('report', 'https://x.test/a)b')).toBe('report')
    expect(link('report', 'https://x.test/a b')).toBe('report')
    expect(link('report', 'https://x.test/a<b')).toBe('report')
  })

  it('refuses a target whose scheme this platform never publishes', () => {
    // A URL reaches the report from harness output, so the scheme is not ours to trust. The
    // label still renders: degrading to plain text keeps the reader informed and the host inert.
    expect(link('click', 'javascript:alert(1)')).toBe('click')
    expect(link('click', 'data:text/html;base64,AAA')).toBe('click')
    expect(link('click', 'file:///etc/passwd')).toBe('click')
    expect(link('click', '/relative/path')).toBe('click')
  })

  it('escapes the label as a CELL in the table variant, so a pipe cannot open a column', () => {
    expect(cellLink('a | b', 'https://x.test/1')).toBe('[a \\| b](https://x.test/1)')
    expect(cellLink('a | b', null)).toBe('a \\| b')
  })
})
