import * as v from 'valibot'
import { describe, expect, it } from 'vitest'
import {
  GUIDED_REVIEW_PROSE_MAX,
  guidedReviewFailure,
  guidedReviewFailureSchema,
} from './guided-review.js'

describe('guidedReviewFailure', () => {
  it('keeps a detail that fits as it is', () => {
    expect(guidedReviewFailure('generation_failed', 'boom')).toEqual({
      reason: 'generation_failed',
      detail: 'boom',
    })
    expect(guidedReviewFailure('budget_exhausted', null)).toEqual({
      reason: 'budget_exhausted',
      detail: null,
    })
  })

  it('cuts a longer detail to fit the schema and says how much it dropped', () => {
    const raw = 'x'.repeat(GUIDED_REVIEW_PROSE_MAX * 2)
    const failure = guidedReviewFailure('model_unavailable', raw)
    expect(v.safeParse(guidedReviewFailureSchema, failure).success).toBe(true)
    const detail = failure.detail ?? ''
    const dropped = Number(/\((\d+) more characters cut\)$/.exec(detail)?.[1])
    const kept = detail.indexOf('\n(')
    expect(kept + dropped).toBe(raw.length)
  })
})
