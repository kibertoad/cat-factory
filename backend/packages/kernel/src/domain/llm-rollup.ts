// Pure folds over the LLM-call rollup the telemetry stores compute.
//
// The store aggregates ONE grain — `(agentKind, phase, provider, model)` — and every coarser
// view a consumer wants (a step's per-kind rollup, a run's per-phase burn breakdown, the run
// totals) is a fold over that same result set. Keeping the folds here rather than in each
// consumer is what makes the numbers agree: a per-phase table whose rows didn't sum to the
// totals printed above it would be worse than no table at all.
//
// The model is in the grain only so `priceRollupCells` can cost a cell before folding it away;
// what every consumer then reads is the `(agentKind, phase)` view it always read, typed as
// `LlmRollupCell` so a collapsed cell cannot be asked which model it was.
//
// These are folds over a handful of cells (kinds x phases in one run), NOT over the rows they
// were computed from — the aggregation itself stays in SQL, per the repo's "push counts and
// aggregates into SQL" rule.

import type {
  LlmCallMetricSummary,
  LlmCallRollupTotals,
  LlmRollupCell,
} from '../ports/llm-metrics.js'

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
  // The IDENTITY of the cost fold, not "unpriced": folding an unpriced cell in must be able to
  // turn a running total null, and starting at null would make every fold null instead.
  costEstimate: 0,
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
    costEstimate: addCost(a.costEstimate, b.costEstimate),
  }
}

function maxNullable(a: number | null, b: number | null): number | null {
  if (a == null) return b
  if (b == null) return a
  return Math.max(a, b)
}

/**
 * Sum two costs, where NULL (unpriced) CONTAMINATES rather than being skipped as a zero.
 *
 * The opposite of {@link maxNullable}, and deliberately so: an unknown ceiling losing to a
 * known one still describes a real ceiling somebody requested, whereas a total that quietly
 * dropped the one cell it could not price is a smaller number presented as complete. A reader
 * cannot tell that from a genuinely cheaper run, so the fold declines to answer instead.
 */
function addCost(a: number | null, b: number | null): number | null {
  if (a == null || b == null) return null
  return a + b
}

/**
 * Per-1M rates for one model's four token classes — the shape a price table resolves to,
 * restated here so the pricing fold stays in the domain without kernel depending on the spend
 * package (which depends on kernel).
 */
export interface LlmTokenRates {
  inputPerMillion: number
  cacheReadPerMillion: number
  cacheWritePerMillion: number
  outputPerMillion: number
}

/**
 * Resolve a cell's rates, or null where this deployment cannot price that model — which is
 * NOT the same as pricing it at zero (see {@link LlmCallRollupTotals.costEstimate}).
 */
export type LlmRateResolver = (provider: string, model: string) => LlmTokenRates | null

/**
 * The three orthogonal INPUT classes of one call (or of any aggregate of calls). Additive by
 * construction: the total input is their sum. They stay apart because they are priced more than
 * an order of magnitude apart and in OPPOSITE directions — a cache read is ~0.1x fresh input, a
 * cache write ~1.25x — so a lumped input count priced at the fresh rate over-states a
 * cache-read-heavy call several-fold.
 */
export interface InputTokenClassCounts {
  /** FRESH (uncached) input tokens, exclusive of both cache classes. */
  promptTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/** The four token counts a cost is a function of, however they were aggregated. */
export interface LlmTokenClassCounts extends InputTokenClassCounts {
  completionTokens: number
}

/**
 * Cost of a set of token counts at one model's rates, each class at its own tier.
 *
 * The ONE place this arithmetic lives. Every producer of money in the codebase routes through
 * it — the ledger's per-call estimate, the rollup fold, the export's per-call sum — because
 * three copies of a four-term sum are three chances for a class to be priced at the wrong
 * tier, and a wrong cost looks exactly like a right one.
 */
export function costOfTokenClasses(rates: LlmTokenRates, tokens: LlmTokenClassCounts): number {
  return (
    (tokens.promptTokens / 1_000_000) * rates.inputPerMillion +
    (tokens.cacheReadTokens / 1_000_000) * rates.cacheReadPerMillion +
    (tokens.cacheWriteTokens / 1_000_000) * rates.cacheWritePerMillion +
    (tokens.completionTokens / 1_000_000) * rates.outputPerMillion
  )
}

/**
 * Price each cell of the store's finest grain and collapse the MODEL dimension, returning the
 * {@link LlmRollupCell}s every consumer reads — now carrying `costEstimate`.
 *
 * This is the one place the model is used, and the reason it is in the grain at all: cost is a
 * function of `(model, token classes)`, so it has to be computed while the model is still
 * attached and can only be summed afterwards. Every coarser view is then the same pure fold it
 * always was, and the costs it adds up agree with the breakdown beside it by construction.
 *
 * `rates` is OPTIONAL because collapsing is not conditional on pricing: a deployment with no
 * price table still owes its consumers the same `(agentKind, phase)` shape, with every cost
 * null. Omitting it is that case stated in code, rather than a resolver that answers nothing.
 */
export function priceRollupCells(
  cells: readonly LlmCallMetricSummary[],
  rates?: LlmRateResolver,
): LlmRollupCell[] {
  const byCell = new Map<string, LlmRollupCell>()
  for (const cell of cells) {
    // `merge(EMPTY, cell)` projects the TOTALS half at the fold's identity, which is what drops
    // `provider`/`model` — no hand-copied field list a new column could quietly fall out of.
    const priced: LlmRollupCell = {
      agentKind: cell.agentKind,
      phase: cell.phase,
      ...merge(EMPTY, cell),
      costEstimate: costOfCell(cell, rates),
    }
    // NUL as the separator, written as an ESCAPE. A raw control byte in the source makes git
    // classify this file as BINARY, which hides every future change to it from code review.
    // It cannot occur in an agent kind or a phase, so two distinct cells can never collide.
    const key = `${cell.agentKind}\u0000${cell.phase}`
    const prev = byCell.get(key)
    byCell.set(
      key,
      prev ? { agentKind: prev.agentKind, phase: prev.phase, ...merge(prev, priced) } : priced,
    )
  }
  return [...byCell.values()]
}

function costOfCell(cell: LlmCallMetricSummary, rates?: LlmRateResolver): number | null {
  const resolved = rates?.(cell.provider, cell.model)
  return resolved ? costOfTokenClasses(resolved, cell) : null
}

/** Fold every cell into one set of run-wide totals. */
export function foldRollupTotals(cells: readonly LlmRollupCell[]): LlmCallRollupTotals {
  return cells.reduce<LlmCallRollupTotals>((acc, cell) => merge(acc, cell), EMPTY)
}

/**
 * Fold the cells into one rollup per agent kind — the grain a pipeline step's `metrics`
 * carries, since the proxy keys a conversation by `(execution, agentKind)` and not by step
 * index. Insertion-ordered on first appearance, so a caller that wants a stable order sorts.
 */
export function foldRollupsByAgentKind(cells: readonly LlmRollupCell[]): LlmKindRollup[] {
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
export function foldRollupsByPhase(cells: readonly LlmRollupCell[]): LlmPhaseRollup[] {
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
