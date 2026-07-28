import { describe, expect, it } from 'vitest'
import type { BugCandidate } from './types.js'
import { bugHuntScore, parseBugHuntVerdicts, rankBugCandidates } from './bug-hunt-logic.js'

function candidate(externalId: string, overrides: Partial<BugCandidate> = {}): BugCandidate {
  return {
    source: 'jira',
    externalId,
    title: `Bug ${externalId}`,
    url: `https://tracker.test/${externalId}`,
    status: 'To Do',
    type: 'Bug',
    priority: null,
    labels: [],
    description: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    commentCount: 0,
    ...overrides,
  }
}

describe('bugHuntScore', () => {
  it('is impact per unit of complexity, to two decimals', () => {
    expect(bugHuntScore(5, 2)).toBe(2.5)
    expect(bugHuntScore(4, 3)).toBe(1.33)
    expect(bugHuntScore(1, 5)).toBe(0.2)
  })

  it('clamps ratings into 1-5 so an out-of-range judgement cannot distort the ordering', () => {
    expect(bugHuntScore(99, 1)).toBe(5)
    expect(bugHuntScore(5, 0)).toBe(5)
    expect(bugHuntScore(-3, 1)).toBe(1)
  })

  it('degrades a non-numeric rating to the midpoint rather than NaN', () => {
    expect(bugHuntScore(Number.NaN, 3)).toBe(1)
  })
})

describe('parseBugHuntVerdicts', () => {
  it('accepts the wrapped shape and computes the score itself', () => {
    const verdicts = parseBugHuntVerdicts({
      candidates: [
        // The model's own `score` is deliberately wrong here: it must not be read.
        {
          externalId: 'PROJ-1',
          impact: 4,
          complexity: 2,
          score: 99,
          confidence: 'high',
          rationale: ' crashes checkout ',
          recommended: true,
        },
      ],
    })
    expect(verdicts.get('PROJ-1')).toEqual({
      impact: 4,
      complexity: 2,
      score: 2,
      confidence: 'high',
      rationale: 'crashes checkout',
      recommended: true,
    })
  })

  it('accepts a bare array', () => {
    const verdicts = parseBugHuntVerdicts([{ externalId: 'PROJ-2', impact: 2, complexity: 2 }])
    expect(verdicts.get('PROJ-2')?.score).toBe(1)
  })

  it('skips rows with no usable externalId and keeps the first verdict for a duplicate', () => {
    const verdicts = parseBugHuntVerdicts({
      candidates: [
        { impact: 5, complexity: 1 },
        { externalId: '   ', impact: 5, complexity: 1 },
        { externalId: 'PROJ-3', impact: 5, complexity: 1 },
        { externalId: 'PROJ-3', impact: 1, complexity: 5 },
        'not an object',
      ],
    })
    expect([...verdicts.keys()]).toEqual(['PROJ-3'])
    expect(verdicts.get('PROJ-3')?.impact).toBe(5)
  })

  it('coerces an unrecognised confidence to the cautious low, and a missing recommended to false', () => {
    const verdicts = parseBugHuntVerdicts([
      { externalId: 'PROJ-4', impact: 3, complexity: 3, confidence: 'certain' },
    ])
    expect(verdicts.get('PROJ-4')).toMatchObject({ confidence: 'low', recommended: false })
  })

  it('returns nothing for a reply that is not a ranking at all', () => {
    expect(parseBugHuntVerdicts(null).size).toBe(0)
    expect(parseBugHuntVerdicts('sorry, I cannot help with that').size).toBe(0)
  })
})

describe('rankBugCandidates', () => {
  it('orders assessed candidates by score, breaking ties on impact', () => {
    const ranked = rankBugCandidates(
      [candidate('A'), candidate('B'), candidate('C')],
      parseBugHuntVerdicts([
        { externalId: 'A', impact: 2, complexity: 2 }, // 1.0
        { externalId: 'B', impact: 4, complexity: 1 }, // 4.0
        { externalId: 'C', impact: 4, complexity: 4 }, // 1.0, higher impact than A
      ]),
    )
    expect(ranked.map((r) => r.externalId)).toEqual(['B', 'C', 'A'])
  })

  it('joins case-insensitively, since vendors and models disagree on issue-key case', () => {
    const ranked = rankBugCandidates(
      [candidate('proj-9')],
      parseBugHuntVerdicts([{ externalId: 'PROJ-9', impact: 5, complexity: 1 }]),
    )
    expect(ranked[0]?.analysis?.score).toBe(5)
  })

  it('keeps unassessed candidates, sorted last in provider order', () => {
    const ranked = rankBugCandidates(
      [candidate('OLD'), candidate('NEW'), candidate('RATED')],
      parseBugHuntVerdicts([{ externalId: 'RATED', impact: 1, complexity: 5 }]),
    )
    expect(ranked.map((r) => r.externalId)).toEqual(['RATED', 'OLD', 'NEW'])
    expect(ranked[1]?.analysis).toBeNull()
    expect(ranked[2]?.analysis).toBeNull()
  })

  it('drops a verdict for an issue the board never returned', () => {
    const ranked = rankBugCandidates(
      [candidate('REAL')],
      parseBugHuntVerdicts([
        { externalId: 'HALLUCINATED', impact: 5, complexity: 1 },
        { externalId: 'REAL', impact: 2, complexity: 2 },
      ]),
    )
    expect(ranked).toHaveLength(1)
    expect(ranked[0]?.externalId).toBe('REAL')
  })

  it('returns every candidate untouched when there is no analysis at all', () => {
    const ranked = rankBugCandidates([candidate('A'), candidate('B')], new Map())
    expect(ranked.map((r) => r.externalId)).toEqual(['A', 'B'])
    expect(ranked.every((r) => r.analysis === null)).toBe(true)
  })
})
