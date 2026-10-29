import { describe, expect, it } from 'vitest'
import type { DesignImageDelivery, DesignImageSet } from '@cat-factory/kernel'
import { foldLoadedImages, loadDesignImages, prepareInlineImages } from './design-images.js'

const ATTACHED: DesignImageDelivery = { attached: true, channel: 'message' }

const SET: DesignImageSet = {
  files: [
    { view: 'Checkout', artifactId: 'art_1', contentType: 'image/png', fileName: 'Checkout.png' },
    { view: 'Cart', artifactId: 'art_2', contentType: 'image/png', fileName: 'Cart.png' },
  ],
  omitted: ['Order confirmation'],
}

function storeWith(blobs: Record<string, Uint8Array | null>) {
  return async () => ({ getBlob: async (_ws: string, id: string) => blobs[id] ?? null }) as never
}

describe('loadDesignImages', () => {
  it('loads each picture with the media type its record carries', async () => {
    const loaded = await loadDesignImages(
      storeWith({ art_1: new Uint8Array([1]), art_2: new Uint8Array([2]) }),
      'ws',
      SET,
    )
    expect(loaded.images.map((i) => [i.view, i.mediaType])).toEqual([
      ['Checkout', 'image/png'],
      ['Cart', 'image/png'],
    ])
    expect(loaded.missing).toEqual([])
  })

  it('drops a picture whose bytes are gone rather than sending an empty part', async () => {
    // The store can hold a row whose blob the backend lost; an image part with no bytes is a
    // failed request, not a degraded one.
    const loaded = await loadDesignImages(
      storeWith({ art_1: new Uint8Array([1]), art_2: new Uint8Array() }),
      'ws',
      SET,
    )
    expect(loaded.images.map((i) => i.view)).toEqual(['Checkout'])
    expect(loaded.missing).toEqual(['Cart'])
  })

  it('reports every view as missing when the account stores nothing', async () => {
    const loaded = await loadDesignImages(async () => null, 'ws', SET)
    expect(loaded.images).toEqual([])
    expect(loaded.missing).toEqual(['Checkout', 'Cart'])
  })
})

describe('foldLoadedImages', () => {
  it('moves a lost view out of the file list so the prompt cannot name it', async () => {
    // Left in the list, the agent is told to look at a picture that is not in the message, which
    // reads to it as its own failure to find something.
    const folded = foldLoadedImages(
      SET,
      {
        images: [{ view: 'Checkout', mediaType: 'image/png', data: new Uint8Array([1]) }],
        missing: ['Cart'],
      },
      ATTACHED,
    )
    expect(folded.set.files.map((f) => f.view)).toEqual(['Checkout'])
    expect(folded.set.omitted).toEqual(['Order confirmation', 'Cart'])
    expect(folded.delivery).toEqual(ATTACHED)
  })

  it('settles a set that loaded NOTHING as a transfer failure, not an empty attachment', async () => {
    // Opposite facts, and only the first sends anyone to look at the store.
    const folded = foldLoadedImages(SET, { images: [], missing: ['Checkout', 'Cart'] }, ATTACHED)
    expect(folded.delivery).toEqual({ attached: false, reason: 'transfer_failed' })
    expect(folded.set).toEqual(SET)
  })
})

describe('prepareInlineImages', () => {
  const base = { set: SET, workspaceId: 'ws' }

  it('loads and attaches the bytes when the model takes images', async () => {
    const prepared = await prepareInlineImages({
      ...base,
      ref: { acceptsImages: true },
      textOnly: false,
      resolveStore: storeWith({ art_1: new Uint8Array([1]), art_2: new Uint8Array([2]) }),
    })
    expect(prepared.outcome?.delivery).toEqual(ATTACHED)
    expect(prepared.images).toHaveLength(2)
  })

  it('states a text-only model and reads no bytes', async () => {
    const prepared = await prepareInlineImages({
      ...base,
      ref: { acceptsImages: false },
      textOnly: false,
      resolveStore: async () => {
        throw new Error('a refused set must not reach the store')
      },
    })
    expect(prepared.outcome?.delivery).toEqual({ attached: false, reason: 'model_no_image_input' })
    expect(prepared.images).toEqual([])
  })

  it('refuses the ambient text-only path whatever the model accepts', async () => {
    const prepared = await prepareInlineImages({
      ...base,
      ref: { acceptsImages: true },
      textOnly: true,
      resolveStore: undefined,
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
      resolveStore: undefined,
    })
    expect(prepared).toEqual({ images: [] })
  })
})
