import { describe, expect, it } from 'vitest'
import type { BinaryArtifactRecord } from '@cat-factory/kernel'
import {
  MAX_DESIGN_REFERENCE_VIEWS,
  designGapReason,
  foldDesignReferences,
  resolveDesignReferences,
  type DesignDocumentSummary,
} from './visual-confirm-design-references.js'

const FILE_A = { source: 'figma' as const, externalId: 'fileA' }
const FILE_B = { source: 'figma' as const, externalId: 'fileB' }

function design(
  over: Partial<DesignDocumentSummary> & Pick<DesignDocumentSummary, 'externalId'>,
): DesignDocumentSummary {
  return {
    source: 'figma',
    title: 'Checkout flow',
    renderStatus: 'stored',
    ...over,
  }
}

let seq = 0
function render(
  document: { source: 'figma'; externalId: string } | null,
  view: string | null,
  over: Partial<BinaryArtifactRecord> = {},
): BinaryArtifactRecord {
  seq += 1
  return {
    id: `art_${seq}`,
    workspaceId: 'ws',
    executionId: null,
    blockId: null,
    kind: 'reference',
    view,
    contentType: 'image/png',
    byteSize: 10,
    hash: 'h',
    storage: 'memory',
    storageKey: `ws/art_${seq}`,
    document,
    createdAt: seq,
    ...over,
  }
}

describe('foldDesignReferences', () => {
  it('folds one design’s frames in, newest render per view winning', () => {
    const documents = [design({ externalId: 'fileA' })]
    const older = render(FILE_A, 'Checkout')
    const newer = render(FILE_A, 'Checkout')
    const other = render(FILE_A, 'Confirm')

    const { references, summary } = foldDesignReferences(documents, [older, newer, other])

    // Ordered oldest-first by the store, so the LAST assignment for a view is the current
    // revision's frame — the same rule the hand-uploaded references follow.
    expect(references).toEqual([
      { view: 'Checkout', artifactId: newer.id },
      { view: 'Confirm', artifactId: other.id },
    ])
    expect(summary).toEqual({ documents: 1, images: 2 })
  })

  it('qualifies a view name TWO designs claim, on both sides', () => {
    const documents = [
      design({ externalId: 'fileA', title: 'Checkout flow' }),
      design({ externalId: 'fileB', title: 'Billing' }),
    ]
    const a = render(FILE_A, 'Summary')
    const b = render(FILE_B, 'Summary')
    const unique = render(FILE_B, 'Card entry')

    const { references } = foldDesignReferences(documents, [a, b, unique])

    // Neither occurrence keeps the bare name: leaving the first bare would hand "Summary" to
    // whichever design happens to be listed first, so re-ordering the links would silently
    // re-point a reviewed view at a different screen.
    expect(references).toEqual([
      { view: 'Summary (Checkout flow)', artifactId: a.id },
      { view: 'Summary (Billing)', artifactId: b.id },
      { view: 'Card entry', artifactId: unique.id },
    ])
  })

  it('disambiguates two designs that share a TITLE by their source id', () => {
    const documents = [
      design({ externalId: 'fileA', title: 'Checkout' }),
      design({ externalId: 'fileB', title: 'Checkout' }),
    ]
    const { references } = foldDesignReferences(documents, [
      render(FILE_A, 'Summary'),
      render(FILE_B, 'Summary'),
    ])

    expect(references.map((r) => r.view)).toEqual([
      'Summary (Checkout fileA)',
      'Summary (Checkout fileB)',
    ])
  })

  it('caps the number of design views and REPORTS what it dropped', () => {
    const documents = [design({ externalId: 'fileA' })]
    const renders = Array.from({ length: MAX_DESIGN_REFERENCE_VIEWS + 3 }, (_, i) =>
      render(FILE_A, `view-${i}`),
    )

    const { references, summary } = foldDesignReferences(documents, renders)

    expect(references).toHaveLength(MAX_DESIGN_REFERENCE_VIEWS)
    // Stated, never silently trimmed: a capped gallery is otherwise indistinguishable from the
    // whole design.
    expect(summary.dropped).toBe(3)
    expect(summary.images).toBe(MAX_DESIGN_REFERENCE_VIEWS)
  })

  it('ignores artifacts belonging to another document or of another kind', () => {
    const documents = [design({ externalId: 'fileA' })]
    const mine = render(FILE_A, 'Checkout')
    const foreign = render({ source: 'figma', externalId: 'unlinked' }, 'Checkout')
    const upload = render(null, 'Checkout')
    const screenshot = render(FILE_A, 'Captured', { kind: 'screenshot' })

    const { references } = foldDesignReferences(documents, [mine, foreign, upload, screenshot])

    expect(references).toEqual([{ view: 'Checkout', artifactId: mine.id }])
  })

  it('counts a view-less render as retained but shows it against nothing', () => {
    const documents = [design({ externalId: 'fileA' })]
    // No view means no pairing key, so it cannot be rendered as a pair — but it IS held, so the
    // document must not then be reported as having retained nothing.
    const { references, summary } = foldDesignReferences(documents, [render(FILE_A, null)])

    expect(references).toEqual([])
    expect(summary.gaps).toBeUndefined()
  })

  it('states a gap per design, keyed by what its last import recorded', () => {
    const documents = [
      design({ externalId: 'fileA', title: 'Partial', renderStatus: 'partial' }),
      design({ externalId: 'fileB', title: 'Broken', renderStatus: 'failed' }),
    ]
    const { summary } = foldDesignReferences(documents, [render(FILE_A, 'Checkout')])

    expect(summary.gaps).toEqual([
      { title: 'Partial', reason: 'partial' },
      { title: 'Broken', reason: 'failed' },
    ])
  })
})

