import { hasBlockingReviewComments, reviewCommentSeverityRank } from '@cat-factory/contracts'
import type { ReviewedPoint } from '@cat-factory/kernel'

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
  /**
   * Whether the round ADVANCED the work — the engine's disposition, not a bar comparison.
   * `disposeCompanionVerdict` also holds a round whose rating cleared the threshold (an open
   * `blocker`, or a first batch raising more than nits), so this is `false` on plenty of rounds
   * that met the bar. See {@link roundOutcome} for why that distinction has to be rendered.
   */
  passed: boolean
  summary: string
  comments?: ReviewedPoint[]
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

/**
 * What the PRODUCER side of the loop owes the round it is answering.
 *
 * The counterpart to {@link PRIOR_ROUNDS_DIRECTIVE}, and needed for the same reason from the other
 * end. Told only to "revise to address the feedback", a producer silently drops the points it
 * disagrees with or does not get to, and the reviewer cannot tell that from a point that was
 * missed: both look like an unchanged artifact. So the next round raises them again verbatim, the
 * one after that too, and the rework budget is spent re-sending the same list ("Still open from
 * rounds 1-3, unchanged" on a real run) instead of converging.
 *
 * Disagreement is a legitimate outcome and this is what gives it a channel. A reviewer is not
 * always right, and a producer that must ARGUE a point down is doing better work than one that
 * complies with everything or ignores what it doubts.
 *
 * The accounting goes in the producer's REPLY, never into the artifact. Every companion reads that
 * reply — the engine folds a settled step's output into the next agent's prompt as prior work
 * (`priorOutputsFor` → the "grading the output of ..." section), which is exactly what an inline
 * companion grades and what a container-backed one reads beside the checkout. Told to put it "in
 * your deliverable" instead, a `doc-writer` commits a dialogue with an automated reviewer into the
 * document that ships, and a `spec-writer` into its `spec/` shards, with nothing anywhere that
 * strips it back out.
 */
export const FEEDBACK_ACCOUNTING_DIRECTIVE =
  'Account for EVERY point raised, one by one. Either change the work and say what you changed, ' +
  'or, where you judge a point wrong, already handled, or out of scope, leave the work as it is ' +
  'and say plainly why. A point you neither act on nor argue against is indistinguishable from ' +
  'one you missed, and it will be raised again unchanged. Put that accounting in your REPLY, as a ' +
  'short "Response to review" section listing each point with its disposition and, where you ' +
  'changed something, where the change is. It belongs in the reply and nowhere else: it is ' +
  'correspondence about the work, so never commit it into the work itself — not into a document, ' +
  'a specification, a code comment or a commit message.'

/**
 * What a grader does with the accounting {@link FEEDBACK_ACCOUNTING_DIRECTIVE} asks for.
 *
 * Rendered only alongside the prior rounds, because that is exactly when an accounting can exist.
 * The claim is checked against the WORK rather than believed: an accounting asserting a change the
 * artifact does not contain is worse than the point it answers, since it would otherwise buy a
 * rating the work did not earn.
 *
 * A MISSING accounting is deliberately not a finding of its own. The rating is on the work, and a
 * producer whose deliverable is a pushed commit legitimately answers with the change alone (the
 * `coder` under `reviewer` is exactly that pair, and the repo's own rule says a coder may end with
 * no final text at all). Marking its absence would spend a rework round on prose the reviewer
 * cannot read anyway; what an unanswered point costs is stated where it belongs, in the point
 * staying open.
 */
export const ACCOUNTING_REVIEW_DIRECTIVE =
  'The producer was asked to answer each point you raised, in its reply. Where it did, hold that ' +
  'accounting to the WORK: confirm a claimed change by finding it, and say so when you cannot. A ' +
  'point argued against is settled on the argument, so accept a sound one and stop raising it ' +
  'rather than repeating it. A point neither changed nor argued is still open. An accounting that ' +
  'claims a change the work does not contain is a more serious finding than the point it was ' +
  'answering. Rate the WORK, never the accounting: some producers answer only with the change ' +
  'itself, so a missing accounting is not a finding — the points it leaves open are.'

/** How much of one round's prose a rendering keeps. Generous for the latest, tight for the rest. */
const LATEST_ROUND_CHARS = 4_000
const EARLIER_ROUND_CHARS = 1_200

