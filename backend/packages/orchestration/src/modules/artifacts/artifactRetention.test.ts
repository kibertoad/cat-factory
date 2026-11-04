import { describe, expect, it } from 'vitest'
import type { BinaryArtifactStore, Block } from '@cat-factory/kernel'
import { sweepBinaryArtifactRetention } from './artifactRetention.js'

const DAY = 24 * 60 * 60 * 1000

function storeAnchoring(anchors: string[]) {
  const pruned: string[][] = []
  const store = {
    pruneOlderThan: async () => 2,
    listBlockAnchorsOlderThan: async () => anchors,
    pruneByBlocks: async (_ws: string, blockIds: readonly string[]) => {
      pruned.push([...blockIds])
      return blockIds.length
    },
  } as unknown as BinaryArtifactStore
  return { store, pruned }
}

function found(id: string, workspaceId: string) {
  return { workspaceId, serviceId: null, block: { id } as Block }
}

describe('sweepBinaryArtifactRetention: block-anchored rows', () => {
  it('reclaims the task images whose block no longer exists in their workspace', async () => {
    // `blk_moved` exists, but homed elsewhere: its rows here are as unreachable as a deleted one's.
    const { store, pruned } = storeAnchoring(['blk_live', 'blk_gone', 'blk_moved'])
    const removed = await sweepBinaryArtifactRetention({
      resolveStore: async () => store,
      listWorkspaceIds: async () => ['ws'],
      retentionDaysFor: async () => 14,
      findBlocks: async () => [found('blk_live', 'ws'), found('blk_moved', 'ws_other')],
      now: 100 * DAY,
    })
    expect(pruned).toEqual([['blk_gone', 'blk_moved']])
    expect(removed).toBe(4)
  })

  it('reads no block and prunes nothing when no aged image is anchored anywhere', async () => {
    const { store, pruned } = storeAnchoring([])
    let reads = 0
    await sweepBinaryArtifactRetention({
      resolveStore: async () => store,
      listWorkspaceIds: async () => ['ws'],
      retentionDaysFor: async () => 14,
      findBlocks: async () => {
        reads += 1
        return []
      },
      now: 100 * DAY,
    })
    expect(reads).toBe(0)
    expect(pruned).toEqual([])
  })
})
