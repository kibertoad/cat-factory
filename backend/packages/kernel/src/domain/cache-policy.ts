// Prompt-caching policy — the single source of truth for how a provider caches a
// growing prompt prefix. It lives in the kernel (not the agents facade) because BOTH
// the AI-call paths AND the model catalog need it: the catalog projects a per-model
// `cachesPrompts` capability the SPA's vendor pickers surface, and the proxy/inline
// paths give the provider the routing hint it needs (those request-building helpers
// stay in `@cat-factory/agents`, which re-exports `providerCachePolicy` from here).
//
// A container agent re-sends its whole growing prompt every turn, so on the providers
// that cache it the stable prefix is a cache hit rather than re-billed input — but
// only with a stable prefix and the provider-specific hint. Keeping the classification
// here means neither the catalog nor the call paths hard-code provider ids twice.

export type CachePolicy =
  // Caches automatically on an exact prefix match; some accept a routing key to pin
  // multi-turn calls to the same cached prefix (OpenAI), others need nothing but a
  // stable prefix (DeepSeek, Qwen/DashScope).
  | 'auto-prefix'
  // Requires explicit `cache_control` breakpoints in the request (Anthropic).
  | 'explicit-anthropic'
  // No caching we rely on (Workers AI third-party models, Moonshot, unknown).
  | 'none'

/** How `provider` caches prompt prefixes. The single source of truth for every path. */
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

/** Whether `provider` caches prompt prefixes at all (any policy other than `none`). */
export function providerCachesPrompts(provider: string): boolean {
  return providerCachePolicy(provider) !== 'none'
}
