import type {
  AgentContextSnapshot,
  AgentContextSnapshotIndex,
  ExecutionInstance,
  LlmCallBodySlice,
  LlmCallMetricPage,
  LlmRollupCell,
  PipelineStep,
} from '@cat-factory/kernel'
import { foldRollupTotals, foldRollupsByAgentKind, foldRollupsByPhase } from '@cat-factory/kernel'
import type {
  DebugAgentContextDetail,
  DebugAgentContextEntry,
  DebugLlmCall,
  DebugRunStep,
  DebugRunSummary,
  DebugSignal,
  DebugSinkStatus,
  DebugText,
  LlmExportInsight,
  LlmExportTotals,
  LlmPhaseInsight,
} from '@cat-factory/contracts'
import {
  cacheHitRate,
  classifyCall,
  isWarningFinishReason,
  outputHeadroomRatio,
  transportOverheadRatio,
} from '../observability/observability.logic.js'

// Pure projections + derivations behind the remote debugging surface. Everything here is a
// total function of already-fetched data — no clock, no repository, no I/O — so the shapes an
// external client depends on are unit-testable without a store, and the service above stays a
// thin "fetch the bounded things, hand them to these" layer.

/** Cap on the container post-mortem inlined on a step (it is a log tail, not a document). */
export const MAX_EVICTION_DETAIL_CHARS = 4_000

/**
 * Count Unicode CODE POINTS — the unit the stores measure in. SQL `length()`/`substr()` count
 * code points on both SQLite and Postgres, while JS `.length` counts UTF-16 units, so an
 * astral-plane character (an emoji) is one to the store and two to `.length`. Every `chars`/
 * `totalChars` on this surface is in code points; mixing the units made `truncated` lie on
 * exactly the boundary case it exists for (a body cut by SQL whose UTF-16 length happened to
 * equal the code-point total read as untruncated).
 */
function codePointLength(text: string): number {
  let count = 0
  for (let i = 0; i < text.length; i += 1) {
    count += 1
    const unit = text.charCodeAt(i)
    // A high surrogate leads a two-unit pair encoding one code point; skip its partner.
    if (unit >= 0xd800 && unit <= 0xdbff) i += 1
  }
  return count
}

/** Advance a UTF-16 index by `count` code points (never landing inside a surrogate pair). */
function advanceCodePoints(text: string, from: number, count: number): number {
  let index = from
  for (let taken = 0; taken < count && index < text.length; taken += 1) {
    const unit = text.charCodeAt(index)
    index += unit >= 0xd800 && unit <= 0xdbff ? 2 : 1
  }
  return index
}

/**
 * Slice a stored body to a caller's window and SAY SO. The metadata matters more than the
 * text: a bare truncated string reads exactly like a short one, so a model handed the first
 * 2 kB of a 40 kB reply would confidently report that the agent said almost nothing.
 *
 * `budget` of 0 returns no text at all while still reporting the full size — that is the
 * shape a sweep uses, and the reason a size-only page is still worth reading. `offset`
 * starts the window later, which is how the tail of a large body is reached; past the end
 * it returns an empty slice whose `offset` is clamped to the total, so
 * `offset + chars <= totalChars` always holds.
 *
 * Budgets, offsets and sizes are CODE POINTS (see {@link codePointLength}), matching the
 * SQL-sliced bodies — and the cut walks whole code points, so it can never split a
 * surrogate pair and hand the caller a lone half of one.
 */
export function sliceText(text: string, budget: number, offset = 0): DebugText {
  const total = codePointLength(text)
  const start = Math.max(0, Math.min(offset, total))
  const chars = Math.max(0, Math.min(budget, total - start))
  let sliced = text
  if (start > 0 || chars < total) {
    const begin = advanceCodePoints(text, 0, start)
    const end = advanceCodePoints(text, begin, chars)
    sliced = text.slice(begin, end)
  }
  return {
    text: sliced,
    chars,
    offset: start,
    totalChars: total,
    truncated: chars < total,
  }
}

/**
 * Project a body the STORE already sliced. The repository returns `{ text, totalChars }`
 * because it cut the body in SQL (so the untaken bytes never left the database); this only
 * re-derives the fields the wire shape adds. Deliberately does NOT re-slice: `text` is
 * already within the window, and slicing again would silently disagree with `totalChars`.
 *
 * `offset` is the window start the caller asked the store for (0 for a list slice), clamped
 * to the total so an ask past the end reports where the body actually stops. A search's
 * per-body `matchOffset` rides through untouched — null (no match in this body) and absent
 * (no search ran) stay distinct on the wire.
 *
 * `chars` and the truncation check count CODE POINTS, because `totalChars` came from SQL
 * `length()` which counts the same — a JS `.length` here reads a SQL-cut emoji-bearing body
 * as untruncated (see {@link codePointLength}).
 */
