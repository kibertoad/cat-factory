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

/**
 * Whether a step is PARKED on a lapsed credential: the wait is recorded AND its approval is still
 * pending. The engine, the HTTP refusals and the SPA all key on this one reading, so a step that
 * kept `credentialWait` after its approval settled (a run stopped while parked keeps the step as
 * it stood) is never offered a surface one side would refuse.
 */
export function isCredentialWaitParked(step: {
  credentialWait?: StepCredentialWait | null
  approval?: { status: string } | null
}): boolean {
  return !!step.credentialWait && step.approval?.status === 'pending'
}

/**
 * Whether `actorUserId` may resume a run's credential wait. The step's lease reads the run
 * INITIATOR's activation, so a resume by anyone else would mint a credential nothing leases and
 * park the step again. A run with no recorded initiator (an auth-less deployment) admits anyone.
 */
export function mayResumeCredentialWait(
  initiatedBy: string | null | undefined,
  actorUserId: string | null | undefined,
): boolean {
  return !initiatedBy || initiatedBy === actorUserId
}
