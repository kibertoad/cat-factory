import { describe, expect, it } from 'vitest'
import {
  cacheTokensFromUsage,
  freshPromptTokens,
  inlineCacheProviderOptions,
  promptCacheParams,
  providerCachePolicy,
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

  it('reads the two cache classes APART across the provider field names', () => {
    // OpenAI/DeepSeek report reads only — a write class they do not expose must be 0, never
    // guessed, or a run on those providers reports spend at 1.25-2x base input that never
    // happened.
    expect(cacheTokensFromUsage({ prompt_tokens_details: { cached_tokens: 1200 } })).toEqual({
      read: 1200,
      write: 0,
    })
    expect(cacheTokensFromUsage({ prompt_cache_hit_tokens: 800 })).toEqual({ read: 800, write: 0 })
    // Anthropic reports both classes under its own fields (raw API + AI SDK camelCase). They
    // stay apart: a read is ~0.1x base input, a write 1.25-2x, so summing them makes a loop
    // that keeps re-writing the prefix look like one riding a warm cache.
    expect(
      cacheTokensFromUsage({ cache_read_input_tokens: 640, cache_creation_input_tokens: 96 }),
    ).toEqual({ read: 640, write: 96 })
    expect(
      cacheTokensFromUsage({ cacheReadInputTokens: 512, cacheCreationInputTokens: 64 }),
    ).toEqual({ read: 512, write: 64 })
    expect(cacheTokensFromUsage({ prompt_tokens: 5000 })).toEqual({ read: 0, write: 0 })
    expect(cacheTokensFromUsage(null)).toEqual({ read: 0, write: 0 })
  })

  it('normalises an inclusive prompt count to fresh input, never below zero', () => {
    // OpenAI/DeepSeek: the cached share is a SUBSET of prompt_tokens, so it comes off.
    expect(freshPromptTokens(5000, 1200)).toBe(3800)
    // A fully-cached turn is 0 fresh — not a negative count when the two figures disagree.
    expect(freshPromptTokens(1200, 1200)).toBe(0)
    expect(freshPromptTokens(1000, 1200)).toBe(0)
    expect(freshPromptTokens(5000, 0)).toBe(5000)
  })
})
