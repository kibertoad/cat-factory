import { describe, expect, it } from 'vitest'
import {
  agentUsageFromModelUsage,
  inlineCacheProviderOptions,
  promptCacheParams,
  providerCachePolicy,
  readInputTokenClasses,
} from '@cat-factory/agents'

// Pure prompt-caching policy shared by the in-container proxy path and the inline
// AI-SDK path. Lives in the worker integration suite because the agents package has
// no standalone test runner (its prompt tests live here too).
describe('provider cache policy', () => {
  it('classifies each provider by how it caches', () => {
    expect(providerCachePolicy('openai')).toBe('auto-prefix')
    expect(providerCachePolicy('deepseek')).toBe('auto-prefix')
    expect(providerCachePolicy('qwen')).toBe('auto-prefix')
    expect(providerCachePolicy('anthropic')).toBe('explicit-anthropic')
    expect(providerCachePolicy('workers-ai')).toBe('none')
    expect(providerCachePolicy('moonshot')).toBe('none')
  })

  it('sends a routing cache key only to OpenAI (others cache on the prefix alone)', () => {
    expect(promptCacheParams('openai', 'exec_1')).toEqual({ prompt_cache_key: 'exec_1' })
    expect(promptCacheParams('deepseek', 'exec_1')).toEqual({})
    expect(promptCacheParams('qwen', 'exec_1')).toEqual({})
    expect(promptCacheParams('workers-ai', 'exec_1')).toEqual({})
    // No key ⇒ no param, even for OpenAI.
    expect(promptCacheParams('openai', null)).toEqual({})
  })

  it('opts Anthropic into explicit ephemeral caching on the inline path', () => {
    expect(inlineCacheProviderOptions('anthropic')).toEqual({
      anthropic: { cacheControl: { type: 'ephemeral' } },
    })
    expect(inlineCacheProviderOptions('openai')).toEqual({})
    expect(inlineCacheProviderOptions('workers-ai')).toEqual({})
  })

  it('splits an INCLUSIVE prompt count into its three classes (OpenAI/DeepSeek)', () => {
    // The cached share is a SUBSET of prompt_tokens, so it comes off to leave fresh. These
    // providers expose no write class, so it is 0 — never guessed, or a run on them reports
    // spend at 1.25-2x base input that never happened.
    expect(
      readInputTokenClasses({
        prompt_tokens: 5000,
        prompt_tokens_details: { cached_tokens: 1200 },
      }),
    ).toEqual({ fresh: 3800, cacheRead: 1200, cacheWrite: 0 })
    expect(readInputTokenClasses({ prompt_tokens: 5000, prompt_cache_hit_tokens: 800 })).toEqual({
      fresh: 4200,
      cacheRead: 800,
      cacheWrite: 0,
    })
    // A fully-cached turn is 0 fresh — not a negative count when the two figures disagree.
    expect(
      readInputTokenClasses({
        prompt_tokens: 1000,
        prompt_tokens_details: { cached_tokens: 1200 },
      }),
    ).toEqual({ fresh: 0, cacheRead: 1200, cacheWrite: 0 })
  })

  it('leaves an EXCLUSIVE prompt count alone and reads both classes beside it (Anthropic)', () => {
    // `input_tokens` is already fresh-only here, so nothing is subtracted and the three are
    // simply additive. Both spellings (raw API + AI SDK camelCase) are covered.
    expect(
      readInputTokenClasses({
        input_tokens: 400,
        cache_read_input_tokens: 640,
        cache_creation_input_tokens: 96,
      }),
    ).toEqual({ fresh: 400, cacheRead: 640, cacheWrite: 96 })
    expect(
      readInputTokenClasses({
        inputTokens: 300,
        cacheReadInputTokens: 512,
        cacheCreationInputTokens: 64,
      }),
    ).toEqual({ fresh: 300, cacheRead: 512, cacheWrite: 64 })
  })

  it('keeps the WRITE class on an OpenAI-shaped gateway fronting Anthropic', () => {
    // The shape that motivated reading the two classes INDEPENDENTLY: a gateway (litellm /
    // OpenRouter) reports its reads under the OpenAI field AND Anthropic's write field beside
    // it. Detecting the read must not suppress the write — that would drop the DEAREST class
    // (1.25-2x base input) on the only path that reports it, i.e. exactly the spend this split
    // exists to expose. Both come off the inclusive prompt count, so the total we record stays
    // equal to the vendor's own `prompt_tokens` rather than minting input it never billed.
    expect(
      readInputTokenClasses({
        prompt_tokens: 5000,
        prompt_tokens_details: { cached_tokens: 4000 },
        cache_creation_input_tokens: 600,
      }),
    ).toEqual({ fresh: 400, cacheRead: 4000, cacheWrite: 600 })
  })

  it('reports no cache classes for a provider that reports none, and survives junk', () => {
    expect(readInputTokenClasses({ prompt_tokens: 5000 })).toEqual({
      fresh: 5000,
      cacheRead: 0,
      cacheWrite: 0,
    })
    expect(readInputTokenClasses(null)).toEqual({ fresh: 0, cacheRead: 0, cacheWrite: 0 })
    // A vendor inconsistency degrades to a sane number rather than a negative or a NaN.
    expect(
      readInputTokenClasses({ prompt_tokens: -1, prompt_tokens_details: { cached_tokens: 'x' } }),
    ).toEqual({ fresh: 0, cacheRead: 0, cacheWrite: 0 })
  })
})

describe('agentUsageFromModelUsage', () => {
  it('splits the AI SDK total by the cache classes the provider reported', () => {
    expect(
      agentUsageFromModelUsage({
        inputTokens: 10_000,
        outputTokens: 500,
        inputTokenDetails: { cacheReadTokens: 8_000, cacheWriteTokens: 1_000 },
      }),
    ).toEqual({
      inputTokens: 10_000,
      outputTokens: 500,
      inputClasses: { promptTokens: 1_000, cacheReadTokens: 8_000, cacheWriteTokens: 1_000 },
    })
  })

  it('reports NO split when the provider said nothing about caching', () => {
    // A provider that caches nothing still fills `noCacheTokens`, so keying on that would let
    // every provider claim a split. Absent here means the lump is priced as fresh, which is the
    // same money and an honest claim about what was observed.
    const usage = agentUsageFromModelUsage({
      inputTokens: 10_000,
      outputTokens: 500,
      inputTokenDetails: { cacheReadTokens: undefined, cacheWriteTokens: undefined },
    })
    expect(usage).toEqual({ inputTokens: 10_000, outputTokens: 500 })
    expect(agentUsageFromModelUsage({})).toEqual({ inputTokens: 0, outputTokens: 0 })
  })

  it('keeps the classes summing to the total even when the details disagree with it', () => {
    const usage = agentUsageFromModelUsage({
      inputTokens: 1_000,
      outputTokens: 0,
      inputTokenDetails: { cacheReadTokens: 5_000, cacheWriteTokens: 0 },
    })
    expect(usage.inputTokens).toBe(1_000)
    expect(usage.inputClasses).toEqual({
      promptTokens: 0,
      cacheReadTokens: 1_000,
      cacheWriteTokens: 0,
    })
  })
})
