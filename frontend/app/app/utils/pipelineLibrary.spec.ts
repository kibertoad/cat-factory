import { describe, expect, it } from 'vitest'
import { PIPELINE_PURPOSES } from '@cat-factory/contracts'
import type { Pipeline } from '~/types/domain'
import { narrowPipelineLibrary } from '~/utils/pipelineLibrary'

type Row = Pick<Pipeline, 'purpose' | 'labels' | 'archived'> & { id: string }

const row = (id: string, purpose?: Pipeline['purpose'], extra: Partial<Row> = {}): Row => ({
  id,
  ...(purpose ? { purpose } : {}),
  ...extra,
})

// A purpose this build has no member for: what a row saved by a newer build (or before a member
// was retired) looks like on the way back out of the store.
const UNKNOWN_PURPOSE = 'acme-migration' as Pipeline['purpose']

// Spread across all three dials, so the purpose count cannot come out right by coincidence: an
// archived row and a differently-labelled row are excluded by the OTHER two either way.
const LIBRARY: Row[] = [
  row('build-a', 'build'),
  row('build-archived', 'build', { archived: true }),
  row('review-a', 'review'),
  row('review-tagged', 'review', { labels: ['nightly'] }),
  row('document-tagged', 'document', { labels: ['nightly'] }),
  row('unclassified', undefined),
]

describe('narrowPipelineLibrary', () => {
  it('lists the whole library while the draft is unclassified', () => {
    const { offered, hiddenByPurpose } = narrowPipelineLibrary(LIBRARY, {
      purpose: null,
      showArchived: true,
    })
    expect(offered.map((p) => p.id)).toEqual(LIBRARY.map((p) => p.id))
    expect(hiddenByPurpose).toBe(0)
  })

  it('lists the pipelines built for the purpose being edited, plus the unclassified ones', () => {
    // An unclassified pipeline is not known-wrong for any purpose, and `purpose` is optional at
    // every write boundary, so hiding one would take a workspace's own hand-built pipelines out of
    // the library they were built in.
    const { offered, hiddenByPurpose } = narrowPipelineLibrary(LIBRARY, { purpose: 'review' })
    expect(offered.map((p) => p.id)).toEqual(['review-a', 'review-tagged', 'unclassified'])
    // `build-archived` is hidden by the archive toggle either way, so the purpose does not claim it.
    expect(hiddenByPurpose).toBe(2)
  })

  it('measures the purpose count against what the other dials already admit', () => {
    // The rule `narrowAgentPalette` established: each hint promises "relax THIS dial alone and you
    // get n more". Counting over the whole library would name `document-tagged` here, which the
    // label filter hides at every purpose.
    const { offered, hiddenByPurpose } = narrowPipelineLibrary(LIBRARY, {
      purpose: 'review',
      label: 'nightly',
    })
    expect(offered.map((p) => p.id)).toEqual(['review-tagged'])
    expect(hiddenByPurpose).toBe(1)
  })

  it('keeps the archive and label dials working on their own', () => {
    expect(
      narrowPipelineLibrary(LIBRARY, { purpose: 'build', showArchived: true }).offered.map(
        (p) => p.id,
      ),
    ).toEqual(['build-a', 'build-archived', 'unclassified'])
    expect(narrowPipelineLibrary(LIBRARY, { purpose: 'build' }).offered.map((p) => p.id)).toEqual([
      'build-a',
      'unclassified',
    ])
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
    })
  })
})
