import { describe } from 'vitest'
import type { ConformanceHarness } from '../harness.js'
import { defineExecutionCompanionConformance } from './execution-companion.js'
import { defineExecutionFailureConformance } from './execution-failures.js'
import { defineExecutionGatesConformance } from './execution-gates.js'
import { defineInputGateConformance } from './execution-input-gate.js'
import { defineJudgeConformance } from './execution-judge.js'
import { defineExecutionPrReportConformance } from './execution-pr-report.js'
import { defineExecutionPrReportEnvironmentsConformance } from './execution-pr-report-environments.js'
import { defineExecutionReviewConformance } from './execution-review.js'
import { defineReviewStoreConcurrencyConformance } from './execution-review-store.js'
import { defineExecutionTesterConformance } from './execution-tester.js'

// The execution-engine conformance, split into cohesive sibling files so no single suite file
// grows unbounded (the file-size ratchet guard). Each `defineX` re-opens the shared
// `execution engine` (and `ralph loop`) describe groups inside the one per-facade
// `[name] conformance` wrapper, so the reported test tree is unchanged from the former monolith.
export function defineExecutionConformance(harness: ConformanceHarness): void {
  describe(`[${harness.name}] conformance`, () => {
    defineExecutionTesterConformance(harness)
    defineExecutionReviewConformance(harness)
    defineExecutionCompanionConformance(harness)
    defineExecutionFailureConformance(harness)
    defineReviewStoreConcurrencyConformance(harness)
    defineExecutionGatesConformance(harness)
    defineInputGateConformance(harness)
    defineExecutionPrReportConformance(harness)
    defineExecutionPrReportEnvironmentsConformance(harness)
    defineJudgeConformance(harness)
  })
}
