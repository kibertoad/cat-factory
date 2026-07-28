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
 * The two cache classes a provider reports in its usage, read APART rather than summed.
 *
 * They are priced very differently — a cache READ is ~0.1× base input, a cache WRITE is
 * 1.25–2× base input, i.e. dearer than fresh — so lumping them makes per-phase spend
 * unreadable: a repair loop that keeps invalidating and re-writing the prefix looks
 * identical to one riding a warm cache. Covers OpenAI
 * (`prompt_tokens_details.cached_tokens`), DeepSeek (`prompt_cache_hit_tokens`) and
 * Anthropic (`cache_read_input_tokens` / `cache_creation_input_tokens`, or the AI SDK's
 * camelCase spellings). Only Anthropic reports a separate write class; the others report
 * reads only, so `write` is 0 there rather than guessed.
 *
 * NOTE on the shapes these come from, which is what {@link freshPromptTokens} exists to
 * reconcile: OpenAI/DeepSeek report an INCLUSIVE prompt count (the cached share is a
 * subset of it), while Anthropic reports `input_tokens` already EXCLUSIVE of both classes.
 */
export function cacheTokensFromUsage(usage: unknown): { read: number; write: number } {
  if (typeof usage !== 'object' || usage === null) return { read: 0, write: 0 }
  const u = usage as Record<string, unknown>
  const nonNegative = (value: unknown): number =>
    typeof value === 'number' && value >= 0 ? value : 0
  // OpenAI: prompt_tokens_details.cached_tokens (reads only).
  const details = u.prompt_tokens_details
  if (typeof details === 'object' && details !== null) {
    const cached = (details as Record<string, unknown>).cached_tokens
    if (typeof cached === 'number' && cached >= 0) return { read: cached, write: 0 }
  }
  // DeepSeek: prompt_cache_hit_tokens (reads only).
  const hit = u.prompt_cache_hit_tokens
  if (typeof hit === 'number' && hit >= 0) return { read: hit, write: 0 }
  // Anthropic: both classes, reported separately from input_tokens.
  return {
    read: nonNegative(u.cache_read_input_tokens ?? u.cacheReadInputTokens),
    write: nonNegative(u.cache_creation_input_tokens ?? u.cacheCreationInputTokens),
  }
}

/**
 * Normalise a provider's reported prompt count to FRESH (uncached) input, the invariant
 * every telemetry population site holds: `promptTokens` is exclusive of both cache classes,
 * so total input = `promptTokens + cacheReadTokens + cacheWriteTokens`.
 *
 * The subtraction is what reconciles the two provider shapes. Where the prompt count is
 * INCLUSIVE (OpenAI/DeepSeek) the cached share must come off it; where it is already
 * exclusive (Anthropic) `prompt_tokens` does not carry the cache classes at all, so nothing
 * is subtracted — which the arithmetic gets right on its own, because on that shape the
 * usage the proxy scrapes reports the classes in fields of their own and the OpenAI-shaped
 * `prompt_tokens` it maps to is the fresh count. Clamped at 0: the counts come off one
 * payload and a vendor inconsistency must never mint a negative token count.
 */
export function freshPromptTokens(promptTokens: number, cacheRead: number): number {
  return Math.max(0, promptTokens - cacheRead)
}
