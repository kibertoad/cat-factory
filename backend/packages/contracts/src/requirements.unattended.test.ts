import { describe, expect, it } from 'vitest'
import {
  clearsAutoAnswerFloor,
  DEFAULT_MIN_AUTO_ANSWER_CONFIDENCE,
  recommendationConfidenceBand,
  reviewSettledForUnattended,
} from './requirements.js'
import type { RequirementRecommendation, RequirementReviewItem } from './requirements.js'

// The rule that decides whether a run NOBODY IS WATCHING folds its requirements answers in and
// carries on, or parks for a person. It is the one place two independent judgements are combined —
// the reviewer's own "answerable without a product owner" classification and the Writer's grade of
// the specific answer — so these pin both halves, and above all the directions that must FAIL:
// a finding needing an owner, and an answer the Writer would not vouch for.

const item = (over: Partial<RequirementReviewItem> = {}): RequirementReviewItem => ({
  id: 'rri_1',
  category: 'question',
  severity: 'medium',
  title: 'page size',
  detail: 'what is the default page size?',
  status: 'open',
  reply: null,
  createdAt: 0,
  updatedAt: 0,
  ...over,
})

const autoRec = (
  itemId: string,
  confidence: number | null,
): Pick<RequirementRecommendation, 'auto' | 'status' | 'sourceFinding' | 'confidence'> => ({
  auto: true,
  status: 'accepted',
  sourceFinding: { title: 't', detail: 'd', itemId },
  confidence,
})

describe('reviewSettledForUnattended', () => {
  it('settles when every finding was auto-answered above the floor', () => {
    const items = [item({ id: 'a', status: 'answered' }), item({ id: 'b', status: 'answered' })]
    const recommendations = [autoRec('a', 0.9), autoRec('b', 0.85)]
    expect(reviewSettledForUnattended({ items, recommendations }, 0.8)).toBe(true)
  })

  it('parks on an OPEN finding, which is what a genuine product decision looks like', () => {
    const items = [item({ id: 'a', status: 'answered' }), item({ id: 'b', status: 'open' })]
    expect(reviewSettledForUnattended({ items, recommendations: [autoRec('a', 1)] }, 0.8)).toBe(
      false,
    )
  })

  it('parks on an auto answer AT OR BELOW the floor', () => {
    const items = [item({ id: 'a', status: 'answered' })]
    expect(reviewSettledForUnattended({ items, recommendations: [autoRec('a', 0.7)] }, 0.8)).toBe(
      false,
    )
  })

  // An UNREPORTED grade is not a weak one, but it is not a strong one either, and the direction
  // that fails is the one that asks a person.
  it('parks on an auto answer the Writer did not grade', () => {
    const items = [item({ id: 'a', status: 'answered' })]
    expect(reviewSettledForUnattended({ items, recommendations: [autoRec('a', null)] }, 0.8)).toBe(
      false,
    )
  })

  it('accepts a HUMAN answer whatever the floor, since nothing was graded to compare', () => {
    const items = [item({ id: 'a', status: 'answered', reply: 'one hundred' })]
    expect(reviewSettledForUnattended({ items, recommendations: [] }, 1)).toBe(true)
  })

  it('counts a dismissed or resolved finding as settled', () => {
    const items = [item({ id: 'a', status: 'dismissed' }), item({ id: 'b', status: 'resolved' })]
    expect(reviewSettledForUnattended({ items }, 0.8)).toBe(true)
  })

  it('parks on a finding still awaiting its recommendation', () => {
    const items = [item({ id: 'a', status: 'recommend_requested' })]
    expect(reviewSettledForUnattended({ items }, 0)).toBe(false)
  })

  // The clarity gate has no Writer, so it passes no recommendations at all. Its findings are the
  // investigator's questions to the reporter, and they must keep parking the run.
  it('parks a review kind with no recommendations while a finding is open', () => {
    expect(reviewSettledForUnattended({ items: [item({ status: 'open' })] }, 0)).toBe(false)
  })

  it('settles an empty review', () => {
    expect(reviewSettledForUnattended({ items: [] }, 0.8)).toBe(true)
  })

  // A floor of 0 is the operator explicitly asking for the ungraded behaviour, and it is the only
  // value at which an unreported grade passes.
  it('accepts an ungraded auto answer only at a floor of zero', () => {
    const items = [item({ id: 'a', status: 'answered' })]
    expect(reviewSettledForUnattended({ items, recommendations: [autoRec('a', null)] }, 0)).toBe(
      true,
    )
  })
})

describe('clearsAutoAnswerFloor', () => {
  it('treats the floor as inclusive', () => {
    expect(clearsAutoAnswerFloor(0.8, 0.8)).toBe(true)
    expect(clearsAutoAnswerFloor(0.79, 0.8)).toBe(false)
  })

  it('reads an unreported grade as clearing only a zero floor', () => {
    expect(clearsAutoAnswerFloor(null, 0)).toBe(true)
    expect(clearsAutoAnswerFloor(undefined, 0.1)).toBe(false)
  })
})

describe('recommendationConfidenceBand', () => {
  it('bands a reported grade', () => {
    expect(recommendationConfidenceBand(0.95)).toBe('high')
    expect(recommendationConfidenceBand(DEFAULT_MIN_AUTO_ANSWER_CONFIDENCE)).toBe('high')
    expect(recommendationConfidenceBand(0.6)).toBe('medium')
    expect(recommendationConfidenceBand(0.2)).toBe('low')
  })

  // Null is a THIRD answer rather than a low band: "the model did not say" and "the model is
  // unsure" want different reactions from a reader, and only one of them is evidence.
  it('keeps an unreported grade out of the bands entirely', () => {
    expect(recommendationConfidenceBand(null)).toBeNull()
    expect(recommendationConfidenceBand(undefined)).toBeNull()
  })
})
