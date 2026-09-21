// Fixtures for the AGENTS.md/CLAUDE.md pairing guard. Run with `node --test 'scripts/*.test.mjs'`,
// the built-in runner, so CI's `repo-guards` job stays install-free like every other guard in it.
//
// The guard is the only thing stopping a new package's AGENTS.md from shipping unpaired, and so
// invisible to Claude Code. The cases below pin what counts as a valid sibling: the missing file,
// the wrong first line, and the allowances (leading blank lines, trailing Claude-only notes).

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { REQUIRED_IMPORT, describeSiblingProblem } from './check-agents-md-pairing.mjs'

describe('describeSiblingProblem', () => {
  it('accepts a bare @AGENTS.md import', () => {
    assert.equal(describeSiblingProblem('@AGENTS.md\n'), null)
  })

  it('accepts leading blank lines before the import', () => {
    assert.equal(describeSiblingProblem('\n\n@AGENTS.md\n'), null)
  })

  it('accepts Claude-only notes after the import', () => {
    assert.equal(describeSiblingProblem('@AGENTS.md\n\nAlso: run the app with pnpm dev.\n'), null)
  })

  it('flags a missing sibling', () => {
    assert.match(describeSiblingProblem(null), /no sibling CLAUDE\.md/)
  })

  it('flags an empty file', () => {
    assert.match(describeSiblingProblem('\n\n'), /empty file/)
  })

  it('flags a first line that is not the import', () => {
    const problem = describeSiblingProblem('# Package rules\n\n@AGENTS.md\n')
    assert.match(problem, /must open with/)
    assert.match(problem, /# Package rules/)
  })

  it('does not accept the import buried below other content', () => {
    // First non-empty line must be the import: an import lower down still works for Claude, but
    // the one-line pattern is what keeps the sibling obviously a pointer and not a second doc.
    assert.notEqual(describeSiblingProblem('intro\n@AGENTS.md\n'), null)
  })

  it('exports the exact import line the fix uses', () => {
    assert.equal(REQUIRED_IMPORT, '@AGENTS.md')
  })
})
