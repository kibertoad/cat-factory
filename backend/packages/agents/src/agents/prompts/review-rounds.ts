// ---------------------------------------------------------------------------
// What a REPEATED grading loop says to itself, in one place.
//
// Two buckets of the step taxonomy re-grade the same artifact on a budget: JUDGES (score against
// a rubric, bounce the producer, re-score) and COMPANIONS (rate a producer's output, loop it back,
// re-rate). They differ in what they read and in the JSON they return, and in nothing that matters
// here — both must anchor their 0..1 score to the same meanings, and both must say what became of
// what they asked for last round.
//
// Keeping those two things here rather than in each prompt is what makes a threshold portable. An
// operator sets ONE number per policy (`judgeMinScore`, a companion step's `threshold`), and two
// graders that mean different things by `0.8` turn that number into noise. The rendering of the
// rounds themselves lives beside them for the same reason: a companion that showed its history in
// a different shape from the judge's would be a second thing to keep in step by hand.
// ---------------------------------------------------------------------------

/** One already-settled round of a grading loop, as a prompt renders it. */
export interface PriorReviewRound {
  /** 1-based, in the order they happened. */
  round: number
  rating: number
  passed: boolean
  summary: string
  comments?: { quotedSource?: string; body: string }[]
}

/**
 * The anchored 0..1 scale every grader in this repo scores on.
 *
 * An UNANCHORED 0..1 score is the single thing that makes a threshold meaningless: asked for "a
 * quality rating" with no scale, a model hovers wherever its priors sit, and the number moves
 * between runs on identical work. Anchoring is also what lets the same `0.8` be a bar for a code
 * reviewer, a design companion and a rubric judge at once.
 *
 * `subject` names what the work is being measured against, so the same anchors read naturally for
 * a rubric ("the rubric") and for a deliverable ("the standard for this deliverable"). The ANCHOR
 * POINTS are the shared part and must not be varied per caller: that is the whole contract.
 */
export function anchoredQualityScale(subject: string): string {
  return (
    `Score on this anchored 0..1 scale: 1.0 fully meets ${subject} with nothing to raise; ` +
    `0.8 meets it with minor, non-blocking nits; 0.6 has a real gap a reviewer would ask about; ` +
    `0.4 clearly falls short of ${subject} in a way that should be fixed before this work goes ` +
    `further; 0.2 or below ignores ${subject}.`
  )
}

/**
 * What a grader is told to do with its own previous rounds.
 *
 * "State plainly for each" is the load-bearing half. A grader merely SHOWN its history still tends
 * to re-review from scratch and spend the round's attention on a fresh subset of problems, which
 * is what produces a score that wanders up and down while the work improves. Being made to
 * account for each earlier ask converts the round into a delta, and makes a score that moved the
 * wrong way something the grader has to justify rather than something it can emit silently.
 */
export const PRIOR_ROUNDS_DIRECTIVE =
  'Judge the CURRENT work on its own merits, but state plainly for each point you raised in an ' +
  'earlier round whether it is now addressed, still open, or no longer applies. Do not re-open a ' +
  'point you already accepted, and do not let a fresh observation displace one you have not yet ' +
  'accounted for: a rating that moved DOWN while every earlier point was addressed needs saying ' +
  'so explicitly, with what got worse.'

/** How much of one round's prose a rendering keeps. Generous for the latest, tight for the rest. */
const LATEST_ROUND_CHARS = 4_000
const EARLIER_ROUND_CHARS = 1_200

/**
 * Render a grading loop's settled rounds, oldest first.
 *
 * The most recent round is the one whose asks are most likely still open, so it keeps far more of
 * its prose than the rest; every earlier one is still NAMED, because a point raised in round 1 and
 * quietly dropped by round 3 is exactly the regression this exists to catch. A trimmed round says
 * so inline rather than ending mid-sentence, so nothing reads as a grader that had little to say.
 */
export function renderPriorReviewRounds(rounds: readonly PriorReviewRound[]): string[] {
  const lines: string[] = []
  for (const [index, round] of rounds.entries()) {
    const isLatest = index === rounds.length - 1
    const verdict = round.passed ? 'met the bar' : 'did not meet the bar'
    lines.push('', `Round ${round.round} — rated ${round.rating.toFixed(2)}, ${verdict}:`)
    lines.push(clip(round.summary.trim() || '(no summary given)', isLatest))
    for (const comment of round.comments ?? []) {
      const target = comment.quotedSource?.trim()
      lines.push(
        target
          ? `- On "${clip(target, false)}": ${clip(comment.body, isLatest)}`
          : `- ${clip(comment.body, isLatest)}`,
      )
    }
  }
  return lines
}

/** Trim one field, STATING that it was trimmed (a silent cut reads as a shorter original). */
function clip(text: string, generous: boolean): string {
  const limit = generous ? LATEST_ROUND_CHARS : EARLIER_ROUND_CHARS
  return text.length > limit ? `${text.slice(0, limit)}… [trimmed]` : text
}
