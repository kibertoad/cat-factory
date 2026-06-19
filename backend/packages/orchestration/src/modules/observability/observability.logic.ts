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

// --- Delta prompt storage --------------------------------------------------
// A container agent re-sends its WHOLE growing conversation on every model call,
// so storing each call's full prompt is hugely redundant — in a real 30-call run
// the per-call prompt grew 4.5k → 11.7k tokens and the serialised prompts were
// ~21× larger than storing the conversation once. Instead we store only the NEW
// messages each call appended (the delta), with enough metadata to reconstruct the
// full prompt on demand:
//   - promptText        the new messages (JSON), or the full array when the call
//                       starts a fresh conversation / can't be chained
//   - promptPrefixCount how many leading messages were elided (0 ⇒ promptText is full)
//   - promptHash        hash of the call's FULL messages array, so the NEXT call can
//                       verify it genuinely extends this one before eliding the prefix
// The hash guard means a fresh conversation (system prompt restart on a retry) or a
// context-compacted prompt — where the prefix is NOT a simple extension — safely
// falls back to storing the full array, so reconstruction can never silently corrupt.

/** The previous call's chain tip: enough to decide if the next call extends it. */
export interface PromptChainTip {
  /** The previous call's full message count (its `messageCount`). */
  messageCount: number
  /** The previous call's {@link LlmCallMetric.promptHash} (hash of its full array). */
  promptHash: string
}

/** What to store for a call's prompt after delta compression. */
export interface StoredPrompt {
  promptText: string
  promptPrefixCount: number
  promptHash: string
}

/** Fast, stable, dependency-free hash (FNV-1a, length-salted) for chain validation. */
export function hashPrompt(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    // FNV prime, kept in 32-bit range via Math.imul.
    h = Math.imul(h, 0x01000193)
  }
  // Salt with the length so two same-hash-different-length strings can't collide.
  return `${text.length.toString(36)}:${(h >>> 0).toString(36)}`
}

function parseMessages(promptText: string): unknown[] | null {
  try {
    const parsed = JSON.parse(promptText)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Compute what to store for a call's prompt: the delta (new messages only) when this
 * call provably extends the previous one in its chain, else the full array. The
 * returned {@link StoredPrompt.promptHash} is always over the FULL array so the next
 * call can chain onto this one. `fullPromptText` is the proxy's `JSON.stringify(messages)`.
 */
export function computeStoredPrompt(
  fullPromptText: string,
  prev: PromptChainTip | null,
): StoredPrompt {
  const promptHash = hashPrompt(fullPromptText)
  const full = parseMessages(fullPromptText)
  // No previous tip, unparseable, or not actually longer ⇒ store the full array.
  if (!full || !prev || prev.messageCount <= 0 || full.length < prev.messageCount) {
    return { promptText: fullPromptText, promptPrefixCount: 0, promptHash }
  }
  // Only elide when the leading `prev.messageCount` messages match what the previous
  // call stored (append-only). A mismatch (fresh conversation / compaction) ⇒ full.
  const prefix = JSON.stringify(full.slice(0, prev.messageCount))
  if (hashPrompt(prefix) !== prev.promptHash) {
    return { promptText: fullPromptText, promptPrefixCount: 0, promptHash }
  }
  return {
    promptText: JSON.stringify(full.slice(prev.messageCount)),
    promptPrefixCount: prev.messageCount,
    promptHash,
  }
}

/**
 * Rebuild each call's FULL prompt from the stored deltas. Calls are grouped by agent
 * kind (each kind is its own conversation chain) and replayed oldest-first,
 * accumulating the running message array; a call with `promptPrefixCount === 0` resets
 * the chain. Best-effort: if a chain's head is missing (e.g. truncated by a list
 * limit) a delta that can't be rebuilt is returned as-is. The returned calls preserve
 * the input order, with `promptText` set to the full array and `promptPrefixCount` 0.
 */
export function reconstructPrompts(calls: LlmCallMetric[]): LlmCallMetric[] {
  const asc = [...calls].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  const running = new Map<string, unknown[]>()
  const fullById = new Map<string, string>()
  for (const c of asc) {
    const delta = parseMessages(c.promptText) ?? []
    let full: unknown[]
    if (c.promptPrefixCount > 0) {
      const prev = running.get(c.agentKind) ?? []
      // Only rebuild when we actually hold the referenced prefix; else keep the delta.
      full = prev.length >= c.promptPrefixCount ? [...prev.slice(0, c.promptPrefixCount), ...delta] : delta
    } else {
      full = delta
    }
    running.set(c.agentKind, full)
    fullById.set(c.id, JSON.stringify(full))
  }
  return calls.map((c) => ({
    ...c,
    promptText: fullById.get(c.id) ?? c.promptText,
    promptPrefixCount: 0,
  }))
}

/**
 * Build the LLM-friendly export bundle for a run from its recorded calls: a
 * self-describing JSON document (totals + per-agent insights + every call, with
 * derived ratios precomputed) meant to be handed straight to a model for analysis.
 * Pure so it is unit-testable; `generatedAt` is injected (no clock here).
 */
export function buildLlmMetricsExport(
  executionId: string,
  storedCalls: LlmCallMetric[],
  generatedAt: number,
): LlmMetricsExport {
  // The export is a self-contained analysis bundle, so rebuild each call's full
  // prompt from the stored deltas before assembling it.
  const calls = reconstructPrompts(storedCalls)
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
