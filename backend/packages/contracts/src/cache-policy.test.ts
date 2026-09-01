import { describe, expect, it } from 'vitest'
import { providerCachePolicy, providerCachesPrompts } from './cache-policy.js'

// The one source of truth three unrelated readers CONCLUDE from: the model catalog projects
// `cachesPrompts` onto the SPA's vendor pickers, the call paths use the policy to decide which
// routing hint a request carries, and the SPA's API-key page reads it directly. Getting a provider's bucket wrong is silent and
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

describe('providerCachePolicy: gateways', () => {
  // On a gateway the provider id names the RESELLER; only the slug names who serves the call.
  // Reading the provider alone answered `none` for all 300+ OpenRouter models, which is wrong in
  // the expensive direction: the picker told a user the hot path ran cache-less on a route that
  // rides the upstream's automatic prefix cache exactly as the direct flavour does.
  it('resolves an openrouter slug to the policy stated for its vendor prefix', () => {
    expect(providerCachePolicy('openrouter', 'openai/gpt-5.6-terra')).toBe('auto-prefix')
    expect(providerCachePolicy('openrouter', 'deepseek/deepseek-v4')).toBe('auto-prefix')
    // The gateway spells two vendors differently from our own provider ids, which is why the
    // prefix map is stated rather than assumed to be an identity.
    expect(providerCachePolicy('openrouter', 'x-ai/grok-4.6')).toBe('auto-prefix')
    // Neither has a direct provider id here at all, so no indirection through one could have
    // stated them; both are automatic on the gateway and both publish a cache-read rate.
    expect(providerCachePolicy('openrouter', 'z-ai/glm-5.2')).toBe('auto-prefix')
    expect(providerCachePolicy('openrouter', 'google/gemini-3.1-pro')).toBe('auto-prefix')
  })

  // The two prefixes whose gateway answer DISAGREES with the direct provider of the same name.
  // Borrowing the direct policy got each wrong in the opposite direction, and the spend table
  // already knew: it pins a cache-read rate for the Moonshot route it was answering `none` for.
  it('states a prefix whose gateway behaviour differs from the direct provider of that name', () => {
    expect(providerCachePolicy('moonshot')).toBe('none')
    expect(providerCachePolicy('openrouter', 'moonshotai/kimi-k2.7-code')).toBe('auto-prefix')
    // Alibaba's gateway route needs the same explicit breakpoints Anthropic does, and nothing
    // on this path emits them, so the direct provider's `auto-prefix` would be a claim to a
    // cache the picker never gets.
    expect(providerCachePolicy('qwen')).toBe('auto-prefix')
    expect(providerCachePolicy('openrouter', 'qwen/qwen3.8-max')).toBe('none')
  })

  // The deliberate asymmetry. `explicit-anthropic` is a claim about a request WE build, and
  // nothing on the gateway path emits `cache_control` breakpoints, so reporting it would tell the
  // picker a prefix is cached that nobody asked to cache.
  it('downgrades anthropic-behind-a-gateway to none, because nothing sends the breakpoints', () => {
    expect(providerCachePolicy('anthropic')).toBe('explicit-anthropic')
    expect(providerCachePolicy('openrouter', 'anthropic/claude-opus-5')).toBe('none')
  })

  it('answers none for a slug it cannot read a vendor off', () => {
    // A vendor that publishes a cache-read rate but whose cache-entry rule OpenRouter does not
    // document stays out of the table: a rate alone does not tell a caller a hit will happen.
    expect(providerCachePolicy('openrouter', 'mistralai/mistral-large')).toBe('none')
    expect(providerCachePolicy('openrouter', 'no-slash-here')).toBe('none')
    expect(providerCachePolicy('openrouter', '/leading-slash')).toBe('none')
    // No model in hand: the request-building helpers only ever ask about a DIRECT provider, so
    // the honest answer for a gateway with no slug is that nothing is known.
    expect(providerCachePolicy('openrouter')).toBe('none')
  })

  // The operator-hosted gateways front many vendors too, but their model ids are the operator's
  // own aliases, so there is nothing in the id to read a vendor off.
  it('does not read a vendor off an operator-aliased gateway id', () => {
    expect(providerCachePolicy('litellm', 'openai/gpt-5.6-terra')).toBe('none')
    expect(providerCachePolicy('bifrost', 'anthropic/claude-opus-5')).toBe('none')
  })

  it('leaves a direct provider unchanged when a model is supplied', () => {
    expect(providerCachePolicy('openai', 'gpt-5.6-terra')).toBe('auto-prefix')
    expect(providerCachePolicy('anthropic', 'claude-opus-5')).toBe('explicit-anthropic')
    expect(providerCachesPrompts('openrouter', 'deepseek/deepseek-v4')).toBe(true)
    expect(providerCachesPrompts('openrouter', 'anthropic/claude-opus-5')).toBe(false)
    expect(providerCachesPrompts('openrouter', 'z-ai/glm-5.2')).toBe(true)
  })
})
