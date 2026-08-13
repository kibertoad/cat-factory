import * as v from 'valibot'
import { companionVerdictSchema } from './step-decisions.js'

// The live state of a COMPANION rework loop: the bar, the budget, the graded history, and the
// flags recording how a loop that never cleared the bar ended.
//
// Extracted from `execution.ts` (a file-size ratchet split) along the seam the loop's own
// controller already follows: `CompanionController` reads and writes exactly this object, and
// nothing else in a step's state takes part in that decision.

/**
 * Live state of a companion step that reviews a preceding producer step. Set when
 * this step's `agentKind` is a companion kind. `threshold` is the quality bar the
 * companion's latest rating (the last `verdicts` entry) must reach; `attempts`
 * counts only the AUTOMATIC reworks performed, and once it reaches `maxAttempts` the
 * step parks on the iteration-cap gate (`exceeded`) for a human rather than failing.
 * A human "request changes" on the companion's gate also re-runs the producer but does
 * NOT consume `attempts` (only the automatic loop is budgeted). Absent for non-companion steps.
 */
export const companionStateSchema = v.object({
  /** The quality bar (0..1) the latest verdict's rating must reach; seeded from the pipeline. */
  threshold: v.number(),
  /** The automatic rework budget: once `attempts` reaches this the gate parks for a human (`exceeded`). */
  maxAttempts: v.number(),
  /**
   * How many AUTOMATIC reworks the companion has driven so far (the producer is
   * looped back once per failed verdict). Human "request changes" cycles are not
   * counted. Defaults to 0; once it reaches `maxAttempts` the step parks on the
   * iteration-cap gate (`exceeded`) — an "extra round" raises `maxAttempts` by one.
   */
  attempts: v.optional(v.number(), 0),
  /**
   * One standardized {@link companionVerdictSchema} per grading cycle, in order —
   * the full sequence of correction iterations (the producer is re-run after each
   * rejected verdict), including any human-driven ones. Empty before the first
   * grade; the last entry is the latest.
   */
  verdicts: v.array(companionVerdictSchema),
  /**
   * Set true when the automatic rework budget (`maxAttempts`) was spent with the
   * rating still below the bar: instead of failing the run, the step parks on its
   * approval gate for a human to resolve via the shared iteration-cap surface
   * (one more round / proceed anyway / stop & reset). Cleared once the human grants
   * an extra round (the loop resumes). Absent until/unless the cap is hit.
   */
  exceeded: v.optional(v.boolean()),
  /**
   * Set true when the run's risk policy ANSWERED that cap instead of parking on it
   * (`autonomy: 'unattended'`), taking the "proceed anyway" choice a person would have been
   * offered. Mutually exclusive with `exceeded` in practice: one records a cap waiting on a
   * human, the other a cap already settled without one.
   *
   * It exists so the two are never confused by a reader. The last `verdicts` entry says the
   * producer was below the bar either way, and without this flag a run that advanced anyway
   * is indistinguishable from one whose companion quietly stopped grading. Rendered on the
   * step and read by whoever reviews the resulting pull request.
   */
  capSettledByPolicy: v.optional(v.boolean()),
  /**
   * Set true when the loop was stopped EARLY, before `maxAttempts`, because it had stopped
   * making progress: the producer returned work byte-identical to the revision it was asked
   * to change, and the companion's rating did not move.
   *
   * A budget is a bound on how long a converging loop may take, not evidence that one is
   * converging. A run that re-graded an unchanged document to the same 0.76 four times over
   * spent its whole budget and ~17k completion tokens per round restating a verdict it had
   * already given, and the two "must fix" items it opened in round 1 were still open at the
   * end. Nothing in the state machine noticed, because `attempts < maxAttempts` was true
   * every time.
   *
   * Recorded rather than merely acted on, and kept DISTINCT from {@link exceeded}, which
   * says the budget genuinely ran out: only this one says the remaining rounds were
   * abandoned as worthless, and only it tells whoever reviews the pull request that the
   * producer stopped responding rather than that the reviewer stayed unsatisfied. The
   * step then takes the same exit the cap does, so an attended run parks for a person and
   * an unattended one settles by policy, both on the record.
   */
  stalled: v.optional(v.boolean()),
})

export type CompanionState = v.InferOutput<typeof companionStateSchema>
