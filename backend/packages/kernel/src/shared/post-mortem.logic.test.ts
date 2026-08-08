import { describe, expect, it } from 'vitest'
import {
  composePostMortem,
  MAX_POST_MORTEM_CHARS,
  tailPostMortemMaterial,
} from './post-mortem.logic.js'

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

describe('tailPostMortemMaterial', () => {
  it('leaves material that already fits alone', () => {
    expect(tailPostMortemMaterial('boot\ncrash', 100)).toBe('boot\ncrash')
  })

  it('keeps the END of the material, which is where the death is', () => {
    // The opposite direction from composePostMortem's cap, and deliberately so. A log's value is
    // at the end; bounding one from the front keeps the boot chatter and drops the crash.
    const logs = `${'boot chatter\n'.repeat(50)}FATAL: out of memory`

    const tail = tailPostMortemMaterial(logs, 40)

    expect(tail.endsWith('FATAL: out of memory')).toBe(true)
    expect(tail).not.toContain('boot chatter\nboot chatter')
  })

  it('says how much it dropped rather than reading like the whole of what was there', () => {
    expect(tailPostMortemMaterial('x'.repeat(30), 10)).toMatch(
      /^…\(20 earlier characters dropped\)\nx{10}$/,
    )
  })

  it('bounds material a LINE cap already passed, which is the case that motivates it', () => {
    // `docker logs --tail 50` counts lines. Fifty lines of an agent echoing a base64 payload is
    // tens of kilobytes, and reaching composePostMortem's head-keeping cap unbounded is what
    // loses precisely the crash the tail was read for.
    const fiftyLongLines = Array.from({ length: 50 }, (_, i) => `${'y'.repeat(500)}${i}`).join('\n')

    const composed = composePostMortem(['verdict', tailPostMortemMaterial(fiftyLongLines, 2_000)])

    expect(composed?.length).toBeLessThan(MAX_POST_MORTEM_CHARS)
    expect(composed).toContain('49')
  })
})
