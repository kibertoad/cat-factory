import { describe, expect, it } from 'vitest'
import { PIPELINE_PURPOSES } from '@cat-factory/contracts'
import type { Pipeline } from '~/types/domain'
import { narrowPipelineLibrary } from '~/utils/pipelineLibrary'

type Row = Pick<Pipeline, 'purpose' | 'labels' | 'archived'> & { id: string }

const row = (id: string, purpose: Pipeline['purpose'], extra: Partial<Row> = {}): Row => ({
  id,
  purpose,
  ...extra,
})

// A purpose this build has no member for: what a row saved by a newer build (or before a member
// was retired) looks like on the way back out of the store. Reachable even though the field is
// mandatory, which is the whole reason the predicates still narrow the value they are handed.
const UNKNOWN_PURPOSE = 'acme-migration' as Pipeline['purpose']

// Spread across all three dials, so neither count can come out right by coincidence: an archived
// row and a differently-labelled row are excluded by the OTHER dials either way.
const LIBRARY: Row[] = [
  row('build-a', 'build'),
  row('build-archived', 'build', { archived: true }),
  row('review-a', 'review'),
  row('review-tagged', 'review', { labels: ['nightly'] }),
  row('review-archived-tagged', 'review', { archived: true, labels: ['nightly'] }),
  row('document-tagged', 'document', { labels: ['nightly'] }),
]

describe('narrowPipelineLibrary', () => {
  it('lists every purpose when the library is browsed at none', () => {
    // `null` is the library's own relaxation, not an unclassified draft: `Pipeline.purpose` is
    // mandatory, so the reader asking to browse past the purpose is the only way to get here.
    const { offered, hiddenByPurpose } = narrowPipelineLibrary(LIBRARY, {
      purpose: null,
      showArchived: true,
    })
    expect(offered.map((p) => p.id)).toEqual(LIBRARY.map((p) => p.id))
    expect(hiddenByPurpose).toBe(0)
  })

  it('lists the pipelines built for the purpose being browsed at', () => {
    const { offered, hiddenByPurpose } = narrowPipelineLibrary(LIBRARY, { purpose: 'review' })
    expect(offered.map((p) => p.id)).toEqual(['review-a', 'review-tagged'])
    // `build-archived` is hidden by the archive toggle either way, so the purpose does not claim it.
    expect(hiddenByPurpose).toBe(2)
  })

  it('measures the purpose count against what the other dials already admit', () => {
    // The rule `narrowAgentPalette` established: each hint promises "relax THIS dial alone and you
    // get n more". Counting over the whole library would name `build-a` here, which the label
    // filter hides at every purpose.
    const { offered, hiddenByPurpose } = narrowPipelineLibrary(LIBRARY, {
      purpose: 'review',
      label: 'nightly',
    })
    expect(offered.map((p) => p.id)).toEqual(['review-tagged'])
    expect(hiddenByPurpose).toBe(1)
  })

  it('counts the archived rows the OTHER dials admit, not the whole catalog', () => {
    // The count the "Archived (n)" toggle renders. Against the raw catalog it would promise rows
    // the toggle cannot reveal: two pipelines are archived, but only one of them is a `review` one.
    expect(narrowPipelineLibrary(LIBRARY, { purpose: 'review' }).archivedInScope).toBe(1)
    expect(narrowPipelineLibrary(LIBRARY, { purpose: 'planning' }).archivedInScope).toBe(0)
    expect(narrowPipelineLibrary(LIBRARY, { purpose: null }).archivedInScope).toBe(2)
    expect(
      narrowPipelineLibrary(LIBRARY, { purpose: null, label: 'nightly' }).archivedInScope,
    ).toBe(1)
  })

  it('keeps the archived count steady across the toggle it governs', () => {
    // Unlike `hiddenByPurpose`, this one may NOT drop to zero once the dial is relaxed: it decides
    // whether the toggle is offered at all, so a count that vanished when the toggle worked would
    // strand the archived rows visible with no way to hide them again.
    const shown = narrowPipelineLibrary(LIBRARY, { purpose: 'review', showArchived: true })
    expect(shown.offered.map((p) => p.id)).toEqual([
      'review-a',
      'review-tagged',
      'review-archived-tagged',
    ])
    expect(shown.archivedInScope).toBe(1)
  })

  it('narrows by neither purpose this build cannot name', () => {
    // Same disposition as the palette's: an unrecognised value is one this build has nothing to
    // narrow BY and nothing to narrow it AGAINST, never a reason to guess a current member. A
    // stored row carrying one stays reachable in the editor that has to fix it.
    const stored = [...LIBRARY, row('acme', UNKNOWN_PURPOSE)]
    for (const purpose of PIPELINE_PURPOSES) {
      expect(narrowPipelineLibrary(stored, { purpose }).offered.some((p) => p.id === 'acme')).toBe(
        true,
      )
    }
    expect(narrowPipelineLibrary(stored, { purpose: UNKNOWN_PURPOSE })).toEqual({
      offered: stored.filter((p) => !p.archived),
      hiddenByPurpose: 0,
      archivedInScope: 2,
    })
  })
})
