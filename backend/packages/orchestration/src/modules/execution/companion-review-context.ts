import type { AgentRunContext, PipelineStep, ReviewedPoint } from '@cat-factory/kernel'
import type { ReviewCommentSeverity } from '@cat-factory/contracts'
import type { AgentKindRegistry } from '@cat-factory/agents'
import { companionTargets, isCompanionKind } from '@cat-factory/agents'

// ---------------------------------------------------------------------------
// The companion loop's MEMORY, resolved for whichever side of it is about to be dispatched.
//
// `step.companion.verdicts` has always accumulated one entry per grading cycle, and nothing ever
// read it into a prompt. So a companion re-graded a revised document knowing nothing about what it
// had asked for last time: each round was an independent draw, it spent its attention on a fresh
// subset of problems, and the rating wandered (72% → 77% → 72% → 78% on a real run) while the work
// genuinely improved. A rework budget buys nothing under those conditions — the loop is not
// converging on anything, it is resampling.
//
// The state was already there and already survives `resetStepForRerun`; this is the read.
//
// It resolves for BOTH sides from the same place, because they are the same fact seen twice: the
// grader needs its own asks to check them off, and the producer needs the ones from rounds before
// the current feedback so a fix from round 1 is not quietly undone in round 3.
// ---------------------------------------------------------------------------

/** One cycle as the prompt renders it, numbered from the order the verdicts were appended. */
function toRounds(
  verdicts: NonNullable<PipelineStep['companion']>['verdicts'],
): NonNullable<AgentRunContext['priorReview']>['rounds'] {
  return verdicts.map((verdict, index) => ({
    round: index + 1,
    rating: verdict.rating,
    passed: verdict.passed,
    summary: verdict.feedback,
    ...(verdict.comments?.length ? { comments: verdict.comments.map(toReviewedPoint) } : {}),
  }))
}

/**
 * One stored comment as a prompt needs it (kernel's {@link ReviewedPoint}).
 *
 * BOTH anchors travel. A companion grading structured items returns `anchorId` and no
 * `quotedSource`, which is the shape every shipped companion prompt asks for, so a projection
 * carrying only the quote rendered each of those findings against an empty target — a `[blocker]`
 * the producer was ordered to resolve first, pointing at nothing. Absent fields stay absent rather
 * than becoming empty strings: the renderer decides what to write when a point has no anchor, and
 * it cannot tell `''` from "there was no anchor".
 */
function toReviewedPoint(comment: {
  quotedSource?: string
  anchorId?: string
  severity?: ReviewCommentSeverity
  body: string
}): ReviewedPoint {
  return {
    ...(comment.quotedSource ? { quotedSource: comment.quotedSource } : {}),
    ...(comment.anchorId ? { anchorId: comment.anchorId } : {}),
    // A reviewer's grade rides through to the producer; a person's comment has none, and an absent
    // one stays absent rather than being defaulted to a level nobody chose.
    ...(comment.severity ? { severity: comment.severity } : {}),
    body: comment.body,
  }
}

/**
 * The `priorReview` slice for the step at `stepIndex`, or `undefined` when there is no history to
 * show (the first grading of a step, a step no companion reviews, a human "request changes" —
 * one person's review is not a loop with rounds).
 *
 * Two shapes, from one piece of state:
 *
 *  - The step IS a companion ⇒ `grader`, carrying EVERY verdict it has given. The current cycle
 *    has not been graded yet, so the whole list is genuinely "what I said before".
 *  - The step is a companion's PRODUCER ⇒ `producer`, carrying every round EXCEPT the last. That
 *    last one is already in `context.revision`, phrased as the work to do now; repeating it here
 *    would have the agent read the same asks twice in two different framings.
 *
 * The producer is found by looking at the NEXT step, which is exactly what
 * `assertValidCompanionPlacement` guarantees: a companion must run immediately after a step whose
 * kind it targets, so a companion's producer is its immediate predecessor and vice versa.
 */
export function priorReviewFor(
  instance: { steps: readonly PipelineStep[] },
  stepIndex: number,
  registry?: AgentKindRegistry,
): AgentRunContext['priorReview'] | undefined {
  const step = instance.steps[stepIndex]
  if (!step) return undefined

  if (isCompanionKind(step.agentKind, registry)) {
    const companion = step.companion
    if (!companion?.verdicts.length) return undefined
    return {
      role: 'grader',
      threshold: companion.threshold,
      rounds: toRounds(companion.verdicts),
    }
  }

  const next = instance.steps[stepIndex + 1]
  if (!next || !companionTargets(next.agentKind, registry).includes(step.agentKind)) {
    return undefined
  }
  const companion = next.companion
  // Nothing to add on the FIRST loop-back: `revision` already carries that single round, and an
  // empty "everything previously raised" section reads as a loop with no history rather than one
  // whose only round is in the paragraph above.
  const earlier = companion?.verdicts.slice(0, -1) ?? []
  if (!earlier.length) return undefined
  return {
    role: 'producer',
    threshold: companion!.threshold,
    rounds: toRounds(earlier),
  }
}

