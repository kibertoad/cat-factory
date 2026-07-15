import { describe, expect, it } from 'vitest'
import type { PrReviewAgentOutput } from '@cat-factory/kernel'
import { coercePrReview, severityRank } from './prReview.logic.js'

function ids(prefix: string): () => string {
  let n = 0
  return () => `${prefix}${++n}`
}

describe('coercePrReview', () => {
  it('mints ids, anchors findings to their slice, and sorts blocker-first', () => {
    const output: PrReviewAgentOutput = {
      summary: '  Overall solid.  ',
      slices: [
        { title: 'Auth', rationale: 'auth + tests', paths: ['src/auth.ts', 'test/auth.test.ts'] },
        { title: 'API', rationale: 'route', paths: ['src/api.ts'] },
      ],
      findings: [
        {
          path: 'src/api.ts',
          severity: 'nit',
          category: 'style',
          title: 'naming',
          detail: 'rename x',
        },
        {
          path: 'src/auth.ts',
          line: 12,
          side: 'RIGHT',
          severity: 'blocker',
          category: 'security',
          title: 'auth bypass',
          detail: 'missing check',
          suggestedFix: 'add guard',
        },
      ],
    }
    const review = coercePrReview(output, ids('prs_'), ids('prf_'))
    expect(review.summary).toBe('Overall solid.')
    expect(review.slices.map((s) => s.id)).toEqual(['prs_1', 'prs_2'])
    // Sorted blocker → nit (ids are minted in input order, then sorted for display).
    expect(review.findings.map((f) => f.severity)).toEqual(['blocker', 'nit'])
    const blocker = review.findings[0]!
    const nit = review.findings[1]!
    // Every finding gets a distinct minted id.
    expect(blocker.id).toMatch(/^prf_/)
    expect(nit.id).toMatch(/^prf_/)
    expect(blocker.id).not.toBe(nit.id)
    // The blocker anchors to the Auth slice (its path is listed there); the nit to the API slice.
    expect(blocker.sliceId).toBe('prs_1')
    expect(blocker.line).toBe(12)
    expect(blocker.suggestedFix).toBe('add guard')
    expect(nit.sliceId).toBe('prs_2')
  })

  it('drops empty slices/findings and leaves an unmatched finding sliceId null', () => {
    const output: PrReviewAgentOutput = {
      summary: undefined,
      slices: [{ title: '', rationale: '', paths: [] }],
      findings: [
        { path: '', severity: 'medium', category: 'other', title: '', detail: '' },
        {
          path: 'unlisted.ts',
          severity: 'high',
          category: 'correctness',
          title: 'bug',
          detail: 'x',
        },
      ],
    }
    const review = coercePrReview(output, ids('prs_'), ids('prf_'))
    expect(review.summary).toBeNull()
    expect(review.slices).toEqual([])
    expect(review.findings).toHaveLength(1)
    expect(review.findings[0]!.sliceId).toBeNull()
  })

  it('is total for a missing output', () => {
    const review = coercePrReview(undefined, ids('prs_'), ids('prf_'))
    expect(review).toEqual({ summary: null, slices: [], findings: [] })
  })

  it('ranks severities blocker-first', () => {
    expect(severityRank('blocker')).toBeLessThan(severityRank('high'))
    expect(severityRank('low')).toBeLessThan(severityRank('nit'))
  })
})
