import type { ExecutionStatus, PublicRun, PublicRunStep } from '@cat-factory/contracts'

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

/**
 * Per-step character cap on the deliverable a STREAM frame carries, applied to `output` and to
 * `data`'s serialized size alike.
 *
 * Sized as a preview a caller can act on (recognise the shape of the deliverable, decide whether
 * to fetch the rest) rather than as a budget for the deliverable itself, and deliberately smaller
 * than the run detail's own 8,000-char sibling (`MAX_HISTORY_OUTPUT_CHARS`, which bounds the same
 * class of content for the same reason): this cap is paid once per step per FRAME, where that one
 * is paid once per step.
 */
export const STREAM_DELIVERABLE_PREVIEW_CHARS = 2_000

/**
 * Reduce a run for an SSE frame: clip each step's oversized `output` to a preview, withhold an
 * oversized `data`, and mark every step the reduction touched.
 *
 * The stream re-sends the whole run on every change, so an unreduced frame repeats every output
 * the run has produced so far and the traffic grows with the SQUARE of the pipeline's length. The
 * point read (`GET /api/v1/tasks/{taskId}/run`) serves both fields whole and is what a caller
 * reads for the deliverable; this keeps the progress channel a progress channel.
 *
 * Only what EXCEEDS the cap is touched. A step whose deliverable already fits — which is the
 * ordinary case for the structured `data` a fork choice or an estimate carries — rides the stream
 * unchanged and unflagged, so `truncated` means exactly "something was left out of this frame"
 * rather than "this frame came from the stream". That is the whole reason the flag exists: a
 * clipped preview that did not say so is indexed by a caller as the step's output, and its tail is
 * then absent in a way that reads as never written.
 */
export function reduceRunForStream(run: PublicRun): PublicRun {
  return { ...run, steps: run.steps.map(reduceStepForStream) }
}

function reduceStepForStream(step: PublicRunStep): PublicRunStep {
  const output = step.output
  const clipped = output !== null && output.length > STREAM_DELIVERABLE_PREVIEW_CHARS
  // Measured, not assumed: `data` is whatever the step's agent kind produced, so its size is a
  // property of the deployment's kinds rather than of this contract.
  const withheld =
    step.data != null && JSON.stringify(step.data).length > STREAM_DELIVERABLE_PREVIEW_CHARS
  if (!clipped && !withheld) return step
  return {
    ...step,
    output: clipped && output !== null ? output.slice(0, STREAM_DELIVERABLE_PREVIEW_CHARS) : output,
    data: withheld ? null : step.data,
    truncated: true,
  }
}