describe('designGapReason', () => {
  it('is silent only when the row says stored AND images are actually held', () => {
    expect(designGapReason('stored', 3)).toBeNull()
    // A row claiming `stored` over an empty shelf is the one combination a reader must not see
    // as "this design has no screens".
    expect(designGapReason('stored', 0)).toBe('not_retained')
  })

  it('passes the recorded status through, since each asks for a different fix', () => {
    expect(designGapReason('partial', 4)).toBe('partial')
    expect(designGapReason('failed', 0)).toBe('failed')
    expect(designGapReason('none', 0)).toBe('none')
    expect(designGapReason('storage_unavailable', 0)).toBe('storage_unavailable')
  })

  it('treats NO recorded outcome as a gap only when nothing is held', () => {
    expect(designGapReason(null, 0)).toBe('not_retained')
    expect(designGapReason(null, 2)).toBeNull()
  })
})

describe('resolveDesignReferences', () => {
  const store = {
    listByDocuments: async () => [render(FILE_A, 'Checkout')],
  } as never

  it('answers null when the task links no design at all', async () => {
    const documents = {
      listByBlock: async () => [
        { source: 'notion', externalId: 'n1', title: 'PRD', renderStatus: null },
      ],
    } as never

    // A different fact from "links one and it gave nothing", which is what the summary states.
    expect(await resolveDesignReferences(documents, store, 'ws', 'blk')).toBeNull()
  })

  it('answers null when documents or storage are unwired', async () => {
    expect(await resolveDesignReferences(undefined, store, 'ws', 'blk')).toBeNull()
    expect(
      await resolveDesignReferences({ listByBlock: async () => [] } as never, null, 'ws', 'blk'),
    ).toBeNull()
  })

  it('asks the store for every linked design in ONE batched read', async () => {
    const asked: unknown[] = []
    const documents = {
      listByBlock: async () => [
        { source: 'figma', externalId: 'fileA', title: 'A', renderStatus: 'stored' },
        { source: 'zeplin', externalId: 'fileB', title: 'B', renderStatus: 'stored' },
        { source: 'notion', externalId: 'n1', title: 'PRD', renderStatus: null },
      ],
    } as never
    const batching = {
      listByDocuments: async (_ws: string, docs: unknown) => {
        asked.push(docs)
        return []
      },
    } as never

    const fold = await resolveDesignReferences(documents, batching, 'ws', 'blk')

    expect(asked).toEqual([
      [
        { source: 'figma', externalId: 'fileA' },
        { source: 'zeplin', externalId: 'fileB' },
      ],
    ])
    expect(fold?.summary.documents).toBe(2)
  })
})
