import type { AgentRunContext } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { dispatchImageDeliveries } from '../src/agents/containerAgentBody.js'

const SET = {
  files: [{ view: 'crash.png', artifactId: 'art_1', contentType: 'image/png', fileName: 'c.png' }],
  omitted: [],
}

const context = (over: Partial<AgentRunContext>) => over as AgentRunContext

describe('dispatchImageDeliveries', () => {
  it('answers each set on its own, and nothing for a set the task does not hold', () => {
    expect(dispatchImageDeliveries(context({}), 'claude-code', { acceptsImages: true })).toEqual({})
    expect(
      dispatchImageDeliveries(context({ taskImages: SET }), 'claude-code', { acceptsImages: true }),
    ).toEqual({ taskImageDelivery: { attached: true, channel: 'files' } })
  })

  it('withholds the attached images on a CLI that cannot read an image', () => {
    expect(
      dispatchImageDeliveries(context({ taskImages: SET, designImages: SET }), 'pi', {
        acceptsImages: true,
      }),
    ).toEqual({
      designImageDelivery: { attached: false, reason: 'harness_no_image_input' },
      taskImageDelivery: { attached: false, reason: 'harness_no_image_input' },
    })
  })
})
