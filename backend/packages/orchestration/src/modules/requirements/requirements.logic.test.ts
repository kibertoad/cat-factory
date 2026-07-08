import { describe, expect, it } from 'vitest'
import type {
  RequirementReviewItem,
  ReviewItemSeverity,
  ReviewItemStatus,
} from '@cat-factory/kernel'
import {
  buildReviewPrompt,
  coerceChunkRecommendations,
  coerceReviewItems,
  disposeReview,
  hasNotesToIncorporate,
} from './requirements.logic.js'

function item(
  severity: ReviewItemSeverity,
  status: ReviewItemStatus = 'open',
): RequirementReviewItem {
  return {
    id: `i_${severity}_${status}`,
    category: 'gap',
    severity,
    title: 't',
    detail: 'd',
    status,
    reply: null,
    createdAt: 0,
    updatedAt: 0,
  }
}

describe('disposeReview', () => {
  const budget = { iteration: 1, maxIterations: 3 }

  it('auto-passes when there are no findings', () => {
    expect(disposeReview([], { ...budget, concernThreshold: 'none' })).toBe('auto-pass')
  })

  it('stops for a human when any finding exceeds the tolerated severity', () => {
    expect(disposeReview([item('high')], { ...budget, concernThreshold: 'none' })).toBe('awaiting')
    expect(disposeReview([item('low')], { ...budget, concernThreshold: 'none' })).toBe('awaiting')
  })

  it('auto-passes when every finding is at or below the tolerated severity', () => {
    expect(
      disposeReview([item('low'), item('medium')], { ...budget, concernThreshold: 'medium' }),
    ).toBe('auto-pass')
    // A single high finding above the medium bar still stops.
    expect(
      disposeReview([item('low'), item('high')], { ...budget, concernThreshold: 'medium' }),
    ).toBe('awaiting')
  })

  it('ignores dismissed/resolved findings when judging severity', () => {
    expect(
      disposeReview([item('high', 'dismissed'), item('low', 'open')], {
        ...budget,
        concernThreshold: 'none',
      }),
    ).toBe('awaiting')
    expect(
      disposeReview([item('high', 'dismissed')], { ...budget, concernThreshold: 'none' }),
    ).toBe('auto-pass')
  })

  it('reports exceeded once the iteration budget is spent and findings remain', () => {
    expect(
      disposeReview([item('high')], { iteration: 3, maxIterations: 3, concernThreshold: 'none' }),
    ).toBe('exceeded')
    // Tolerated findings auto-pass even at the cap.
    expect(
      disposeReview([item('low')], { iteration: 3, maxIterations: 3, concernThreshold: 'high' }),
    ).toBe('auto-pass')
  })

  it('rejects a non-positive cap or sub-1 iteration counter as a wiring bug', () => {
    expect(() =>
      disposeReview([item('high')], { iteration: 1, maxIterations: 0, concernThreshold: 'none' }),
    ).toThrow(/maxIterations/)
    expect(() =>
      disposeReview([item('high')], { iteration: 0, maxIterations: 3, concernThreshold: 'none' }),
    ).toThrow(/iteration/)
  })
})

describe('hasNotesToIncorporate', () => {
  const answered = (): RequirementReviewItem => ({
    ...item('medium', 'answered'),
    reply: 'use UTC timestamps',
  })

  it('is false when every finding was dismissed (nothing to fold in)', () => {
    expect(hasNotesToIncorporate([item('high', 'dismissed'), item('low', 'dismissed')])).toBe(false)
  })

  it('is false with no items and no feedback', () => {
    expect(hasNotesToIncorporate([])).toBe(false)
  })

  it('is true when a finding was answered with a non-empty reply', () => {
    expect(hasNotesToIncorporate([item('low', 'dismissed'), answered()])).toBe(true)
  })

  it('ignores an answered finding whose reply is blank', () => {
    expect(hasNotesToIncorporate([{ ...item('medium', 'answered'), reply: '   ' }])).toBe(false)
  })

  it('is true when the human gave freeform redo feedback even with no answers', () => {
    expect(hasNotesToIncorporate([item('low', 'dismissed')], 'restructure around tenants')).toBe(
      true,
    )
  })
})

