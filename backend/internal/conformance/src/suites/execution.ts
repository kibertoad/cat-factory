import { describe } from 'vitest'
import type { ConformanceHarness } from '../harness.js'
import { defineExecutionGatesConformance } from './execution-gates.js'
import { defineExecutionReviewConformance } from './execution-review.js'
import { defineExecutionTesterConformance } from './execution-tester.js'

// The execution-engine conformance, split into cohesive sibling files so no single suite file
// grows unbounded (the file-size ratchet guard). Each `defineX` re-opens the shared
// `execution engine` (and `ralph loop`) describe groups inside the one per-facade
// `[name] conformance` wrapper, so the reported test tree is unchanged from the former monolith.
export function defineExecutionConformance(harness: ConformanceHarness): void {
  describe(`[${harness.name}] conformance`, () => {
    defineExecutionTesterConformance(harness)
    defineExecutionReviewConformance(harness)
    defineExecutionGatesConformance(harness)
  })
}
