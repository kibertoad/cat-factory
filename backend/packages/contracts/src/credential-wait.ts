import * as v from 'valibot'

// ---------------------------------------------------------------------------
// A step PARKED because a credential it needs is not there. Two subjects:
//
//  - `personal`: the run's personal-subscription credential lapsed. A run that uses an
//    individual-usage model (Claude / Codex / a subscriber's GLM) carries a per-run activation of
//    the initiator's credential with a fixed lifetime; every dispatch leases it, and a step whose
//    lease is refused parks here. The initiator resumes it by entering their personal password.
//  - `capability`: a capability credential the step declared (a project definition's vendor
//    login, say) does not resolve for the run's workspace. A person who can manage the
//    workspace's secrets stores it, and any member resumes the step once it resolves.
//
// Recorded on the STEP because the step is what could not dispatch, and because the park rides
// the step's generic approval like every other dedicated park surface.
// ---------------------------------------------------------------------------

const personalCredentialWaitSchema = v.object({
  subject: v.literal('personal'),
  /** Epoch ms the lease was refused and the step parked. */
  raisedAt: v.number(),
})

const capabilityCredentialWaitSchema = v.object({
  subject: v.literal('capability'),
  raisedAt: v.number(),
  /** The capability-credential lookup key the step needs. */
  key: v.string(),
  /** What declared it (`project-definition` and `research/acme:vendor`, say), for the re-check. */
  declaredBy: v.object({ kind: v.string(), id: v.string() }),
  /** What the declarer calls it, for the person storing it. */
  label: v.optional(v.string()),
  /** What the person does to obtain it from the vendor. */
  onboarding: v.optional(v.object({ url: v.optional(v.string()), instructions: v.string() })),
  /** Why the step needs it, and what the agent observed on the way (both scrubbed). */
  reason: v.optional(v.string()),
  observed: v.optional(v.string()),
})

/**
 * A wait persisted before waits carried a `subject`. It is NOT read as `personal`: it is named
 * as what it is, refused on resume (`credential_wait_unrecorded`), and its run is restarted.
 */
const unrecordedCredentialWaitSchema = v.pipe(
  v.object({ raisedAt: v.number() }),
  v.transform((wait) => ({ subject: 'unrecorded' as const, raisedAt: wait.raisedAt })),
)

export const stepCredentialWaitSchema = v.union([
  personalCredentialWaitSchema,
  capabilityCredentialWaitSchema,
  unrecordedCredentialWaitSchema,
])
export type StepCredentialWait = v.InferOutput<typeof stepCredentialWaitSchema>
export type CapabilityCredentialWait = Extract<StepCredentialWait, { subject: 'capability' }>

/**
 * Whether a step is PARKED on a missing credential: the wait is recorded AND its approval is still
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
 * Whether `actorUserId` may resume a run's credential wait.
 *
 * A personal wait admits only the run's INITIATOR: the step's lease reads that person's
 * activation, so a resume by anyone else would mint a credential nothing leases. A run with no
 * recorded initiator (an auth-less deployment) admits anyone. A capability wait admits any member
 * (the route's write floor enforces membership): the person who stored the key must be able to
 * resume, and they are rarely the initiator. An unrecorded wait admits no one.
 */
export function mayResumeCredentialWait(
  wait: StepCredentialWait,
  initiatedBy: string | null | undefined,
  actorUserId: string | null | undefined,
): boolean {
  switch (wait.subject) {
    case 'personal':
      return !initiatedBy || initiatedBy === actorUserId
    case 'capability':
      return true
    case 'unrecorded':
      return false
    default:
      return unknownSubject(wait)
  }
}

function unknownSubject(wait: never): never {
  throw new Error(`unknown credential wait subject: ${JSON.stringify(wait)}`)
}
