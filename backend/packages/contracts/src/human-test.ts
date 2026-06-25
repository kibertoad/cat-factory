import * as v from 'valibot'

// Wire contracts for the human-testing gate's run-driving actions. The gate spins up an
// ephemeral environment, parks for a human to validate it, and then drives one of a small set
// of actions: confirm (pass + tear down + advance), request a fix from findings, pull main into
// the branch + redeploy, recreate the env, or destroy it. Only `request-fix` carries a body.

/** Body for "the human wrote findings and asked for a fix" → dispatches the Tester's `fixer`. */
export const requestHumanTestFixSchema = v.object({
  /** The human's findings: what failed in the env and what the fixer should address. */
  findings: v.pipe(v.string(), v.minLength(1)),
})
export type RequestHumanTestFixInput = v.InferOutput<typeof requestHumanTestFixSchema>
