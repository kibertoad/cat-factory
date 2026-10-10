import { describe, expect, it } from 'vitest'
import type { BinaryArtifactRecord } from '@cat-factory/kernel'
import { mergeBlockReferences, resolveBlockReferences } from './block-reference-set.js'

let seq = 0
function artifact(view: string | null, over: Partial<BinaryArtifactRecord> = {}) {
  seq += 1
  return {
    id: `art_${seq}`,
    workspaceId: 'ws',
    executionId: null,
    blockId: 'blk',
    kind: 'reference' as const,
    view,
    contentType: 'image/png',
    byteSize: 10,
    hash: 'h',
    storage: 'memory',
    storageKey: `ws/art_${seq}`,
    document: null,
    createdAt: seq,
    ...over,
  }
}

describe('mergeBlockReferences', () => {
  it('lets an UPLOAD outrank a design frame for the same view', () => {
    const upload = artifact('Checkout')

    const merged = mergeBlockReferences(
      [{ view: 'Checkout', artifactId: 'design_1', contentType: 'image/png' }],
      [upload],
    )

    // An upload is a deliberate act against this one task; a design frame is a projection the
    // next body-changing import replaces wholesale.
    expect(merged).toEqual([
      { view: 'Checkout', artifactId: upload.id, contentType: 'image/png', origin: 'upload' },
    ])
  })

  it('keeps the NEWEST upload for a view', () => {
    const older = artifact('Checkout')
    const newer = artifact('Checkout')

    // `listByBlock` reads oldest-first, so a person re-uploading a corrected reference for a view
    // they already populated must override the stale one rather than be discarded.
    expect(mergeBlockReferences([], [older, newer])[0]?.artifactId).toBe(newer.id)
  })

  it('files an upload with no view of its own under one shared name', () => {
    expect(mergeBlockReferences([], [artifact(null)])[0]?.view).toBe('(reference)')
  })

  it('emits the design frames in their own order, then the views only uploads introduce', () => {
    const merged = mergeBlockReferences(
      [
        { view: 'Checkout', artifactId: 'd1', contentType: 'image/png' },
        { view: 'Confirm', artifactId: 'd2', contentType: 'image/png' },
      ],
      [artifact('Settings')],
    )

    expect(merged.map((reference) => reference.view)).toEqual(['Checkout', 'Confirm', 'Settings'])
  })

  it('carries each image’s stored content type through', () => {
    const merged = mergeBlockReferences([], [artifact('Checkout', { contentType: 'image/jpeg' })])

    expect(merged[0]?.contentType).toBe('image/jpeg')
  })
})

describe('resolveBlockReferences', () => {
  it('answers an empty set when no artifact store is wired', async () => {
    const set = await resolveBlockReferences(undefined, null, 'ws', 'blk')

    expect(set).toEqual({ references: [], design: null })
  })

  it('reads a task’s uploads even when it links no design', async () => {
    const upload = artifact('Checkout')
    const store = {
      listByBlock: async () => [upload, artifact('Captured', { kind: 'screenshot' })],
    } as never

    const set = await resolveBlockReferences(undefined, store, 'ws', 'blk')

    // Screenshots share the block; only references are references.
    expect(set.references).toEqual([
      { view: 'Checkout', artifactId: upload.id, contentType: 'image/png', origin: 'upload' },
    ])
    expect(set.design).toBeNull()
  })

  it('folds a linked design’s frames in beside the uploads, and states its gaps', async () => {
    const frame = artifact('Checkout', { document: { source: 'figma', externalId: 'fileA' } })
    const upload = artifact('Settings')
    const documents = {
      listByBlock: async () => [
        { source: 'figma', externalId: 'fileA', title: 'Checkout flow', renderStatus: 'partial' },
      ],
    } as never
    const store = {
      listByDocuments: async () => [frame],
      listByBlock: async () => [upload],
    } as never

    const set = await resolveBlockReferences(documents, store, 'ws', 'blk')

    expect(set.references).toEqual([
      { view: 'Checkout', artifactId: frame.id, contentType: 'image/png', origin: 'design' },
      { view: 'Settings', artifactId: upload.id, contentType: 'image/png', origin: 'upload' },
    ])
    // "A design is linked and gave less than it has" is a fact the reference list cannot state.
    expect(set.design).toEqual({
      documents: 1,
      images: 1,
      gaps: [{ title: 'Checkout flow', reason: 'partial' }],
    })
  })
})
