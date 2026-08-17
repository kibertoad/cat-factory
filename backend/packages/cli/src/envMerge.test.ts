import { parseEnv } from 'node:util'
import { describe, expect, it } from 'vitest'
import {
  describeEntries,
  describeMerge,
  mergeEnvFile,
  quoteEnvValue,
  readAssignments,
} from './envMerge.js'

// A setup command's promises all fail SILENTLY: a merge that loses a hand-added variable looks like
// a successful write, and a value written in a form the reader disagrees about looks like a value
// that was kept. So what is pinned here is agreement between this WRITER and `node:util`'s
// `parseEnv`, which is what actually reads a `.env` back, plus the four-way report that is the only
// thing able to state "nothing was overwritten".

describe('mergeEnvFile', () => {
  it('categorises every key so nothing is overwritten without a word about it', () => {
    const merge = mergeEnvFile('A=1\nB=2\nC=3\n', [
      { key: 'A', value: '1' },
      { key: 'B', value: 'changed' },
      { key: 'D', value: 'new' },
    ])
    expect(merge.kept).toEqual(['A'])
    expect(merge.changed).toEqual(['B'])
    expect(merge.added).toEqual(['D'])
    expect(merge.preserved).toEqual(['C'])
  })

  it('reads `export FOO=bar` and a quoted value as the same assignment', () => {
    // Both spellings appear in a hand-written `.env`, and reading either as a different key would
    // have this command write a second copy of it beside the first.
    const merge = mergeEnvFile('export A="1"\n', [{ key: 'A', value: '1' }])
    expect(merge.kept).toEqual(['A'])
    expect(merge.text).toBe('A=1\n')
  })

  it('drops the comment block above a key it rewrites, so no comment outlives its value', () => {
    const merge = mergeEnvFile('# describes A\nA=old\nB=keep\n', [
      { key: 'A', value: 'new', comment: ['the current description'] },
    ])
    expect(merge.text).toContain('# the current description\nA=new')
    expect(merge.text).not.toContain('# describes A')
    expect(merge.text).toContain('B=keep')
  })

  it('writes a whole file when there was none', () => {
    const merge = mergeEnvFile(null, [{ key: 'A', value: '1' }])
    expect(merge.text).toBe('A=1\n')
    expect(merge.added).toEqual(['A'])
    expect(merge.preserved).toEqual([])
  })

  it('re-writes the carried-over header instead of stacking one copy per run', () => {
    // The header introduces UNMANAGED content, so the ordinary comment-block rule carries it over,
    // and a merge that then prepended a fresh copy grew the file by one identical line every run.
    // A single merge cannot see this, which is why it is asserted across three.
    let text: string | null = 'ACCEPTANCE_RUN_BUDGET_MS=1200000\n# my own note\n'
    for (let pass = 0; pass < 3; pass++) {
      text = mergeEnvFile(text, [{ key: 'A', value: '1', comment: ['managed'] }]).text
    }
    expect(text?.match(/Carried over unchanged/g)).toHaveLength(1)
    expect(text).toContain('ACCEPTANCE_RUN_BUDGET_MS=1200000')
    expect(text).toContain('# my own note')
  })

  it('recognises the carried-over header a PREVIOUS wording wrote, instead of stacking a second', () => {
    // Rule 4 fires on the day the sentence changes, not only when it is missing: this header used to
    // name `configure`, so every file an earlier run had written carried a line the next run no longer
    // matched. It was filed as an ordinary comment above unmanaged content and a fresh header went in
    // above it, which is the growth the recognition exists to prevent.
    const older =
      '# Carried over unchanged from the previous file; `configure` does not manage these.\n' +
      'ACCEPTANCE_RUN_BUDGET_MS=1200000\n'
    const merge = mergeEnvFile(older, [{ key: 'A', value: '1' }])
    expect(merge.text.match(/Carried over unchanged/g)).toHaveLength(1)
    expect(merge.text).not.toContain('`configure` does not manage')
    expect(merge.text).toContain('ACCEPTANCE_RUN_BUDGET_MS=1200000')
  })

  it('replaces a MANAGED multi-line value whole, rather than leaving its body behind', () => {
    // The corruption rule 1 promises to prevent: `KEY="-----BEGIN…` matches an assignment on its first
    // line alone, so a line-at-a-time strip dropped that line and re-emitted the certificate body as
    // unmanaged content. The written file then held the new value plus orphaned base64 lines, one of
    // which (`Qm9keQ==`) even parses as an assignment and would be reported as a preserved key.
    const existing = 'PEM="-----BEGIN CERT-----\nQm9keQ==\n-----END CERT-----"\nKEEP=1\n'
    const merge = mergeEnvFile(existing, [{ key: 'PEM', value: 'replaced' }])
    expect(merge.changed).toEqual(['PEM'])
    expect(merge.text).not.toContain('BEGIN CERT')
    expect(merge.text).not.toContain('Qm9keQ==')
    expect(merge.preserved).toEqual(['KEEP'])
    expect(parseEnv(merge.text).PEM).toBe('replaced')
  })

  it('carries an UNMANAGED multi-line value over intact, body and closing line included', () => {
    // The same reading from the other side: the value belongs to somebody else, so all of it survives
    // and the reader gets back exactly what was pasted in.
    const pem = '-----BEGIN CERT-----\nQm9keQ==\n-----END CERT-----'
    const merge = mergeEnvFile(`THEIR_PEM="${pem}"\n`, [{ key: 'A', value: '1' }])
    expect(merge.preserved).toEqual(['THEIR_PEM'])
    expect(parseEnv(merge.text).THEIR_PEM).toBe(pem)
  })

  it('refuses a file whose quoted value is never closed, rather than guessing where it ends', () => {
    // With no closing quote, where the value ends is unknowable, so every answer the report makes
    // (which keys the file holds, what is unmanaged, what was preserved) would be a guess presented as
    // a fact. `parseEnv` cannot read such a file either.
    expect(() => mergeEnvFile('PEM="-----BEGIN CERT-----\nQm9keQ==\n', [])).toThrow(/never closed/)
  })

  it('quotes a managed value the reader would otherwise disagree about', () => {
    // The suite reads its `.env` with `node:util`'s `parseEnv`, which treats an unquoted `#` as a
    // comment and strips surrounding whitespace, while `renderEnvFile` emits a bare `KEY=value`. So a
    // value READ from a quoted line, offered as a default and accepted unchanged was written back as
    // a DIFFERENT value, with `describeMerge` calling it unchanged.
    const merge = mergeEnvFile('ACCEPTANCE_NAME_PREFIX="cf-acc #2"\n', [
      { key: 'ACCEPTANCE_NAME_PREFIX', value: 'cf-acc #2' },
    ])
    expect(merge.kept).toEqual(['ACCEPTANCE_NAME_PREFIX'])
    expect(merge.text).toBe('ACCEPTANCE_NAME_PREFIX="cf-acc #2"\n')
    expect(parseEnv(merge.text).ACCEPTANCE_NAME_PREFIX).toBe('cf-acc #2')
  })

  it('round-trips every ordinary managed value through parseEnv unchanged', () => {
    // The property that matters is agreement between this writer and the suite's reader, asserted
    // over the value shapes that actually occur rather than over one hand-picked string.
    const values = ['http://127.0.0.1:8787', 'cf_live_pak_a.b-c', 'ws_1', 'cf-acc', 'true', '']
    for (const value of values) {
      const text = mergeEnvFile(null, [{ key: 'K', value }]).text
      expect(parseEnv(text).K ?? '').toBe(value)
    }
  })

  it('refuses a value no quoting style can represent, rather than writing a lie', () => {
    // `parseEnv` supports both delimiters and no escape inside either, so a value carrying both quote
    // characters cannot survive. This command's promise is that the file it wrote is the file the
    // suite will read.
    expect(() => mergeEnvFile(null, [{ key: 'K', value: `he said "hi" to 'them'` }])).toThrow(
      /cannot be written to a .env file/,
    )
  })
})

