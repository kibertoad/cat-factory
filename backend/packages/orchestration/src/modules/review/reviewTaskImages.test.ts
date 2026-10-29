import type { BinaryArtifactRecord, Block, ModelRef } from '@cat-factory/kernel'
import { createRecordingLogger } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { reviewRequestWithTaskImages } from './reviewTaskImages.js'

const block = { id: 'blk_1' } as Block
const IMAGE_MODEL: ModelRef = { provider: 'anthropic', model: 'claude', acceptsImages: true }

function attached(over: Partial<BinaryArtifactRecord> = {}): BinaryArtifactRecord {
  return {
    id: 'art_1',
    workspaceId: 'ws',
    executionId: null,
    blockId: 'blk_1',
    kind: 'context',
    view: 'crash.png',
    contentType: 'image/png',
    byteSize: 3,
    hash: 'h',
    storage: 'memory',
    storageKey: 'ws/art_1',
    document: null,
    createdAt: 1,
    ...over,
  }
}

function storeWith(records: BinaryArtifactRecord[]) {
  return async () =>
    ({
      listByBlock: async () => records,
      getBlob: async () => new Uint8Array([1, 2, 3]),
    }) as never
}

describe('reviewRequestWithTaskImages', () => {
  it('sends the plain prompt, unchanged, for a task with no attached image', async () => {
    const request = await reviewRequestWithTaskImages(
      { resolveBinaryArtifactStore: storeWith([attached({ kind: 'reference' })]) },
      'ws',
      block,
      IMAGE_MODEL,
      'Review this.',
    )
    expect(request).toEqual({ prompt: 'Review this.' })
  })

  it('attaches the images to the reviewer request and names them in its text', async () => {
    const request = await reviewRequestWithTaskImages(
      { resolveBinaryArtifactStore: storeWith([attached()]) },
      'ws',
      block,
      IMAGE_MODEL,
      'Review this.',
    )
    expect('messages' in request).toBe(true)
    const content = 'messages' in request ? request.messages[0]!.content : []
    expect(content.filter((part) => part.type === 'image')).toHaveLength(1)
    expect(JSON.stringify(content)).toContain('Images attached to this task')
  })

  it('states the images in text when the model cannot take them', async () => {
    const request = await reviewRequestWithTaskImages(
      { resolveBinaryArtifactStore: storeWith([attached()]) },
      'ws',
      block,
      { provider: 'workers-ai', model: '@cf/text' },
      'Review this.',
    )
    expect('prompt' in request && request.prompt).toContain('could NOT put in front of you')
  })

  it('reviews on unchanged when the store cannot be read, and logs it', async () => {
    const logger = createRecordingLogger()
    const request = await reviewRequestWithTaskImages(
      {
        resolveBinaryArtifactStore: async () => {
          throw new Error('store down')
        },
        logger,
      },
      'ws',
      block,
      IMAGE_MODEL,
      'Review this.',
    )
    expect(request).toEqual({ prompt: 'Review this.' })
    expect(logger.lines.filter((line) => line.level === 'warn')).toHaveLength(1)
  })
})
