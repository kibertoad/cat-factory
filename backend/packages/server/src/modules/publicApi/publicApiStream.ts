import type { ExecutionStatus } from '@cat-factory/contracts'

// Park announcement for the public SSE streams (`/api/v1/jobs/:id/events` and the board task
// stream). Extracted from `PublicApiController` because BOTH streams need identical behaviour and
// the state is exactly the kind that drifts when copy-pasted: one loop re-arming on resume and the
// other not is invisible in review and only shows up as a second park nobody was told about.
//
// It is also the only part of the stream loop that is unit-testable at all — everything around it
// is a live poll over the store behind a hijacked response.

/**
 * Whether a run is PARKED: waiting on a human decision and unable to move until one is answered.
 *
 * `blocked` is the engine's parked state. It is deliberately NOT terminal for these streams: a
 * `decide`-scope caller can answer the park over `/api/v1/runs/:runId/decisions`, and answering
 * resumes the very run being watched — which the caller should see on the SAME connection.
 */
export function isParked(status: ExecutionStatus): boolean {
  return status === 'blocked'
}

/**
 * Tracks whether the current park has been announced, so a `decision` frame is emitted ONCE per
 * park rather than on every poll tick.
 *
 * Announce-once matters because a park lasts as long as a human takes (there is no run-killing
 * timeout by design), so a frame per tick would be an unbounded stream of identical payloads. The
 * RE-ARM on resume matters just as much in the other direction: a pipeline can park more than once
 * (a requirements review, then a fork choice later on the coder step), and a latch that never reset
 * would leave the caller waiting on a second park it was never told about.
 */
export function createParkAnnouncer(): {
  /** Feed each poll's status; true exactly on the tick a NEW park should be announced. */
  shouldAnnounce: (status: ExecutionStatus) => boolean
} {
  let announced = false
  return {
    shouldAnnounce(status: ExecutionStatus): boolean {
      if (!isParked(status)) {
        announced = false
        return false
      }
      if (announced) return false
      announced = true
      return true
    },
  }
}
