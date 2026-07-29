// Pure folds over the LLM-call rollup the telemetry stores compute.
//
// The store aggregates ONE grain — `(agentKind, phase)` — and every coarser view a consumer
// wants (a step's per-kind rollup, a run's per-phase burn breakdown, the run totals) is a fold
// over that same result set. Keeping the folds here rather than in each consumer is what makes
// the numbers agree: a per-phase table whose rows didn't sum to the totals printed above it
// would be worse than no table at all.
//
// These are folds over a handful of cells (kinds x phases in one run), NOT over the rows they
// were computed from — the aggregation itself stays in SQL, per the repo's "push counts and
// aggregates into SQL" rule.

import type { LlmCallMetricSummary, LlmCallRollupTotals } from '../ports/llm-metrics.js'

/** A rollup of one agent kind's calls, folded across that kind's phases. */
export interface LlmKindRollup extends LlmCallRollupTotals {
  agentKind: string
}

/** A rollup of one phase's calls, folded across the agent kinds that spent them. */
export interface LlmPhaseRollup extends LlmCallRollupTotals {
  phase: string
}

const EMPTY: LlmCallRollupTotals = {
  calls: 0,
  promptTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  completionTokens: 0,
  peakCompletionTokens: 0,
  maxOutputTokens: null,
  truncatedCalls: 0,
  upstreamMs: 0,
  overheadMs: 0,
  errors: 0,
  warnings: 0,
  carryCostTokens: 0,
}

/**
 * Combine two rollup cells. Counts and sums add; `peakCompletionTokens` and `maxOutputTokens`
 * take the MAX (they are extremes, not totals — summing two steps' ceilings would invent an
 * output limit no request ever asked for), and a null ceiling loses to a known one rather than
 * poisoning the fold.
 */
function merge(a: LlmCallRollupTotals, b: LlmCallRollupTotals): LlmCallRollupTotals {
  return {
    calls: a.calls + b.calls,
    promptTokens: a.promptTokens + b.promptTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    peakCompletionTokens: Math.max(a.peakCompletionTokens, b.peakCompletionTokens),
    maxOutputTokens: maxNullable(a.maxOutputTokens, b.maxOutputTokens),
    truncatedCalls: a.truncatedCalls + b.truncatedCalls,
    upstreamMs: a.upstreamMs + b.upstreamMs,
    overheadMs: a.overheadMs + b.overheadMs,
    errors: a.errors + b.errors,
    warnings: a.warnings + b.warnings,
    carryCostTokens: a.carryCostTokens + b.carryCostTokens,
  }
}

function maxNullable(a: number | null, b: number | null): number | null {
  if (a == null) return b
  if (b == null) return a
  return Math.max(a, b)
}

/** Fold every cell into one set of run-wide totals. */
export function foldRollupTotals(cells: readonly LlmCallMetricSummary[]): LlmCallRollupTotals {
  return cells.reduce<LlmCallRollupTotals>((acc, cell) => merge(acc, cell), EMPTY)
}

/**
 * Fold the cells into one rollup per agent kind — the grain a pipeline step's `metrics`
 * carries, since the proxy keys a conversation by `(execution, agentKind)` and not by step
 * index. Insertion-ordered on first appearance, so a caller that wants a stable order sorts.
 */
export function foldRollupsByAgentKind(cells: readonly LlmCallMetricSummary[]): LlmKindRollup[] {
  const byKind = new Map<string, LlmKindRollup>()
  for (const cell of cells) {
    const prev = byKind.get(cell.agentKind)
    byKind.set(cell.agentKind, {
      agentKind: cell.agentKind,
      ...merge(prev ?? EMPTY, cell),
    })
  }
  return [...byKind.values()]
}

/**
 * Fold the cells into one rollup per phase — the burn breakdown. The `''` phase is a cell like
 * any other and is NEVER filtered out: a run whose calls are all unattributed was metered by a
 * channel with no phase concept, not one that spent nothing, and hiding the cell makes the two
 * indistinguishable while the table still looks complete.
 */
export function foldRollupsByPhase(cells: readonly LlmCallMetricSummary[]): LlmPhaseRollup[] {
  const byPhase = new Map<string, LlmPhaseRollup>()
  for (const cell of cells) {
    const prev = byPhase.get(cell.phase)
    byPhase.set(cell.phase, { phase: cell.phase, ...merge(prev ?? EMPTY, cell) })
  }
  return [...byPhase.values()]
}

/**
 * Total input tokens a rollup covers: the three classes are orthogonal at the source, so the
 * volume figure is simply their sum (the like-for-like of Claude Code's own context gauge,
 * which counts the same buckets because a cached token still occupies the window).
 */
export function rollupInputTokens(totals: LlmCallRollupTotals): number {
  return totals.promptTokens + totals.cacheReadTokens + totals.cacheWriteTokens
}
