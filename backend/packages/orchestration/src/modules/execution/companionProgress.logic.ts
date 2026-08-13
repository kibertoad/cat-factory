import type { PipelineStep } from '@cat-factory/kernel'

// Whether a companion rework loop is still getting anywhere.
//
// `attempts < maxAttempts` bounds how LONG a loop may run and says nothing about whether it is
// converging. A real run sat on an `architect-companion` rating of exactly 0.76 for four rounds
// while the companion's own round-4 text said the document was "materially identical to the one I
// rated 0.76 three times"; the two blocking items it opened in round 1 were still open when the
// budget ran out. Each of those rounds cost a full grading call, and none of them could have
// produced a different answer.
//
// The cause of THAT run was a dispatch-id collision that stopped the producer re-running at all
// (fixed separately, in `dispatchEpochFor`). This is the other half: a producer that genuinely
// re-runs and returns the same work is the same dead loop, and nothing was watching for it.

/**
 * How close two ratings must be to count as "did not move".
 *
 * Exact equality is too strict for a model emitting a float, and anything much wider starts
 * swallowing real movement: at 0.01 a loop that climbs a hundredth per round still reads as
 * progress, while the 0.76 → 0.76 → 0.76 case reads as the standstill it is.
 */
const RATING_EPSILON = 0.01

/**
 * Normalise a proposal for comparison: trailing whitespace per line and blank runs collapsed.
 *
 * A pure byte compare would be defeated by a model re-emitting its own text with one reflowed
 * paragraph, and anything cleverer (a similarity ratio, a token diff) would be a threshold nobody
 * can justify and a false stop nobody can debug. This catches the case that actually happens: the
 * producer returned what it was handed.
 */
function normalizeProposal(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Whether this grading cycle proves the loop has stopped making progress, and the rounds still on
 * the budget would only repeat it.
 *
 * BOTH halves must hold, and that conjunction is the whole design:
 *
 *  - **The producer did not change the work.** Its current `output` normalises to the same text as
 *    the `previousProposal` it was handed to revise. That is the only signal available here that
 *    is about the WORK rather than about an opinion of it.
 *  - **The rating did not move.** Compared against the previous cycle's verdict, within
 *    {@link RATING_EPSILON}. A rating that MOVED on unchanged text means the grader has changed
 *    its mind, and the next round can legitimately differ, so the loop is left alone.
 *
 * Requiring both is what keeps this from firing on the ordinary case it would otherwise ruin: a
 * first round always has no predecessor to compare against, and a producer that made a small edit
 * for a rating that stayed flat is still working. The cost of a false NEGATIVE is one wasted
 * round, already bounded by `maxAttempts`; the cost of a false positive is a run cut short with
 * work left undone, so the rule errs the cheap way.
 *
 * Deliberately NOT keyed on the number of rounds a finding has stayed open. A companion that keeps
 * raising the same point at a producer that keeps arguing back is a loop doing exactly what the
 * feedback-accounting directives ask of it, and stopping that would punish the disagreement
 * channel those exist to provide.
 */
export function companionLoopStalled(args: {
  /** The producer step as it stands after this round's re-run. */
  producer: PipelineStep | undefined
  /** The companion's verdict history INCLUDING this cycle's, newest last. */
  verdicts: NonNullable<PipelineStep['companion']>['verdicts']
}): boolean {
  const { producer, verdicts } = args
  if (!producer || verdicts.length < 2) return false
  const current = verdicts[verdicts.length - 1]
  const previous = verdicts[verdicts.length - 2]
  if (!current || !previous) return false
  if (Math.abs(current.rating - previous.rating) > RATING_EPSILON) return false
  // No `rework` means this producer was never looped back, so there is no "what it was asked to
  // change" to compare its output against, and nothing here can be concluded.
  const asked = producer.rework?.previousProposal
  if (asked === undefined) return false
  return normalizeProposal(producer.output ?? '') === normalizeProposal(asked)
}
