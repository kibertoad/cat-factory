import { describe, expect, it } from 'vitest'
import {
  baselineVersionId,
  builtinFixture,
  listBuiltinFixtures,
  suggestExperiment,
} from './fixtures.js'
import { scoreExpectations } from './rubrics.js'

describe('listBuiltinFixtures', () => {
  it('projects every builtin definition to a valid wire fixture', () => {
    const fixtures = listBuiltinFixtures(1_700_000_000_000)
    expect(fixtures.length).toBeGreaterThan(0)
    expect(fixtures.every((f) => f.origin === 'builtin' && f.objective?.kind === 'findings')).toBe(
      true,
    )
  })
})

describe('baselineVersionId', () => {
  it('maps a catalog kind to its baseline lineage id', () => {
    expect(baselineVersionId('reviewer')).toBe('baseline:review')
    // architecture review has no numbered baseline → falls back to the agent kind.
    expect(baselineVersionId('architect-companion')).toBe('baseline:architect-companion')
  })
})

describe('suggestExperiment', () => {
  it('builds a cartesian matrix using the baseline prompt by default', () => {
    const exp = suggestExperiment({
      agentKind: 'reviewer',
      models: ['anthropic:claude-opus-4-8', 'cf:llama'],
      fixtureIds: ['review-token-bucket-simple'],
    })
    expect(exp.agentKind).toBe('reviewer')
    expect(exp.matrix.promptVersionIds).toEqual(['baseline:review'])
    expect(exp.matrix.models).toHaveLength(2)
    expect(exp.matrix.fixtureIds).toEqual(['review-token-bucket-simple'])
    expect(exp.repeats).toBe(1)
    // judgeModel omitted so the API applies its default.
    expect(exp.judgeModel).toBeUndefined()
  })

  it('honors supplied candidate prompts, judge and repeats', () => {
    const exp = suggestExperiment({
      agentKind: 'requirements-review',
      models: ['anthropic:claude-opus-4-8'],
      fixtureIds: ['req-notify-prefs-simple'],
      promptVersionIds: ['lineage-1', 'lineage-2'],
      judgeModel: 'anthropic:claude-opus-4-8',
      repeats: 3,
    })
    expect(exp.matrix.promptVersionIds).toEqual(['lineage-1', 'lineage-2'])
    expect(exp.judgeModel).toBe('anthropic:claude-opus-4-8')
    expect(exp.repeats).toBe(3)
  })

  it('refuses an empty model or fixture selection', () => {
    expect(() =>
      suggestExperiment({ agentKind: 'reviewer', models: [], fixtureIds: ['x'] }),
    ).toThrow()
    expect(() =>
      suggestExperiment({ agentKind: 'reviewer', models: ['m'], fixtureIds: [] }),
    ).toThrow()
  })
})

describe('scoreExpectations against a real fixture', () => {
  const fixture = builtinFixture('review-token-bucket-simple')!
  const expectations = fixture.expectations

  it('rewards a thorough review that catches the high-impact and tricky findings', () => {
    const strong = [
      'This is not a token bucket: the count never resets, so it is a lifetime cap, not 100 per minute.',
      'The Map grows unbounded — one entry per IP, never evicted — a memory leak.',
      'The read-modify-write is not atomic, so concurrent requests race.',
    ].join(' ')
    const out = scoreExpectations(expectations, strong)
    expect(out.impactRecall).toBe(1)
    expect(out.wowBonus).toBe(1)
    expect(out.missedHighImpact).toEqual([])
  })

  it('punishes missing the high-impact finding far more than missing a tricky one', () => {
    // Catches only the subtle concurrency point (tricky, low impact) and misses the
    // headline "no window reset" (high impact) and the memory leak.
    const weak = 'The read-modify-write is not atomic, so concurrent requests race.'
    const out = scoreExpectations(expectations, weak)
    expect(out.missedHighImpact).toContain('no-window-reset')
    expect(out.impactRecall).toBeLessThan(0.5)
    // It did catch the tricky concurrency item, so some wow bonus is earned.
    expect(out.wowBonus).toBeGreaterThan(0)
  })
})
