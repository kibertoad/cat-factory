// How merged work has gone, per change class, for the stories that show the merge track record.
import type { ChangeClass, MergeClassRollup } from '@cat-factory/contracts'

interface Tally {
  /** Merge routes. */
  auto: number
  human: number
  external: number
  rejected: number
  pending: number
  /** Effort tags a person gave. Every other record in the class counts as untagged. */
  none: number
  minor: number
  major: number
}

/** One change class's track record. `merged` and `total` are derived as the backend derives them. */
export function mergeClassRollup(changeClass: ChangeClass, tally: Tally): MergeClassRollup {
  const merged = tally.auto + tally.human + tally.external
  const total = merged + tally.rejected + tally.pending
  return {
    changeClass,
    total,
    merged,
    autoMerged: tally.auto,
    humanMerged: tally.human,
    externalMerged: tally.external,
    rejected: tally.rejected,
    pendingReview: tally.pending,
    effort: {
      none: tally.none,
      minor: tally.minor,
      major: tally.major,
      untagged: total - tally.none - tally.minor - tally.major,
    },
  }
}

/** Docs and tests merge on their own; source changes mostly go through a person. */
export const mergeClassRollups: MergeClassRollup[] = [
  mergeClassRollup('docs', {
    auto: 14,
    human: 2,
    external: 0,
    rejected: 0,
    pending: 1,
    none: 10,
    minor: 1,
    major: 0,
  }),
  mergeClassRollup('test', {
    auto: 9,
    human: 3,
    external: 1,
    rejected: 1,
    pending: 0,
    none: 6,
    minor: 2,
    major: 0,
  }),
  mergeClassRollup('source', {
    auto: 4,
    human: 21,
    external: 3,
    rejected: 2,
    pending: 3,
    none: 3,
    minor: 9,
    major: 4,
  }),
  mergeClassRollup('dependency', {
    auto: 6,
    human: 1,
    external: 0,
    rejected: 0,
    pending: 0,
    none: 5,
    minor: 0,
    major: 0,
  }),
]
