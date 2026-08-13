import { describe, expect, it } from 'vitest'
import { parseCompanionAssessment } from './companion.js'
import {
  blockingReviewComments,
  bySeverityWorstFirst,
  hasBlockingReviewComments,
  hasReviewCommentsBeyondNits,
  isReviewCommentSeverity,
  reviewCommentSeverityRank,
  reviewCommentSeveritySchema,
  UNGRADED_REVIEW_COMMENT_RANK,
  type StepReviewComment,
} from './step-decisions.js'

// How a review comment's URGENCY survives the trip from a model reply to the two readers that act
// on it (the engine's disposition, the run panel). Each case here is one the parse itself decides,
// which is why they are asserted through `parseCompanionAssessment` rather than the schema: what a
// reviewer wrote and what the engine sees are only the same thing because of what this does with
// the awkward values.

const assessment = (comments: unknown[]) =>
  parseCompanionAssessment({ rating: 0.9, summary: 'the change holds up', comments })

describe('a review comment severity, as parsed off a model reply', () => {
  it('carries the graded level through', () => {
    const parsed = assessment([{ body: 'unsafe cast', severity: 'blocker' }])
    expect(parsed.comments?.[0]?.severity).toBe('blocker')
    expect(hasBlockingReviewComments(parsed.comments)).toBe(true)
  })

  it('reads an out-of-vocabulary level as `major` instead of failing the verdict', () => {
    // The whole assessment is one parse. Without the fallback a reviewer that answered "critical"
    // would make its reply unparseable, and an unparseable companion verdict FAILS THE RUN
    // (`companion_rejected`) — a far worse outcome than one point landing a level off.
    const parsed = assessment([{ body: 'unsafe cast', severity: 'critical' }])
    expect(parsed.comments?.[0]?.severity).toBe('major')
    // And `major` specifically: the safe default may not invent a hard stop out of a typo…
    expect(hasBlockingReviewComments(parsed.comments)).toBe(false)
    // …nor quietly retire the point to a nit.
    expect(bySeverityWorstFirst(parsed.comments ?? [])[0]?.severity).toBe('major')
  })

  it('leaves an ungraded comment ungraded', () => {
    // A person's "request changes" comment goes through this same shape and carries no grading.
    // Defaulting it to any level would put a judgement on the screen that nobody made.
    const parsed = assessment([{ body: 'reword this paragraph' }])
    expect(parsed.comments?.[0]?.severity).toBeUndefined()
    expect(hasBlockingReviewComments(parsed.comments)).toBe(false)
  })
})

describe('reading a set of comments', () => {
  const comments: StepReviewComment[] = [
    { body: 'nit', severity: 'minor' },
    { body: 'ungraded' },
    { body: 'must fix', severity: 'blocker' },
    { body: 'should fix', severity: 'major' },
    { body: 'must fix too', severity: 'blocker' },
  ]

  it('selects every blocker, in the order they were raised', () => {
    expect(blockingReviewComments(comments).map((c) => c.body)).toEqual([
      'must fix',
      'must fix too',
    ])
    expect(blockingReviewComments(undefined)).toEqual([])
    expect(hasBlockingReviewComments([])).toBe(false)
  })

  it('separates a batch worth a rework round from one that is all nits', () => {
    expect(hasReviewCommentsBeyondNits(comments)).toBe(true)
    expect(hasReviewCommentsBeyondNits([{ body: 'nit', severity: 'minor' }])).toBe(false)
    expect(hasReviewCommentsBeyondNits([])).toBe(false)
    expect(hasReviewCommentsBeyondNits(undefined)).toBe(false)
    // An UNGRADED point counts: its urgency is unknown, not known to be low, and the cheap error
    // is one wasted round rather than a point silently dropped.
    expect(hasReviewCommentsBeyondNits([{ body: 'ungraded' }])).toBe(true)
  })

  it('orders worst first, sinking the ungraded to the end', () => {
    // Worst first is the order a producer should work the list in, and an ungraded comment sorts
    // last rather than being guessed into the middle of the graded ones.
    expect(bySeverityWorstFirst(comments).map((c) => c.severity)).toEqual([
      'blocker',
      'blocker',
      'major',
      'minor',
      undefined,
    ])
    // Stable within a level, so two blockers keep the order the reviewer raised them in.
    expect(
      bySeverityWorstFirst(comments)
        .slice(0, 2)
        .map((c) => c.body),
    ).toEqual(['must fix', 'must fix too'])
  })
})

describe('a severity this build no longer knows, read off a stored row', () => {
  // The schema's `major` fallback covers the model REPLY, which is the only thing it parses. A
  // stored verdict is mapped onto the type by the facade repositories rather than re-parsed, so a
  // level retired from the vocabulary reaches a reader with its type claiming otherwise — the
  // "total against the TYPE, partial against the DATA" gap. These are the readers that meet it.
  const retired = [
    { body: 'raised at a level since retired', severity: 'blocker-legacy' },
    { body: 'nit', severity: 'minor' },
  ] as unknown as StepReviewComment[]

  it('is not a member of the vocabulary, tested against the picklist itself', () => {
    expect(isReviewCommentSeverity('blocker')).toBe(true)
    expect(isReviewCommentSeverity('blocker-legacy')).toBe(false)
    // Derived from the schema's own options, so a member added to the picklist is admitted here
    // with no second list to update.
    expect(reviewCommentSeveritySchema.options.every(isReviewCommentSeverity)).toBe(true)
  })

  it('ranks with the ungraded rather than returning undefined from the Record', () => {
    // Read straight off `REVIEW_COMMENT_SEVERITY_RANK` this is `undefined`, which sorts by NaN: the
    // list silently keeps whatever order it arrived in.
    expect(reviewCommentSeverityRank('blocker-legacy')).toBe(UNGRADED_REVIEW_COMMENT_RANK)
    expect(reviewCommentSeverityRank(undefined)).toBe(UNGRADED_REVIEW_COMMENT_RANK)
    expect(reviewCommentSeverityRank('blocker')).toBeGreaterThan(reviewCommentSeverityRank('major'))
    expect(bySeverityWorstFirst(retired).map((c) => c.body)).toEqual([
      'nit',
      'raised at a level since retired',
    ])
  })

  it('carries no mechanical force, and is never guessed onto a current level', () => {
    // It cannot hold the run: nothing knows the retired level meant `blocker`, and a stale value
    // that stopped every run would be worse than one that stops none. What it must not do is come
    // back AS a current member, which is why the value stays readable for the surface that renders
    // it (the panel names it, and this is what makes retiring a member a row rewrite rather than a
    // silent re-grading).
    expect(hasBlockingReviewComments(retired)).toBe(false)
    expect(blockingReviewComments(retired)).toEqual([])
    // …and it is not read as a nit either, so a first batch carrying one still buys a round.
    expect(hasReviewCommentsBeyondNits(retired)).toBe(true)
  })
})