/**
 * What became of one settled round, in the words that are actually true of it.
 *
 * `passed` is the ENGINE's disposition, and rendering it as "met the bar" / "did not meet the bar"
 * asserted a comparison that had not been made: `disposeCompanionVerdict` holds a round on an open
 * `blocker` whatever the rating, and force-loops the FIRST batch that raises anything beyond a nit
 * even from a producer that scored well. So a grader was shown "rated 0.86, did not meet the bar"
 * against a bar of 0.80 it had been given in the same prompt, and one of the two numbers had to be
 * wrong. Neither was; the sentence joining them was.
 *
 * The bar comparison and the disposition are therefore stated as the two separate facts they are,
 * with the reason named whenever they disagree — on the PASSING side as much as the failing one.
 * Reading `passed` as "met the bar" is the same conflation mirror-imaged: a round the engine
 * advanced on a rating below the threshold would be rendered as having met a bar it did not meet,
 * against a number the same prompt states. Nothing here may derive the comparison from anything but
 * the two numbers. This repo's own rule: causes that need different
 * reactions must not render the same, and "your score was too low" and "your score was fine, a
 * must-fix held it" need opposite responses from the producer being reworked.
 *
 * The threshold's NUMBER stays out of the wording deliberately. Only the grader is given it (in the
 * heading above these rounds), for the reason it is the only side told how much rope is left: a
 * producer handed the number optimises for it rather than for the work. Both sides still get the
 * comparison, which is the part that is about their own round.
 */
function roundOutcome(round: PriorReviewRound, threshold: number): string {
  const metBar = round.rating >= threshold
  if (round.passed) {
    return metBar ? 'which met the bar' : 'which was below the bar and was passed anyway'
  }
  if (!metBar) return 'below the bar'
  if (hasBlockingReviewComments(round.comments)) {
    return 'which met the bar, but a [blocker] below held the work back'
  }
  return 'which met the bar, and was still sent back once over the findings below'
}

/**
 * Render a grading loop's settled rounds, oldest first.
 *
 * The most recent round is the one whose asks are most likely still open, so it keeps far more of
 * its prose than the rest; every earlier one is still NAMED, because a point raised in round 1 and
 * quietly dropped by round 3 is exactly the regression this exists to catch. A trimmed round says
 * so inline rather than ending mid-sentence, so nothing reads as a grader that had little to say.
 *
 * Each point carries the SEVERITY it was raised at, worst first, because that is what the round
 * actually decided: a `[blocker]` from round 1 is the reason the loop is still running, and read
 * as an undifferentiated bullet it competes for attention with a nit raised in the same breath.
 *
 * `threshold` is what the loop's ratings were judged against, and it is required rather than
 * optional: without it the rendering can only echo a `passed` flag whose meaning is not the bar
 * comparison it reads as (see {@link roundOutcome}).
 *
 * `alreadyListed` is the points the SAME prompt states elsewhere as the work to do now
 * ({@link renderRevisionComments}); each one is folded out of the history and counted instead. A
 * point still open is re-raised every round by design, so without this the producer reads the same
 * ask twice in two framings and has no single authoritative list: on a real run "the same six
 * points appear three times". The fold is COUNTED rather than silent, because a round whose every
 * point moved into the current list would otherwise render as a round that raised nothing.
 */
export function renderPriorReviewRounds(
  rounds: readonly PriorReviewRound[],
  threshold: number,
  alreadyListed: readonly ReviewedPoint[] = [],
): string[] {
  const listed = new Set(alreadyListed.map(pointIdentity))
  const lines: string[] = []
  for (const [index, round] of rounds.entries()) {
    const isLatest = index === rounds.length - 1
    lines.push(
      '',
      `Round ${round.round} — rated ${round.rating.toFixed(2)}, ${roundOutcome(round, threshold)}:`,
    )
    lines.push(clip(round.summary.trim() || '(no summary given)', isLatest))
    let folded = 0
    for (const comment of worstFirst(round.comments)) {
      if (listed.has(pointIdentity(comment))) {
        folded += 1
        continue
      }
      const target = reviewedPointTarget(comment)
      const grade = comment.severity ? `[${comment.severity}] ` : ''
      lines.push(
        target
          ? `- ${grade}On ${clip(target, false)}: ${clip(comment.body, isLatest)}`
          : `- ${grade}${clip(comment.body, isLatest)}`,
      )
    }
    if (folded > 0) {
      lines.push(
        `- (${folded} point(s) raised in this round are still open and are listed in full above; ` +
          'they are the same points, not new ones.)',
      )
    }
  }
  return lines
}

/**
 * What makes two renderings of a point the SAME point: its BODY, under whatever it is attached to.
 *
 * The anchor NARROWS the match, it does not replace it. An `anchorId` names an ITEM (the companion
 * contract calls it "a spec requirement / acceptance-criterion id"), not a finding, and one item
 * routinely collects several: "REQ-3 is missing the error case" and "REQ-3 is ambiguously worded"
 * are two asks on one anchor. Keyed on the anchor alone they hash together, so re-raising one of
 * them folds BOTH out of the history, and the count then claims two points are "listed in full
 * above" when only one is: the producer is never told about the other again. That is why
 * `quotedSource` has always been paired with the body, and the anchor now is too.
 *
 * The cost is the opposite error: a point re-raised in genuinely different words renders twice.
 * That is the safe direction and the deliberate one. Showing a point twice costs tokens; folding
 * two DIFFERENT points together drops an ask the producer was never told about.
 *
 * Deliberately not severity-sensitive. A reviewer that escalates a `minor` to a `blocker` between
 * rounds is raising the same point harder, and the current round's rendering is the one carrying
 * the up-to-date grade.
 */