export function toDebugText(slice: LlmCallBodySlice, offset = 0): DebugText {
  const chars = codePointLength(slice.text)
  return {
    text: slice.text,
    chars,
    offset: Math.max(0, Math.min(offset, slice.totalChars)),
    totalChars: slice.totalChars,
    truncated: chars < slice.totalChars,
    ...(slice.matchOffset !== undefined ? { matchOffset: slice.matchOffset } : {}),
  }
}

/** Project a persisted run onto the lean summary every debug list and overview leads with. */
export function toDebugRunSummary(execution: ExecutionInstance): DebugRunSummary {
  return {
    runId: execution.id,
    blockId: execution.blockId,
    pipelineId: execution.pipelineId,
    pipelineName: execution.pipelineName,
    status: execution.status,
    createdAt: execution.createdAt ?? 0,
    currentStep: execution.currentStep,
    stepCount: execution.steps.length,
    failure: execution.failure ?? null,
  }
}

/** Project one pipeline step onto the debug view (identity + clocks + container mortality). */
export function toDebugRunStep(step: PipelineStep, index: number): DebugRunStep {
  const detail = step.firstEvictionDetail
  return {
    index,
    agentKind: step.agentKind,
    state: step.state,
    progress: step.progress,
    model: step.model ?? null,
    skipped: step.skipped ?? false,
    startedAt: step.startedAt ?? null,
    finishedAt: step.finishedAt ?? null,
    lastActivityAt: step.lastActivityAt ?? null,
    subtasks: step.subtasks
      ? {
          completed: step.subtasks.completed,
          inProgress: step.subtasks.inProgress,
          total: step.subtasks.total,
        }
      : null,
    outputChars: (step.output ?? '').length,
    hasStructuredResult: step.custom != null,
    evictionRecoveries: step.evictionRecoveries ?? 0,
    firstEvictionDetail: detail ? sliceText(detail, MAX_EVICTION_DETAIL_CHARS) : null,
  }
}

/**
 * Project a bounded call-page row onto the wire shape. `bodyOffset` is the window start the
 * store's slices were taken at (a point read's `?bodyOffset=`; always 0 on a list row).
 */
export function toDebugLlmCall(call: LlmCallMetricPage, bodyOffset = 0): DebugLlmCall {
  return {
    callId: call.id,
    runId: call.executionId,
    agentKind: call.agentKind,
    provider: call.provider,
    model: call.model,
    createdAt: call.createdAt,
    outcome: classifyCall(call),
    ok: call.ok,
    httpStatus: call.httpStatus,
    errorMessage: call.errorMessage,
    finishReason: call.finishReason,
    streaming: call.streaming,
    phase: call.phase,
    turnIndex: call.turnIndex,
    messageCount: call.messageCount,
    toolCount: call.toolCount,
    requestMaxTokens: call.requestMaxTokens,
    promptTokens: call.promptTokens,
    cacheReadTokens: call.cacheReadTokens,
    cacheWriteTokens: call.cacheWriteTokens,
    completionTokens: call.completionTokens,
    totalTokens: call.totalTokens,
    upstreamMs: call.upstreamMs,
    overheadMs: call.overheadMs,
    totalMs: call.totalMs,
    elidedLeadingMessages: call.promptPrefixCount,
    prompt: toDebugText(call.prompt, bodyOffset),
    response: toDebugText(call.response, bodyOffset),
    reasoning: toDebugText(call.reasoning, bodyOffset),
  }
}

/** Project a snapshot index row onto the wire shape. */
export function toDebugAgentContextEntry(row: AgentContextSnapshotIndex): DebugAgentContextEntry {
  return {
    snapshotId: row.id,
    agentKind: row.agentKind,
    stepIndex: row.stepIndex,
    createdAt: row.createdAt,
    model: row.model,
    harness: row.harness,
    systemPromptChars: row.systemPromptChars,
    userPromptChars: row.userPromptChars,
    fragmentsChars: row.fragmentsChars,
    contextFilesChars: row.contextFilesChars,
  }
}

