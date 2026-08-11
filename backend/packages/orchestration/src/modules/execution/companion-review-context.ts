import type { AgentRunContext, PipelineStep } from '@cat-factory/kernel'
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
    ...(verdict.comments?.length
      ? {
          comments: verdict.comments.map((comment) => ({
            ...(comment.quotedSource ? { quotedSource: comment.quotedSource } : {}),
            body: comment.body,
          })),
        }
      : {}),
  }))
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
      roundsRemaining: Math.max(0, companion.maxAttempts - companion.attempts),
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
    roundsRemaining: Math.max(0, companion!.maxAttempts - companion!.attempts),
    rounds: toRounds(earlier),
  }
}

/**
 * The `revision` slice: what a step being RE-RUN with feedback is answering now — a human's
 * "request changes" on its approval gate, or a downstream companion's automatic rework
 * (`step.rework`, which wins when both are present). Empty when neither applies.
 */
function revisionSlice(step: PipelineStep): { revision?: AgentRunContext['revision'] } {
  const source = step.rework
    ? {
        previousProposal: step.rework.previousProposal,
        feedback: step.rework.feedback,
        comments: step.rework.comments,
      }
    : step.approval?.status === 'changes_requested'
      ? {
          previousProposal: step.approval.proposal,
          feedback: step.approval.feedback ?? '',
          comments: step.approval.comments,
        }
      : undefined
  if (!source) return {}
  return {
    revision: {
      previousProposal: source.previousProposal,
      feedback: source.feedback,
      ...(source.comments?.length
        ? {
            comments: source.comments.map((c) => ({
              ...(c.quotedSource ? { quotedSource: c.quotedSource } : {}),
              body: c.body,
            })),
          }
        : {}),
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
): { revision?: AgentRunContext['revision']; priorReview?: AgentRunContext['priorReview'] } {
  const priorReview = priorReviewFor(instance, instance.currentStep, registry)
  return { ...revisionSlice(step), ...(priorReview ? { priorReview } : {}) }
}
