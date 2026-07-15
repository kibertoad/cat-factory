import { describe, expect, it } from 'vitest'
import type { PrReviewAgentOutput, PrReviewFinding } from '@cat-factory/kernel'
import {
  buildPrReviewPost,
  coercePrReview,
  renderPrReviewFixerFeedback,
  severityRank,
} from './prReview.logic.js'

const finding = (over: Partial<PrReviewFinding>): PrReviewFinding => ({
  id: 'prf_x',
  sliceId: null,
  path: 'src/a.ts',
  line: null,
  side: null,
  severity: 'medium',
  category: 'correctness',
  title: 'Finding',
  detail: 'detail',
  suggestedFix: null,
  ...over,
})

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

describe('renderPrReviewFixerFeedback', () => {
  it('renders each selected finding with its location, severity, detail and suggested fix', () => {
    const out = renderPrReviewFixerFeedback([
      finding({
        path: 'src/auth.ts',
        line: 12,
        severity: 'blocker',
        category: 'security',
        title: 'Auth bypass',
        detail: 'Missing check.',
        suggestedFix: 'Add a guard.',
      }),
      finding({
        path: 'README.md',
        line: null,
        severity: 'nit',
        title: 'Typo',
        detail: 'teh → the',
      }),
    ])
    expect(out).toContain('push it back onto the SAME branch')
    expect(out).toContain('[blocker · security] src/auth.ts:12 — Auth bypass')
    expect(out).toContain('Suggested fix: Add a guard.')
    // A line-less finding renders with just its path (no `:line`).
    expect(out).toContain('README.md — Typo')
    expect(out).not.toContain('README.md:')
  })
})

describe('buildPrReviewPost', () => {
  it('anchors line-carrying findings as inline COMMENT-review comments', () => {
    const post = buildPrReviewPost(
      [finding({ path: 'src/a.ts', line: 5, side: 'RIGHT', title: 'Bug', detail: 'boom' })],
      'Looks mostly good.',
    )
    expect(post.event).toBe('COMMENT')
    expect(post.comments).toHaveLength(1)
    expect(post.comments[0]).toMatchObject({ path: 'src/a.ts', line: 5, side: 'RIGHT' })
    expect(post.comments[0]!.body).toContain('Bug')
    // The reviewer summary rides the review body.
    expect(post.body).toContain('Looks mostly good.')
  })

  it('folds line-less findings into the review body instead of dropping them', () => {
    const post = buildPrReviewPost(
      [finding({ path: 'docs.md', line: null, title: 'No anchor', detail: 'general note' })],
      null,
    )
    expect(post.comments).toHaveLength(0)
    expect(post.body).toContain('No anchor')
    expect(post.body).toContain('general note')
  })

  it('always emits a non-empty body — falls back to a count when nothing else supplies one', () => {
    // All findings line-anchored + no summary: GitHub can reject a bodyless COMMENT review, so a
    // fallback body must be present (a count of the inline comments) rather than omitted.
    const post = buildPrReviewPost(
      [
        finding({ path: 'src/a.ts', line: 5, title: 'One', detail: 'x' }),
        finding({ path: 'src/b.ts', line: 9, title: 'Two', detail: 'y' }),
      ],
      null,
    )
    expect(post.comments).toHaveLength(2)
    expect(post.body).toBeTruthy()
    expect(post.body).toContain('2 inline findings')
  })
})
