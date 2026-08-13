import { describe, expect, it } from 'vitest'
import type { PipelineStep } from '@cat-factory/kernel'
import { defaultAgentKindRegistry, type AgentKindRegistry } from '@cat-factory/agents'
import { buildReworkContext, priorReviewFor } from './companion-review-context.js'

// The companion loop's memory, resolved from `step.companion.verdicts` for whichever side of the
// loop is about to run. The behaviour worth pinning is that BOTH sides get it and that they get
// DIFFERENT slices — a producer must not read the current round's asks twice (they are already in
// `revision`), and a grader must see every round including the latest, which is the one whose asks
// it is about to check.

function registry(): AgentKindRegistry {
  const reg = defaultAgentKindRegistry()
  reg.register({ kind: 'architect', systemPrompt: 'You design.' })
  reg.register({ kind: 'architect-companion', systemPrompt: 'You grade designs.' })
  reg.registerCompanion({
    kind: 'architect-companion',
    targets: ['architect'],
    defaultThreshold: 0.8,
    reviews: 'the design',
  })
  return reg
}

const verdict = (
  rating: number,
  feedback: string,
  comments?: { body: string; anchorId?: string; severity?: 'blocker' | 'major' | 'minor' }[],
) => ({
  rating,
  threshold: 0.8,
  passed: false,
  feedback,
  ...(comments ? { comments } : {}),
})

/** The rework a producer is looped back with: the LATEST verdict, as the engine records it. */
function reworkFrom(inst: { steps: readonly PipelineStep[] }): NonNullable<PipelineStep['rework']> {
  const latest = inst.steps[1]!.companion!.verdicts.at(-1)!
  return {
    previousProposal: 'the design',
    feedback: latest.feedback,
    requestedBy: 'reviewer',
    ...(latest.comments?.length ? { comments: latest.comments } : {}),
  }
}

/** The run as it stands when a companion has graded `verdicts.length` times. */
function instance(verdicts: ReturnType<typeof verdict>[], attempts = verdicts.length) {
  return {
    currentStep: 0,
    steps: [
      { agentKind: 'architect', state: 'done', output: 'the design' },
      {
        agentKind: 'architect-companion',
        state: 'working',
        companion: { threshold: 0.8, maxAttempts: 3, attempts, verdicts },
      },
    ] as unknown as PipelineStep[],
  }
}

describe('priorReviewFor', () => {
  it('gives the GRADER every round it has already given', () => {
    const inst = instance([verdict(0.72, 'pin the image tag'), verdict(0.77, 'runAsNonRoot')])
    const prior = priorReviewFor(inst, 1, registry())

    expect(prior?.role).toBe('grader')
    expect(prior?.rounds.map((r) => r.round)).toEqual([1, 2])
    expect(prior?.rounds.map((r) => r.rating)).toEqual([0.72, 0.77])
    expect(prior?.threshold).toBe(0.8)
    // One automatic round left of the three, so the grader knows how much rope remains.
    expect(prior?.roundsRemaining).toBe(1)
  })

  it('gives the PRODUCER the earlier rounds only, since the latest is already its feedback', () => {
    const inst = instance([verdict(0.72, 'pin the image tag'), verdict(0.77, 'runAsNonRoot')])
    const prior = priorReviewFor(inst, 0, registry())

    expect(prior?.role).toBe('producer')
    // Round 2 is what `revision.feedback` carries, phrased as the work to do now. Repeating it
    // here would have the agent read the same asks twice in two framings.
    expect(prior?.rounds.map((r) => r.round)).toEqual([1])
    expect(prior?.rounds[0]?.summary).toBe('pin the image tag')
  })

  it('carries the ANCHORED comments, not just the summary', () => {
    // The point of storing them: "was what I asked for done" is unanswerable against a summary
    // that named none of the specific asks.
    const inst = instance([
      verdict(0.72, 'several gaps', [{ body: 'pathType is required in networking.k8s.io/v1' }]),
      verdict(0.77, 'still short'),
    ])
    expect(priorReviewFor(inst, 1, registry())?.rounds[0]?.comments?.[0]?.body).toContain(
      'pathType',
    )
  })

  it('carries the ANCHOR each point targets, both ways round the loop', () => {
    // A companion anchors to a structured item by id and quotes no prose, which is the shape every
    // shipped companion prompt asks for. Projecting only `quotedSource` dropped the one handle the
    // producer had on WHICH item a finding was about, and the prompt then rendered each of them
    // against an empty target while ordering the producer to fix them first.
    const anchored = [
      { anchorId: 'REQ-4', severity: 'blocker' as const, body: 'the retry path is unhandled' },
    ]
    const graderRound = priorReviewFor(
      instance([verdict(0.72, 'several gaps', anchored), verdict(0.74, 'still short')]),
      1,
      registry(),
    )?.rounds[0]
    expect(graderRound?.comments?.[0]?.anchorId).toBe('REQ-4')
    expect(graderRound?.comments?.[0]?.severity).toBe('blocker')

    // The producer reads the same point off the round it is being sent back with.
    const looped = instance([verdict(0.72, 'earlier'), verdict(0.74, 'still short', anchored)])
    const producerStep = { ...looped.steps[0]!, rework: reworkFrom(looped) }
    const context = buildReworkContext({ ...looped, currentStep: 0 }, producerStep, registry())
    expect(context.revision?.comments?.[0]?.anchorId).toBe('REQ-4')
    // Absent fields stay ABSENT rather than becoming empty strings: the renderer decides what to
    // write for a point with no quote, and it cannot tell `''` from "there was no quote".
    expect(context.revision?.comments?.[0]).not.toHaveProperty('quotedSource')
  })

  it('is absent before there is any history to show', () => {
    // The first grading of a step (nothing graded yet) and the first loop-back (whose single
    // round IS the producer's current feedback) both have nothing to add. An empty slice would
    // render a heading over nothing.
    expect(priorReviewFor(instance([]), 1, registry())).toBeUndefined()
    expect(priorReviewFor(instance([verdict(0.72, 'once')]), 0, registry())).toBeUndefined()
  })

  it('is absent for a step no companion reviews', () => {
    const inst = {
      currentStep: 0,
      steps: [
        { agentKind: 'architect', state: 'working' },
        { agentKind: 'coder', state: 'pending' },
      ] as unknown as PipelineStep[],
    }
    expect(priorReviewFor(inst, 0, registry())).toBeUndefined()
  })

  it('reports a spent budget as zero rounds remaining rather than a negative', () => {
    // A human-granted extra round can push `attempts` past `maxAttempts`; the prompt says "this
    // is the last round" off this number, and "-1 rounds remain" is not a sentence.
    const inst = instance([verdict(0.72, 'a'), verdict(0.7, 'b'), verdict(0.74, 'c')], 4)
    expect(priorReviewFor(inst, 1, registry())?.roundsRemaining).toBe(0)
  })
})
