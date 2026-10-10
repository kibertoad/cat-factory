import { describe, expect, it } from 'vitest'
import { BLOCK_LEVEL_RUNS_PIPELINES, blockLevelSchema, isSafeDocPath } from './primitives.js'

// isSafeDocPath gates the in-repo path a `document` task's writer commits to verbatim, so a
// regression that lets `..`, an absolute path, or a non-`.md` target through means an agent can
// overwrite arbitrary repo files. Pin the accept/reject boundary explicitly.
describe('isSafeDocPath', () => {
  it('accepts a plain relative markdown path', () => {
    expect(isSafeDocPath('docs/rfcs/0001-foo.md')).toBe(true)
    expect(isSafeDocPath('README.md')).toBe(true)
  })

  it('trims surrounding whitespace before validating', () => {
    expect(isSafeDocPath('  docs/a.md  ')).toBe(true)
  })

  it('requires a .md extension (case-insensitive)', () => {
    expect(isSafeDocPath('docs/a.MD')).toBe(true)
    expect(isSafeDocPath('docs/a.md')).toBe(true)
    expect(isSafeDocPath('docs/a.txt')).toBe(false)
    expect(isSafeDocPath('docs/package.json')).toBe(false)
    // A ".md" that is not the extension is not enough.
    expect(isSafeDocPath('docs/a.md.txt')).toBe(false)
  })

  it('rejects the empty / whitespace-only path', () => {
    expect(isSafeDocPath('')).toBe(false)
    expect(isSafeDocPath('   ')).toBe(false)
  })

  it('rejects parent-directory traversal segments', () => {
    expect(isSafeDocPath('../secrets.md')).toBe(false)
    expect(isSafeDocPath('docs/../../etc/passwd.md')).toBe(false)
    // A ".." that is only a substring of a segment is fine.
    expect(isSafeDocPath('docs/a..b.md')).toBe(true)
  })

  it('rejects absolute POSIX and Windows-drive paths', () => {
    expect(isSafeDocPath('/etc/passwd.md')).toBe(false)
    expect(isSafeDocPath('C:/Users/a.md')).toBe(false)
    expect(isSafeDocPath('z:\\a.md')).toBe(false)
  })

  it('rejects backslash and NUL characters', () => {
    expect(isSafeDocPath('docs\\a.md')).toBe(false)
    expect(isSafeDocPath('docs/a\0.md')).toBe(false)
  })

  it('rejects paths longer than 300 chars', () => {
    const long = `${'a/'.repeat(200)}x.md`
    expect(long.length).toBeGreaterThan(300)
    expect(isSafeDocPath(long)).toBe(false)
  })
})

// The preset-selection guard asks this Record which blocks in a moved subtree carry a merge
// policy worth judging. A level missing from it is a hole, not a wrong answer: the move is
// admitted with nothing to compare. Derive the expectation from the picklist the type comes
// from, so a new level fails HERE rather than being silently exempt.
describe('BLOCK_LEVEL_RUNS_PIPELINES', () => {
  it('classifies every declared block level exactly once', () => {
    expect(Object.keys(BLOCK_LEVEL_RUNS_PIPELINES).sort()).toEqual(
      [...blockLevelSchema.options].sort(),
    )
  })

  it('names the two levels a run can actually start on', () => {
    // `task` is the everyday one; `initiative` is the one a `level === 'task'` test silently
    // exempted, even though an initiative block starts its own planning chain and so resolves a
    // preset of its own.
    const runnable = blockLevelSchema.options.filter((level) => BLOCK_LEVEL_RUNS_PIPELINES[level])
    expect([...runnable].sort()).toEqual(['initiative', 'task'])
  })
})
