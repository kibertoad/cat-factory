import { describe, expect, it } from 'vitest'
import type { BinaryArtifactRecord } from '@cat-factory/kernel'
import { defaultAgentKindRegistry } from '@cat-factory/agents'
import {
  MAX_REFERENCE_SCREENSHOTS,
  capReferences,
  nameReferenceFiles,
  resolveReferenceScreenshots,
} from './run-reference-screenshots.js'

/** The default registry answers `image: 'ui'` for `tester-ui` and for nothing else built-in. */
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

describe('nameReferenceFiles', () => {
  it('names each file from its view and keeps the view beside it', () => {
    const named = nameReferenceFiles([
      { view: 'Checkout / step 1', artifactId: 'a1', contentType: 'image/png', origin: 'design' },
    ])

    expect(named).toEqual([
      { view: 'Checkout / step 1', artifactId: 'a1', fileName: 'Checkout-step-1.png' },
    ])
  })

  it('suffixes rather than drops when two views slug to one name', () => {
    const named = nameReferenceFiles([
      { view: 'Checkout / step 1', artifactId: 'a1', contentType: 'image/png', origin: 'design' },
      { view: 'Checkout — step 1', artifactId: 'a2', contentType: 'image/png', origin: 'upload' },
    ])

    // Dropping one would hand the agent a directory quietly missing a screen it is being asked
    // to compare; the prompt states which view each file is, so the suffix needs no interpreting.
    expect(named.map((file) => file.fileName)).toEqual([
      'Checkout-step-1.png',
      'Checkout-step-1-2.png',
    ])
  })

  it('names the file after the type the bytes were stored as', () => {
    const named = nameReferenceFiles([
      { view: 'Checkout', artifactId: 'a1', contentType: 'image/jpeg', origin: 'upload' },
      { view: 'Confirm', artifactId: 'a2', contentType: 'image/svg+xml', origin: 'upload' },
    ])

    // A `.png` over a JPEG is a lie an image loader is entitled to act on; an unrecognised type
    // falls back rather than producing an extensionless file.
    expect(named.map((file) => file.fileName)).toEqual(['Checkout.jpg', 'Confirm.png'])
  })

  it('still names a view whose characters all fall outside the safe set', () => {
    const named = nameReferenceFiles([
      { view: '???', artifactId: 'a1', contentType: 'image/png', origin: 'design' },
    ])

    expect(named[0]?.fileName).toBe('view.png')
  })
})

describe('capReferences', () => {
  function reference(view: string, origin: 'design' | 'upload') {
    return { view, artifactId: `a-${view}`, contentType: 'image/png', origin }
  }

  it('passes a set that fits through untouched', () => {
    const references = [reference('A', 'design'), reference('B', 'upload')]

    expect(capReferences(references)).toEqual({ kept: references, omitted: [] })
  })

  it('drops DESIGN frames before uploads, whatever order they were emitted in', () => {
    // The merge emits design frames first and appends upload-only views, so a plain prefix would
    // discard exactly the deliberate half. An upload is an act against this one task; a design
    // frame is a projection the next import replaces wholesale.
    const designs = Array.from({ length: MAX_REFERENCE_SCREENSHOTS }, (_, n) =>
      reference(`design-${n}`, 'design'),
    )
    const uploads = [reference('upload-1', 'upload'), reference('upload-2', 'upload')]

    const { kept, omitted } = capReferences([...designs, ...uploads])

    expect(kept).toHaveLength(MAX_REFERENCE_SCREENSHOTS)
    expect(kept.filter((r) => r.origin === 'upload')).toEqual(uploads)
    // The two design frames the uploads displaced, named off the same ceiling the code reads.
    expect(omitted).toEqual(
      designs.slice(MAX_REFERENCE_SCREENSHOTS - uploads.length).map((r) => r.view),
    )
  })

  it('keeps the emitted ORDER of whatever it kept', () => {
    const references = [
      reference('d1', 'design'),
      reference('u1', 'upload'),
      reference('d2', 'design'),
      reference('u2', 'upload'),
    ]

    // A caller renders the set in order (each design's frames contiguous), so the cap may choose
    // what to drop but never reshuffle what it keeps.
    const { kept } = capReferences(references.slice(0, MAX_REFERENCE_SCREENSHOTS))
    expect(kept.map((r) => r.view)).toEqual(['d1', 'u1', 'd2', 'u2'])
  })

  it('still names every dropped view when the uploads ALONE overflow', () => {
    const uploads = Array.from({ length: MAX_REFERENCE_SCREENSHOTS + 3 }, (_, n) =>
      reference(`upload-${n}`, 'upload'),
    )

    const { kept, omitted } = capReferences(uploads)

    expect(kept).toHaveLength(MAX_REFERENCE_SCREENSHOTS)
    // Nothing is silently lost even when the preference cannot help: what is dropped is stated.
    expect(omitted).toEqual(uploads.slice(MAX_REFERENCE_SCREENSHOTS).map((r) => r.view))
    expect(kept.length + omitted.length).toBe(uploads.length)
  })
})

describe('resolveReferenceScreenshots', () => {
  const store = {
    listByBlock: async () => [upload('Checkout')],
    listByDocuments: async () => [],
  } as never

  it('asks nothing for a kind that captures no views', async () => {
    expect(
      await resolveReferenceScreenshots(
        { agentKindRegistry: registry, resolveBinaryArtifactStore: async () => store },
        'coder',
        'ws',
        'blk',
      ),
    ).toEqual({})
  })

  it('asks nothing when the deployment stores no binary artifacts', async () => {
    expect(
      await resolveReferenceScreenshots({ agentKindRegistry: registry }, 'tester-ui', 'ws', 'blk'),
    ).toEqual({})
    expect(
      await resolveReferenceScreenshots(
        { agentKindRegistry: registry, resolveBinaryArtifactStore: async () => null },
        'tester-ui',
        'ws',
        'blk',
      ),
    ).toEqual({})
  })

  it('answers an EMPTY array for a task that simply has no reference', async () => {
    const empty = { listByBlock: async () => [], listByDocuments: async () => [] } as never

    // Distinct from an absent field: this dispatch asked, and the answer was none. The executor
    // sends no manifest either way, but the two are different facts about the run.
    expect(
      await resolveReferenceScreenshots(
        { agentKindRegistry: registry, resolveBinaryArtifactStore: async () => empty },
        'tester-ui',
        'ws',
        'blk',
      ),
    ).toEqual({ referenceScreenshots: { files: [], omitted: [] } })
  })

  it('names the task’s references for delivery', async () => {
    const resolved = await resolveReferenceScreenshots(
      { agentKindRegistry: registry, resolveBinaryArtifactStore: async () => store },
      'tester-ui',
      'ws',
      'blk',
    )

    expect(resolved.referenceScreenshots).toEqual({
      files: [{ view: 'Checkout', artifactId: 'art_1', fileName: 'Checkout.png' }],
      omitted: [],
    })
  })
})