/**
 * Project a whole snapshot onto the wire shape, budgeting EVERY body INDEPENDENTLY rather
 * than against one shared allowance. A snapshot routinely holds one enormous injected file
 * next to the prompts, and a shared budget spent in array order would leave the prompts — the
 * thing a reader almost always came for — empty because a README came first.
 */
export function toDebugAgentContextDetail(
  snapshot: AgentContextSnapshot,
  bodyChars: number,
  bodyOffset = 0,
): DebugAgentContextDetail {
  return {
    snapshotId: snapshot.id,
    runId: snapshot.executionId,
    agentKind: snapshot.agentKind,
    stepIndex: snapshot.stepIndex,
    createdAt: snapshot.createdAt,
    model: snapshot.model,
    harness: snapshot.harness,
    systemPrompt: sliceText(snapshot.systemPrompt, bodyChars, bodyOffset),
    userPrompt: sliceText(snapshot.userPrompt, bodyChars, bodyOffset),
    fragments: snapshot.fragments.map((f) => ({
      id: f.id,
      body: sliceText(f.body, bodyChars, bodyOffset),
    })),
    contextFiles: snapshot.contextFiles.map((f) => ({
      path: f.path,
      title: f.title,
      url: f.url,
      content: sliceText(f.content, bodyChars, bodyOffset),
    })),
    extras: snapshot.extras,
  }
}

/**
 * Fold the store's `(agentKind, phase)` rollup cells into the run-level totals + the two
 * breakdowns the overview reports. Built from {@link LlmRollupCell} — the aggregate the
 * store computes without touching a text column — rather than from the calls themselves, so a
 * 3,000-call run costs one GROUP BY here instead of reading 3,000 rows to add them up in
 * JavaScript.
 *
 * Both breakdowns are folds over the SAME cells (kernel's `foldRollupsBy*`), so they total
 * identically to each other and to `totals` by construction — the alternative, one aggregate
 * per axis, could only ever produce two answers to the same question.
 *
 * The per-kind output reuses the metrics EXPORT's shapes on purpose: both describe the same
 * run's model activity, and two independently-derived totals would eventually disagree.
 */
export function foldLlmRollup(summaries: LlmRollupCell[]): {
  totals: LlmExportTotals
  byAgentKind: LlmExportInsight[]
  byPhase: LlmPhaseInsight[]
} {
  const byAgentKind: LlmExportInsight[] = foldRollupsByAgentKind(summaries).map((s) => ({
    agentKind: s.agentKind,
    calls: s.calls,
    promptTokens: s.promptTokens,
    cacheReadTokens: s.cacheReadTokens,
    cacheWriteTokens: s.cacheWriteTokens,
    cacheHitRate: cacheHitRate(s.cacheReadTokens, s.cacheWriteTokens, s.promptTokens),
    completionTokens: s.completionTokens,
    peakCompletionTokens: s.peakCompletionTokens,
    maxOutputTokens: s.maxOutputTokens,
    outputHeadroomRatio: outputHeadroomRatio(s.peakCompletionTokens, s.maxOutputTokens),
    truncatedCalls: s.truncatedCalls,
    upstreamMs: s.upstreamMs,
    overheadMs: s.overheadMs,
    transportOverheadRatio: transportOverheadRatio(s.upstreamMs, s.overheadMs),
    errors: s.errors,
    warnings: s.warnings,
    costEstimate: s.costEstimate,
  }))
  const phases = foldRollupsByPhase(summaries)
  // Denominator for each phase's share of the carry cost. Folded from the phase rows
  // themselves rather than re-summed off `summaries`, so the shares provably sum to 1.
  const runCarryCost = phases.reduce((acc, p) => acc + p.carryCostTokens, 0)
  const byPhase: LlmPhaseInsight[] = phases
    .map((p) => ({
      phase: p.phase,
      calls: p.calls,
      promptTokens: p.promptTokens,
      cacheReadTokens: p.cacheReadTokens,
      cacheWriteTokens: p.cacheWriteTokens,
      cacheHitRate: cacheHitRate(p.cacheReadTokens, p.cacheWriteTokens, p.promptTokens),
      completionTokens: p.completionTokens,
      carryCostTokens: p.carryCostTokens,
      carryCostShare: runCarryCost > 0 ? p.carryCostTokens / runCarryCost : null,
      upstreamMs: p.upstreamMs,
      overheadMs: p.overheadMs,
      errors: p.errors,
      warnings: p.warnings,
      truncatedCalls: p.truncatedCalls,
      costEstimate: p.costEstimate,
    }))
    // Expensive slice first: the caller reading this is asking which phase to attack, and a
    // store-order list buries the answer behind whichever phase happened to run first.
    .sort((a, b) => b.carryCostTokens - a.carryCostTokens || b.calls - a.calls)
  const runTotals = foldRollupTotals(summaries)
  return {
    totals: {
      calls: runTotals.calls,
      promptTokens: runTotals.promptTokens,
      cacheReadTokens: runTotals.cacheReadTokens,
      cacheWriteTokens: runTotals.cacheWriteTokens,
      cacheHitRate: cacheHitRate(
        runTotals.cacheReadTokens,
        runTotals.cacheWriteTokens,
        runTotals.promptTokens,
      ),
      completionTokens: runTotals.completionTokens,
      upstreamMs: runTotals.upstreamMs,
      overheadMs: runTotals.overheadMs,
      transportOverheadRatio: transportOverheadRatio(runTotals.upstreamMs, runTotals.overheadMs),
      errors: runTotals.errors,
      warnings: runTotals.warnings,
      truncatedCalls: runTotals.truncatedCalls,
      costEstimate: runTotals.costEstimate,
    },
    byAgentKind,
    byPhase,
  }
}

