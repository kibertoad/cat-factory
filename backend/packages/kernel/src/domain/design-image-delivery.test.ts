import { describe, expect, it } from 'vitest'
import type { HarnessKind } from '../ports/model-provider.js'
import {
  HARNESS_IMAGE_INPUT,
  harnessAcceptsImages,
  resolveDesignImageDelivery,
} from './design-image-delivery.js'

describe('harnessAcceptsImages', () => {
  it('answers for every harness the platform can dispatch to', () => {
    // Derived from the table itself rather than a pinned list: adding a harness must force an
    // answer here, and an omitted entry would read as `false` and silently drop every picture.
    for (const harness of Object.keys(HARNESS_IMAGE_INPUT) as HarnessKind[]) {
      expect(typeof harnessAcceptsImages(harness)).toBe('boolean')
    }
  })

  it('treats an INLINE call as able to carry one', () => {
    // No harness means no CLI in between: the caller composes the model message itself, so the
    // model half is the only question left.
    expect(harnessAcceptsImages(undefined)).toBe(true)
  })
})

describe('resolveDesignImageDelivery', () => {
  it('attaches through the MESSAGE for an inline call on an image-capable model', () => {
    expect(resolveDesignImageDelivery(undefined, { acceptsImages: true })).toEqual({
      attached: true,
      channel: 'message',
    })
  })

  it('attaches through FILES on a harness that reads them', () => {
    // The channel is what the prompt names, and naming the wrong one is worse than naming
    // neither: a container agent told its designs are "attached below" searches a message with
    // none.
    expect(resolveDesignImageDelivery('claude-code', { acceptsImages: true })).toEqual({
      attached: true,
      channel: 'files',
    })
  })

  it('blames the HARNESS before the model, even when the model is the weaker half', () => {
    // A subscription harness pins its own model, so reporting `model_no_image_input` would send
    // someone to change a model they cannot change without also changing the CLI.
    expect(resolveDesignImageDelivery('pi', { acceptsImages: false })).toEqual({
      attached: false,
      reason: 'harness_no_image_input',
    })
  })

  it('keeps an UNDECLARED model apart from a text-only one', () => {
    // Two different fixes: declare the flavour's modality, versus pick a different model.
    expect(resolveDesignImageDelivery(undefined, {})).toEqual({
      attached: false,
      reason: 'unknown_model_image_input',
    })
    expect(resolveDesignImageDelivery(undefined, { acceptsImages: false })).toEqual({
      attached: false,
      reason: 'model_no_image_input',
    })
  })
})
