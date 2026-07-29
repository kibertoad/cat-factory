import { describe, expect, it } from 'vitest'
import { cleanBrief } from './LlmFragmentBriefGenerator.js'

// `cleanBrief` NORMALISES only — it neither truncates nor rejects. Whether what it returns is
// usable is the kernel's `isUsableBrief` (see `fragment-brief.test.ts`), so that the size rule
// lives in exactly one place and no caller can get a silently shortened standard back.

describe('cleanBrief', () => {
  it('passes ordinary prose through, trimmed', () => {
    expect(cleanBrief('  Always validate at the boundary.  ')).toBe(
      'Always validate at the boundary.',
    )
  })

  it('unwraps a fenced reply', () => {
    // Models routinely wrap a "document" answer in a fence despite being told not to; left in,
    // the backticks would be folded into an implementer's prompt as literal syntax.
    expect(cleanBrief('```\nNever log a credential.\n```')).toBe('Never log a credential.')
    expect(cleanBrief('```markdown\nNever log a credential.\n```')).toBe('Never log a credential.')
  })

  it('strips a leading label the prompt asked it to omit', () => {
    expect(cleanBrief('Condensed standard: Prefer composition.')).toBe('Prefer composition.')
    expect(cleanBrief('Brief - Prefer composition.')).toBe('Prefer composition.')
  })

  it('strips the label INSIDE a fence, not just outside it', () => {
    expect(cleanBrief('```\nCondensed standard: Prefer composition.\n```')).toBe(
      'Prefer composition.',
    )
  })

  it('leaves an inner fence alone, so a standard quoting code survives', () => {
    // Only a fence WRAPPING the whole reply is the model's own packaging; one in the middle is
    // part of the standard (a required snippet, a config example) and must not be unwrapped.
    const withExample = 'Use the helper:\n\n```ts\nrunBestEffort(log, "x", fn)\n```\n\nAlways.'
    expect(cleanBrief(withExample)).toBe(withExample)
  })

  it('returns empty for an empty or whitespace-only reply', () => {
    expect(cleanBrief('   \n  ')).toBe('')
  })
})
