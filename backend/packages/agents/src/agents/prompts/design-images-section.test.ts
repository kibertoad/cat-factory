import { describe, expect, it } from 'vitest'
import type { AgentRunContext } from '@cat-factory/kernel'
import { DESIGN_RENDER_DIR, designImagesSection } from './standard.js'

const FILES = [
  { view: 'Checkout', artifactId: 'art_1', contentType: 'image/png', fileName: 'Checkout.png' },
  { view: 'Cart', artifactId: 'art_2', contentType: 'image/png', fileName: 'Cart.png' },
]

function context(over: Partial<AgentRunContext>): AgentRunContext {
  return over as AgentRunContext
}

describe('designImagesSection', () => {
  it('is empty for a run whose task links no design', () => {
    // Byte-identical to the prompt every such run got before, which is most of them.
    expect(designImagesSection(context({}))).toBe('')
  })

  it('is empty while the dispatch has not decided yet', () => {
    // The set alone cannot be rendered: what the section SAYS depends on what became of it.
    expect(designImagesSection(context({ designImages: { files: FILES, omitted: [] } }))).toBe('')
  })

  it('points a container agent at the files on disk', () => {
    const section = designImagesSection(
      context({
        designImages: { files: FILES, omitted: [] },
        designImageDelivery: { attached: true, channel: 'files' },
      }),
    )
    expect(section).toContain(`${DESIGN_RENDER_DIR}/Checkout.png`)
    expect(section).toContain('Checkout')
    expect(section).not.toContain('attached to this message')
  })

  it('tells an inline model the pictures are in the message, and names no path', () => {
    // Naming the wrong channel is worse than naming neither: an inline model has no filesystem.
    const section = designImagesSection(
      context({
        designImages: { files: FILES, omitted: [] },
        designImageDelivery: { attached: true, channel: 'message' },
      }),
    )
    expect(section).toContain('attached to this message')
    expect(section).not.toContain(DESIGN_RENDER_DIR)
  })

  it('states the CAUSE when the pictures could not be delivered, and says not to chase them', () => {
    for (const [reason, phrase] of [
      ['harness_no_image_input', 'agent CLI'],
      ['model_no_image_input', 'does not accept image input'],
      ['unknown_model_image_input', 'does not know whether'],
      ['transfer_failed', 'could not be retrieved'],
    ] as const) {
      const section = designImagesSection(
        context({
          designImages: { files: FILES, omitted: [] },
          designImageDelivery: { attached: false, reason },
        }),
      )
      expect(section).toContain(phrase)
      // The agent must still learn the views EXIST, or the textual description reads as
      // everything the platform had.
      expect(section).toContain('Checkout')
      expect(section).toContain('Do not ask for the images')
    }
  })

  it('names the views it is not showing', () => {
    const section = designImagesSection(
      context({
        designImages: { files: FILES, omitted: ['Order confirmation'] },
        designImageDelivery: { attached: true, channel: 'message' },
      }),
    )
    expect(section).toContain('Order confirmation')
  })
})