/** What {@link deriveSignals} needs beyond the run itself. */
export interface SignalInput {
  execution: ExecutionInstance
  steps: DebugRunStep[]
  totals: LlmExportTotals
  byAgentKind: LlmExportInsight[]
  sinks: {
    llmCalls: DebugSinkStatus
    agentContext: DebugSinkStatus
    searchQueries: DebugSinkStatus
    toolCalls: DebugSinkStatus
    provisioningLog: DebugSinkStatus
  }
  /** Provisioning attempts for this run recorded as failures. */
  provisioningFailures: number
}

/** A cache hit rate below this on a substantial prompt volume is worth flagging. */
const COLD_CACHE_RATE = 0.1
/** Only flag a cold cache once the run has actually sent enough prompt to benefit from one. */
const COLD_CACHE_MIN_PROMPT_TOKENS = 50_000
/** Above this share of latency spent in transport, the proxy is the story, not the model. */
const HIGH_TRANSPORT_OVERHEAD = 0.5

/**
 * Precompute the diagnostic hints the overview publishes. Every one of these is derivable by
 * the caller from the same payload — which is exactly the point: a model that has to
 * rediscover "13 of 40 calls were truncated" by arithmetic over a JSON blob will sometimes get
 * it wrong and will always spend context getting it right. Ordered most-severe first, so a
 * reader that truncates the list keeps what matters.
 *
 * Deliberately NOT a verdict. Each signal names one observation and its magnitude; nothing
 * here claims to know why the run failed, because a wrong confident cause is worse for a
 * debugging client than an ordered list of facts.
 */
