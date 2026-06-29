import { describe, expect, it } from 'vitest'
import type { StepGating, TaskEstimate } from '@cat-factory/kernel'
import { shouldRunGatedStep } from './stepGating.logic.js'

const estimate = (complexity: number, risk: number, impact: number): TaskEstimate => ({
  complexity,
  risk,
  impact,
  rationale: '',
  createdAt: 0,
})

describe('shouldRunGatedStep', () => {
  it('runs when there is no gating or gating is disabled', () => {
    expect(shouldRunGatedStep(estimate(0, 0, 0), undefined)).toBe(true)
    expect(shouldRunGatedStep(estimate(0, 0, 0), null)).toBe(true)
    expect(
      shouldRunGatedStep(estimate(0, 0, 0), {
        enabled: false,
        minRisk: 0.9,
        onMissingEstimate: 'run',
      }),
    ).toBe(true)
  })

  it('runs iff ANY supplied axis is met or exceeded (OR)', () => {
    const gating: StepGating = {
      enabled: true,
      minRisk: 0.6,
      minImpact: 0.6,
      onMissingEstimate: 'run',
    }
    expect(shouldRunGatedStep(estimate(0.9, 0.1, 0.1), gating)).toBe(false) // complexity not gated on
    expect(shouldRunGatedStep(estimate(0.1, 0.7, 0.1), gating)).toBe(true) // risk clears
    expect(shouldRunGatedStep(estimate(0.1, 0.1, 0.6), gating)).toBe(true) // impact exactly meets
    expect(shouldRunGatedStep(estimate(0.1, 0.1, 0.1), gating)).toBe(false) // nothing clears
  })

  it('a gating block with no thresholds never triggers on score → skip', () => {
    expect(shouldRunGatedStep(estimate(1, 1, 1), { enabled: true, onMissingEstimate: 'run' })).toBe(
      false,
    )
  })

  it('falls back to onMissingEstimate when no estimate is present (default run)', () => {
    expect(
      shouldRunGatedStep(null, { enabled: true, minRisk: 0.6, onMissingEstimate: 'run' }),
    ).toBe(true)
    expect(
      shouldRunGatedStep(undefined, { enabled: true, minRisk: 0.6, onMissingEstimate: 'skip' }),
    ).toBe(false)
  })
})
