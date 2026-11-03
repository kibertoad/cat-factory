import * as v from 'valibot'

// ---------------------------------------------------------------------------
// A step PARKED because the run's personal-subscription credential lapsed.
//
// A run that uses an individual-usage model (Claude / Codex / a subscriber's GLM) carries a
// per-run activation of the initiator's credential with a fixed lifetime. Every dispatch leases
// it, and the lease is the ONE authority on whether it is still live: a step whose lease is
// refused parks here instead of failing the run, and the person resumes it by entering their
// personal password, which re-mints the activation and re-dispatches the same step.
//
// Recorded on the STEP because the step is what could not dispatch, and because the park rides
// the step's generic approval like every other dedicated park surface.
// ---------------------------------------------------------------------------

export const stepCredentialWaitSchema = v.object({
  /** Epoch ms the lease was refused and the step parked. */
  raisedAt: v.number(),
})
export type StepCredentialWait = v.InferOutput<typeof stepCredentialWaitSchema>
