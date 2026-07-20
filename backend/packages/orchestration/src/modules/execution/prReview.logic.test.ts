import { describe, expect, it } from 'vitest'
import type { PrReviewAgentOutput, PrReviewFinding } from '@cat-factory/kernel'
import type { CreateReviewResult, GitHubChangedFile } from '@cat-factory/kernel'
import {
  buildPrReviewPost,
  buildPrReviewPostReport,
  coercePrReview,
  computeCommentableLines,
  initialPrReviewState,
  isPrReviewPostComplete,
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

describe('initialPrReviewState', () => {
  it('seeds an empty `reviewing` state carrying the PR + model, so the window shows a real phase', () => {
    const state = initialPrReviewState(
      'https://github.com/o/r/pull/42',
      'anthropic:claude',
      'head-sha-123',
    )
    expect(state).toEqual({
      status: 'reviewing',
      summary: null,
      slices: [],
      findings: [],
      selectedFindingIds: [],
      resolution: null,
      prUrl: 'https://github.com/o/r/pull/42',
      model: 'anthropic:claude',
      reviewedHeadSha: 'head-sha-123',
      postReport: null,
      postedFindingIds: [],
      postedBody: false,
    })
  })

  it('tolerates an unknown PR / model (null), and the recordFindings guard coerces over it', () => {
    const state = initialPrReviewState(null, null)
    expect(state.status).toBe('reviewing')
    expect(state.prUrl).toBeNull()
    expect(state.model).toBeNull()
    // The completion interceptor treats `reviewing` as "not yet recorded" (it only short-circuits
    // on a status OTHER than `reviewing`), so a seeded run still coerces its findings on completion.
    expect(state.status).toBe('reviewing')
  })
})

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
    const { input, commentFindingIds } = buildPrReviewPost(
      [
        finding({
          id: 'prf_1',
          path: 'src/a.ts',
          line: 5,
          side: 'RIGHT',
          title: 'Bug',
          detail: 'boom',
        }),
      ],
      'Looks mostly good.',
    )
    expect(input.event).toBe('COMMENT')
    expect(input.comments).toHaveLength(1)
    expect(input.comments[0]).toMatchObject({ path: 'src/a.ts', line: 5, side: 'RIGHT' })
    expect(input.comments[0]!.body).toContain('Bug')
    expect(commentFindingIds).toEqual(['prf_1'])
    // The reviewer summary rides the review body.
    expect(input.body).toContain('Looks mostly good.')
  })

  it('folds line-less findings into the review body instead of dropping them', () => {
    const { input, foldedFindingIds } = buildPrReviewPost(
      [finding({ path: 'docs.md', line: null, title: 'No anchor', detail: 'general note' })],
      null,
    )
    expect(input.comments).toHaveLength(0)
    expect(input.body).toContain('No anchor')
    expect(input.body).toContain('general note')
    // A truly line-less finding is summarised, not counted as "folded" (it never could be inline).
    expect(foldedFindingIds).toEqual([])
  })

  it('folds a finding whose line is OUTSIDE the diff into the body (avoids the 422 at the source)', () => {
    const commentable = computeCommentableLines([
      {
        path: 'src/a.ts',
        previousPath: null,
        status: 'modified',
        additions: 1,
        deletions: 0,
        patch: '@@ -1,1 +1,2 @@\n ctx\n+added',
      },
    ])
    const { input, commentFindingIds, foldedFindingIds } = buildPrReviewPost(
      [
        finding({ id: 'prf_in', path: 'src/a.ts', line: 2, title: 'In diff', detail: 'x' }),
        finding({ id: 'prf_out', path: 'src/a.ts', line: 999, title: 'Out of diff', detail: 'y' }),
      ],
      null,
      commentable,
    )
    // Only the in-diff finding is anchored inline; the out-of-diff one is folded into the body.
    expect(input.comments).toHaveLength(1)
    expect(commentFindingIds).toEqual(['prf_in'])
    expect(foldedFindingIds).toEqual(['prf_out'])
    expect(input.body).toContain('Out of diff')
  })

  it('always emits a non-empty body — falls back to a count when nothing else supplies one', () => {
    const { input } = buildPrReviewPost(
      [
        finding({ path: 'src/a.ts', line: 5, title: 'One', detail: 'x' }),
        finding({ path: 'src/b.ts', line: 9, title: 'Two', detail: 'y' }),
      ],
      null,
    )
    expect(input.comments).toHaveLength(2)
    expect(input.body).toBeTruthy()
    expect(input.body).toContain('2 inline findings')
  })

  it('folds ALL line-carrying findings into the summary when staleHead (branch moved since review)', () => {
    // Even a line that IS in the diff is folded, because the branch moved and the number may have
    // drifted — nothing is anchored inline.
    const commentable = computeCommentableLines([
      {
        path: 'src/a.ts',
        previousPath: null,
        status: 'modified',
        additions: 1,
        deletions: 0,
        patch: '@@ -1,1 +1,2 @@\n ctx\n+added',
      },
    ])
    const { input, commentFindingIds, foldedFindingIds } = buildPrReviewPost(
      [
        finding({ id: 'prf_a', path: 'src/a.ts', line: 2, title: 'In diff', detail: 'x' }),
        finding({ id: 'prf_b', path: 'src/a.ts', line: 1, title: 'Also in diff', detail: 'y' }),
      ],
      'Summary.',
      commentable,
      { staleHead: true },
    )
    expect(input.comments).toHaveLength(0)
    expect(commentFindingIds).toEqual([])
    expect(foldedFindingIds).toEqual(['prf_a', 'prf_b'])
    expect(input.body).toContain('branch was updated')
    expect(input.body).toContain('In diff')
    expect(input.body).toContain('Also in diff')
  })

  it('drops the summary prose but keeps the folded findings when summaryAlreadyPosted (stale retry)', () => {
    // A stale-head RETRY: the summary already landed on the first attempt, but a finding that
    // failed to post inline then drifted must still be delivered. The body carries the finding
    // WITHOUT re-posting the summary prose, so the review isn't lost and isn't duplicated.
    const { input, foldedFindingIds } = buildPrReviewPost(
      [finding({ id: 'prf_a', path: 'src/a.ts', line: 2, title: 'Drifted finding', detail: 'x' })],
      'Summary prose that already landed.',
      undefined,
      { staleHead: true, summaryAlreadyPosted: true },
    )
    expect(input.comments).toHaveLength(0)
    expect(foldedFindingIds).toEqual(['prf_a'])
    // The drifted finding is delivered...
    expect(input.body).toContain('branch was updated')
    expect(input.body).toContain('Drifted finding')
    // ...but the already-posted summary prose is NOT repeated.
    expect(input.body).not.toContain('Summary prose that already landed.')
  })
})

