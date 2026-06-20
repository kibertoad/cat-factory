import { describe, expect, it } from 'vitest'
import {
  cachedTokensFromUsage,
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

  it('reads cached token counts across the provider field names', () => {
    expect(cachedTokensFromUsage({ prompt_tokens_details: { cached_tokens: 1200 } })).toBe(1200)
    expect(cachedTokensFromUsage({ prompt_cache_hit_tokens: 800 })).toBe(800)
    expect(cachedTokensFromUsage({ prompt_tokens: 5000 })).toBe(0)
    expect(cachedTokensFromUsage(null)).toBe(0)
  })
})
