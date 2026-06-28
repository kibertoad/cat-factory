import * as v from 'valibot'

// Wire contracts for the visual-confirmation gate's run-driving actions. The gate gathers the
// UI tester's screenshots + the uploaded reference designs, parks for a human to review them,
// and then drives one of a small set of actions: approve (advance), request a fix from findings
// (dispatches the Tester's `fixer`), or recapture (refresh the pairs). Only `request-fix` has a body.

/** Body for "the human reviewed the screenshots and asked for a fix" → dispatches the `fixer`. */
export const requestVisualConfirmFixSchema = v.object({
  /** The human's findings: what looks wrong in the UI and what the fixer should change. */
  findings: v.pipe(v.string(), v.minLength(1)),
})
export type RequestVisualConfirmFixInput = v.InferOutput<typeof requestVisualConfirmFixSchema>