function pointIdentity(point: ReviewedPoint): string {
  const body = normaliseForIdentity(point.body)
  const anchor = point.anchorId?.trim()
  if (anchor) return `anchor:${anchor.toLowerCase()} ${body}`
  const quoted = point.quotedSource?.trim()
  return quoted ? `quoted:${normaliseForIdentity(quoted)} ${body}` : `body:${body}`
}

/** Collapse the incidental differences between two renderings of one point's prose. */
function normaliseForIdentity(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase()
}

/**
 * Render the points a producer must answer THIS round, worst first.
 *
 * The counterpart of {@link renderPriorReviewRounds} (settled history) and deliberately its
 * neighbour: one loop's two renderings, ordered by the same rule, naming an anchor the same way.
 * Each point gets its own block rather than a bullet, because a `body` is markdown that may itself
 * carry lists.
 *
 * The blocker directive is stated once, above the list, and only when there IS one: a producer told
 * on every round that blockers must be resolved first learns nothing from the sentence, and the
 * engine's own rule is exactly this (kernel's `disposeCompanionVerdict` holds the step while one is
 * open, whatever the rating).
 */
export function renderRevisionComments(comments: readonly ReviewedPoint[]): string[] {
  const lines = ['', 'Comments on specific parts of your proposal:']
  if (hasBlockingReviewComments(comments)) {
    lines.push(
      'Every comment marked [blocker] MUST be resolved in this revision: while one is open the',
      'work does not move on. Deal with those first, then the rest.',
    )
  }
  for (const comment of worstFirst(comments)) {
    const grade = comment.severity ? ` [${comment.severity}]` : ''
    const quoted = comment.quotedSource?.trim()
    const anchor = comment.anchorId?.trim()
    // A quoted block goes on its own line, because it is verbatim source of arbitrary length; an
    // anchor is a short id and reads as part of the heading. A point with NEITHER is addressed to
    // the proposal as a whole, which is what it is: the alternative shipped as `On this part:` over
    // a literal `(empty)`, telling a producer to fix a specific part while showing it none — and
    // that was every companion finding, since a companion anchors by id and quotes nothing.
    if (quoted) lines.push('', `On this part:${grade}`, quoted)
    else if (anchor) lines.push('', `On item \`${anchor}\`:${grade}`)
    else lines.push('', `On your proposal overall:${grade}`)
    lines.push('Comment:', comment.body || '(none given)')
  }
  return lines
}

/**
 * WHAT a point is about, as a prompt can name it, or `undefined` when the point named nothing.
 *
 * The two anchors are not interchangeable and neither may be rendered as the other: a human review
 * quotes the prose it targets, so it reads back quoted, while a companion names a structured item's
 * id, which is a locator the producer looks up. A point with neither is rendered as the standalone
 * note it is, rather than against an empty target — the failure mode a `(empty)` placeholder
 * produced, where a producer was told to fix a specific part and shown nothing.
 */
function reviewedPointTarget(comment: ReviewedPoint): string | undefined {
  const quoted = comment.quotedSource?.trim()
  if (quoted) return `"${quoted}"`
  const anchor = comment.anchorId?.trim()
  return anchor ? `item \`${anchor}\`` : undefined
}

/**
 * Severity-graded points, worst first; an ungraded one (a person's) sorts last.
 *
 * Generic over the shape rather than taking contracts' `StepReviewComment`, because the prompt layer
 * renders what it was handed: a {@link ReviewedPoint} carries no `srcStart`/`srcEnd` and the
 * persisted comment carries no reason to reach a prompt. The RANKING is contracts' own
 * (`reviewCommentSeverityRank`), so a level this build no longer knows sinks to the ungraded end
 * here exactly as it does in the panel, rather than sorting by `NaN`.
 *
 * Shared by both renderers here: {@link renderPriorReviewRounds} orders a settled round's points and
 * {@link renderRevisionComments} the ones a producer must answer now. Two copies of one ranking is
 * how a severity added to the vocabulary comes to sort differently in the two halves of one loop.
 */
function worstFirst<T extends { severity?: string }>(comments: readonly T[] | undefined): T[] {
  return [...(comments ?? [])].sort(
    (a, b) => reviewCommentSeverityRank(b.severity) - reviewCommentSeverityRank(a.severity),
  )
}

/** Trim one field, STATING that it was trimmed (a silent cut reads as a shorter original). */
function clip(text: string, generous: boolean): string {
  const limit = generous ? LATEST_ROUND_CHARS : EARLIER_ROUND_CHARS
  return text.length > limit ? `${text.slice(0, limit)}… [trimmed]` : text
}