describe('readAssignments', () => {
  it('keeps an empty assignment, so a carried-over blank can still be reported', () => {
    // `preserved` has to be able to name a `FOO=` line the merge carried over. A caller wanting
    // prompt DEFAULTS filters the blanks itself, because there blank means absent.
    expect(readAssignments('A=1\nB=\n# note\n')).toEqual({ A: '1', B: '' })
  })

  it('reads a multi-line quoted value as ONE assignment, not a key and some garbage', () => {
    // Line at a time, the value is the opening line alone and every body line is examined on its own:
    // `Qm9keQ==` matches the assignment grammar, so the reader answered a key that does not exist and
    // a value that is a fragment of one that does.
    expect(readAssignments('PEM="-----BEGIN\nQm9keQ==\n-----END"\nA=1\n')).toEqual({
      PEM: '-----BEGIN\nQm9keQ==\n-----END',
      A: '1',
    })
  })

  it('treats a mid-value apostrophe as text, since it opens nothing', () => {
    // The continuation rule keys on the value's FIRST character. Any quote anywhere would make
    // `A=it's fine` swallow the rest of the file.
    expect(readAssignments("A=it's fine\nB=2\n")).toEqual({ A: "it's fine", B: '2' })
  })
})

describe('describeMerge', () => {
  it('leads with what it replaced, which is the only category that can surprise anyone', () => {
    const lines = describeMerge(
      { text: '', kept: ['K'], changed: ['C'], added: ['A'], preserved: ['P'] },
      'acceptance/.env',
    )
    expect(lines[0]).toBe('Wrote acceptance/.env.')
    expect(lines[1]).toContain('replaced: C')
    expect(lines.join('\n')).toContain('left alone (not managed here): P')
  })
})

describe('describeEntries', () => {
  it('withholds a secret by the LIST it is given, never by what its name looks like', () => {
    // The list is the caller's precisely so the next secret whose name says nothing (`ACCEPTANCE_PIN`
    // here) is still withheld, where a `key.includes('TOKEN')` predicate would print it.
    const lines = describeEntries(
      [
        { key: 'ACCEPTANCE_PIN', value: 'super-secret' },
        { key: 'ACCEPTANCE_TOKEN_HINT', value: 'not-a-secret' },
        { key: 'ACCEPTANCE_EMPTY', value: '' },
      ],
      new Set(['ACCEPTANCE_PIN']),
    )
    expect(lines).toEqual([
      '  ACCEPTANCE_PIN=(set, not shown)',
      '  ACCEPTANCE_TOKEN_HINT=not-a-secret',
      '  ACCEPTANCE_EMPTY=(empty)',
    ])
  })
})

describe('quoteEnvValue', () => {
  it('leaves an ordinary value bare and quotes one the reader would misread', () => {
    expect(quoteEnvValue('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787')
    expect(quoteEnvValue('cf-acc #2')).toBe('"cf-acc #2"')
    expect(quoteEnvValue('he said "hi"')).toBe(`'he said "hi"'`)
  })
})
