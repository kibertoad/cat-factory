import { describe, expect, it } from 'vitest'
import type { PipelineStep } from '~/types/execution'
import {
  binaryCandidateAbsence,
  binaryCandidateHasWarnings,
  binaryCandidateView,
} from './binaryCandidates'

function step(overrides: Record<string, unknown> = {}): PipelineStep {
  // The candidate override MERGES into the base state rather than replacing it, so a case that
  // only cares about one counter does not have to restate the whole candidate list.
  const { binaryCandidates, ...rest } = overrides
  return {
    agentKind: 'imager',
    state: 'waiting_decision',
    binaryCandidates: {
      status: 'awaiting_choice',
      multiSelect: false,
      invalidEntries: 0,
      omitted: 0,
      unusablePreviews: 0,
      candidates: [
        { id: 'c1', service: 's', location: 'a.png', subject: 'anvil', generator: 'flux' },
        { id: 'c2', service: 's', location: 'b.png', subject: 'anvil', generator: 'retro' },
        { id: 'c3', service: 's', location: 'c.png', subject: 'hammer' },
      ],
      ...(binaryCandidates as Record<string, unknown> | undefined),
    },
    ...rest,
  } as unknown as PipelineStep
}

describe('binaryCandidateView', () => {
  // A step that never compared renders nothing at all, exactly as the binary-output section does
  // for a step that never generated: a row saying "no comparison here" would ride every step.
  it('is absent for a step with no comparison story', () => {
    expect(binaryCandidateView({ agentKind: 'coder' } as PipelineStep)).toBeNull()
    expect(binaryCandidateView(null)).toBeNull()
  })

  // A person compares one subject at a time; forty subjects is forty comparisons, not one wall of
  // eighty pictures.
  it('groups candidates by subject in first-appearance order', () => {
    const view = binaryCandidateView(step())!
    expect(view.groups.map((g) => g.subject)).toEqual(['anvil', 'hammer'])
    expect(view.groups[0]?.rows.map((r) => r.id)).toEqual(['c1', 'c2'])
  })

  // An unlabelled candidate is not "the same thing" as any labelled one, and filing it under the
  // first subject would put a picture of something else into a comparison.
  it('keeps unlabelled candidates in their own group rather than merging them', () => {
    const view = binaryCandidateView(
      step({
        binaryCandidates: {
          candidates: [
            { id: 'c1', service: 's', location: 'a.png', subject: 'anvil' },
            { id: 'c2', service: 's', location: 'b.png' },
          ],
        },
      }),
    )!
    expect(view.groups.map((g) => g.subject)).toEqual(['anvil', null])
  })

  it('marks what was kept and the id it was kept under', () => {
    const view = binaryCandidateView(
      step({
        binaryCandidates: {
          status: 'chosen',
          multiSelect: true,
          choice: {
            kept: [{ candidateId: 'c2', storeAs: 'anvil-pixel' }],
            discarded: ['c1', 'c3'],
            at: 1,
          },
        },
      }),
    )!
    const rows = view.groups.flatMap((g) => g.rows)
    expect(rows.find((r) => r.id === 'c2')).toMatchObject({ kept: true, storeAs: 'anvil-pixel' })
    expect(rows.find((r) => r.id === 'c1')?.kept).toBe(false)
    expect(view.awaiting).toBe(false)
  })

  // An automatic keep is NOT a review. A surface that renders it as a choice tells a reader a
  // person looked at this and approved it, which is the claim the whole feature exists to make
  // true.
  it('reports an automatic keep as its own fact', () => {
    const view = binaryCandidateView(
      step({
        binaryCandidates: {
          status: 'chosen',
          choice: { kept: [{ candidateId: 'c1' }], discarded: [], automatic: true, at: 1 },
        },
      }),
    )!
    expect(view.automatic).toBe(true)
  })

  it('counts candidates with no renderable preview', () => {
    expect(binaryCandidateView(step())!.withoutPreview).toBe(3)
  })
})

describe('binaryCandidateHasWarnings', () => {
  // A comparison made over three of five candidates must not read as one made over all five.
  it('is raised by any counted loss and by nothing else', () => {
    expect(binaryCandidateHasWarnings(binaryCandidateView(step())!)).toBe(false)
    for (const field of ['invalidEntries', 'omitted', 'unusablePreviews'] as const) {
      const view = binaryCandidateView(step({ binaryCandidates: { [field]: 1 } }))!
      expect(binaryCandidateHasWarnings(view)).toBe(true)
    }
  })
})

describe('binaryCandidateAbsence', () => {
  // The window used to render a titled shell with a blank body for all three of these (UX-80).
  // They are different facts, and only one of them is a claim about the RUN.
  it('separates a read in flight, a failed read, and a run that compared nothing', () => {
    expect(binaryCandidateAbsence(true, null)).toBe('loading')
    expect(binaryCandidateAbsence(false, 'network down')).toBe('load_failed')
    expect(binaryCandidateAbsence(false, null)).toBe('nothing_compared')
  })

  // A Retry re-enters `loading` while the PREVIOUS attempt's message is still recorded. Reporting
  // the stale failure over the live attempt would make the button look like it did nothing.
  it('lets a fresh attempt outrank the error it is clearing', () => {
    expect(binaryCandidateAbsence(true, 'network down')).toBe('loading')
  })

  // 'nothing_compared' renders "nothing to compare", which is a statement about what the run
  // produced. A request that never landed knows nothing about that, so it must never reach here.
  it('never claims emptiness on the strength of a request that failed', () => {
    for (const error of ['boom', 'Failed to load']) {
      expect(binaryCandidateAbsence(false, error)).not.toBe('nothing_compared')
    }
  })
})
