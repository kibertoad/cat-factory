import { readInputTokenClasses } from '@cat-factory/agents'
import type { UseCaseUsage } from '@cat-factory/contracts'

// ---------------------------------------------------------------------------
// What one inline use-case invocation cost, read off the AI SDK's usage object into the three
// numbers the public surface publishes.
//
// Its own module with its own test because the reading is NOT the obvious field read. The SDK's
// flat `inputTokens` is whatever the provider's own mapping put there, and vendors disagree about
// whether a cached prefix is INSIDE the prompt count (OpenAI: `prompt_tokens` covers it) or BESIDE
// it (Anthropic: `input_tokens` is fresh-only, with `cache_read_input_tokens` and
// `cache_creation_input_tokens` alongside). This repo already owns that reconciliation once, in
// `readInputTokenClasses`, and it is deliberately read here rather than re-spelled: a hand-rolled
// `usage.inputTokens ?? usage.promptTokens` understates a cache-heavy call on half the vendors,
// and the surface publishes that number as what was BILLED, which a wrapper metering its own users
// would then under-bill from silently.
// ---------------------------------------------------------------------------

/** A usable token count, else 0. Never coerced, never negative. */
function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * The invocation's usage, as the public surface publishes it.
 *
 * The billed input is taken from the vendor's RAW payload through the shared reconciler, and the
 * SDK's own flat total is the floor rather than the alternative: whichever is larger is the one
 * that cannot be an understatement, and on every provider mapping in this build the two agree
 * (each already folds both cache classes into its total). The floor is what keeps a provider that
 * passes no `raw` through, or one whose payload this build does not recognise, from publishing a 0.
 *
 * `totalTokens` is the SUM rather than any total the provider reported, so the three numbers a
 * caller receives always add up. A published total that disagreed with its own two parts would
 * leave a consumer no way to tell which of them to trust.
 */
export function readUseCaseUsage(usage: unknown): UseCaseUsage {
  const reported = (usage ?? {}) as Record<string, unknown>
  const classes = readInputTokenClasses(reported.raw)
  const inputTokens = Math.max(
    classes.fresh + classes.cacheRead + classes.cacheWrite,
    count(reported.inputTokens),
  )
  const outputTokens = count(reported.outputTokens)
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }
}
