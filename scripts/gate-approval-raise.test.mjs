// Fixtures for the hand-rolled-gate-raise detector. Run with `node --test 'scripts/*.test.mjs'`,
// the built-in runner, so CI's `repo-guards` job stays install-free like every other guard in it.
//
// The three shapes below look nearly identical and mean different things, which is the whole
// reason the detection is a tested module rather than a regex inline in the walker: a guard that
// flags the spread form would be turned off within a week, and one that misses the literal form
// re-admits exactly the bug it was written for.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { findHandRolledApprovalRaises } from './gate-approval-raise.mjs'

/** The 1-based lines `src` is flagged on. */
const linesOf = (src) => findHandRolledApprovalRaises(src)

describe('findHandRolledApprovalRaises', () => {
  it('flags a fresh object literal, the shape that drops the policy', () => {
    const src = [
      'step.approval = {',
      "  id: this.idGenerator.next('appr'),",
      "  status: 'pending',",
      '  proposal: step.output,',
      '}',
    ].join('\n')
    assert.deepEqual(linesOf(src), [1])
  })

  it('flags it on one line too', () => {
    assert.deepEqual(linesOf("step.approval = { id, status: 'pending', proposal }\n"), [1])
  })

  it('accepts the builder call', () => {
    assert.deepEqual(linesOf('step.approval = buildStepApproval(step, id, step.output)\n'), [])
  })

  it('accepts a SPREAD of the existing approval, which is a refresh and keeps the policy', () => {
    assert.deepEqual(
      linesOf("step.approval = { ...step.approval, proposal: step.output ?? '' }\n"),
      [],
    )
  })

  it('accepts a spread broken across lines', () => {
    assert.deepEqual(linesOf('step.approval = {\n  ...step.approval,\n  proposal,\n}\n'), [])
  })

  it('ignores a line that only DESCRIBES the banned shape', () => {
    // This guard's own header and the builder's doc comment both spell it out; flagging prose
    // would make the guard unable to explain itself.
    const src = [
      '// never write `step.approval = { id, status }` by hand',
      ' * A raise spelled `step.approval = {` drops the snapshot.',
    ].join('\n')
    assert.deepEqual(linesOf(src), [])
  })

  it('still flags code that carries a trailing comment', () => {
    assert.deepEqual(linesOf('step.approval = { id } // raise the gate\n'), [1])
  })
})