describe('computeCommentableLines', () => {
  const file = (patch: string | null): GitHubChangedFile => ({
    path: 'f.ts',
    previousPath: null,
    status: 'modified',
    additions: 0,
    deletions: 0,
    patch,
  })

  it('collects added + context lines on RIGHT and removed + context on LEFT', () => {
    // @@ -10,3 +10,3 @@ : context 10, remove old 11, add new 11, context (new 12/old 12).
    const map = computeCommentableLines([file('@@ -10,3 +10,3 @@\n ctx\n-gone\n+added\n tail')])
    const lines = map.get('f.ts')!
    expect([...lines.right].sort((a, b) => a - b)).toEqual([10, 11, 12])
    expect([...lines.left].sort((a, b) => a - b)).toEqual([10, 11, 12])
  })

  it('omits a file with no patch (binary / too large) so its findings fall back to a direct attempt', () => {
    expect(computeCommentableLines([file(null)]).has('f.ts')).toBe(false)
  })
})

describe('buildPrReviewPostReport', () => {
  const selected = [
    finding({ id: 'prf_ok', path: 'a.ts', line: 3, title: 'ok' }),
    finding({ id: 'prf_bad', path: 'b.ts', line: 9, title: 'bad' }),
  ]

  it('maps per-comment outcomes to a report + the newly-posted finding ids', () => {
    const built = buildPrReviewPost(selected, 'sum')
    const result: CreateReviewResult = {
      comments: [{ posted: true }, { posted: false, error: 'Line could not be resolved' }],
      bodyPosted: true,
    }
    const { report, newlyPostedFindingIds } = buildPrReviewPostReport(built, selected, result)
    expect(report.attempted).toBe(2)
    expect(report.posted).toBe(1)
    expect(report.bodyPosted).toBe(true)
    expect(report.failures).toEqual([
      { findingId: 'prf_bad', path: 'b.ts', line: 9, reason: 'Line could not be resolved' },
    ])
    expect(newlyPostedFindingIds).toEqual(['prf_ok'])
    expect(isPrReviewPostComplete(report)).toBe(false)
  })

  it('reports a fully-successful attempt as complete', () => {
    const built = buildPrReviewPost([selected[0]!], null)
    const result: CreateReviewResult = { comments: [{ posted: true }], bodyPosted: null }
    const { report } = buildPrReviewPostReport(built, [selected[0]!], result)
    expect(report.posted).toBe(1)
    expect(report.failures).toEqual([])
    expect(isPrReviewPostComplete(report)).toBe(true)
  })
})
