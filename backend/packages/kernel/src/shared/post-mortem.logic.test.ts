import { describe, expect, it } from 'vitest'
import { composePostMortem, MAX_POST_MORTEM_CHARS } from './post-mortem.logic.js'

// The two obligations every transport's eviction `detail` carries, asserted once here rather
// than per transport: the text is persisted and rendered to a person, and it is assembled from
// a dead container's own output.

describe('composePostMortem', () => {
  it('joins the parts a caller composed with plain optionals', () => {
    expect(composePostMortem(['exit code 137', undefined, '  ', 'logs:\nboom'])).toBe(
      'exit code 137\nlogs:\nboom',
    )
  })

  it('answers undefined when there was nothing to say', () => {
    // Distinct from an empty string on purpose: the eviction view omits the field entirely, so
    // "nothing could be read" does not render as a container that had nothing to report.
    expect(composePostMortem([])).toBeUndefined()
    expect(composePostMortem([undefined, ''])).toBeUndefined()
  })

  it('scrubs the secrets a container echoes back in its own output', () => {
    const composed = composePostMortem(['clone failed: authorization: Bearer ghp_realsecret0001'])

    expect(composed).toContain('clone failed')
    expect(composed).not.toContain('ghp_realsecret0001')
  })

  it('caps the text and says what it dropped', () => {
    // A cap that ends mid-word reads exactly like the whole of what was there, which is the one
    // way a truncated diagnostic actively misleads.
    const composed = composePostMortem(['verdict', 'x'.repeat(MAX_POST_MORTEM_CHARS)])

    expect(composed?.startsWith('verdict\n')).toBe(true)
    expect(composed).toMatch(/…\(8 more characters of post-mortem detail dropped\)$/)
  })

  it('scrubs BEFORE it caps, so the two cannot disagree about a redacted span', () => {
    // Capping first would leave a half-written token in the kept text and no rule that ever
    // matches it again.
    const filler = 'x'.repeat(MAX_POST_MORTEM_CHARS - 20)
    const composed = composePostMortem([filler, 'authorization: Bearer ghp_realsecret0002'])

    expect(composed).not.toContain('ghp_realsecret0002')
  })
})
