import { describe, expect, it } from 'vitest'
import type { BinaryArtifactRecord } from '@cat-factory/kernel'
import { defaultAgentKindRegistry } from '@cat-factory/agents'
import { nameReferenceFiles, resolveReferenceScreenshots } from './run-reference-screenshots.js'

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
    ).toEqual({ referenceScreenshots: [] })
  })

  it('names the task’s references for delivery', async () => {
    const resolved = await resolveReferenceScreenshots(
      { agentKindRegistry: registry, resolveBinaryArtifactStore: async () => store },
      'tester-ui',
      'ws',
      'blk',
    )

    expect(resolved.referenceScreenshots).toEqual([
      { view: 'Checkout', artifactId: 'art_1', fileName: 'Checkout.png' },
    ])
  })
})
