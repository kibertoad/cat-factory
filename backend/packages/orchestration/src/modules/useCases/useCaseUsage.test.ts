import { describe, expect, it } from 'vitest'
import { readUseCaseUsage } from './useCaseUsage.js'

// The one thing the public `usage` object promises: `inputTokens` is what the vendor BILLED as
// input, cache classes included, and the three numbers add up. Both vendor shapes are asserted
// because they disagree about where a cached prefix is counted, and the wrong reading is silent:
// it publishes a number that looks plausible and under-reports a cache-heavy call.

/** The AI SDK's usage object, as `generateText` hands it back (flat totals plus the raw payload). */
function sdkUsage(
  inputTokens: number | undefined,
  outputTokens: number,
  raw?: Record<string, unknown>,
) {
  return { inputTokens, outputTokens, totalTokens: (inputTokens ?? 0) + outputTokens, raw }
}

describe('readUseCaseUsage', () => {
  it('counts an Anthropic-shaped cache read as billed input, not beside it', () => {
    // `input_tokens` is fresh-only here, with both cache classes alongside it. Reading the prompt
    // field alone would publish 1,000 for a call that billed 7,200.
    const usage = sdkUsage(1_000, 40, {
      input_tokens: 1_000,
      cache_read_input_tokens: 6_000,
      cache_creation_input_tokens: 200,
      output_tokens: 40,
    })
    expect(readUseCaseUsage(usage)).toEqual({
      inputTokens: 7_200,
      outputTokens: 40,
      totalTokens: 7_240,
    })
  })

  it('does not double-count an OpenAI-shaped cache read, which is already inside the prompt count', () => {
    const usage = sdkUsage(3_000, 25, {
      prompt_tokens: 3_000,
      prompt_tokens_details: { cached_tokens: 2_400 },
      completion_tokens: 25,
    })
    expect(readUseCaseUsage(usage)).toEqual({
      inputTokens: 3_000,
      outputTokens: 25,
      totalTokens: 3_025,
    })
  })

  it("falls back to the SDK's own total when the provider passed no raw payload", () => {
    expect(readUseCaseUsage(sdkUsage(120, 30))).toEqual({
      inputTokens: 120,
      outputTokens: 30,
      totalTokens: 150,
    })
  })

  it('answers zeroes rather than NaN for a provider that reported nothing', () => {
    expect(readUseCaseUsage(sdkUsage(undefined, 0, {}))).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    })
    expect(readUseCaseUsage(undefined)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    })
  })

  it('publishes a total that is the sum of its own parts', () => {
    // The provider's own total is deliberately not published: a cache-heavy call whose reported
    // total was computed off a fresh-only input count would answer with three figures that
    // disagree, leaving a consumer no way to tell which to meter from.
    const usage = {
      ...sdkUsage(1_000, 40, { input_tokens: 1_000, cache_read_input_tokens: 6_000 }),
      totalTokens: 1_040,
    }
    const read = readUseCaseUsage(usage)
    expect(read.totalTokens).toBe(read.inputTokens + read.outputTokens)
    expect(read.totalTokens).toBe(7_040)
  })
})
