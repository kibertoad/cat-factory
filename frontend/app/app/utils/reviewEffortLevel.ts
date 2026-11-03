import { REVIEW_EFFORT_LEVELS, type ReviewEffortLevel } from '@cat-factory/contracts'

/**
 * Label keys for the review effort levels (`ReviewEffortLevel` in `@cat-factory/contracts`), shared
 * by every picker that sets one: a risk policy's post-implementation review effort and a review
 * task's own. An exhaustive `Record` keyed off the union, each value a LITERAL catalog key so the
 * typed-message-keys check sees it and a new level fails the typecheck until it has copy.
 */
export const REVIEW_EFFORT_LABEL_KEYS: Record<ReviewEffortLevel, string> = {
  low: 'reviewEffort.levels.low',
  medium: 'reviewEffort.levels.medium',
  high: 'reviewEffort.levels.high',
  xhigh: 'reviewEffort.levels.xhigh',
  max: 'reviewEffort.levels.max',
}

/** The select items for a review effort picker, lowest to highest (the vocabulary's own order). */
export function reviewEffortOptions(
  t: (key: string) => string,
): { value: ReviewEffortLevel; label: string }[] {
  return REVIEW_EFFORT_LEVELS.map((value) => ({ value, label: t(REVIEW_EFFORT_LABEL_KEYS[value]) }))
}
