import { LLM_WARNING_FINISH_REASONS, type LlmCallMetric } from '@cat-factory/kernel'
import type { LlmExportInsight, LlmMetricsExport } from '@cat-factory/contracts'

// Pure classification + headroom helpers for LLM observability, kept out of the
// service so they are trivially unit-testable and reused by the frontend's mental
// model (errors fail a run's call, warnings flag truncation/filtering).

export type LlmCallOutcome = 'ok' | 'warning' | 'error'

/** Whether a finish reason is a (non-fatal) warning — output truncated or filtered. */
export function isWarningFinishReason(finishReason: string | null): boolean {
  return finishReason != null && (LLM_WARNING_FINISH_REASONS as readonly string[]).includes(finishReason)
}

/**
 * Classify a recorded call: a non-2xx/failed call is an `error`; a successful call
 * cut short by the output limit or content filter is a `warning`; otherwise `ok`.
 */
export function classifyCall(
  metric: Pick<LlmCallMetric, 'ok' | 'finishReason'>,
): LlmCallOutcome {
  if (!metric.ok) return 'error'
  if (isWarningFinishReason(metric.finishReason)) return 'warning'
  return 'ok'
}

/**
 * Fraction (0..1) of the output budget the largest single completion consumed, or
 * null when the ceiling is unknown. 1 (or a `length` finish) means a call was
 * truncated. Drives the board's "output-limit headroom" bar.
 */
export function outputHeadroomRatio(
  peakCompletionTokens: number,
  maxOutputTokens: number | null,
): number | null {
  if (maxOutputTokens == null || maxOutputTokens <= 0) return null
  return Math.min(1, peakCompletionTokens / maxOutputTokens)
}

/** Share of total latency spent in transport/proxy overhead (0..1), or null when no timing. */
export function transportOverheadRatio(upstreamMs: number, overheadMs: number): number | null {
  const total = upstreamMs + overheadMs
  return total > 0 ? overheadMs / total : null
}

/**
 * Build the LLM-friendly export bundle for a run from its recorded calls: a
 * self-describing JSON document (totals + per-agent insights + every call, with
 * derived ratios precomputed) meant to be handed straight to a model for analysis.
 * Pure so it is unit-testable; `generatedAt` is injected (no clock here).
 */
export function buildLlmMetricsExport(
  executionId: string,
  calls: LlmCallMetric[],
  generatedAt: number,
): LlmMetricsExport {
  const byKind = new Map<string, LlmCallMetric[]>()
  for (const call of calls) {
    const list = byKind.get(call.agentKind)
    if (list) list.push(call)
    else byKind.set(call.agentKind, [call])
  }

  const insights: LlmExportInsight[] = [...byKind.entries()].map(([agentKind, kindCalls]) => {
    const promptTokens = sum(kindCalls, (c) => c.promptTokens)
    const completionTokens = sum(kindCalls, (c) => c.completionTokens)
    const peakCompletionTokens = kindCalls.reduce((m, c) => Math.max(m, c.completionTokens), 0)
    const maxOutputTokens = maxNullable(kindCalls.map((c) => c.requestMaxTokens))
    const upstreamMs = sum(kindCalls, (c) => c.upstreamMs)
    const overheadMs = sum(kindCalls, (c) => c.overheadMs)
    return {
      agentKind,
      calls: kindCalls.length,
      promptTokens,
      completionTokens,
      peakCompletionTokens,
      maxOutputTokens,
      outputHeadroomRatio: outputHeadroomRatio(peakCompletionTokens, maxOutputTokens),
      truncatedCalls: kindCalls.filter((c) => c.finishReason === 'length').length,
      upstreamMs,
      overheadMs,
      transportOverheadRatio: transportOverheadRatio(upstreamMs, overheadMs),
      errors: kindCalls.filter((c) => !c.ok).length,
      warnings: kindCalls.filter((c) => c.ok && isWarningFinishReason(c.finishReason)).length,
    }
  })

  const upstreamMs = sum(calls, (c) => c.upstreamMs)
  const overheadMs = sum(calls, (c) => c.overheadMs)
  return {
    kind: 'cat-factory.llm-metrics-export',
    version: 1,
    executionId,
    generatedAt,
    totals: {
      calls: calls.length,
      promptTokens: sum(calls, (c) => c.promptTokens),
      completionTokens: sum(calls, (c) => c.completionTokens),
      upstreamMs,
      overheadMs,
      transportOverheadRatio: transportOverheadRatio(upstreamMs, overheadMs),
      errors: calls.filter((c) => !c.ok).length,
      warnings: calls.filter((c) => c.ok && isWarningFinishReason(c.finishReason)).length,
      truncatedCalls: calls.filter((c) => c.finishReason === 'length').length,
    },
    insights,
    calls,
  }
}

function sum<T>(items: T[], pick: (item: T) => number): number {
  return items.reduce((acc, item) => acc + pick(item), 0)
}

function maxNullable(values: Array<number | null>): number | null {
  const present = values.filter((v): v is number => v != null)
  return present.length > 0 ? Math.max(...present) : null
}
