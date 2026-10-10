import { describe, expect, it } from 'vitest'
import { joinSentences } from './prose.js'

describe('joinSentences', () => {
  it('separates present fragments with exactly one space', () => {
    expect(joinSentences('CI is still red.', 'Two checks failed.', 'Retry once fixed.')).toBe(
      'CI is still red. Two checks failed. Retry once fixed.',
    )
  })

  // The defect this helper exists for: the hole sits BETWEEN two fragments, which is exactly
  // where a trailing `.trim()` on the concatenation cannot reach.
  it('closes the gap when the middle fragment is absent', () => {
    expect(joinSentences('CI is still red.', undefined, 'Retry once fixed.')).toBe(
      'CI is still red. Retry once fixed.',
    )
  })

  it('treats empty, whitespace-only and null the same as absent', () => {
    expect(joinSentences('a.', '', 'b.', '   ', 'c.', null, 'd.')).toBe('a. b. c. d.')
  })

  it('drops an absent fragment at either end without leaving an edge space', () => {
    expect(joinSentences(undefined, 'Only this.')).toBe('Only this.')
    expect(joinSentences('Only this.', undefined)).toBe('Only this.')
  })

  it('trims each fragment, so a provider summary carrying its own newline still joins cleanly', () => {
    expect(joinSentences('Head.', '  Two checks failed.\n', 'Tail.')).toBe(
      'Head. Two checks failed. Tail.',
    )
  })

  it('returns an empty string when nothing is present', () => {
    expect(joinSentences(undefined, '', null, '  ')).toBe('')
    expect(joinSentences()).toBe('')
  })

  it('keeps interior whitespace of a fragment intact', () => {
    expect(joinSentences('one  two', 'three')).toBe('one  two three')
  })
})
