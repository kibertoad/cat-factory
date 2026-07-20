import { describe, it, expect } from 'vitest'
import { freshPromptTokens } from './observability'

describe('freshPromptTokens', () => {
  it('subtracts the cached prefix from the prompt-token sum', () => {
    expect(freshPromptTokens(1000, 300)).toBe(700)
  })

  it('reduces a near-fully-cached agentic run to its tiny fresh input', () => {
    // The 31M-cache-read shape from the investigation: raw prompt tokens are ~all cache reads,
    // so the fresh figure is a few hundred tokens, not tens of millions.
    expect(freshPromptTokens(31_100_498, 31_099_813)).toBe(685)
  })

  it('clamps at 0 when cached is reported >= prompt (provider off-by-one)', () => {
    expect(freshPromptTokens(500, 500)).toBe(0)
    expect(freshPromptTokens(500, 600)).toBe(0)
  })
})
