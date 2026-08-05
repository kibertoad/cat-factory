// Pure folds over the TOOL-CALL rollup the telemetry stores compute.
//
// The sibling of `llm-rollup.ts`, and it follows the same rule for the same reason: the store
// aggregates ONE grain — `(agentKind, tool)` — and every coarser view (per tool, per agent
// kind, the run totals) is a fold over that same result set. A second aggregate over the same
// rows is a second chance to disagree with the breakdown printed beside it.
//
// These fold a handful of cells (the tools one run touched), NOT the rows they were computed
// from: the aggregation itself stays in SQL.

import type { AgentToolCallSummary } from '../ports/agent-tool-calls.js'

/** What every level of the tool-call rollup counts. */
export interface ToolCallRollupTotals {
  calls: number
  /** Calls that came back `ok: false` — the tool itself failed, inside the container. */
  failures: number
}

/** One tool's calls, folded across the agent kinds that made them. */
export interface ToolCallToolRollup extends ToolCallRollupTotals {
  tool: string
}

/** One agent kind's calls, folded across the tools it used. */
export interface ToolCallKindRollup extends ToolCallRollupTotals {
  agentKind: string
}

const EMPTY: ToolCallRollupTotals = { calls: 0, failures: 0 }

function merge(a: ToolCallRollupTotals, b: ToolCallRollupTotals): ToolCallRollupTotals {
  return { calls: a.calls + b.calls, failures: a.failures + b.failures }
}

/** Fold every cell into the run's totals. */
export function foldToolCallTotals(cells: readonly AgentToolCallSummary[]): ToolCallRollupTotals {
  return cells.reduce<ToolCallRollupTotals>((acc, cell) => merge(acc, cell), EMPTY)
}

/**
 * Order two folded rows most-broken first: failure COUNT, then the failure SHARE, then the
 * name so the order is total (an order that varies between two reads of the same unchanged
 * run reads to a caller as a change in the run).
 *
 * The share is compared by cross-multiplication rather than by dividing: both `calls` are
 * positive on a folded row, so the two orderings agree, and this one cannot produce a NaN
 * from a row an empty fold happened to reach.
 */
function mostBrokenFirst(a: ToolCallRollupTotals, b: ToolCallRollupTotals): number {
  return b.failures - a.failures || b.failures * a.calls - a.failures * b.calls
}

/**
 * Fold the cells into one rollup per TOOL, most-failed first.
 *
 * Ordered by failures rather than by call count or store order, because the question this
 * breakdown exists to answer is which tool to look at, and a run's busiest tool is almost
 * never its broken one.
 */
export function foldToolCallsByTool(cells: readonly AgentToolCallSummary[]): ToolCallToolRollup[] {
  const byTool = new Map<string, ToolCallToolRollup>()
  for (const cell of cells) {
    const prev = byTool.get(cell.tool)
    byTool.set(cell.tool, { tool: cell.tool, ...merge(prev ?? EMPTY, cell) })
  }
  return [...byTool.values()].sort((a, b) => mostBrokenFirst(a, b) || a.tool.localeCompare(b.tool))
}

/** Fold the cells into one rollup per AGENT KIND, most-failed first (same ordering rule). */
export function foldToolCallsByAgentKind(
  cells: readonly AgentToolCallSummary[],
): ToolCallKindRollup[] {
  const byKind = new Map<string, ToolCallKindRollup>()
  for (const cell of cells) {
    const prev = byKind.get(cell.agentKind)
    byKind.set(cell.agentKind, { agentKind: cell.agentKind, ...merge(prev ?? EMPTY, cell) })
  }
  return [...byKind.values()].sort(
    (a, b) => mostBrokenFirst(a, b) || a.agentKind.localeCompare(b.agentKind),
  )
}

/**
 * The single `(agentKind, tool)` cell most worth looking at, or null when nothing failed.
 *
 * The finest grain the store keeps, which is the point: a run's failures are diagnostic when
 * they CONCENTRATE (one agent kind retrying one tool is a stuck loop) and unremarkable when
 * they scatter, and only a cell can tell those apart. Ordered by the same rule as the
 * breakdowns, so the row a reader is pointed at is the one that sorts first in them.
 */
export function worstToolCallCell(
  cells: readonly AgentToolCallSummary[],
): AgentToolCallSummary | null {
  const failing = cells.filter((cell) => cell.failures > 0)
  if (failing.length === 0) return null
  return failing.sort(
    (a, b) =>
      mostBrokenFirst(a, b) ||
      a.agentKind.localeCompare(b.agentKind) ||
      a.tool.localeCompare(b.tool),
  )[0]!
}

/**
 * The share of a rollup's calls that failed, or NULL where it made none.
 *
 * Null rather than 0: a run that called no tools has no failure rate, and reporting one as a
 * clean 0% would put it beside a run whose every call worked — the same number for "nothing
 * happened" and "everything worked", which are different findings. A cell always has calls (it
 * exists because rows were counted into it), so only the folded totals of an empty run reach
 * the null.
 */
export function toolCallFailureRate(totals: ToolCallRollupTotals): number | null {
  return totals.calls > 0 ? totals.failures / totals.calls : null
}
