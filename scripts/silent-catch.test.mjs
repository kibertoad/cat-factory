// Fixtures for the silent-promise-drop detector. Run with `node --test scripts/` — the built-in
// runner, deliberately, so CI's `repo-guards` job stays install-free like every other guard in it.
//
// This guard is now the only thing standing between the tree and the idiom growing back one
// convenient call site at a time, and its logic is subtle enough (a masking scan, regex-vs-division,
// a contiguous-comment-block lookup) that "it passed on the tree once" is not evidence it works.
// The cases below are the ones that actually bit: the URL false negative that motivated the
// rewrite, and each spelling of an empty handler.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { findSilentCatches, maskCommentsAndStrings } from './silent-catch.mjs'

/** The 1-based lines `src` is flagged on. */
const linesOf = (src) => findSilentCatches(src)

describe('findSilentCatches', () => {
  it('flags the bare idiom', () => {
    assert.deepEqual(linesOf('void doThing().catch(() => {})\n'), [1])
  })

  it('flags it when an earlier string on the line contains "//"', () => {
    // The regression this detector was rewritten for: the previous prefix heuristic read the `//`
    // inside the URL as the start of a comment and skipped the drop entirely.
    assert.deepEqual(linesOf(`void fetch('https://example.com/x').catch(() => {})\n`), [1])
  })

  it('flags every spelling of an empty handler', () => {
    const src = [
      'a().catch(() => {})',
      'b().catch((e) => {})',
      'c().catch(e => {})',
      'd().catch(async () => {})',
      'e().catch((error: unknown) => {})',
      'f().catch(function () {})',
      'g().catch(function named(e) {})',
      'h().catch(async function () {})',
      'i().catch(() => {\n})',
    ].join('\n')
    assert.deepEqual(linesOf(src), [1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  it('flags a body that holds only a comment', () => {
    // The likeliest regrowth path: it lets an author document a swallow without the stated reason
    // the escape hatch requires, so masking must reduce it to the same empty body.
    assert.deepEqual(linesOf('a().catch(() => { /* ignored */ })\n'), [1])
    assert.deepEqual(linesOf('a().catch(() => {\n  // nothing to do\n})\n'), [1])
  })

  it('ignores the idiom quoted in a comment or a string', () => {
    assert.deepEqual(linesOf('// replaced every `.catch(() => {})` with runBestEffort\n'), [])
    assert.deepEqual(linesOf('/*\n * was: x.catch(() => {})\n */\n'), [])
    assert.deepEqual(linesOf(`const doc = 'use .catch(() => {}) never'\n`), [])
    assert.deepEqual(linesOf('const doc = `use .catch(() => {}) never`\n'), [])
  })

  it('still flags a drop inside a template interpolation', () => {
    // Interpolations hold real code, so they must not be masked along with the literal text.
    assert.deepEqual(linesOf('const s = `${void a().catch(() => {})}`\n'), [1])
  })

  it('does not lose the trail across a regex literal containing quotes', () => {
    // A regex mistaken for a string would mask the code after it — and masked code is code the
    // guard no longer sees.
    const src = `const q = /["']/\nvoid a().catch(() => {})\n`
    assert.deepEqual(linesOf(src), [2])
  })

  it('does not mistake division for a regex literal', () => {
    const src = 'const r = (a) / 2 / 3\nvoid a().catch(() => {})\n'
    assert.deepEqual(linesOf(src), [2])
  })

  it('leaves a non-empty handler alone', () => {
    assert.deepEqual(linesOf('a().catch(() => false)\n'), [])
    assert.deepEqual(linesOf('a().catch((e) => { report(e) })\n'), [])
    assert.deepEqual(linesOf('a().catch(noop)\n'), [])
  })

  it('honours an annotation on the line above', () => {
    const src = '// silent-catch-ok: the race below already reports this.\na().catch(() => {})\n'
    assert.deepEqual(linesOf(src), [])
  })

  it('honours an annotation spread over a contiguous comment block', () => {
    const src = [
      '// silent-catch-ok: the race below already observes this rejection, so a second',
      '// report would fire on every probe timeout for a cause the caller already has.',
      'a().catch(() => {})',
    ].join('\n')
    assert.deepEqual(linesOf(src), [])
  })

  it('rejects a marker with no stated reason', () => {
    assert.deepEqual(linesOf('// silent-catch-ok:\na().catch(() => {})\n'), [1 + 1])
  })

  it('does not let a marker carry across a blank line or intervening code', () => {
    assert.deepEqual(linesOf('// silent-catch-ok: reason\n\na().catch(() => {})\n'), [3])
    assert.deepEqual(linesOf('// silent-catch-ok: reason\nconst x = 1\na().catch(() => {})\n'), [3])
  })

  it('reports the right line deep in a file', () => {
    assert.deepEqual(linesOf(`${'\n'.repeat(41)}a().catch(() => {})\n`), [42])
  })
})

describe('maskCommentsAndStrings', () => {
  it('preserves length and line structure', () => {
    const src = `const a = 'xx' // yy\nconst b = 2\n`
    const masked = maskCommentsAndStrings(src)
    assert.equal(masked.length, src.length)
    assert.equal(masked.split('\n').length, src.split('\n').length)
  })

  it('keeps delimiters and blanks only the content', () => {
    assert.equal(maskCommentsAndStrings(`x('ab')`), `x('  ')`)
  })

  it('does not run past an unterminated string', () => {
    const masked = maskCommentsAndStrings(`const a = 'oops\nvoid b().catch(() => {})\n`)
    assert.match(masked, /void b\(\)\.catch\(\(\) => \{\}\)/)
  })
})
