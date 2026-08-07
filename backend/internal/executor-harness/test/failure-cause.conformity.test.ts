import { HARNESS_FAILURE_CAUSES, failureKindFromHarnessCause } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { FAILURE_CAUSES } from '../src/failure.js'

// The harness's failure-cause vocabulary is a deliberate hand-kept COPY of the kernel union that
// classifies it: the container image builds from `src/` plus typescript alone, so it can carry no
// runtime dependency on a workspace package (the constraint behind `src/host-markdown.ts` and
// `normalizeProxyPhase` too).
//
// Drift in the direction this pins is SILENT and costly: a cause this image stamps that kernel
// does not know is dropped by `isHarnessFailureCause`, so the consumer falls back to its
// error-string regex exactly as if the harness had reported nothing — and the structured cause
// exists precisely because that regex was deleted. The failure then classifies as a generic agent
// error, which is the wrong remedy for a watchdog kill.
//
// Only that direction is asserted. A kernel member no harness emits is dead vocabulary, not a
// bug, and the union deliberately holds causes this image cannot produce (`deploy` belongs to
// the deploy-harness), so a two-way equality here would fail on a correct tree.

describe('harness FailureCause conforms to the kernel union', () => {
  it('every cause this image can stamp is one kernel recognises and classifies', () => {
    for (const cause of FAILURE_CAUSES) {
      expect(HARNESS_FAILURE_CAUSES).toContain(cause)
      // Recognised is not enough: an unmapped member would still reach the consumer as
      // `undefined` and route to the regex fallback.
      expect(failureKindFromHarnessCause(cause)).toBeDefined()
    }
  })

  it('lists each cause exactly once', () => {
    expect(new Set(FAILURE_CAUSES).size).toBe(FAILURE_CAUSES.length)
  })
})
