import { describe, it, expect } from 'vitest'
import { freshPromptTokens } from './observability'

describe('freshPromptTokens', () => {
  it('subtracts the cached prefix from the prompt-token sum', () => {
    expect(freshPromptTokens(1000, 300)).toBe(700)
  })

  it('reduces a near-fully-cached agentic run to its tiny fresh input (inclusive shape)', () => {
    // The 31M-cache-read shape from the investigation on the INCLUSIVE shape (subscription
    // harness / OpenAI-style): prompt tokens INCLUDE the cache reads, so subtracting the cached
    // subset leaves the few-hundred-token fresh figure, not tens of millions.
    expect(freshPromptTokens(31_100_498, 31_099_813)).toBe(685)
  })

  it('treats promptTokens as already-fresh when cached exceeds it (Anthropic separate shape)', () => {
    // Anthropic via the LLM proxy reports cache reads SEPARATELY, so promptTokens is fresh-only
    // and cachedPromptTokens can far exceed it. The fresh figure is promptTokens itself — NOT 0
    // (the old subtract-and-clamp collapsed real fresh input to zero on this shape).
    expect(freshPromptTokens(685, 31_099_813)).toBe(685)
  })

  it('never returns negative, and treats a fully-cached inclusive rollup as 0 fresh', () => {
    expect(freshPromptTokens(500, 500)).toBe(0)
    // cached > prompt ⇒ separate shape ⇒ fresh = prompt (never a negative number).
    expect(freshPromptTokens(500, 600)).toBe(500)
  })
})
