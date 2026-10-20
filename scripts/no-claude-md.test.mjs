// Fixtures for the no-CLAUDE.md guard. Run with `node --test 'scripts/*.test.mjs'`, the built-in
// runner, so CI's `repo-guards` job stays install-free like every other guard in it.
//
// The guard is the only thing stopping a re-added CLAUDE.md from switching off every AGENTS.md
// again, silently. The cases below pin the boundary that matters: the three names Claude Code
// counts, at any depth, against the many tracked paths that merely carry "claude" in the name.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { BANNED_NAMES, isBannedInstructionFile } from './check-no-claude-md.mjs'

describe('isBannedInstructionFile', () => {
  it('names both files Claude Code counts', () => {
    assert.deepEqual(BANNED_NAMES, ['CLAUDE.md', 'CLAUDE.local.md'])
  })

  it('catches a root CLAUDE.md', () => {
    assert.equal(isBannedInstructionFile('CLAUDE.md'), true)
  })

  it('catches a nested CLAUDE.md', () => {
    assert.equal(isBannedInstructionFile('backend/packages/kernel/CLAUDE.md'), true)
  })

  it('catches a CLAUDE.local.md', () => {
    assert.equal(isBannedInstructionFile('frontend/app/CLAUDE.local.md'), true)
  })

  it('catches one under a .claude directory', () => {
    assert.equal(isBannedInstructionFile('.claude/CLAUDE.md'), true)
  })

  it('allows AGENTS.md itself', () => {
    assert.equal(isBannedInstructionFile('backend/packages/kernel/AGENTS.md'), false)
  })

  it('allows a doc whose name merely contains claude', () => {
    assert.equal(isBannedInstructionFile('backend/docs/figma-claude-design-context.md'), false)
  })

  it('allows a skill file under a claude-named directory', () => {
    assert.equal(isBannedInstructionFile('.claude/skills/benchmark/SKILL.md'), false)
  })

  it('allows a source file named for the Claude CLI', () => {
    assert.equal(
      isBannedInstructionFile('backend/internal/executor-harness/src/claude-cli.ts'),
      false,
    )
  })

  it('does not match a lowercase claude.md, which Claude Code does not read', () => {
    assert.equal(isBannedInstructionFile('docs/claude.md'), false)
  })
})
