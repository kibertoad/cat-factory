import { describe, expect, it } from 'vitest'
import { parseCompanionAssessment } from './companion.js'
import {
  blockingReviewComments,
  bySeverityWorstFirst,
  hasBlockingReviewComments,
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
