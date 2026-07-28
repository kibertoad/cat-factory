import type {
  AgentContextSnapshot,
  AgentContextSnapshotIndex,
  ExecutionInstance,
  LlmCallBodySlice,
  LlmCallMetricPage,
  LlmCallMetricSummary,
  PipelineStep,
} from '@cat-factory/kernel'
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
 * Slice a stored body to a caller's budget and SAY SO. The pair matters more than either
 * half: a bare truncated string reads exactly like a short one, so a model handed the first
 * 2 kB of a 40 kB reply would confidently report that the agent said almost nothing.
 *
 * `budget` of 0 returns no text at all while still reporting the full size — that is the
 * shape a sweep uses, and the reason a size-only page is still worth reading.
 */
export function sliceText(text: string, budget: number): DebugText {
  const total = text.length
  const chars = Math.max(0, Math.min(budget, total))
  return {
    text: chars === total ? text : text.slice(0, chars),
    chars,
    totalChars: total,
    truncated: chars < total,
  }
}

/**
 * Project a body the STORE already sliced. The repository returns `{ text, totalChars }`
 * because it cut the body in SQL (so the untaken bytes never left the database); this only
 * re-derives the two fields the wire shape adds. Deliberately does NOT re-slice: `text` is
 * already within budget, and slicing again would silently disagree with `totalChars`.
 */
export function toDebugText(slice: LlmCallBodySlice): DebugText {
  return {
    text: slice.text,
    chars: slice.text.length,
    totalChars: slice.totalChars,
    truncated: slice.text.length < slice.totalChars,
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

/** Project a bounded call-page row onto the wire shape. */
export function toDebugLlmCall(call: LlmCallMetricPage): DebugLlmCall {
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
    messageCount: call.messageCount,
    toolCount: call.toolCount,
    requestMaxTokens: call.requestMaxTokens,
    promptTokens: call.promptTokens,
    cachedPromptTokens: call.cachedPromptTokens,
    completionTokens: call.completionTokens,
    totalTokens: call.totalTokens,
    upstreamMs: call.upstreamMs,
    overheadMs: call.overheadMs,
    totalMs: call.totalMs,
    elidedLeadingMessages: call.promptPrefixCount,
    prompt: toDebugText(call.prompt),
    response: toDebugText(call.response),
    reasoning: toDebugText(call.reasoning),
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
): DebugAgentContextDetail {
  return {
    snapshotId: snapshot.id,
    runId: snapshot.executionId,
    agentKind: snapshot.agentKind,
    stepIndex: snapshot.stepIndex,
    createdAt: snapshot.createdAt,
    model: snapshot.model,
    harness: snapshot.harness,
    systemPrompt: sliceText(snapshot.systemPrompt, bodyChars),
    userPrompt: sliceText(snapshot.userPrompt, bodyChars),
    fragments: snapshot.fragments.map((f) => ({ id: f.id, body: sliceText(f.body, bodyChars) })),
    contextFiles: snapshot.contextFiles.map((f) => ({
      path: f.path,
      title: f.title,
      url: f.url,
      content: sliceText(f.content, bodyChars),
    })),
    extras: snapshot.extras,
  }
}

/**
 * Fold the per-agent-kind SQL rollups into the run-level totals + insight list the overview
 * reports. Built from {@link LlmCallMetricSummary} — the aggregate the store computes without
 * touching a text column — rather than from the calls themselves, so a 3,000-call run costs
 * one GROUP BY here instead of reading 3,000 rows to add them up in JavaScript.
 *
 * The output reuses the metrics EXPORT's shapes on purpose: both describe the same run's model
 * activity, and two independently-derived totals would eventually disagree.
 */
export function foldLlmRollup(summaries: LlmCallMetricSummary[]): {
  totals: LlmExportTotals
  byAgentKind: LlmExportInsight[]
} {
  const byAgentKind: LlmExportInsight[] = summaries.map((s) => ({
    agentKind: s.agentKind,
    calls: s.calls,
    promptTokens: s.promptTokens,
    cachedPromptTokens: s.cachedPromptTokens,
    cacheHitRate: cacheHitRate(s.cachedPromptTokens, s.promptTokens),
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
  }))
  const total = <K extends keyof LlmCallMetricSummary>(key: K): number =>
    summaries.reduce((acc, s) => acc + (s[key] as number), 0)
  const promptTokens = total('promptTokens')
  const cachedPromptTokens = total('cachedPromptTokens')
  const upstreamMs = total('upstreamMs')
  const overheadMs = total('overheadMs')
  return {
    totals: {
      calls: total('calls'),
      promptTokens,
      cachedPromptTokens,
      cacheHitRate: cacheHitRate(cachedPromptTokens, promptTokens),
      completionTokens: total('completionTokens'),
      upstreamMs,
      overheadMs,
      transportOverheadRatio: transportOverheadRatio(upstreamMs, overheadMs),
      errors: total('errors'),
      warnings: total('warnings'),
      truncatedCalls: total('truncatedCalls'),
    },
    byAgentKind,
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
    ['provisioningLog', sinks.provisioningLog, 'provisioning events'],
  ] as const) {
    if (!sink.available) {
      push(
        'telemetry_unavailable',
        'info',
        `No ${what} are retained: the '${name}' sink is not wired on this deployment, or the workspace turned agent-context capture off. Its count of 0 does not mean none happened.`,
      )
    }
  }
  if (sinks.llmCalls.available && sinks.llmCalls.count === 0) {
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