export function deriveSignals(input: SignalInput): DebugSignal[] {
  const { execution, steps, totals, byAgentKind, sinks, provisioningFailures } = input
  const signals: DebugSignal[] = []
  const push = (
    code: string,
    severity: DebugSignal['severity'],
    message: string,
    extra: Partial<Pick<DebugSignal, 'count' | 'agentKind' | 'stepIndex'>> = {},
  ): void => {
    signals.push({
      code,
      severity,
      message,
      count: extra.count ?? null,
      agentKind: extra.agentKind ?? null,
      stepIndex: extra.stepIndex ?? null,
    })
  }

  if (execution.status === 'failed') {
    const failure = execution.failure
    push(
      'run_failed',
      'error',
      failure
        ? `The run failed with '${failure.kind}': ${failure.message}`
        : 'The run failed without recording a structured failure.',
      { stepIndex: execution.currentStep },
    )
  }
  if (provisioningFailures > 0) {
    push(
      'provisioning_failed',
      'error',
      `${provisioningFailures} provisioning attempt(s) for this run failed. Read GET /debug/runs/:runId/logs for the verbatim provider error — a run whose infrastructure never came up records no model calls at all.`,
      { count: provisioningFailures },
    )
  }
  if (totals.errors > 0) {
    push('llm_calls_failed', 'error', `${totals.errors} model call(s) failed.`, {
      count: totals.errors,
    })
  }
  for (const step of steps) {
    if (step.evictionRecoveries > 0) {
      push(
        'container_evicted',
        'warning',
        `Step ${step.index} (${step.agentKind}) lost its container ${step.evictionRecoveries} time(s) and was re-dispatched.`,
        { count: step.evictionRecoveries, agentKind: step.agentKind, stepIndex: step.index },
      )
    }
  }
  for (const insight of byAgentKind) {
    if (insight.truncatedCalls > 0) {
      push(
        'output_truncated',
        'warning',
        `${insight.truncatedCalls} of ${insight.agentKind}'s ${insight.calls} call(s) hit the output limit, so the model's reply was cut mid-answer.`,
        { count: insight.truncatedCalls, agentKind: insight.agentKind },
      )
    }
  }
  // The most common hard diagnosis has NO row of its own: a run that failed while every model
  // call looks healthy. Tool-EXECUTION errors (malformed arguments, a stuck edit loop) happen
  // inside the container and are recorded only as text inside the prompt deltas — each call
  // still reports `ok` with a clean finish reason, so without this pointer the overview reads
  // like a healthy run that inexplicably died and the caller has nothing to follow.
  if (
    execution.status === 'failed' &&
    sinks.llmCalls.available &&
    totals.calls > 0 &&
    totals.errors === 0 &&
    totals.truncatedCalls === 0
  ) {
    push(
      'failure_outside_model_calls',
      'warning',
      `The run failed but none of its ${totals.calls} model call(s) failed or was truncated — the model side looks healthy, so the cause most likely sits in tool execution inside the container or in the engine, neither of which records calls here. Search the bodies for tool errors (GET /debug/runs/:runId/llm-calls?contains=...), read the newest calls' deltas, and check each step's firstEvictionDetail plus /logs.`,
      { count: totals.calls },
    )
  }
  if (
    totals.transportOverheadRatio != null &&
    totals.transportOverheadRatio > HIGH_TRANSPORT_OVERHEAD
  ) {
    push(
      'transport_overhead_high',
      'warning',
      `${Math.round(totals.transportOverheadRatio * 100)}% of the run's model latency was transport/proxy overhead rather than model execution.`,
    )
  }
  if (
    totals.promptTokens >= COLD_CACHE_MIN_PROMPT_TOKENS &&
    totals.cacheHitRate != null &&
    totals.cacheHitRate < COLD_CACHE_RATE
  ) {
    push(
      'prompt_cache_cold',
      'info',
      `Only ${Math.round(totals.cacheHitRate * 100)}% of ${totals.promptTokens} prompt tokens were served from the provider's prefix cache, so the conversation was re-billed almost in full every turn.`,
    )
  }
  if (execution.status === 'blocked') {
    push(
      'run_parked',
      'info',
      'The run is parked awaiting a human decision; it will wait indefinitely by design.',
      { stepIndex: execution.currentStep },
    )
  }
  if (execution.status === 'paused') {
    push('run_paused', 'info', 'The run is paused by the spend safeguard.', {
      stepIndex: execution.currentStep,
    })
  }
  // A sink that is not wired and a sink that is wired but empty need DIFFERENT follow-up
  // actions from the caller — "turn capture on / this deployment does not keep it" versus
  // "nothing happened here, look elsewhere" — so they are never collapsed into one hint.
  for (const [name, sink, what] of [
    ['llmCalls', sinks.llmCalls, 'model calls'],
    ['agentContext', sinks.agentContext, 'agent-context snapshots'],
    ['searchQueries', sinks.searchQueries, 'web searches'],
    ['toolCalls', sinks.toolCalls, 'tool calls'],
    ['provisioningLog', sinks.provisioningLog, 'provisioning events'],
  ] as const) {
    if (!sink.available) {
      // Availability is REPOSITORY presence only. A workspace that turned capture off (or a
      // deployment without LLM_RECORD_PROMPTS) still reads `available: true, count: 0` — the
      // capture gates act at record time, and this reader cannot see them.
      push(
        'telemetry_unavailable',
        'info',
        `No ${what} are retained: the '${name}' sink is not wired on this deployment. Its count of 0 does not mean none happened.`,
      )
    }
  }
  // Skipped for a `done` run on purpose: a completed run with no model calls is a legitimate
  // shape (a gate-only or pass-through pipeline), not a diagnosis.
  if (sinks.llmCalls.available && sinks.llmCalls.count === 0 && execution.status !== 'done') {
    push(
      'no_model_calls',
      'warning',
      'The run recorded no model calls at all, so it failed or stalled before (or outside of) any agent work.',
    )
  }
  return signals
}

/** Re-exported so the service and its tests classify a call exactly as the SPA does. */
export { classifyCall, isWarningFinishReason }