/**
 * The `gradingBar` slice: the bar THIS companion dispatch is scoring against, plus the rope left.
 *
 * Present for every companion dispatch and nothing else. Split from {@link priorReviewFor} because
 * the two have different availability: the history exists only from round two, while the bar
 * applies from round one, and reading it off the history left the FIRST grading of every step
 * asking for a rating against a threshold the prompt never stated. `step.companion` is seeded at
 * run start (bar, budget, `verdicts: []`), so the fact was always there; this is the read.
 *
 * `roundsRemaining` lives HERE and nowhere else: it is a fact about the loop's remaining budget,
 * not about any round already in it, and the history slice used to carry a copy that only the
 * grader's rendering read.
 */
function gradingBarFor(
  step: PipelineStep,
  registry?: AgentKindRegistry,
): AgentRunContext['gradingBar'] | undefined {
  if (!isCompanionKind(step.agentKind, registry)) return undefined
  const companion = step.companion
  if (!companion) return undefined
  return {
    threshold: companion.threshold,
    roundsRemaining: Math.max(0, companion.maxAttempts - companion.attempts),
  }
}

/**
 * The `revision` slice: what a step being RE-RUN with feedback is answering now — a human's
 * "request changes" on its approval gate, or a rework round a downstream reviewer drove
 * (`step.rework`, which wins when both are present). Empty when neither applies.
 *
 * WHO asked travels with it. This is the one place both loops are in view, and the answer is not
 * derivable from which field carried the feedback: a human requesting changes on a COMPANION's
 * gate has their feedback redirected onto the producer's `step.rework` too, which is why the
 * source of that record states it rather than this reader inferring it.
 */
function revisionSlice(step: PipelineStep): { revision?: AgentRunContext['revision'] } {
  const source = step.rework
    ? {
        previousProposal: step.rework.previousProposal,
        feedback: step.rework.feedback,
        comments: step.rework.comments,
        requestedBy: step.rework.requestedBy,
      }
    : step.approval?.status === 'changes_requested'
      ? {
          previousProposal: step.approval.proposal,
          feedback: step.approval.feedback ?? '',
          comments: step.approval.comments,
          requestedBy: 'human' as const,
        }
      : undefined
  if (!source) return {}
  return {
    revision: {
      previousProposal: source.previousProposal,
      feedback: source.feedback,
      // A rework row written before this field existed (a run in flight across the deploy) reads
      // back without it. The reviewer framing is the safe answer there: it is the common case and
      // the failure it avoids — claiming a person is waiting — is the one being fixed.
      requestedBy: source.requestedBy ?? 'reviewer',
      ...(source.comments?.length ? { comments: source.comments.map(toReviewedPoint) } : {}),
    },
  }
}

/**
 * EVERYTHING a re-run of this step is told about the feedback it is answering: the current round
 * ({@link revisionSlice}) and the rounds before it ({@link priorReviewFor}).
 *
 * One call rather than two spreads, because they are one concern seen at two distances and a
 * caller has no reason to take either alone — the current round without its history is exactly the
 * amnesia this exists to fix, and the history without the current round is a step told what to
 * preserve and not what to do.
 *
 * Folded in the CONTEXT BUILDER rather than in either controller, because that is the one place
 * both sides of the loop pass through: an inline companion, a container-backed one, a companion a
 * deployment registered, and the producer being reworked all take their context from
 * `buildContext`. Wired anywhere else, the memory would arrive for some of them and not others,
 * and the one it went missing for would be the one nobody thought to check.
 *
 * Each half is present only when it has something to say, so an absent slice stays absent rather
 * than becoming an empty one (a `priorReview` with no rounds would render a heading over nothing).
 */
export function buildReworkContext(
  instance: { steps: readonly PipelineStep[]; currentStep: number },
  step: PipelineStep,
  registry?: AgentKindRegistry,
): {
  revision?: AgentRunContext['revision']
  priorReview?: AgentRunContext['priorReview']
  gradingBar?: AgentRunContext['gradingBar']
} {
  const priorReview = priorReviewFor(instance, instance.currentStep, registry)
  const gradingBar = gradingBarFor(step, registry)
  return {
    ...revisionSlice(step),
    ...(priorReview ? { priorReview } : {}),
    ...(gradingBar ? { gradingBar } : {}),
  }
}
