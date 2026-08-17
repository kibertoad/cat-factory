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
 * The three orthogonal input classes of one model call: input processed from scratch, plus
 * the two cache classes. Additive by construction — total input is their sum — which is the
 * invariant every telemetry population site holds.
 *
 * They stay apart because they are priced an order of magnitude apart in OPPOSITE directions:
 * a cache READ is ~0.1× base input, a cache WRITE 1.25–2×, i.e. dearer than fresh. Summed,
 * a repair loop that keeps invalidating and re-writing its prefix is indistinguishable from
 * one riding a warm cache.
 */
export interface InputTokenClasses {
  fresh: number
  cacheRead: number
  cacheWrite: number
}

const ZERO_INPUT_CLASSES: InputTokenClasses = { fresh: 0, cacheRead: 0, cacheWrite: 0 }

/**
 * The first candidate that is a usable token count, else 0. Vendors spell the same figure
 * several ways and occasionally omit or garble one, so a count is only accepted when it is a
 * finite positive number — never coerced, never allowed to go negative.
 */
function firstNumber(...candidates: unknown[]): number {
  for (const value of candidates) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  }
  return 0
}

/**
 * Read a provider's usage payload into the three input classes, reconciling the two shapes
 * vendors report in. This is ONE function rather than a "read the cache classes" helper plus
 * a "subtract them" helper, because splitting it made the shape decision a rule the CALLER
 * had to know and pair correctly — and the pairing is the whole subtlety.
 *
 * The shape is decided by WHICH read field the payload carries, and the two classes are read
 * INDEPENDENTLY of each other:
 *
 * - **Inclusive** (OpenAI `prompt_tokens_details.cached_tokens`, DeepSeek
 *   `prompt_cache_hit_tokens`): the prompt count is the WHOLE prompt and every cache class the
 *   payload reports is a partition of it, so both come off. Subtracting both — not just the
 *   read — is what keeps the total we record equal to the vendor's own `prompt_tokens`: an
 *   OpenAI-shaped gateway fronting Anthropic (`bifrost`, `litellm`, OpenRouter) reports its reads under
 *   the OpenAI field AND a `cache_creation_input_tokens` beside it, and reading only one of
 *   them would either drop the dearest class or mint input the vendor never billed.
 * - **Exclusive** (Anthropic `cache_read_input_tokens` / `cache_creation_input_tokens`, or the
 *   AI SDK's camelCase spellings): `input_tokens` is already fresh-only and the classes sit
 *   beside it, so nothing is subtracted.
 *
 * Everything is clamped at 0 and read defensively: the counts come off ONE payload, so a
 * vendor inconsistency must degrade to a sane number rather than mint a negative one.
 */
export function readInputTokenClasses(usage: unknown): InputTokenClasses {
  if (typeof usage !== 'object' || usage === null) return ZERO_INPUT_CLASSES
  const u = usage as Record<string, unknown>
  // The prompt count under the OpenAI wire name, falling back to the Anthropic/AI-SDK ones so
  // a raw vendor payload still yields its fresh figure instead of a silent 0.
  const promptCount = firstNumber(u.prompt_tokens, u.input_tokens, u.inputTokens)
  // Read independently of the read class: on a gateway shape both fields are present, and
  // detecting one must never suppress the other.
  const cacheWrite = firstNumber(u.cache_creation_input_tokens, u.cacheCreationInputTokens)

  const details = u.prompt_tokens_details
  const openAiCached =
    typeof details === 'object' && details !== null
      ? (details as Record<string, unknown>).cached_tokens
      : undefined
  // The presence of an inclusive-shape read field is what identifies the shape, so it is
  // probed for a NUMBER rather than mere presence: a junk value must fall through to the
  // exclusive reading, not commit the payload to a subtraction on a count of 0.
  if (typeof openAiCached === 'number' || typeof u.prompt_cache_hit_tokens === 'number') {
    const cacheRead = firstNumber(openAiCached, u.prompt_cache_hit_tokens)
    return { fresh: Math.max(0, promptCount - cacheRead - cacheWrite), cacheRead, cacheWrite }
  }

  return {
    fresh: promptCount,
    cacheRead: firstNumber(u.cache_read_input_tokens, u.cacheReadInputTokens),
    cacheWrite,
  }
}
