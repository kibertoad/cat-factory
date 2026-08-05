// Formatting + derivation helpers for the LLM observability surfaces (inline step
// rollups + the drill-down panel). Kept here so the components stay declarative and
// the number-crunching is unit-testable.

import { classifyLlmCallOutcome } from '@cat-factory/contracts'
import type {
  AgentFailure,
  AgentToolCall,
  LlmCallMetric,
  LlmCallOutcome,
  PipelineStep,
  RunToolCallFailures,
  StepMetrics,
  StepPhaseMetrics,
} from '~/types/execution'

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

/**
 * Smallest amount {@link formatCost} will print as a figure. Below it, four decimals round to
 * `0.0000`, which is the same "free" claim a null renders as `0.00` — so such an amount is
 * shown as a threshold instead.
 */
const MIN_RENDERED_COST = 0.0001

/**
 * Format an estimated cost for display, or null when there is nothing honest to show.
 *
 * Null in ⇒ null out, and the caller renders the tokens WITHOUT a money figure: a cost the
 * deployment could not price and a cost of zero are different facts, and `0.00` claims the
 * second one. Small amounts keep more decimals because most steps land well under a unit and
 * rounding them all to `0.00` would make the whole column useless; an amount too small even
 * for those decimals is rendered as `<0.0001` rather than rounded down to the zero this
 * function exists to avoid printing.
 */
export function formatCost(amount: number | null | undefined, currency?: string): string | null {
  if (amount == null) return null
  const value = formatCostAmount(amount)
  // The currency is a bare ISO code beside the number rather than a locale symbol: the amounts
  // come from a deployment-configured table whose code is whatever an operator set, and a
  // symbol we guessed for an unrecognised code would be a wrong label on a right number.
  return currency ? `${value} ${currency}` : value
}

function formatCostAmount(amount: number): string {
  if (amount > 0 && amount < MIN_RENDERED_COST) return `<${MIN_RENDERED_COST}`
  // Four decimals under a unit, where most steps land; two above it, where they read as money.
  return amount.toFixed(amount > 0 && amount < 1 ? 4 : 2)
}

/**
 * Sum costs across rows the way the backend folds do: NULL contaminates rather than being
 * skipped as zero, so a total that could not price one of its parts declines to answer instead
 * of reporting a smaller number that reads as complete.
 */
