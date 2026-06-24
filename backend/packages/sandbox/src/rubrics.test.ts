import type { SandboxExpectation } from '@cat-factory/contracts'
import { describe, expect, it } from 'vitest'
import { renderExpectationBrief, rubricFor, scoreExpectations, weightedTotal } from './rubrics.js'

const expectation = (
  over: Partial<SandboxExpectation> & Pick<SandboxExpectation, 'id'>,
): SandboxExpectation => ({
  summary: over.id,
  detail: '',
  trickiness: 1,
  impact: 1,
  matchHints: [],
  ...over,
})

describe('rubricFor', () => {
  it('returns the dimension set for each task', () => {
    expect(rubricFor('code-review').dimensions.map((d) => d.key)).toContain('issue_detection')
    expect(rubricFor('implementation').dimensions.map((d) => d.key)).toContain('faithfulness')
    expect(rubricFor('requirement-review').dimensions.map((d) => d.key)).toContain('gap_coverage')
  })
})

describe('weightedTotal', () => {
  it('computes the weighted mean using rubric weights', () => {
    // code-review weights: issue_detection 3, correctness 3, severity_order 1,
    // actionability 2, false_positives 2 → total weight 11.
    const scores = [
      { key: 'issue_detection', score: 5 },
      { key: 'correctness', score: 4 },
      { key: 'severity_order', score: 3 },
      { key: 'actionability', score: 4 },
      { key: 'false_positives', score: 2 },
    ]
    // (5*3 + 4*3 + 3*1 + 4*2 + 2*2) / 11 = (15+12+3+8+4)/11 = 42/11 = 3.818...
    expect(weightedTotal('code-review', scores)).toBe(3.82)
  })

  it('ignores unknown keys and missing dimensions', () => {
    expect(weightedTotal('code-review', [{ key: 'bogus', score: 5 }])).toBe(0)
  })

  it('weights only the dimensions present', () => {
    // Only issue_detection (w=3) present → mean is just its score.
    expect(weightedTotal('code-review', [{ key: 'issue_detection', score: 4 }])).toBe(4)
  })
})

describe('scoreExpectations', () => {
  it('matches an expectation via its summary, token-sequence (not substring)', () => {
    const out = scoreExpectations(
      [expectation({ id: 'a', summary: 'missing reset logic' })],
      'The token bucket has a MISSING   reset logic bug.',
    )
    expect(out.caught.map((e) => e.id)).toEqual(['a'])
    // `reset logic` must NOT match inside `preset logic`.
    const noMatch = scoreExpectations(
      [expectation({ id: 'a', summary: 'reset logic' })],
      'The preset logic is fine.',
    )
    expect(noMatch.missed.map((e) => e.id)).toEqual(['a'])
  })

  it('prefers matchHints over summary when present', () => {
    const out = scoreExpectations(
      [
        expectation({
          id: 'a',
          summary: 'unbounded memory growth',
          matchHints: ['Map', 'never evicted'],
        }),
      ],
      'The buckets are never evicted from the table.',
    )
    expect(out.caught.map((e) => e.id)).toEqual(['a'])
  })

  it('weights the miss penalty by impact (missing high-impact hurts most)', () => {
    const exps = [expectation({ id: 'low', impact: 1 }), expectation({ id: 'high', impact: 5 })]
    // Catch only the low-impact one → impactRecall = 1 - 5/6 ≈ 0.17, and the
    // high-impact miss is flagged.
    const out = scoreExpectations(exps, 'low')
    expect(out.impactRecall).toBe(0.17)
    expect(out.missedHighImpact).toEqual(['high'])
  })

  it('awards the wow bonus only for catching tricky items, never penalizes missing them', () => {
    const exps = [
      expectation({ id: 'tricky-caught', trickiness: 5, summary: 'tricky-caught' }),
      expectation({ id: 'tricky-missed', trickiness: 4, summary: 'tricky-missed' }),
      expectation({ id: 'easy', trickiness: 1, summary: 'easy' }),
    ]
    const out = scoreExpectations(exps, 'tricky-caught and easy are here')
    // wowBonus = 5 / (5 + 4) ≈ 0.56; the easy item does not dilute it.
    expect(out.wowBonus).toBe(0.56)
  })

  it('treats an empty expectation set as full recall and no wow on offer', () => {
    expect(scoreExpectations([], 'anything')).toMatchObject({ impactRecall: 1, wowBonus: 1 })
  })

  it('reports wowBonus 1 when nothing is tricky', () => {
    const out = scoreExpectations([expectation({ id: 'a', trickiness: 2, summary: 'a' })], 'a')
    expect(out.wowBonus).toBe(1)
  })
})

describe('renderExpectationBrief', () => {
  it('renders impact/trickiness and is empty for no expectations', () => {
    expect(renderExpectationBrief([])).toBe('')
    const brief = renderExpectationBrief([
      expectation({
        id: 'a',
        summary: 'no time-window reset',
        detail: 'lifetime cap, not a rate limit',
        impact: 5,
        trickiness: 3,
      }),
    ])
    expect(brief).toContain('no time-window reset')
    expect(brief).toContain('impact 5, trickiness 3')
    expect(brief).toContain('lifetime cap, not a rate limit')
  })
})
