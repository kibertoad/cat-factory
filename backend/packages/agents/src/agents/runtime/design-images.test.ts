import { describe, expect, it } from 'vitest'
import type { DesignImageDelivery, DesignImageSet } from '@cat-factory/kernel'
import { createRecordingLogger } from '@cat-factory/kernel'
import {
  foldLoadedImages,
  inlineImageStore,
  loadDesignImages,
  prepareInlineImages,
} from './design-images.js'

const ATTACHED: DesignImageDelivery = { attached: true, channel: 'message' }

const SET: DesignImageSet = {
  files: [
    { view: 'Checkout', artifactId: 'art_1', contentType: 'image/png', fileName: 'Checkout.png' },
    { view: 'Cart', artifactId: 'art_2', contentType: 'image/png', fileName: 'Cart.png' },
  ],
  omitted: ['Order confirmation'],
}

/** Two pasted screenshots: the clipboard names every one of them `image.png`. */
const PASTED: DesignImageSet = {
  files: [
    { view: 'image.png', artifactId: 'art_a', contentType: 'image/png', fileName: 'image.png' },
    { view: 'image.png', artifactId: 'art_b', contentType: 'image/png', fileName: 'image-2.png' },
  ],
  omitted: [],
}

function storeOf(blobs: Record<string, Uint8Array | null | Error>) {
  return {
    getBlob: async (_ws: string, id: string) => {
      const blob = blobs[id]
      if (blob instanceof Error) throw blob
      return blob ?? null
    },
  } as never
}

function storeWith(blobs: Record<string, Uint8Array | null | Error>) {
  return async () => storeOf(blobs)
}

describe('loadDesignImages', () => {
  it('loads each picture with the media type its record carries', async () => {
    const loaded = await loadDesignImages(
      storeOf({ art_1: new Uint8Array([1]), art_2: new Uint8Array([2]) }),
      'ws',
      SET,
    )
    expect(loaded.images.map((i) => [i.artifactId, i.view, i.mediaType])).toEqual([
      ['art_1', 'Checkout', 'image/png'],
      ['art_2', 'Cart', 'image/png'],
    ])
    expect(loaded.missing).toEqual([])
  })

  it('drops a picture whose bytes are gone rather than sending an empty part', async () => {
    // The store can hold a row whose blob the backend lost; an image part with no bytes is a
    // failed request, not a degraded one.
    const loaded = await loadDesignImages(
      storeOf({ art_1: new Uint8Array([1]), art_2: new Uint8Array() }),
      'ws',
      SET,
    )
    expect(loaded.images.map((i) => i.view)).toEqual(['Checkout'])
    expect(loaded.missing).toEqual([{ artifactId: 'art_2', view: 'Cart' }])
  })

  it('withholds a picture whose read THREW, logs it, and keeps the rest', async () => {
    const logger = createRecordingLogger()
    const loaded = await loadDesignImages(
      storeOf({ art_1: new Error('R2 503'), art_2: new Uint8Array([2]) }),
      'ws',
      SET,
      logger,
    )
    expect(loaded.images.map((i) => i.artifactId)).toEqual(['art_2'])
    expect(loaded.missing).toEqual([{ artifactId: 'art_1', view: 'Checkout' }])
    expect(logger.lines.filter((line) => line.level === 'warn')).toHaveLength(1)
  })

  it('reports every picture as missing when the account stores nothing', async () => {
    const loaded = await loadDesignImages(null, 'ws', SET)
    expect(loaded.images).toEqual([])
    expect(loaded.missing.map((m) => m.view)).toEqual(['Checkout', 'Cart'])
  })
})