export function sumCosts(values: readonly (number | null | undefined)[]): number | null {
  let total = 0
  for (const value of values) {
    if (value == null) return null
    total += value
  }
  return total
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

/** Zero cell, so the fold below has one accumulator shape and never aliases a store row. */
const EMPTY_PHASE: Omit<StepPhaseMetrics, 'phase'> = {
  calls: 0,
  promptTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  completionTokens: 0,
  carryCostTokens: 0,
  errors: 0,
  costEstimate: 0,
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
 *
 * Every returned row is a FRESH object, never a row of `step.metrics.byPhase` passed through:
 * those belong to the store, and a fold whose output aliases its input is a trap for the next
 * caller that reasonably assumes it may mutate what a fold handed it.
 */
export function foldRunPhaseMetrics(steps: readonly PipelineStep[]): StepPhaseMetrics[] {
  const seenKinds = new Set<string>()
  const byPhase = new Map<string, StepPhaseMetrics>()
  for (const step of steps) {
    const rows = step.metrics?.byPhase
    if (!rows?.length || seenKinds.has(step.agentKind)) continue
    seenKinds.add(step.agentKind)
    for (const row of rows) {
      const prev = byPhase.get(row.phase) ?? EMPTY_PHASE
      byPhase.set(row.phase, {
        phase: row.phase,
        calls: prev.calls + row.calls,
        promptTokens: prev.promptTokens + row.promptTokens,
        cacheReadTokens: prev.cacheReadTokens + row.cacheReadTokens,
        cacheWriteTokens: prev.cacheWriteTokens + row.cacheWriteTokens,
        completionTokens: prev.completionTokens + row.completionTokens,
        carryCostTokens: prev.carryCostTokens + row.carryCostTokens,
        errors: prev.errors + row.errors,
        // Same contaminating sum the backend fold uses: one unpriced phase makes the run's
        // figure unknown rather than quietly smaller.
        costEstimate: sumCosts([prev.costEstimate, row.costEstimate]),
      })
    }
  }
  return [...byPhase.values()].sort(
    (a, b) => b.carryCostTokens - a.carryCostTokens || b.calls - a.calls,
  )
}

// --- failing-call-first triage ---------------------------------------------------------------
// The panel's top section answers "what broke" before the operator reads anything. Everything it
// shows is DERIVED here rather than in the component, for the usual reason plus one specific to
// this surface: the difference between "nothing failed" and "we recorded nothing" is a judgement
// with three inputs, and getting it wrong renders a confident all-clear over a run that died.

/** Which calls a drill-down list is narrowed to. `all` is the default: no filter. */
export type CallOutcomeFilter = 'all' | LlmCallOutcome
/** Which tool calls a trajectory list is narrowed to (a tool has no `warning` class). */
export type ToolOutcomeFilter = 'all' | 'ok' | 'error'

/** How many calls fall in each outcome class, so a filter control can state what it hides. */
export interface CallOutcomeCounts {
  all: number
  ok: number
  warning: number
  error: number
}

/**
 * Count a run's calls by outcome, classified through the SHARED rule in `@cat-factory/contracts`
 * (the same one the row badge and the backend's `?outcome=` predicate use), so a chip reading
 * "2 errors" and a list showing three red rows is not a state this can reach.
 */
export function countCallOutcomes(calls: readonly LlmCallMetric[]): CallOutcomeCounts {
  const counts: CallOutcomeCounts = { all: calls.length, ok: 0, warning: 0, error: 0 }
  for (const call of calls) counts[classifyLlmCallOutcome(call)] += 1
  return counts
}

/** Narrow a call list to one outcome class; `all` passes the list through untouched. */
export function filterCallsByOutcome(
  calls: readonly LlmCallMetric[],
  filter: CallOutcomeFilter,
): LlmCallMetric[] {
  if (filter === 'all') return [...calls]
  return calls.filter((call) => classifyLlmCallOutcome(call) === filter)
}

/** Narrow a tool-call trajectory to the failing (or the succeeding) calls. */
export function filterToolCallsByOutcome(
  toolCalls: readonly AgentToolCall[],
  filter: ToolOutcomeFilter,
): AgentToolCall[] {
  if (filter === 'all') return [...toolCalls]
  return toolCalls.filter((call) => call.ok === (filter === 'ok'))
}

/**
 * What one telemetry sink was able to say about this run.
 *
 * A sink that has not answered and a sink that answered "nothing" are different facts, and the
 * one thing this surface must never do is render them alike. A bare row count cannot hold the
 * difference: zero rows is what a still-loading read, a failed read, an unwired sink and a
 * genuinely quiet run all look like from the outside.
 *
 * - `pending`: no answer yet — in flight, or never requested. Not evidence, and never a clean
 *   bill of health.
 * - `unreachable`: the read FAILED. The strongest of the four, because it means no conclusion is
 *   available at all — an HTTP error rendered as "no rows recorded" is a claim about the run
 *   made out of a claim about the network.
 * - `answered`: the sink spoke. `rows` may be 0, and THAT is the honest "nothing was recorded".
 */
export type SinkAnswer =
  | { status: 'pending' }
  | { status: 'unreachable' }
  | { status: 'answered'; rows: number }

/**
 * Read one sink's answer off the store flags that describe it.
 *
 * The precedence is the point. An in-flight read is PENDING even when a previous answer or a
 * previous error is still in hand, because what the panel says next depends on what is coming
 * back, not on what it happened to be holding. Never-requested collapses into pending for the
 * same reason: both are "nobody has answered", which is exactly what must not be rendered as
 * "the answer was nothing".
 */
export function sinkAnswer(input: {
  loading: boolean
  error: string | null
  loaded: boolean
  rows: number
}): SinkAnswer {
  if (input.loading) return { status: 'pending' }
  if (input.error) return { status: 'unreachable' }
  return input.loaded ? { status: 'answered', rows: input.rows } : { status: 'pending' }
}

/** Whether a sink answered and holds at least one row for the run. */
function answeredWithRows(answer: SinkAnswer): boolean {
  return answer.status === 'answered' && answer.rows > 0
}

/**
 * What the run's telemetry says about its failure, ready to render.
 *
 * `failure` is the run's own structured record (the `agent_runs.failure` JSON the engine writes);
 * the two evidence rows are the calls that ACTUALLY failed, which is the part the operator
 * otherwise finds by scrolling. They are independent: a run can fail with neither (the engine
 * died, or the container never came up), with one, or with both.
 */
export interface RunFailureEvidence {
  /** The run's structured failure record, or null when it did not fail (or recorded nothing). */
  failure: AgentFailure | null
  /** The most recent call that FAILED outright, or null when none did. */
  lastErroredCall: LlmCallMetric | null
  /** How many of the run's loaded calls failed outright. */
  erroredCallCount: number
  /** The last tool call that reported failure, or null when none did. */
  lastFailedToolCall: AgentToolCall | null
  /**
   * How many of the run's tool calls reported failure — the SQL aggregate over the whole run,
   * not the length of any list held here.
   *
   * This is the number that must not be counted off the trajectory. That read is a bounded
   * PREFIX, so a run whose failures came after its opening moves would be counted at zero, which
   * is the confident all-clear this whole section exists to refuse.
   */
  failedToolCallCount: number
  /**
   * Whether {@link lastFailedToolCall} was picked from a bounded slice of the run's failures
   * rather than all of them, so a "last" that is only the last one HELD says so.
   */
  failedToolCallsTruncated: boolean
  /** What each sink was able to say. See {@link SinkAnswer}. */
  calls: SinkAnswer
  tools: SinkAnswer
}

/**
 * Fold a run's failure record and its two telemetry sinks into the evidence the panel pins.
 *
 * The model calls arrive NEWEST-first (the metrics list's own order) and the tool-call failures
 * OLDEST-first (trajectory order), so "the last one that failed" is the FIRST match in one and
 * the LAST in the other. Reading either in the wrong direction still returns a failing call,
 * which is why it is worth stating: it would just be the wrong one, and the row nearest the
 * failure is the whole reason to pin one at all.
 *
 * The tool side is handed the run's FAILURES and its exact count, never the trajectory: the two
 * are separate reads precisely so the count here is about the run rather than about the prefix
 * the browse tab happens to be holding.
 */
export function deriveRunFailureEvidence(input: {
  failure?: AgentFailure | null
  calls: readonly LlmCallMetric[]
  callsAnswer: SinkAnswer
  toolFailures: RunToolCallFailures | null
  toolsAnswer: SinkAnswer
}): RunFailureEvidence {
  const errored = input.calls.filter((call) => !call.ok)
  const failures = input.toolFailures?.failures ?? []
  return {
    failure: input.failure ?? null,
    lastErroredCall: errored[0] ?? null,
    erroredCallCount: errored.length,
    lastFailedToolCall: failures[failures.length - 1] ?? null,
    failedToolCallCount: input.toolFailures?.failed ?? 0,
    failedToolCallsTruncated: input.toolFailures?.failuresTruncated ?? false,
    calls: input.callsAnswer,
    tools: input.toolsAnswer,
  }
}

/**
 * Whether the pinned failure section has anything to say about this run.
 *
 * An UNREACHABLE sink counts: "part of this run's telemetry could not be read" is exactly the
 * kind of thing an operator must be told before they conclude anything from the rest of the
 * page, and staying silent about it is how the page's other numbers get believed whole.
 */
export function hasFailureEvidence(evidence: RunFailureEvidence): boolean {
  return (
    !!evidence.failure ||
    evidence.erroredCallCount > 0 ||
    evidence.failedToolCallCount > 0 ||
    evidence.calls.status === 'unreachable' ||
    evidence.tools.status === 'unreachable'
  )
}

/**
 * Why the pinned section can point at no failing call, as a discriminated reason rather than a
 * bare absence. Each needs different words and a different next step from the operator:
 *
 * - `sink-unreachable`: a read FAILED, so nothing can be concluded. Named first because it
 *   OUTRANKS every statement below: each of those is a claim about the run, and this is the one
 *   case where the panel does not have the standing to make one.
 * - `recorded-clean`: both sinks answered, both hold rows, and none of them failed — so the
 *   cause sits where no producer records anything (the engine, or a container that died between
 *   calls).
 * - `no-telemetry`: both answered and neither holds a row, so the run failed before (or outside
 *   of) any agent work, and this panel is the wrong place to look.
 * - `partial-calls-only` / `partial-tools-only`: both answered but only one holds rows, named by
 *   the one that DID. Which sink is empty matters, because an empty sink is not evidence of
 *   anything and the panel must not let it read as a clean bill.
 *
 * Null when a failing call WAS found (nothing to explain) or while a sink is still loading (an
 * answer nobody has given yet must never be reported as one that came back clean).
 */
export type NoFailingCallReason =
  | 'sink-unreachable'
  | 'recorded-clean'
  | 'no-telemetry'
  | 'partial-calls-only'
  | 'partial-tools-only'

/** Why nothing failing could be pinned, or null when something was (or nothing is settled). */
export function noFailingCallReason(evidence: RunFailureEvidence): NoFailingCallReason | null {
  if (evidence.calls.status === 'unreachable' || evidence.tools.status === 'unreachable') {
    return 'sink-unreachable'
  }
  if (evidence.erroredCallCount > 0 || evidence.failedToolCallCount > 0) return null
  if (evidence.calls.status === 'pending' || evidence.tools.status === 'pending') return null
  const hasCalls = answeredWithRows(evidence.calls)
  const hasTools = answeredWithRows(evidence.tools)
  if (hasCalls && hasTools) return 'recorded-clean'
  if (hasCalls) return 'partial-calls-only'
  if (hasTools) return 'partial-tools-only'
  return 'no-telemetry'
}

/** Tailwind text/bg colour for an output-headroom level (green → amber → red). */
export function headroomColor(ratio: number | null, truncated: boolean): string {
  if (truncated || (ratio != null && ratio >= 0.98)) return 'text-rose-400'
  if (ratio != null && ratio >= 0.8) return 'text-amber-400'
  return 'text-emerald-400'
}
