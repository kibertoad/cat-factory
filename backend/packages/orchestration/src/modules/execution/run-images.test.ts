import { describe, expect, it } from 'vitest'
import type { BinaryArtifactRecord } from '@cat-factory/kernel'
import { defaultAgentKindRegistry } from '@cat-factory/agents'
import { resolveRunImages } from './run-images.js'
import { MAX_DESIGN_IMAGES } from './run-design-images.js'

/**
 * The default registry answers `image: 'ui'` for `tester-ui` and the `design-images` trait for the
 * building kinds, so `tester-ui` / `coder` / `merger` cover the three gates this resolver applies.
 */
const registry = defaultAgentKindRegistry()

function upload(view: string | null, over: Partial<BinaryArtifactRecord> = {}) {
  return {
    id: 'art_1',
    workspaceId: 'ws',
    executionId: null,
    blockId: 'blk',
    kind: 'reference' as const,
    view,
    contentType: 'image/png',
    byteSize: 10,
    hash: 'h',
    storage: 'memory',
    storageKey: 'ws/art_1',
    document: null,
    createdAt: 1,
    ...over,
  }
}

function deps(records: BinaryArtifactRecord[], reads?: { count: number }) {
  const store = {
    listByBlock: async () => {
      if (reads) reads.count += 1
      return records
    },
    listByDocuments: async () => [],
  } as never
  return { agentKindRegistry: registry, resolveBinaryArtifactStore: async () => store }
}

describe('resolveRunImages', () => {
  it('asks nothing for a kind that neither captures nor builds a screen', async () => {
    // The two reads must stay off the dispatch path of every kind with no use for them.
    expect(await resolveRunImages(deps([upload('Checkout')]), 'merger', 'ws', 'blk')).toEqual({})
  })

  it('asks nothing when the deployment stores no binary artifacts', async () => {
    expect(
      await resolveRunImages({ agentKindRegistry: registry }, 'tester-ui', 'ws', 'blk'),
    ).toEqual({})
    expect(
      await resolveRunImages(
        { agentKindRegistry: registry, resolveBinaryArtifactStore: async () => null },
        'coder',
        'ws',
        'blk',
      ),
    ).toEqual({})
  })

  it('names the task’s references for a capturing kind, and shows it no design set', async () => {
    expect(await resolveRunImages(deps([upload('Checkout')]), 'tester-ui', 'ws', 'blk')).toEqual({
      referenceScreenshots: {
        files: [{ view: 'Checkout', artifactId: 'art_1', fileName: 'Checkout.png' }],
        omitted: [],
      },
    })
  })

  it('hands a building kind the pictures, typed, and no capture manifest', async () => {
    expect(await resolveRunImages(deps([upload('Checkout')]), 'coder', 'ws', 'blk')).toEqual({
      designImages: {
        files: [
          {
            view: 'Checkout',
            artifactId: 'art_1',
            contentType: 'image/png',
            fileName: 'Checkout.png',
          },
        ],
        omitted: [],
      },
    })
  })

  it('answers an EMPTY capture set but NOTHING for a design set when the task holds none', async () => {
    // Asymmetric on purpose: an empty capture set still tells a tester it was asked, while an empty
    // design set would only say "this task links no design", the ordinary state of most tasks.
    expect(await resolveRunImages(deps([]), 'tester-ui', 'ws', 'blk')).toEqual({
      referenceScreenshots: { files: [], omitted: [] },
    })
    expect(await resolveRunImages(deps([]), 'coder', 'ws', 'blk')).toEqual({})
  })

  it('reads the reference set ONCE for a kind that both captures and builds', async () => {
    // The reason the two halves resolve together: derived twice they could disagree about a view
    // name, which is the exact join the visual-confirmation gate performs.
    const both = defaultAgentKindRegistry()
    both.assignTraits('tester-ui', ['design-images'])
    const reads = { count: 0 }
    const resolved = await resolveRunImages(
      { ...deps([upload('Checkout')], reads), agentKindRegistry: both },
      'tester-ui',
      'ws',
      'blk',
    )
    expect(reads.count).toBe(1)
    expect(resolved.referenceScreenshots?.files[0]!.fileName).toBe(
      resolved.designImages?.files[0]!.fileName,
    )
  })

  it('caps the design half far tighter than the capture half, naming what it dropped', async () => {
    const records = Array.from({ length: MAX_DESIGN_IMAGES + 3 }, (_, i) =>
      upload(`View ${i}`, { id: `art_${i}` }),
    )
    const resolved = await resolveRunImages(deps(records), 'coder', 'ws', 'blk')
    const set = resolved.designImages!
    expect(set.files).toHaveLength(MAX_DESIGN_IMAGES)
    // Nothing is silently shortened: from inside the run a screen nobody mentioned and a screen
    // the design lacks are the same absence.
    expect(set.files.length + set.omitted.length).toBe(records.length)
    expect(set.omitted).toEqual(records.slice(MAX_DESIGN_IMAGES).map((r) => r.view))
  })

  it('gives two views that slug alike distinct file names', async () => {
    const resolved = await resolveRunImages(
      deps([
        upload('Checkout / step 1', { id: 'art_a' }),
        upload('Checkout — step 1', { id: 'art_b' }),
      ]),
      'coder',
      'ws',
      'blk',
    )
    const names = resolved.designImages!.files.map((file) => file.fileName)
    expect(new Set(names).size).toBe(names.length)
  })
})
