import * as v from 'valibot'

// Wire contracts for LLM observability — the per-call detail behind the board's
// step rollups (see `stepMetricsSchema` in entities). The proxy records one of
// these per model call (full prompt + response, output-limit headroom, the
// transport-vs-execution latency split); the drill-down panel lists them and the
// export endpoint returns an LLM-analysable bundle.

/** One proxied LLM call, with its full prompt/response and timing breakdown. */
export const llmCallMetricSchema = v.object({
  id: v.string(),
  workspaceId: v.string(),
  executionId: v.nullable(v.string()),
  agentKind: v.string(),
  provider: v.string(),
  model: v.string(),
  /** When the call completed (epoch ms). */
  createdAt: v.number(),
  streaming: v.boolean(),
  messageCount: v.number(),
  /** Tools offered to the model (0 = the agent could not edit anything). */
  toolCount: v.number(),
  /** The `max_tokens` the request asked for (the output ceiling), or null. */
  requestMaxTokens: v.nullable(v.number()),
  promptTokens: v.number(),
  /** Prompt tokens served from the provider's prompt cache (subset of promptTokens). */
  cachedPromptTokens: v.optional(v.number(), 0),
  completionTokens: v.number(),
  totalTokens: v.number(),
  /** Upstream finish reason (`stop` | `length` | `tool_calls` | `content_filter` | …). */
  finishReason: v.nullable(v.string()),
  /** Time waiting on the model (ms) — the actual execution. */
  upstreamMs: v.number(),
  /** Transport/proxy overhead (ms). */
  overheadMs: v.number(),
  /** End-to-end time the proxy spent on the call (ms). */
  totalMs: v.number(),
  ok: v.boolean(),
  httpStatus: v.nullable(v.number()),
  errorMessage: v.nullable(v.string()),
  /**
   * The request messages serialised as JSON, stored as a DELTA — only the messages
   * this call appended beyond `promptPrefixCount` (the full array when that is 0).
   * The export rebuilds the full prompt from a chain's deltas.
   */
  promptText: v.string(),
  /**
   * Leading messages elided from `promptText` (stored by an earlier call in the same
   * conversation). 0 ⇒ `promptText` is the full array. Optional/defaulted so exports
   * predating delta storage still parse.
   */
  promptPrefixCount: v.optional(v.number(), 0),
  /** Hash of the call's full messages array (chain key for the next call's delta). */
  promptHash: v.optional(v.string(), ''),
  /** The full assistant response text. */
  responseText: v.string(),
})
export type LlmCallMetric = v.InferOutput<typeof llmCallMetricSchema>

/**
 * The compact per-call summary pushed live over the workspace event stream (the
 * `llmCall` {@link WorkspaceEvent}). It is {@link llmCallMetricSchema} WITHOUT the
 * heavy text bodies (`promptText`/`responseText`) and the delta bookkeeping
 * (`promptPrefixCount`/`promptHash`), so a stalled-driver "is the agent still
 * calling the model?" view updates in real time without shipping prompt bytes over
 * the socket. The drill-down panel lazy-loads the full bodies for an expanded row
 * from `GET /executions/:id/llm-metrics` (the persisted store), keyed by the shared
 * call `id`.
 */
export const llmCallActivitySchema = v.object({
  id: v.string(),
  workspaceId: v.string(),
  executionId: v.nullable(v.string()),
  agentKind: v.string(),
  provider: v.string(),
  model: v.string(),
  createdAt: v.number(),
  streaming: v.boolean(),
  messageCount: v.number(),
  toolCount: v.number(),
  requestMaxTokens: v.nullable(v.number()),
  promptTokens: v.number(),
  // Always supplied by the proxy emit (unlike the persisted metric, which defaults it
  // for rows that predate delta storage), so it is required here — matching the SPA's
  // `LlmCallActivity` type, which derives it as a required field from `LlmCallMetric`.
  cachedPromptTokens: v.number(),
  completionTokens: v.number(),
  totalTokens: v.number(),
  finishReason: v.nullable(v.string()),
  upstreamMs: v.number(),
  overheadMs: v.number(),
  totalMs: v.number(),
  ok: v.boolean(),
  httpStatus: v.nullable(v.number()),
  errorMessage: v.nullable(v.string()),
})
export type LlmCallActivity = v.InferOutput<typeof llmCallActivitySchema>

/** Response of `GET /workspaces/:ws/executions/:id/llm-metrics` (drill-down panel). */
export const llmMetricsResponseSchema = v.object({
  executionId: v.string(),
  calls: v.array(llmCallMetricSchema),
})
export type LlmMetricsResponse = v.InferOutput<typeof llmMetricsResponseSchema>

/**
 * A single per-agent-kind insight in the LLM-friendly export: the same rollup the
 * board step shows, plus derived ratios so an analysing model needs no arithmetic.
 */
export const llmExportInsightSchema = v.object({
  agentKind: v.string(),
  calls: v.number(),
  promptTokens: v.number(),
  completionTokens: v.number(),
  peakCompletionTokens: v.number(),
  maxOutputTokens: v.nullable(v.number()),
  /** peakCompletionTokens / maxOutputTokens, 0..1; null when the ceiling is unknown. */
  outputHeadroomRatio: v.nullable(v.number()),
  truncatedCalls: v.number(),
  upstreamMs: v.number(),
  overheadMs: v.number(),
  /** overheadMs / (upstreamMs + overheadMs), 0..1; the share spent in transport. */
  transportOverheadRatio: v.nullable(v.number()),
  errors: v.number(),
  warnings: v.number(),
})
export type LlmExportInsight = v.InferOutput<typeof llmExportInsightSchema>

/**
 * LLM-friendly export of a run's model activity: a self-describing, structured JSON
 * bundle (totals + per-agent insights + every call) intended to be handed straight
 * to a model for analysis ("why did this run truncate / spend / stall?"). Field
 * names and derived ratios are explicit so no external context is needed.
 */
export const llmMetricsExportSchema = v.object({
  /** Schema marker so a consuming model knows the shape. */
  kind: v.literal('cat-factory.llm-metrics-export'),
  version: v.literal(1),
  executionId: v.string(),
  generatedAt: v.number(),
  totals: v.object({
    calls: v.number(),
    promptTokens: v.number(),
    completionTokens: v.number(),
    upstreamMs: v.number(),
    overheadMs: v.number(),
    /** Share of total latency spent in transport/proxy (0..1), or null with no timing. */
    transportOverheadRatio: v.nullable(v.number()),
    errors: v.number(),
    warnings: v.number(),
    truncatedCalls: v.number(),
  }),
  insights: v.array(llmExportInsightSchema),
  calls: v.array(llmCallMetricSchema),
})
export type LlmMetricsExport = v.InferOutput<typeof llmMetricsExportSchema>
