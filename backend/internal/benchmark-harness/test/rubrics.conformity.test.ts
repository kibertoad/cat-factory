import { rubricFor as sandboxRubricFor } from '@cat-factory/sandbox'
import { describe, expect, it } from 'vitest'
import { rubricFor } from '../src/rubrics'
import type { TaskType } from '../src/types'

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

const TASKS: TaskType[] = ['requirement-review', 'code-review', 'implementation']

describe('rubric conformity with @cat-factory/sandbox', () => {
  for (const task of TASKS) {
    it(`keeps the ${task} dimensions identical in both copies`, () => {
      expect(rubricFor(task).dimensions).toEqual(sandboxRubricFor(task).dimensions)
    })
  }
})
