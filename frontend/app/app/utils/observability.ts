// Formatting + derivation helpers for the LLM observability surfaces (inline step
// rollups + the drill-down panel). Kept here so the components stay declarative and
// the number-crunching is unit-testable.

import type { PipelineStep, StepMetrics, StepPhaseMetrics } from '~/types/execution'

/** Compact token count: 1234 → "1.2k", 980 → "980", 2_500_000 → "2.5M". */
export function formatTokens(n: number): string {
  if (n < 1000) return `${n}`
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

/**
 * TOTAL input tokens: fresh + cache read + cache write. This is the headline "↑" figure on
 * every LLM surface, and it deliberately COUNTS THE CACHED CLASSES.
 *
 * That is the like-for-like measure of Claude Code's own context gauge, which sums exactly these
 * buckets because a cached token still physically occupies the context window. Leading with the
 * fresh figure instead (what this surface used to do, on the grounds that the raw sum "reads as a
 * blow-up") discounts cache reads because their DOLLAR cost is low — but the quota, latency and
 * context-window cost is the whole thing an autonomous run burns, and hiding it is what let a
 * ~31M-token run look like a 685-token one. See
 * `docs/initiatives/token-burn-instrumentation.md`.
 *
 * The three classes are still rendered as the breakdown beneath it, because they are priced an
 * order of magnitude apart in opposite directions — this makes the volume honest WITHOUT making
 * the cost unreadable. The two fields are optional on an older snapshot, where absent reads as 0
 * and the total degrades to the fresh count.
 */
export function totalInputTokens(m: {
  promptTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}): number {
  return m.promptTokens + (m.cacheReadTokens ?? 0) + (m.cacheWriteTokens ?? 0)
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

/**
 * The run's model spend split by the PHASE that spent it, folded from the per-step rollups the
 * engine already pushes. Rows come back costliest-carry-cost first — the slice worth attacking.
 *
 * Two things make this correct rather than a naive sum over `steps`:
 *
 * 1. **Deduplicate by agent kind.** A step's `metrics` is the rollup for its AGENT KIND across
 *    the whole run (the proxy keys a conversation by `(execution, agentKind)`, not by step
 *    index), so two steps of the same kind carry the SAME numbers. Adding them would double
 *    every figure on any pipeline with, say, two tester steps.
 * 2. **Read it off the rollup, not off the loaded calls.** The panel's call list is capped, so
 *    folding phases client-side from it would silently under-report exactly the long runs this
 *    breakdown exists for. The rollup is a SQL aggregate over every row.
 */
export function foldRunPhaseMetrics(steps: readonly PipelineStep[]): StepPhaseMetrics[] {
  const seenKinds = new Set<string>()
  const byPhase = new Map<string, StepPhaseMetrics>()
  for (const step of steps) {
    const rows = step.metrics?.byPhase
    if (!rows?.length || seenKinds.has(step.agentKind)) continue
    seenKinds.add(step.agentKind)
    for (const row of rows) {
      const prev = byPhase.get(row.phase)
      byPhase.set(
        row.phase,
        prev
          ? {
              phase: row.phase,
              calls: prev.calls + row.calls,
              promptTokens: prev.promptTokens + row.promptTokens,
              cacheReadTokens: prev.cacheReadTokens + row.cacheReadTokens,
              cacheWriteTokens: prev.cacheWriteTokens + row.cacheWriteTokens,
              completionTokens: prev.completionTokens + row.completionTokens,
              carryCostTokens: prev.carryCostTokens + row.carryCostTokens,
              errors: prev.errors + row.errors,
            }
          : row,
      )
    }
  }
  return [...byPhase.values()].sort(
    (a, b) => b.carryCostTokens - a.carryCostTokens || b.calls - a.calls,
  )
}

/** Tailwind text/bg colour for an output-headroom level (green → amber → red). */
export function headroomColor(ratio: number | null, truncated: boolean): string {
  if (truncated || (ratio != null && ratio >= 0.98)) return 'text-rose-400'
  if (ratio != null && ratio >= 0.8) return 'text-amber-400'
  return 'text-emerald-400'
}