describe('buildReviewPrompt', () => {
  it('instructs the reviewer to assign a severity to every finding', () => {
    const prompt = buildReviewPrompt({
      block: { title: 'T', type: 'service', description: 'do a thing' },
      docs: [],
      tasks: [],
    })
    expect(prompt).toContain('severity')
    expect(prompt).toContain('Assign a severity to EVERY item')
  })

  it('instructs the reviewer to classify each finding as autoAnswerable', () => {
    const prompt = buildReviewPrompt({
      block: { title: 'T', type: 'service', description: 'do a thing' },
      docs: [],
      tasks: [],
    })
    expect(prompt).toContain('autoAnswerable')
  })
})

describe('coerceReviewItems', () => {
  let n = 0
  const newId = () => `id-${n++}`

  it('carries the reviewer autoAnswerable classification, defaulting non-true to false', () => {
    n = 0
    const items = coerceReviewItems(
      {
        items: [
          { title: 'a', detail: 'da', severity: 'high', autoAnswerable: true },
          { title: 'b', detail: 'db', severity: 'high', autoAnswerable: false },
          { title: 'c', detail: 'dc', severity: 'high' }, // missing ⇒ false
          { title: 'd', detail: 'dd', severity: 'high', autoAnswerable: 'yes' }, // non-bool ⇒ false
        ],
      },
      newId,
      0,
    )
    const byTitle = Object.fromEntries(items.map((i) => [i.title, i.autoAnswerable]))
    expect(byTitle).toEqual({ a: true, b: false, c: false, d: false })
  })
})

describe('coerceChunkRecommendations', () => {
  const findings = (...ids: string[]): RequirementReviewItem[] =>
    ids.map((id) => ({
      id,
      category: 'gap',
      severity: 'high',
      title: `title-${id}`,
      detail: `detail-${id}`,
      status: 'recommend_requested',
      reply: null,
      createdAt: 0,
      updatedAt: 0,
    }))

  it('routes each suggestion to its finding by the echoed itemId', () => {
    const out = coerceChunkRecommendations(
      {
        recommendations: [
          { itemId: 'b', recommendation: 'for B' },
          { itemId: 'a', recommendation: 'for A', fromStandard: 'std-1' },
        ],
      },
      findings('a', 'b'),
    )
    expect(out.get('a')).toEqual({ recommendation: 'for A', fromStandard: 'std-1' })
    expect(out.get('b')).toEqual({ recommendation: 'for B', fromStandard: null })
  })

  it('falls back to prompt order when the Writer omits the echoed itemIds', () => {
    // The whole batched response would otherwise be discarded (every finding force-reopened);
    // with no ids to route by, entries map to findings in the order the prompt listed them.
    const out = coerceChunkRecommendations(
      { recommendations: [{ recommendation: 'for A' }, { recommendation: 'for B' }] },
      findings('a', 'b'),
    )
    expect(out.get('a')).toEqual({ recommendation: 'for A', fromStandard: null })
    expect(out.get('b')).toEqual({ recommendation: 'for B', fromStandard: null })
  })

  it('mixes id-matched and positional fallback without stealing a matched entry', () => {
    // 'b' is echoed correctly; 'a' and 'c' come back id-less and fill the remaining findings in
    // order — the 'b' entry is consumed by its id match and not reused positionally.
    const out = coerceChunkRecommendations(
      {
        recommendations: [
          { recommendation: 'for A' },
          { itemId: 'b', recommendation: 'for B' },
          { recommendation: 'for C' },
        ],
      },
      findings('a', 'b', 'c'),
    )
    expect(out.get('a')).toEqual({ recommendation: 'for A', fromStandard: null })
    expect(out.get('b')).toEqual({ recommendation: 'for B', fromStandard: null })
    expect(out.get('c')).toEqual({ recommendation: 'for C', fromStandard: null })
  })

  it('drops entries with no recommendation text and leaves unfilled findings absent', () => {
    const out = coerceChunkRecommendations(
      { recommendations: [{ itemId: 'a', recommendation: '' }, { recommendation: '   ' }] },
      findings('a', 'b'),
    )
    expect(out.size).toBe(0)
  })
})
