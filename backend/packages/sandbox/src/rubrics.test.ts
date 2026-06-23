import { describe, expect, it } from 'vitest'
import { rubricFor, scoreExpectedFindings, weightedTotal } from './rubrics.js'

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

describe('scoreExpectedFindings', () => {
  it('counts case- and whitespace-insensitive substring matches', () => {
    const out = scoreExpectedFindings(
      ['missing reset logic', 'off-by-one error'],
      'The token bucket has a MISSING   reset logic bug, but counting is fine.',
    )
    expect(out.matched).toBe(1)
    expect(out.total).toBe(2)
    expect(out.recall).toBe(0.5)
    expect(out.missing).toEqual(['off-by-one error'])
  })

  it('treats an empty expected set as full recall', () => {
    expect(scoreExpectedFindings([], 'anything')).toMatchObject({ matched: 0, total: 0, recall: 1 })
  })
})
