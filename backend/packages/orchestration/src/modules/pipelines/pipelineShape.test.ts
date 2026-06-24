import { describe, expect, it } from 'vitest'
import { seedPipelines } from '@cat-factory/kernel'
import {
  assertValidCompanionPlacement,
  assertValidGating,
  validatePipelineShape,
} from './pipelineShape.js'

describe('validatePipelineShape', () => {
  it('every built-in seed pipeline is structurally valid (so runs never refuse to start)', () => {
    for (const p of seedPipelines()) {
      expect(() =>
        validatePipelineShape({ agentKinds: p.agentKinds, enabled: p.enabled, gating: p.gating }),
      ).not.toThrow()
    }
  })

  it('rejects a companion with no producer to review, over the enabled subset', () => {
    expect(() => assertValidCompanionPlacement(['reviewer'])).toThrow()
    // A disabled producer leaves its companion orphaned → rejected.
    expect(() => assertValidCompanionPlacement(['coder', 'reviewer'], [false, true])).toThrow()
    // A producer several steps back is fine (engine reviews the nearest preceding target).
    expect(() => assertValidCompanionPlacement(['coder', 'tester', 'reviewer'])).not.toThrow()
  })

  it('requires an enabled task-estimator before any enabled gated step', () => {
    expect(() =>
      assertValidGating(['coder', 'reviewer'], undefined, [null, { enabled: true, minRisk: 0.5 }]),
    ).toThrow()
    expect(() =>
      assertValidGating(['task-estimator', 'coder', 'reviewer'], undefined, [
        null,
        null,
        { enabled: true, minRisk: 0.5 },
      ]),
    ).not.toThrow()
    // A disabled gated step imposes no requirement.
    expect(() =>
      assertValidGating(
        ['coder', 'reviewer'],
        [true, false],
        [null, { enabled: true, minRisk: 0.5 }],
      ),
    ).not.toThrow()
  })

  it('only allows gating on companion steps (skipping a producer would starve downstream)', () => {
    // A producer (coder) cannot be estimate-gated even with an estimator before it.
    expect(() =>
      assertValidGating(['task-estimator', 'coder', 'tester'], undefined, [
        null,
        { enabled: true, minRisk: 0.5 },
        null,
      ]),
    ).toThrow()
    // The companion in the same chain is fine.
    expect(() =>
      assertValidGating(['task-estimator', 'coder', 'reviewer'], undefined, [
        null,
        null,
        { enabled: true, minRisk: 0.5 },
      ]),
    ).not.toThrow()
  })

  it('rejects enabled gating with no axis threshold (it would always skip)', () => {
    expect(() =>
      assertValidGating(['task-estimator', 'coder', 'reviewer'], undefined, [
        null,
        null,
        { enabled: true },
      ]),
    ).toThrow()
  })
})
