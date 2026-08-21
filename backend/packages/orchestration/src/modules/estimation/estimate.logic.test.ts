import { describe, expect, it } from 'vitest'
import type { TaskEstimate } from '@cat-factory/kernel'
import { coerceTaskEstimate, reviseTaskEstimate, summarizeEstimate } from './estimate.logic.js'

// The pure half of task assessment: what the platform reads off a triage reply, what the block
// then holds, and what a human sees in place of the raw JSON. Two agent kinds produce these
// scores (the inline `task-estimator` forecasts them, the container `task-reassessor` measures
// them), so every case below is about the two readings staying distinguishable.

const NOW = 1_700_000_000_000

const forecast = (over: Partial<TaskEstimate> = {}): TaskEstimate => ({
  complexity: 0.4,
  risk: 0.3,
  impact: 0.5,
  rationale: 'reads like a small change',
  model: 'model-a',
  createdAt: NOW - 60_000,
  basis: 'predicted',
  ...over,
})

describe('coerceTaskEstimate', () => {
  it("reads the reply a producer returns, stamping the caller's basis", () => {
    const estimate = coerceTaskEstimate(
      '{"complexity": 0.8, "risk": 0.6, "impact": 0.9, "rationale": "touched the auth path"}',
      'model-b',
      NOW,
      'observed',
    )
    expect(estimate).toEqual({
      complexity: 0.8,
      risk: 0.6,
      impact: 0.9,
      rationale: 'touched the auth path',
      model: 'model-b',
      createdAt: NOW,
      basis: 'observed',
    })
  })

  it('finds JSON embedded in prose, and clamps the axes', () => {
    const estimate = coerceTaskEstimate(
      'Here is my triage:\n```json\n{"complexity": 1.4, "risk": -2, "impact": 0.5}\n```\n',
      null,
      NOW,
    )
    expect(estimate).toMatchObject({ complexity: 1, risk: 0, impact: 0.5, rationale: '' })
  })

  it('defaults the basis to a forecast, so only a caller can claim a measurement', () => {
    // The basis follows from which STEP ran. A reply claiming `basis: "observed"` must not be able
    // to promote a forecast into a measurement of a change nobody read.
    const estimate = coerceTaskEstimate(
      '{"complexity": 0.1, "risk": 0.1, "impact": 0.1, "basis": "observed"}',
      null,
      NOW,
    )
    expect(estimate?.basis).toBe('predicted')
  })

  it('records NOTHING when an axis is missing or unreadable', () => {
    // The caller then leaves the block's estimate untouched. Nothing acts on this record
    // structurally, so an unreadable reply must not become a maximally severe task that silently
    // changes what every estimate gate decides.
    expect(coerceTaskEstimate('{"complexity": 0.5, "risk": 0.5}', null, NOW)).toBeNull()
    expect(
      coerceTaskEstimate('{"complexity": 0.5, "risk": 0.5, "impact": null}', null, NOW),
    ).toBeNull()
    expect(coerceTaskEstimate('no json here at all', null, NOW)).toBeNull()
    expect(coerceTaskEstimate('', null, NOW)).toBeNull()
  })
})

