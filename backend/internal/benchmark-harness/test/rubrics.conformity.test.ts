import { SANDBOX_TASK_TYPES, rubricFor as sandboxRubricFor } from '@cat-factory/sandbox'
import { describe, expect, it } from 'vitest'
import { rubricFor } from '../src/rubrics'
import { TASK_TYPES } from '../src/types'

// `@cat-factory/sandbox` carries a hand-copied duplicate of these rubrics so the in-product
// Sandbox and the offline `cat-bench` grade on the same axes (it says so in its own header). A
// hand-kept copy needs a guard, or the two silently diverge the first time someone adds a
// dimension to one — and the drift is invisible: both sides keep grading, just on different
// axes, so a Sandbox score and a benchmark score stop being comparable with nothing failing.
//
// This is the cheap direction to enforce it: the harness is private and already devDeps-only
// here, so the published package stays unaware of it. If a rubric legitimately needs to differ
// per surface one day, that is a real design decision — split the types and delete this test,
// don't loosen it.
//
// The relation is deliberately ONE-WAY. The Sandbox ships rubrics the offline harness has no runner
// for (`architecture-review`, `bug-triage`, `estimation`, `answer-recommendation`), so equality of
// the two task LISTS would fail on every Sandbox-only addition and teach the next person to
// re-pin it unread. What must hold is that the harness never grades on an axis the Sandbox does not
// know: every harness task IS a Sandbox task, with identical dimensions.

describe('rubric conformity with @cat-factory/sandbox', () => {
  for (const task of TASK_TYPES) {
    it(`keeps the ${task} dimensions identical in both copies`, () => {
      expect(rubricFor(task).dimensions).toEqual(sandboxRubricFor(task).dimensions)
    })
  }

  it('grades only tasks the Sandbox also ships', () => {
    // Derived from both sides' own exported lists rather than a count: an added harness task with no
    // Sandbox rubric fails here (its grades would be incomparable), while an added Sandbox-only
    // rubric passes, which is the asymmetry above.
    for (const task of TASK_TYPES) {
      expect(SANDBOX_TASK_TYPES, `${task} has no Sandbox rubric`).toContain(task)
    }
  })
})
