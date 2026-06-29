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

  it('requires a companion to run immediately after a producer it can review', () => {
    expect(() => assertValidCompanionPlacement(['reviewer'])).toThrow()
    // A disabled producer leaves its companion orphaned → rejected.
    expect(() => assertValidCompanionPlacement(['coder', 'reviewer'], [false, true])).toThrow()
    // Adjacent producer → companion is valid.
    expect(() => assertValidCompanionPlacement(['coder', 'reviewer'])).not.toThrow()
    // A step slipped between the producer and its companion → rejected (strict adjacency).
    expect(() => assertValidCompanionPlacement(['coder', 'tester-api', 'reviewer'])).toThrow()
    // Adjacency is over the ENABLED subset: a disabled step between them doesn't break it.
    expect(() =>
      assertValidCompanionPlacement(['coder', 'tester-api', 'reviewer'], [true, false, true]),
    ).not.toThrow()
  })

  it('requires an enabled task-estimator before any enabled gated step', () => {
    expect(() =>
      assertValidGating(['coder', 'reviewer'], undefined, [
        null,
        { enabled: true, minRisk: 0.5, onMissingEstimate: 'run' },
      ]),
    ).toThrow()
    expect(() =>
      assertValidGating(['task-estimator', 'coder', 'reviewer'], undefined, [
        null,
        null,
        { enabled: true, minRisk: 0.5, onMissingEstimate: 'run' },
      ]),
    ).not.toThrow()
    // A disabled gated step imposes no requirement.
    expect(() =>
      assertValidGating(
        ['coder', 'reviewer'],
        [true, false],
        [null, { enabled: true, minRisk: 0.5, onMissingEstimate: 'run' }],
      ),
    ).not.toThrow()
  })

  it('only allows gating on companion steps (skipping a producer would starve downstream)', () => {
    // A producer (coder) cannot be estimate-gated even with an estimator before it.
    expect(() =>
      assertValidGating(['task-estimator', 'coder', 'tester-api'], undefined, [
        null,
        { enabled: true, minRisk: 0.5, onMissingEstimate: 'run' },
        null,
      ]),
    ).toThrow()
    // The companion in the same chain is fine.
    expect(() =>
      assertValidGating(['task-estimator', 'coder', 'reviewer'], undefined, [
        null,
        null,
        { enabled: true, minRisk: 0.5, onMissingEstimate: 'run' },
      ]),
    ).not.toThrow()
  })

  it('rejects enabled gating with no axis threshold (it would always skip)', () => {
    expect(() =>
      assertValidGating(['task-estimator', 'coder', 'reviewer'], undefined, [
        null,
        null,
        { enabled: true, onMissingEstimate: 'run' },
      ]),
    ).toThrow()
  })
})