describe('reviseTaskEstimate', () => {
  const measured = coerceTaskEstimate(
    '{"complexity": 0.8, "risk": 0.6, "impact": 0.9, "rationale": "wider than it looked"}',
    'model-b',
    NOW,
    'observed',
  )!

  it('carries the forecast it replaced, so calibration stays answerable', () => {
    const revised = reviseTaskEstimate(forecast(), measured)
    expect(revised).toMatchObject({ complexity: 0.8, basis: 'observed' })
    expect(revised.supersedes).toEqual({
      complexity: 0.4,
      risk: 0.3,
      impact: 0.5,
      basis: 'predicted',
      model: 'model-a',
      createdAt: NOW - 60_000,
    })
  })

  it('reads an estimate with NO basis as the forecast it was', () => {
    // Rows written before the vocabulary existed carry no basis and are read back without a schema
    // pass. Every one of them came from the estimator.
    const stored = { ...forecast(), basis: undefined } as TaskEstimate
    expect(reviseTaskEstimate(stored, measured).supersedes?.basis).toBe('predicted')
  })

  it('supersedes nothing when there was nothing before it', () => {
    // The "generate in the first place" case: a pipeline with no estimator, measured after the
    // change landed.
    expect(reviseTaskEstimate(null, measured).supersedes).toBeUndefined()
  })

  it('supersedes nothing when the basis is unchanged and there was no pair', () => {
    // Two consecutive forecasts (a re-run of the estimator) are one forecast revised, not a
    // prediction/measurement pair. Recording the earlier one would render a comparison that never
    // happened.
    const second = coerceTaskEstimate('{"complexity": 0.2, "risk": 0.2, "impact": 0.2}', null, NOW)!
    expect(reviseTaskEstimate(forecast(), second).supersedes).toBeUndefined()
  })

  it('INHERITS the pair when the basis is unchanged, rather than deleting the forecast', () => {
    // A retried reassessor step measures a second time. Its predecessor is the first measurement,
    // so nothing new was superseded, but dropping what that record carried would delete the
    // forecast the comparison exists for.
    const first = reviseTaskEstimate(forecast(), measured)
    const retried = coerceTaskEstimate(
      '{"complexity": 0.7, "risk": 0.6, "impact": 0.9}',
      null,
      NOW + 1,
      'observed',
    )!
    const second = reviseTaskEstimate(first, retried)
    expect(second.complexity).toBe(0.7)
    expect(second.supersedes).toMatchObject({ basis: 'predicted', complexity: 0.4 })
  })

  it('keeps the chain one level deep', () => {
    const once = reviseTaskEstimate(forecast(), measured)
    const twice = reviseTaskEstimate(once, forecast({ createdAt: NOW + 1 }))
    expect(twice.supersedes).toMatchObject({ basis: 'observed', complexity: 0.8 })
    expect(twice.supersedes && 'supersedes' in twice.supersedes).toBe(false)
  })
})

describe('summarizeEstimate', () => {
  it('titles a forecast and a measurement differently', () => {
    expect(summarizeEstimate(forecast())).toContain('Task estimate (predicted)')
    expect(summarizeEstimate({ ...forecast(), basis: 'observed' })).toContain(
      'Task assessment (from the change that landed)',
    )
  })

  it('reads a missing basis as a forecast', () => {
    const stored = { ...forecast(), basis: undefined } as TaskEstimate
    expect(summarizeEstimate(stored)).toContain('Task estimate (predicted)')
  })

  it('says so when the basis is one this build cannot name', () => {
    // `basis` is persisted and read back with a plain `JSON.parse`, so a value retired from the
    // union reaches this function. Splicing `undefined` into the operator's summary, or guessing
    // onto a current member, are both worse than saying it is unrecognised.
    const stale = { ...forecast(), basis: 'sampled' } as unknown as TaskEstimate
    const summary = summarizeEstimate(stale)
    expect(summary).toContain('basis no longer recognised')
    expect(summary).not.toContain('undefined')
    expect(summary).toContain('Complexity 40%')
  })

  it('states the movement when a measurement corrected a forecast', () => {
    const revised = reviseTaskEstimate(
      forecast(),
      coerceTaskEstimate('{"complexity": 0.8, "risk": 0.6, "impact": 0.9}', null, NOW, 'observed')!,
    )
    const summary = summarizeEstimate(revised)
    expect(summary).toContain('Complexity 80%')
    expect(summary).toContain('complexity 40% → 80%')
    expect(summary).toContain('risk 30% → 60%')
  })

  it('says nothing about movement when there is none to state', () => {
    expect(summarizeEstimate(forecast())).not.toContain('→')
  })
})
