import { describe, expect, it } from 'vitest'
import type { StepReviewComment } from '@cat-factory/contracts'
import { disposeCompanionVerdict, type CompanionDispositionInput } from './companion-logic.js'

// The companion loop's whole decision, in the one place it is made. The case that matters most is
// the one a rating alone cannot express: a review that found something unshippable while grading
// the work above the bar. Before graded findings existed that verdict passed, and the run carried
// the reviewer's own "must fix" past the step it was raised on.

const comment = (severity?: StepReviewComment['severity']): StepReviewComment => ({
  body: 'name the failure mode here',
  ...(severity ? { severity } : {}),
})

/** A cleared rating with a round still to spend, so each case varies exactly one thing. */
const base: CompanionDispositionInput = {
  rating: 0.95,
  threshold: 0.8,
  comments: undefined,
  attempts: 1,
  maxAttempts: 3,
  hasProducer: true,
}

describe('disposeCompanionVerdict', () => {
  it('passes a rating at or above the bar with nothing blocking', () => {
    expect(disposeCompanionVerdict(base).disposition).toBe('pass')
    // `>=`, not `>`: the bar an operator typed must be meetable exactly.
    expect(disposeCompanionVerdict({ ...base, rating: 0.8 }).disposition).toBe('pass')
    expect(disposeCompanionVerdict({ ...base, rating: 0.79 }).disposition).toBe('rework')
  })

  it('reworks a cleared rating while a blocker is open', () => {
    const decision = disposeCompanionVerdict({
      ...base,
      comments: [comment('minor'), comment('blocker')],
    })
    expect(decision.disposition).toBe('rework')
  })

  it('PARKS a cleared rating whose blocker outlived the budget', () => {
    // The load-bearing case. With the budget spent, every other route out of this function accepts
    // the work: the rating cleared the bar, so without the blocker check this is a plain `pass`.
    const decision = disposeCompanionVerdict({
      ...base,
      attempts: 3,
      comments: [comment('blocker')],
    })
    expect(decision.disposition).toBe('park')
    expect(decision.parkReason).toBe('blocking_findings')
  })

  it('parks a spent budget below the bar as the automation giving up', () => {
    // The OTHER park, and the reason the vocabulary is not a boolean: this one an unattended risk
    // policy may answer, and the one above it may not.
    const decision = disposeCompanionVerdict({ ...base, rating: 0.4, attempts: 3 })
    expect(decision.disposition).toBe('park')
    expect(decision.parkReason).toBe('budget_spent')
  })

  it('holds a blocker even where the policy buys no rework rounds at all', () => {
    // `companionMaxReworks: 0` says "do not spend model calls looping"; it does not say "accept
    // whatever comes back". So the finding still stops the run, it just stops it at a person.
    const decision = disposeCompanionVerdict({
      ...base,
      attempts: 0,
      maxAttempts: 0,
      comments: [comment('blocker')],
    })
    expect(decision.disposition).toBe('park')
    expect(decision.parkReason).toBe('blocking_findings')
  })

  it('spends the first round on any findings, and only the first', () => {
    const first = { ...base, attempts: 0, comments: [comment('minor')] }
    expect(disposeCompanionVerdict(first).disposition).toBe('rework')
    // Second pass onward the rating decides: a nit that survived one round is not worth another.
    expect(disposeCompanionVerdict({ ...first, attempts: 1 }).disposition).toBe('pass')
    // …and a policy that buys no round has already answered the first-batch question too.
    expect(disposeCompanionVerdict({ ...first, maxAttempts: 0 }).disposition).toBe('pass')
  })

  it('treats an ungraded comment as neither blocking nor absent', () => {
    // A person's comment carries no severity. It is worth the first-batch round like any finding,
    // and it can never hold the run — only a reviewer's explicit `blocker` does that.
    expect(disposeCompanionVerdict({ ...base, attempts: 0, comments: [comment()] }).disposition).toBe(
      'rework',
    )
    expect(disposeCompanionVerdict({ ...base, attempts: 3, comments: [comment()] }).disposition).toBe(
      'pass',
    )
  })

  it('passes with no producer, whatever the verdict said', () => {
    // Nothing of this companion's target kind precedes it, so there is nothing to hold back and
    // nothing the findings could be about.
    const decision = disposeCompanionVerdict({
      ...base,
      hasProducer: false,
      rating: 0,
      attempts: 3,
      comments: [comment('blocker')],
    })
    expect(decision.disposition).toBe('pass')
    expect(decision.parkReason).toBeUndefined()
  })
})
