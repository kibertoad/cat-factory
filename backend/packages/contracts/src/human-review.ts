import * as v from 'valibot'

// Wire contracts for the human-review gate's run-driving actions. The gate polls the PR's
// GitHub review state and self-drives (approve → advance; comments → fixer), but a human can
// ALSO request a fix at any time with a freeform prompt — dispatched to the `fixer` immediately,
// bypassing the grace window. (The GitHub-comment path needs no body: the polling probe reads
// the PR's comments directly.)

/** Body for "the human typed a freeform fix request" → dispatches the `fixer` now. */
export const requestHumanReviewFixSchema = v.object({
  /** What the fixer should change on the PR branch (freeform instructions). */
  instructions: v.pipe(v.string(), v.minLength(1)),
})
export type RequestHumanReviewFixInput = v.InferOutput<typeof requestHumanReviewFixSchema>
