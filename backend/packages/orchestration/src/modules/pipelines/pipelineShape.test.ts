import { describe, expect, it } from 'vitest'
import { seedPipelines } from '@cat-factory/kernel'
import {
  assertPipelineLaunchable,
  assertValidCompanionPlacement,
  assertValidGating,
  assertValidTesterQualityGating,
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

  it('the seeded pl_bug_triage pipeline is recurring-only, well-shaped, and estimator-first', () => {
    const bugTriage = seedPipelines().find((p) => p.id === 'pl_bug_triage')
    expect(bugTriage, 'pl_bug_triage must be a built-in seed pipeline').toBeTruthy()
    const kinds = bugTriage!.agentKinds
    // Structurally valid (the reviewer companion sits adjacent to coder; no invalid gating).
    expect(() =>
      validatePipelineShape({
        agentKinds: kinds,
        enabled: bugTriage!.enabled,
        gating: bugTriage!.gating,
      }),
    ).not.toThrow()
    // Recurring-only: a bug-intake step forces `availability: 'recurring'`, so it fires from a
    // schedule and refuses a one-off manual start.
    expect(bugTriage!.availability).toBe('recurring')
    expect(() =>
      assertPipelineLaunchable(kinds, bugTriage!.availability, 'recurring'),
    ).not.toThrow()
    expect(() => assertPipelineLaunchable(kinds, bugTriage!.availability, 'manual')).toThrow()
    // The task-estimator runs BEFORE any implementation spend (design §6): the estimate is
    // available to gate the expensive downstream steps (repro-test / coder / reviewer / tester).
    const estimatorIdx = kinds.indexOf('task-estimator')
    expect(estimatorIdx).toBeGreaterThanOrEqual(0)
    for (const spend of ['repro-test', 'coder', 'reviewer', 'tester-api']) {
      expect(kinds.indexOf(spend)).toBeGreaterThan(estimatorIdx)
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

  describe('tester quality-control gating', () => {
    it('requires an enabled task-estimator before a QC-gated Tester step', () => {
      expect(() =>
        assertValidTesterQualityGating(['coder', 'tester-api'], undefined, [
          null,
          { enabled: true, gating: { enabled: true, minRisk: 0.5, onMissingEstimate: 'run' } },
        ]),
      ).toThrow()
      expect(() =>
        assertValidTesterQualityGating(['task-estimator', 'coder', 'tester-api'], undefined, [
          null,
          null,
          { enabled: true, gating: { enabled: true, minRisk: 0.5, onMissingEstimate: 'run' } },
        ]),
      ).not.toThrow()
    })

    it('rejects a QC gate that sets no axis threshold', () => {
      expect(() =>
        assertValidTesterQualityGating(['task-estimator', 'tester-api'], undefined, [
          null,
          { enabled: true, gating: { enabled: true, onMissingEstimate: 'run' } },
        ]),
      ).toThrow()
    })

    it('imposes no requirement when QC is enabled-but-ungated, disabled, or gate-disabled', () => {
      // Enabled, no gating → nothing to validate.
      expect(() =>
        assertValidTesterQualityGating(['tester-api'], undefined, [{ enabled: true }]),
      ).not.toThrow()
      // A disabled Tester step with a QC gate imposes no requirement (it never runs).
      expect(() =>
        assertValidTesterQualityGating(
          ['tester-api'],
          [false],
          [{ enabled: true, gating: { enabled: true, minRisk: 0.5, onMissingEstimate: 'run' } }],
        ),
      ).not.toThrow()
      // A QC gate flagged disabled needs no estimator.
      expect(() =>
        assertValidTesterQualityGating(['tester-api'], undefined, [
          { enabled: true, gating: { enabled: false, onMissingEstimate: 'run' } },
        ]),
      ).not.toThrow()
    })
  })
})

describe('assertPipelineLaunchable', () => {
  it('requires a recurring pipeline for a bug-intake step (unset ⇒ both ⇒ rejected)', () => {
    expect(() => assertPipelineLaunchable(['bug-intake', 'coder'], 'recurring')).not.toThrow()
    expect(() => assertPipelineLaunchable(['bug-intake', 'coder'], 'both')).toThrow()
    expect(() => assertPipelineLaunchable(['bug-intake', 'coder'], 'one-off')).toThrow()
    // Absent availability means 'both' → a bug-intake pipeline is still rejected.
    expect(() => assertPipelineLaunchable(['bug-intake', 'coder'], undefined)).toThrow()
    // No bug-intake step → any availability is fine.
    expect(() => assertPipelineLaunchable(['coder'], undefined)).not.toThrow()
    expect(() => assertPipelineLaunchable(['coder'], 'recurring')).not.toThrow()
  })

  it('gates the launch origin against the pipeline availability', () => {
    // A manual start of a recurring-only pipeline is refused; a scheduled fire of it is fine.
    expect(() => assertPipelineLaunchable(['coder'], 'recurring', 'manual')).toThrow()
    expect(() => assertPipelineLaunchable(['coder'], 'recurring', 'recurring')).not.toThrow()
    // A scheduled fire of a one-off-only pipeline is refused; a manual start of it is fine.
    expect(() => assertPipelineLaunchable(['coder'], 'one-off', 'recurring')).toThrow()
    expect(() => assertPipelineLaunchable(['coder'], 'one-off', 'manual')).not.toThrow()
    // 'both' / unset runs either way.
    expect(() => assertPipelineLaunchable(['coder'], 'both', 'manual')).not.toThrow()
    expect(() => assertPipelineLaunchable(['coder'], 'both', 'recurring')).not.toThrow()
    expect(() => assertPipelineLaunchable(['coder'], undefined, 'manual')).not.toThrow()
    expect(() => assertPipelineLaunchable(['coder'], undefined, 'recurring')).not.toThrow()
  })

  it('skips the origin gate when no origin is supplied (retry/restart re-drive)', () => {
    // A retry re-drives stored steps with no origin — the launch gate must not fire.
    expect(() => assertPipelineLaunchable(['coder'], 'recurring')).not.toThrow()
    expect(() => assertPipelineLaunchable(['coder'], 'one-off')).not.toThrow()
  })

  it('evaluates the bug-intake requirement over the enabled subset', () => {
    // A DISABLED bug-intake step never runs, so it imposes no recurring requirement — the
    // pipeline may be saved as 'both'/'one-off' (parity with every other check in this file).
    expect(() =>
      assertPipelineLaunchable(['bug-intake', 'coder'], 'both', undefined, [false, true]),
    ).not.toThrow()
    expect(() =>
      assertPipelineLaunchable(['bug-intake', 'coder'], 'one-off', 'manual', [false, true]),
    ).not.toThrow()
    // An ENABLED bug-intake step (explicit true, or default when the mask omits it) still requires
    // recurring.
    expect(() =>
      assertPipelineLaunchable(['bug-intake', 'coder'], 'both', undefined, [true, true]),
    ).toThrow()
    expect(() =>
      assertPipelineLaunchable(['bug-intake', 'coder'], 'both', undefined, [
        undefined as never,
        true,
      ]),
    ).toThrow()
  })
})
