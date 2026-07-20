// Formatting + derivation helpers for the LLM observability surfaces (inline step
// rollups + the drill-down panel). Kept here so the components stay declarative and
// the number-crunching is unit-testable.

import type { StepMetrics } from '~/types/execution'

/** Compact token count: 1234 → "1.2k", 980 → "980", 2_500_000 → "2.5M". */
export function formatTokens(n: number): string {
  if (n < 1000) return `${n}`
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

/**
 * FRESH (uncached) prompt tokens: the input tokens actually processed this call/rollup after
 * excluding the prefix served from the provider's cache. A long agentic run re-sends its whole
 * growing transcript every turn, so on the "inclusive" shape the raw `promptTokens` sum is
 * dominated by cache reads (often >99%) — showing THAT as "tokens burned" reads as a blow-up
 * when almost nothing fresh was processed. This surfaces the fresh figure alongside cached.
 *
 * `cachedPromptTokens` has PROVIDER-DEPENDENT semantics (see the field docs on `stepMetricsSchema`
 * / `llmCallMetricSchema`), so we can't blindly subtract:
 *  - Inclusive shape (OpenAI/DeepSeek, and the subscription-CLI harness, which folds cache into
 *    `promptTokens`): cached is a SUBSET of prompt ⇒ fresh = prompt − cached.
 *  - Separate shape (Anthropic via the LLM proxy): cache reads are reported SEPARATELY and
 *    `promptTokens` is ALREADY fresh-only, so cached can EXCEED prompt. Subtracting there would
 *    wrongly collapse a real fresh input to 0 — when cached ≥ prompt, `promptTokens` itself IS
 *    the fresh figure.
 *
 * NOTE: with only these two aggregates we cannot distinguish the separate shape while cached is
 * still ≤ prompt (there the subtraction under-counts fresh by the cache-read amount). A fully
 * exact split needs the wire contract to carry cache-read vs cache-write distinctly at the
 * source; this heuristic fixes the dominant (cached ≫ prompt) case and never returns negative.
 */
export function freshPromptTokens(promptTokens: number, cachedPromptTokens: number): number {
  // Separate shape: promptTokens is already fresh-only (cache reads counted separately).
  if (cachedPromptTokens > promptTokens) return promptTokens
  // Inclusive shape: cached is a subset of prompt.
  return promptTokens - cachedPromptTokens
}

/** Compact duration: 850 → "850ms", 1500 → "1.5s", 90_000 → "1m 30s". */
export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  const totalSec = ms / 1000
  if (totalSec < 60) return `${totalSec.toFixed(totalSec < 10 ? 1 : 0)}s`
  const m = Math.floor(totalSec / 60)
  const sec = Math.round(totalSec % 60)
  return sec ? `${m}m ${sec}s` : `${m}m`
}

/** A ratio (0..1) as a whole-number percentage. */
export function pct(ratio: number): number {
  return Math.round(ratio * 100)
}

/**
 * Output-limit headroom for a step's rollup: the fraction of the output ceiling the
 * closest call consumed (0..1), or null when the ceiling is unknown. 1 (or any
 * truncated call) means a call hit the limit and was cut short.
 */
export function headroomRatio(
  m: Pick<StepMetrics, 'peakCompletionTokens' | 'maxOutputTokens'>,
): number | null {
  if (m.maxOutputTokens == null || m.maxOutputTokens <= 0) return null
  return Math.min(1, m.peakCompletionTokens / m.maxOutputTokens)
}

/** Share of a step's latency spent in transport/proxy overhead (0..1), or null. */
export function transportRatio(m: Pick<StepMetrics, 'upstreamMs' | 'overheadMs'>): number | null {
  const total = m.upstreamMs + m.overheadMs
  return total > 0 ? m.overheadMs / total : null
}

/** Tailwind text/bg colour for an output-headroom level (green → amber → red). */
export function headroomColor(ratio: number | null, truncated: boolean): string {
  if (truncated || (ratio != null && ratio >= 0.98)) return 'text-rose-400'
  if (ratio != null && ratio >= 0.8) return 'text-amber-400'
  return 'text-emerald-400'
}
