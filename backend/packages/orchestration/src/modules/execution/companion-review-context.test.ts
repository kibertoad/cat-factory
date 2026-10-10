import { describe, expect, it } from 'vitest'
import type { PipelineStep } from '@cat-factory/kernel'
import { defaultAgentKindRegistry, type AgentKindRegistry } from '@cat-factory/agents'
import { buildReworkContext, openFindingsFor, priorReviewFor } from './companion-review-context.js'

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
})

describe('gradingBarFor (through buildReworkContext)', () => {
  // The bar the companion is scoring against, split off the history slice because the two have
  // different availability: the history exists from round two, the bar from round one. Read off
  // `priorReview`, the FIRST grading of every step asked for a rating against a threshold the
  // prompt never stated.

  it('is present on the FIRST grading, before any verdict exists', () => {
    const inst = instance([])
    const context = buildReworkContext({ ...inst, currentStep: 1 }, inst.steps[1]!, registry())
    expect(context.gradingBar).toEqual({ threshold: 0.8, roundsRemaining: 3 })
    // …and there is still no history to show, which is the state that used to lose the bar.
    expect(context.priorReview).toBeUndefined()
  })

  it('reports a spent budget as zero rounds remaining rather than a negative', () => {
    // A human-granted extra round can push `attempts` past `maxAttempts`; the prompt says "this
    // is the last round" off this number, and "-1 rounds remain" is not a sentence.
    const inst = instance([verdict(0.72, 'a'), verdict(0.7, 'b'), verdict(0.74, 'c')], 4)
    const context = buildReworkContext({ ...inst, currentStep: 1 }, inst.steps[1]!, registry())
    expect(context.gradingBar?.roundsRemaining).toBe(0)
  })

  it('is absent for the PRODUCER side, which must not optimise for the number', () => {
    const inst = instance([verdict(0.72, 'a'), verdict(0.75, 'b')])
    const producerStep = { ...inst.steps[0]!, rework: reworkFrom(inst) }
    const context = buildReworkContext({ ...inst, currentStep: 0 }, producerStep, registry())
    expect(context.gradingBar).toBeUndefined()
    expect(context.priorReview?.role).toBe('producer')
  })

  it('is absent for a step that is not a companion at all', () => {
    const inst = {
      currentStep: 0,
      steps: [{ agentKind: 'coder', state: 'working' }] as unknown as PipelineStep[],
    }
    expect(buildReworkContext(inst, inst.steps[0]!, registry()).gradingBar).toBeUndefined()
  })
})

describe('openFindingsFor', () => {
  // A companion loop does not only end clean. Past its first forced round a `major` stops holding
  // the run, so the last verdict's points can be real, unanswered and on the record while the run
  // walks straight past them. These pin that they reach the next producer, and that they reach
  // nobody who is still inside the loop.

  /** The run once the companion has PASSED and the engine has moved on to the next step. */
  function settled(verdicts: ReturnType<typeof verdict>[]) {
    const inst = instance(verdicts)
    inst.currentStep = 2
    ;(inst.steps[1] as { state: string }).state = 'done'
    return inst
  }

  it('carries the last verdict points the loop never sent back', () => {
    const open = openFindingsFor(
      settled([
        verdict(0.75, 'round one', [{ body: 'runAsNonRoot will not start', severity: 'major' }]),
        verdict(0.83, 'round two', [
          { body: 'rootDir src breaks the build', anchorId: 'steps/2', severity: 'major' },
        ]),
      ]),
      0,
      registry(),
    )

    expect(open?.map((f) => f.body)).toEqual(['rootDir src breaks the build'])
    expect(open?.[0]?.anchorId).toBe('steps/2')
    expect(open?.[0]?.severity).toBe('major')
  })

  it('does NOT re-raise the earlier rounds, which were answered', () => {
    // Every round before the last one drove a rework: its points were fixed or argued down. Folding
    // them back in would re-open settled work against a producer with no standing to settle it.
    const open = openFindingsFor(
      settled([
        verdict(0.75, 'round one', [{ body: 'the ingress class is undecided', severity: 'major' }]),
        verdict(0.83, 'round two', [{ body: 'the lint plugin is missing', severity: 'major' }]),
      ]),
      0,
      registry(),
    )
    expect(open?.map((f) => f.body)).toEqual(['the lint plugin is missing'])
  })

  it('drops nits, which the reviewer is told never hold anything', () => {
    const open = openFindingsFor(
      settled([
        verdict(0.83, 'clean enough', [
          { body: 'a wording nit', severity: 'minor' },
          { body: 'the build config will not compile', severity: 'major' },
        ]),
      ]),
      0,
      registry(),
    )
    expect(open?.map((f) => f.body)).toEqual(['the build config will not compile'])
  })

  it('orders worst severity first', () => {
    const open = openFindingsFor(
      settled([
        verdict(0.6, 'held', [
          { body: 'ungraded point' },
          { body: 'a real gap', severity: 'major' },
          { body: 'must not ship', severity: 'blocker' },
        ]),
      ]),
      0,
      registry(),
    )
    expect(open?.map((f) => f.body)).toEqual(['must not ship', 'a real gap', 'ungraded point'])
  })

  it('carries a blocker a HUMAN approved over, not only a passing verdict', () => {
    // The park path: the companion refused, a person accepted the work anyway. The point is every
    // bit as open as one a rating walked past, and reading `passed` would have dropped exactly the
    // most serious case.
    const held = settled([
      verdict(0.4, 'refused', [{ body: 'no auth on the write path', severity: 'blocker' }]),
    ])
    expect(openFindingsFor(held, 0, registry())?.map((f) => f.body)).toEqual([
      'no auth on the write path',
    ])
  })

  it('is absent while the loop is still running, for both sides of it', () => {
    // The grader reads its own verdicts through `priorReview` and the producer under rework reads
    // them through `revision`. A third rendering of the same points is the duplication this module
    // exists to have removed.
    const mid = instance([verdict(0.75, 'round one', [{ body: 'a gap', severity: 'major' }])])
    mid.currentStep = 1 // the companion is the step about to be dispatched
    expect(openFindingsFor(mid, 0, registry())).toBeUndefined()

    mid.currentStep = 0 // the producer is being reworked
    expect(openFindingsFor(mid, 0, registry())).toBeUndefined()
  })

  it('is absent when the loop left nothing open, so a clean review renders no section', () => {
    // An empty list would read downstream as "reviewed, and here are its defects: none", which is a
    // different claim from the one a nit-only verdict supports.
    expect(openFindingsFor(settled([verdict(0.9, 'clean')]), 0, registry())).toBeUndefined()
    expect(
      openFindingsFor(
        settled([verdict(0.9, 'clean', [{ body: 'nit', severity: 'minor' }])]),
        0,
        registry(),
      ),
    ).toBeUndefined()
  })

  it('is absent for a step no companion targets', () => {
    const inst = settled([verdict(0.83, 'ok', [{ body: 'a gap', severity: 'major' }])])
    // Index 1 is the companion itself; nothing grades IT.
    expect(openFindingsFor(inst, 1, registry())).toBeUndefined()
  })
})
