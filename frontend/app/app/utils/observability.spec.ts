import { describe, it, expect } from 'vitest'
import { totalInputTokens } from './observability'

describe('totalInputTokens', () => {
  it('sums all three input classes, so the headline matches Claude Code’s context gauge', () => {
    expect(
      totalInputTokens({ promptTokens: 685, cacheReadTokens: 31_099_813, cacheWriteTokens: 0 }),
    ).toBe(31_100_498)
  })

  it('counts cache WRITES too — they occupy the window like any other input token', () => {
    expect(
      totalInputTokens({ promptTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 40 }),
    ).toBe(1040)
  })

  it('does NOT lead with the fresh figure on a cache-dominated run', () => {
    // The regression this pins: leading with fresh made a ~31M-token run render as 685 tokens,
    // discounting cache reads because their dollar cost is low. Volume is the thing being
    // measured here, and a cached token costs the same context window as a fresh one.
    const m = { promptTokens: 685, cacheReadTokens: 31_099_813, cacheWriteTokens: 0 }
    expect(totalInputTokens(m)).toBeGreaterThan(m.promptTokens * 1000)
  })

  it('degrades to the fresh count when an older snapshot carries no cache fields', () => {
    expect(totalInputTokens({ promptTokens: 500 })).toBe(500)
  })
})
