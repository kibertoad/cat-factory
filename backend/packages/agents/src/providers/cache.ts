// Prompt-caching request/response helpers, shared by BOTH AI-call paths so they treat
// a provider the same way: the in-container path (Pi → the LLM proxy, OpenAI Chat
// Completions over HTTP) and the inline path (the Vercel AI SDK via the ModelProvider
// port). A container agent re-sends its whole growing prompt every turn, so on the
// providers that cache it the stable prefix should be a cache hit rather than re-billed
// input — but only if we (a) keep the prefix byte-stable and (b) give the provider the
// hint it needs.
//
// The classification of HOW a provider caches lives in the kernel
// (`providerCachePolicy`) because the model catalog also needs it (to project a
// per-model `cachesPrompts` capability the UI surfaces); it is re-exported here so the
// existing `@cat-factory/agents` import sites keep working.
import { type CachePolicy, providerCachePolicy } from '@cat-factory/kernel'

export { type CachePolicy, providerCachePolicy }

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

/**
 * The cached-input-token count a provider reports in its usage, across the field names
 * they use. Covers OpenAI (`prompt_tokens_details.cached_tokens`), DeepSeek
 * (`prompt_cache_hit_tokens`) and Anthropic (`cache_read_input_tokens`, or the AI SDK's
 * camelCase `cacheReadInputTokens`). NOTE on the Anthropic shape: its cache reads are
 * reported SEPARATELY from `input_tokens` (they are NOT a subset of it), so a hit-rate
 * computed as cached/prompt can exceed 1 — callers clamp it (see `cacheHitRate`).
 */
export function cachedTokensFromUsage(usage: unknown): number {
  if (typeof usage !== 'object' || usage === null) return 0
  const u = usage as Record<string, unknown>
  // OpenAI: prompt_tokens_details.cached_tokens.
  const details = u.prompt_tokens_details
  if (typeof details === 'object' && details !== null) {
    const cached = (details as Record<string, unknown>).cached_tokens
    if (typeof cached === 'number' && cached >= 0) return cached
  }
  // DeepSeek: prompt_cache_hit_tokens.
  const hit = u.prompt_cache_hit_tokens
  if (typeof hit === 'number' && hit >= 0) return hit
  // Anthropic: cache_read_input_tokens (raw API) / cacheReadInputTokens (AI SDK).
  const anthropicRead = u.cache_read_input_tokens ?? u.cacheReadInputTokens
  if (typeof anthropicRead === 'number' && anthropicRead >= 0) return anthropicRead
  return 0
}
