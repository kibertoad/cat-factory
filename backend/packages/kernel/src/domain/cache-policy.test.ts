import { describe, expect, it } from 'vitest'
import { providerCachePolicy, providerCachesPrompts } from './cache-policy.js'

// The one source of truth two unrelated readers CONCLUDE from: the model catalog projects
// `cachesPrompts` onto the SPA's vendor pickers, and the call paths use the policy to decide
// which routing hint a request carries. Getting a provider's bucket wrong is silent and
// expensive: a container agent re-sends its whole growing prompt every turn, so a stable prefix
// that should have been a cache hit is re-billed as input on every one of them.

describe('providerCachePolicy', () => {
  it('buckets the auto-prefix providers, which need no explicit breakpoints', () => {
    expect(providerCachePolicy('openai')).toBe('auto-prefix')
    expect(providerCachePolicy('deepseek')).toBe('auto-prefix')
    expect(providerCachePolicy('qwen')).toBe('auto-prefix')
  })

  it('buckets anthropic apart, because its caching needs explicit cache_control', () => {
    // Handing an Anthropic request the auto-prefix treatment caches nothing at all: the
    // breakpoints are what turn the prefix into a cached one.
    expect(providerCachePolicy('anthropic')).toBe('explicit-anthropic')
  })

  it('answers `none` for an UNKNOWN provider rather than guessing a policy', () => {
    // A new provider must arrive as "no caching we rely on". The other way round would send
    // cache hints to an API that does not honour them, and nothing would report it.
    expect(providerCachePolicy('moonshot')).toBe('none')
    expect(providerCachePolicy('workers-ai')).toBe('none')
    expect(providerCachePolicy('')).toBe('none')
  })

  it('matches the provider id exactly, not by prefix or case', () => {
    expect(providerCachePolicy('OpenAI')).toBe('none')
    expect(providerCachePolicy('openai-compatible')).toBe('none')
  })
})

describe('providerCachesPrompts', () => {
  it('is true for every policy other than `none`', () => {
    expect(providerCachesPrompts('openai')).toBe(true)
    expect(providerCachesPrompts('anthropic')).toBe(true)
    expect(providerCachesPrompts('deepseek')).toBe(true)
    expect(providerCachesPrompts('qwen')).toBe(true)
  })

  it('is false exactly when the policy is `none`', () => {
    expect(providerCachesPrompts('moonshot')).toBe(false)
    expect(providerCachesPrompts('unknown-vendor')).toBe(false)
  })
})
