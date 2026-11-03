import * as v from 'valibot'

// ---------------------------------------------------------------------------
// How much effort a code review spends: the breadth of what it reports and the confidence a
// finding needs before it is worth a reader's time. Two reviews read it:
//
// - a `review` task's `pr-reviewer`, picked per task when the task is created
//   (`taskTypeFields.reviewEffort`);
// - the post-implementation `reviewer` companion, governed by the task's risk policy
//   (`postImplementationReviewEffort`).
//
// It is a PROMPT-level setting. The engine renders the level as guidance the reviewer is handed
// (`reviewEffortGuidance` in `@cat-factory/agents`); it does not pick a model or a reasoning budget.
// Absent on either side means `high`, the level both reviews ran at before the setting existed.
// ---------------------------------------------------------------------------

/** The effort levels, lowest to highest. The order is the scale, so it is never re-sorted. */
export const REVIEW_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

export const reviewEffortLevelSchema = v.picklist(REVIEW_EFFORT_LEVELS)
export type ReviewEffortLevel = v.InferOutput<typeof reviewEffortLevelSchema>

/** The level a review runs at when nothing chose one: a task with no pick, a policy with none. */
export const DEFAULT_REVIEW_EFFORT_LEVEL: ReviewEffortLevel = 'high'

/** Whether `value` is a current effort level. Derived from the picklist so the two cannot drift. */
export function isReviewEffortLevel(value: unknown): value is ReviewEffortLevel {
  return (REVIEW_EFFORT_LEVELS as readonly unknown[]).includes(value)
}