describe('foldLoadedImages', () => {
  it('moves a lost picture out of the file list so the prompt cannot name it', async () => {
    // Left in the list, the agent is told to look at a picture that is not in the message, which
    // reads to it as its own failure to find something.
    const folded = foldLoadedImages(
      SET,
      {
        images: [
          {
            artifactId: 'art_1',
            view: 'Checkout',
            mediaType: 'image/png',
            data: new Uint8Array([1]),
          },
        ],
        missing: [{ artifactId: 'art_2', view: 'Cart' }],
      },
      ATTACHED,
    )
    expect(folded.set.files.map((f) => f.view)).toEqual(['Checkout'])
    expect(folded.set.omitted).toEqual(['Order confirmation', 'Cart'])
    expect(folded.delivery).toEqual(ATTACHED)
  })

  it('keys on the artifact, so two same-named pictures with one lost list ONE file', async () => {
    // Keyed on the view name, the shown `image.png` kept both files in the list while the message
    // carried one picture.
    const loaded = await loadDesignImages(
      storeOf({ art_a: new Uint8Array([1]), art_b: null }),
      'ws',
      PASTED,
    )
    const folded = foldLoadedImages(PASTED, loaded, ATTACHED)
    expect(folded.set.files.map((f) => f.artifactId)).toEqual(['art_a'])
    expect(folded.set.omitted).toEqual(['image.png'])
    expect(loaded.images).toHaveLength(folded.set.files.length)
  })

  it('settles a set that loaded NOTHING as a transfer failure, not an empty attachment', async () => {
    // Opposite facts, and only the first sends anyone to look at the store.
    const folded = foldLoadedImages(
      SET,
      {
        images: [],
        missing: [
          { artifactId: 'art_1', view: 'Checkout' },
          { artifactId: 'art_2', view: 'Cart' },
        ],
      },
      ATTACHED,
    )
    expect(folded.delivery).toEqual({ attached: false, reason: 'transfer_failed' })
    expect(folded.set).toEqual(SET)
  })
})

describe('inlineImageStore', () => {
  it('resolves the store once however many times it is asked', async () => {
    let calls = 0
    const store = inlineImageStore(async () => {
      calls += 1
      return null
    }, 'ws')
    await store!()
    await store!()
    expect(calls).toBe(1)
  })

  it('offers nothing to read through without a resolver or a workspace', () => {
    expect(inlineImageStore(undefined, 'ws')).toBeUndefined()
    expect(inlineImageStore(async () => null, undefined)).toBeUndefined()
  })
})

describe('prepareInlineImages', () => {
  const base = { set: SET, workspaceId: 'ws' }

  it('loads and attaches the bytes when the model takes images', async () => {
    const prepared = await prepareInlineImages({
      ...base,
      ref: { acceptsImages: true },
      textOnly: false,
      store: storeWith({ art_1: new Uint8Array([1]), art_2: new Uint8Array([2]) }),
    })
    expect(prepared.outcome?.delivery).toEqual(ATTACHED)
    expect(prepared.images).toHaveLength(2)
  })

  it('states a text-only model and reads no bytes', async () => {
    const prepared = await prepareInlineImages({
      ...base,
      ref: { acceptsImages: false },
      textOnly: false,
      store: async () => {
        throw new Error('a refused set must not reach the store')
      },
    })
    expect(prepared.outcome?.delivery).toEqual({ attached: false, reason: 'model_no_image_input' })
    expect(prepared.images).toEqual([])
  })

  it('settles an unreachable store as a transfer failure instead of throwing', async () => {
    const logger = createRecordingLogger()
    const prepared = await prepareInlineImages({
      ...base,
      ref: { acceptsImages: true },
      textOnly: false,
      store: async () => {
        throw new Error('account settings unreachable')
      },
      logger,
    })
    expect(prepared.outcome?.delivery).toEqual({ attached: false, reason: 'transfer_failed' })
    expect(prepared.images).toEqual([])
    expect(logger.lines.filter((line) => line.level === 'warn')).toHaveLength(1)
  })

  it('refuses the ambient text-only path whatever the model accepts', async () => {
    const prepared = await prepareInlineImages({
      ...base,
      ref: { acceptsImages: true },
      textOnly: true,
      store: undefined,
    })
    expect(prepared.outcome?.delivery).toEqual({
      attached: false,
      reason: 'inline_harness_text_only',
    })
  })

  it('answers nothing for an empty set', async () => {
    const prepared = await prepareInlineImages({
      set: { files: [], omitted: [] },
      workspaceId: 'ws',
      ref: { acceptsImages: true },
      textOnly: false,
      store: undefined,
    })
    expect(prepared).toEqual({ images: [] })
  })
})
