// Prompt-caching policy, shared by BOTH AI-call paths so they treat a provider the
// same way: the in-container path (Pi → the LLM proxy, OpenAI Chat Completions over
// HTTP) and the inline path (the Vercel AI SDK via the ModelProvider port). A
// container agent re-sends its whole growing prompt every turn, so on the providers
// that cache it the stable prefix should be a cache hit rather than re-billed input
// — but only if we (a) keep the prefix byte-stable and (b) give the provider the
// hint it needs. This module is the single source of truth for "how does provider X
// cache", so neither path hard-codes provider ids.

export type CachePolicy =
  // Caches automatically on an exact prefix match; some accept a routing key to pin
  // multi-turn calls to the same cached prefix (OpenAI), others need nothing but a
  // stable prefix (DeepSeek, Qwen/DashScope).
  | 'auto-prefix'
  // Requires explicit `cache_control` breakpoints in the request (Anthropic).
  | 'explicit-anthropic'
  // No caching we rely on (Workers AI third-party models, Moonshot, unknown).
  | 'none'

/** How `provider` caches prompt prefixes. The single source of truth for both paths. */
export function providerCachePolicy(provider: string): CachePolicy {
  switch (provider) {
    case 'openai':
    case 'deepseek':
    case 'qwen':
      return 'auto-prefix'
    case 'anthropic':
      return 'explicit-anthropic'
    default:
      return 'none'
  }
}

/**
 * Extra OpenAI Chat Completions params that route a multi-turn conversation to the
 * same cached prefix, for the in-container proxy path. Only OpenAI documents a
 * routing key (`prompt_cache_key`); DeepSeek/Qwen cache automatically on the prefix
 * with no param (so we send none rather than risk a strict endpoint rejecting an
 * unknown field), and Anthropic's cache is explicit (handled on the inline path).
 * `cacheKey` should be stable per conversation (e.g. the execution id).
 */
export function promptCacheParams(
  provider: string,
  cacheKey: string | null | undefined,
): Record<string, unknown> {
  if (cacheKey && provider === 'openai') return { prompt_cache_key: cacheKey }
  return {}
}

/**
 * Vercel-AI `providerOptions` that enable prompt caching for the inline path. Only
 * Anthropic needs an explicit opt-in (cache the system + tools prefix as ephemeral);
 * the auto-prefix providers need nothing beyond a stable prompt. Empty when the
 * provider caches automatically or not at all.
 */
export function inlineCacheProviderOptions(provider: string): Record<string, unknown> {
  if (providerCachePolicy(provider) === 'explicit-anthropic') {
    return { anthropic: { cacheControl: { type: 'ephemeral' } } }
  }
  return {}
}

/** The cached-input-token count a provider reports in its usage, across the field names they use. */
export function cachedTokensFromUsage(usage: unknown): number {
  if (typeof usage !== 'object' || usage === null) return 0
  const u = usage as Record<string, unknown>
  // OpenAI: prompt_tokens_details.cached_tokens. DeepSeek: prompt_cache_hit_tokens.
  const details = u.prompt_tokens_details
  if (typeof details === 'object' && details !== null) {
    const cached = (details as Record<string, unknown>).cached_tokens
    if (typeof cached === 'number' && cached >= 0) return cached
  }
  const hit = u.prompt_cache_hit_tokens
  if (typeof hit === 'number' && hit >= 0) return hit
  return 0
}
