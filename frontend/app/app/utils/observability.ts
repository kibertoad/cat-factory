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
export function headroomRatio(m: Pick<StepMetrics, 'peakCompletionTokens' | 'maxOutputTokens'>): number | null {
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
