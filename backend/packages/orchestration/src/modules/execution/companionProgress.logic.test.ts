import { describe, expect, it } from 'vitest'
import type { PipelineStep } from '@cat-factory/kernel'
import { companionLoopStalled } from './companionProgress.logic.js'

// The rule has to fire on the run that motivated it and stay silent on every ordinary loop, and
// the two failure directions cost very differently: a missed stall wastes rounds the budget
// already bounds, a false stall cuts a working run short. So the silent cases outnumber the
// firing one here on purpose.

function producer(
  output: string,
  askedToRevise?: string,
  requestedBy: 'reviewer' | 'human' = 'reviewer',
): PipelineStep {
  return {
    agentKind: 'architect',
    state: 'done',
    progress: 1,
    decision: null,
    output,
    ...(askedToRevise === undefined
      ? {}
      : { rework: { previousProposal: askedToRevise, feedback: 'tighten it', requestedBy } }),
  } as PipelineStep
}

type Verdicts = NonNullable<PipelineStep['companion']>['verdicts']

/** Ratings, oldest first, as the verdict list stores them. */
function verdicts(...ratings: number[]): Verdicts {
  return ratings.map((rating) => ({
    rating,
    threshold: 0.8,
    passed: false,
    feedback: 'still vague',
  })) as Verdicts
}

/** The ordinary call: a producer whose deliverable IS the reply this rule reads. */
function stalled(args: {
  producer: PipelineStep | undefined
  verdicts: Verdicts
  producerDeliverableIsReply?: boolean
}): boolean {
  return companionLoopStalled({
    producer: args.producer,
    verdicts: args.verdicts,
    producerDeliverableIsReply: args.producerDeliverableIsReply ?? true,
  })
}

const DESIGN = '# Design\n\nUse a queue.\n\n- one\n- two'

describe('companionLoopStalled', () => {
  it('fires when the producer returned the text it was handed and the rating held', () => {
    // The real run: 0.76 re-emitted against a document the producer did not touch.
    expect(stalled({ producer: producer(DESIGN, DESIGN), verdicts: verdicts(0.76, 0.76) })).toBe(
      true,
    )
  })

  it('ignores whitespace-only churn, which is a producer that changed nothing', () => {
    expect(
      stalled({
        producer: producer('# Design  \n\n\n\nUse a queue.\n\n- one\n- two  \n', DESIGN),
        verdicts: verdicts(0.76, 0.76),
      }),
    ).toBe(true)
  })

  it('stays silent when the producer actually changed the work', () => {
    expect(
      stalled({ producer: producer(`${DESIGN}\n- three`, DESIGN), verdicts: verdicts(0.76, 0.76) }),
    ).toBe(false)
  })

  it('stays silent when the rating moved, even on unchanged text', () => {
    // The grader changed its mind about the same document, so the next round can legitimately
    // differ. Both directions: a loop climbing slowly is working, and one sliding is telling the
    // producer something new.
    expect(stalled({ producer: producer(DESIGN, DESIGN), verdicts: verdicts(0.7, 0.78) })).toBe(
      false,
    )
    expect(stalled({ producer: producer(DESIGN, DESIGN), verdicts: verdicts(0.78, 0.7) })).toBe(
      false,
    )
  })

  it('treats a rating that only wobbled as not having moved, and one that cleared the epsilon as movement', () => {
    // A model emitting a float will not repeat itself to the bit, so the standstill is a band
    // rather than an equality. Both sides of it, so widening or narrowing the band is a visible
    // decision rather than a silent one.
    expect(stalled({ producer: producer(DESIGN, DESIGN), verdicts: verdicts(0.76, 0.765) })).toBe(
      true,
    )
    expect(stalled({ producer: producer(DESIGN, DESIGN), verdicts: verdicts(0.76, 0.78) })).toBe(
      false,
    )
  })

  it('never fires on the first round, which has nothing to compare against', () => {
    expect(stalled({ producer: producer(DESIGN, DESIGN), verdicts: verdicts(0.76) })).toBe(false)
    expect(stalled({ producer: producer(DESIGN, DESIGN), verdicts: [] })).toBe(false)
  })

  it('never fires on a producer that was never looped back', () => {
    // No `rework` means there is no "what it was asked to change", so identical-to-what is
    // unanswerable.
    expect(stalled({ producer: producer(DESIGN), verdicts: verdicts(0.76, 0.76) })).toBe(false)
  })

  it('never fires on a rework a HUMAN asked for', () => {
    // A human "request changes" on the companion's gate re-runs the producer with the person's own
    // feedback and consumes none of the automatic budget. Reading a standstill off it would abandon
    // rounds that were never spent, on a round this loop did not ask for — and it is the one rework
    // where somebody is actually waiting.
    expect(
      stalled({ producer: producer(DESIGN, DESIGN, 'human'), verdicts: verdicts(0.76, 0.76) }),
    ).toBe(false)
  })

  it('never fires for a producer whose work is a pushed commit, not its reply', () => {
    // `reviewer`/`coder` is the shipped pair this protects: the coder's deliverable is the diff and
    // it legitimately ends with no final text, so two rounds of empty (or boilerplate) summary are
    // what a WORKING coder looks like. The reviewer reads the real repository for exactly this
    // reason; this rule only ever sees the summary, so for that pair it must not conclude anything.
    expect(
      stalled({
        producer: producer('I fixed the issues.', 'I fixed the issues.'),
        verdicts: verdicts(0.7, 0.7),
        producerDeliverableIsReply: false,
      }),
    ).toBe(false)
    // Including the case that would otherwise look most like a standstill.
    expect(
      stalled({
        producer: producer('', ''),
        verdicts: verdicts(0.7, 0.7),
        producerDeliverableIsReply: false,
      }),
    ).toBe(false)
  })

  it('never fires with no producer resolved', () => {
    expect(stalled({ producer: undefined, verdicts: verdicts(0.76, 0.76) })).toBe(false)
  })

  it('fires when a REPLY-delivering producer that was asked to revise returned nothing at all', () => {
    // An empty output against an empty prior proposal is two rounds of the same nothing, which is
    // the standstill in its purest form rather than an exception to it — but only for a kind whose
    // whole deliverable was that reply. The commit-pushing case above is the other half of this.
    expect(stalled({ producer: producer('', ''), verdicts: verdicts(0.4, 0.4) })).toBe(true)
  })
})
