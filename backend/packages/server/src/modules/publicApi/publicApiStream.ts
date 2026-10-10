import type {
  ExecutionStatus,
  PublicDecisionList,
  PublicRun,
  PublicRunStep,
} from '@cat-factory/contracts'

// The pure decisions the public SSE streams share: when a park is announced, when a decision list
// counts as moved, and how a frame is reduced for the wire. The loops themselves are in
// `publicApiStreamRoutes.ts`.
//
// Split out because BOTH streams need identical behaviour and this is exactly the kind of state
// that drifts when copy-pasted: one loop re-arming on resume and the other not is invisible in
// review and only shows up as a second park nobody was told about.
//
// It is also the only part of the stream loop that is unit-testable at all: everything around it
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
 * Tracks the last DECISION payload written, so a `decision-state` frame is emitted only when the
 * run's decision list actually moved.
 *
 * The counterpart of {@link createParkAnnouncer}, and it fails the same two invisible ways. A
 * detector that always fires turns a park into an unbounded stream of identical payloads, since a
 * park lasts as long as a human takes and the projection is rebuilt every tick. One that latches
 * and never re-arms delivers the first state and then goes quiet, which is the failure the channel
 * exists to prevent: a review whose slices report one by one would report the first and nothing
 * after it, and a caller cannot tell that from a reviewer that stopped.
 *
 * Compared on the SERIALIZED payload rather than a field of it, for the reason the progress frames
 * beside it are: what counts as "moved" is decided by the whole projection, so a decision kind that
 * grows a field is covered with no edit here.
 */
export function createDecisionAnnouncer(): {
  /** Feed each tick's serialized decision list; true exactly when it should be written. */
  shouldAnnounce: (payload: string) => boolean
} {
  let last: string | null = null
  return {
    shouldAnnounce(payload: string): boolean {
      if (payload === last) return false
      last = payload
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

/**
 * Per-string character cap on the model-authored text a DECISION frame carries.
 *
 * Smaller than {@link STREAM_DELIVERABLE_PREVIEW_CHARS}, which bounds the same class of content on
 * the run streams, and the difference is what the cap is paid PER. The run stream pays it once per
 * step, so a pipeline's length bounds the frame; a decision list pays it once per string in a list
 * the RUN sizes (a deep review parks with one finding per issue it found, each carrying a detail,
 * an evidence quote and a suggested fix), so the same number would still let one frame reach
 * hundreds of kilobytes and be re-sent on every change.
 *
 * Sized as a preview a caller can act on: enough to recognise what a finding is about and decide
 * whether to fetch it whole, which is what `GET /api/v1/runs/{runId}/decisions` is for.
 */
export const STREAM_DECISION_TEXT_PREVIEW_CHARS = 1_000

/**
 * Reduce a decision list for an SSE frame: clip every over-long string to a preview and report the
 * clip on the list's own `truncated` flag.
 *
 * Kind-AGNOSTIC by construction, for the same reason {@link createDecisionAnnouncer} compares the
 * serialized payload rather than a field of it: what a decision kind carries is decided by that
 * kind, so a rule written per kind is one a new kind (or a new field on an old one) silently
 * escapes. Clipping by LENGTH wherever the text sits covers all fourteen with no edit, and the ids,
 * statuses, counts and enums a caller routes on are short by construction, so nothing it acts on
 * is what gets clipped.
 *
 * What is NEVER reduced is the list itself. Every decision the run is asking is in every frame,
 * because an empty `decisions` that means "this payload was narrowed" and one that means "nothing
 * is being asked" are opposite facts, and telling them apart is the whole job of this surface.
 */
export function reduceDecisionsForStream(list: PublicDecisionList): PublicDecisionList {
  let clipped = false
  const clip = (value: unknown): unknown => {
    if (typeof value === 'string') {
      if (value.length <= STREAM_DECISION_TEXT_PREVIEW_CHARS) return value
      clipped = true
      return value.slice(0, STREAM_DECISION_TEXT_PREVIEW_CHARS)
    }
    if (Array.isArray(value)) return value.map(clip)
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, clip(v)]))
    }
    return value
  }
  const decisions = clip(list.decisions) as PublicDecisionList['decisions']
  const unanswerable = clip(list.unanswerable) as PublicDecisionList['unanswerable']
  return { ...list, decisions, unanswerable, truncated: clipped }
}
