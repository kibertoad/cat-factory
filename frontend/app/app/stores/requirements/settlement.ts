import type { RequirementReview } from '~/types/requirements'

/**
 * What a requirements review's findings ADD UP TO: how many still need a human, how many the human
 * answered, and the three dispositions the window's action rail derives from that pair.
 *
 * Pure functions of one review, so they live beside the store rather than inside it. They also
 * share ONE pass over the findings, memoised on the review OBJECT: they compose (`canIncorporate`
 * asks `allSettled`, which asks `openCount`, and then asks `answeredCount`), so a card rendering a
 * review's state filtered its item list up to five times. Keying on identity is safe and
 * self-invalidating because the store REPLACES the review object on every write, so a tallied
 * object can never change under the cache; a `WeakMap` also lets a superseded review be collected
 * along with its tally.
 */
const tallies = new WeakMap<RequirementReview, { open: number; answered: number }>()

function tally(review: RequirementReview): { open: number; answered: number } {
  let counts = tallies.get(review)
  if (!counts) {
    counts = { open: 0, answered: 0 }
    for (const item of review.items) {
      if (item.status === 'open') counts.open++
      else if (item.status === 'answered' || item.status === 'resolved') counts.answered++
    }
    tallies.set(review, counts)
  }
  return counts
}

/** Findings still needing a human (status `open`). */
export function openCount(review: RequirementReview): number {
  return tally(review).open
}

/** Findings the human answered (a reply recorded), which the companion folds in. */
export function answeredCount(review: RequirementReview): number {
  return tally(review).answered
}

/** Every finding is settled (answered or dismissed), none still open. */
export function allSettled(review: RequirementReview): boolean {
  return tally(review).open === 0
}

/** Incorporation is possible: all findings settled AND at least one was answered. */
export function canIncorporate(review: RequirementReview): boolean {
  const { open, answered } = tally(review)
  return open === 0 && answered > 0
}

/** Proceed (skip the companion) is possible: all findings settled but none answered. */
export function canProceed(review: RequirementReview): boolean {
  const { open, answered } = tally(review)
  return open === 0 && answered === 0
}
