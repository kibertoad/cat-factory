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
  /**
   * The model's reasoning / "thinking" trace on a separate channel, when emitted
   * (empty for non-reasoning models). Optional/defaulted so exports predating reasoning
   * capture still parse.
   */
  reasoningText: v.optional(v.string(), ''),
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

// ---------------------------------------------------------------------------
// Agent-context observability: the complete, redacted context one container-agent
// dispatch was *provided* (composed prompts + folded fragments + injected files).
// These schemas are the single source of truth for the shape: the kernel
// `agent-context` port derives its types from them, and the execution route
// contract reuses them as its response body, so the wire shape and the port can't
// drift.
// ---------------------------------------------------------------------------

/** One file injected into the agent's container as context, with its full body. */
export const agentContextFileSchema = v.object({
  /** Sanitized basename the file is materialised under (`.cat-context/<path>`). */
  path: v.string(),
  title: v.string(),
  url: v.string(),
  /** The full file body as written into the container. */
  content: v.string(),
})
export type AgentContextFile = v.InferOutput<typeof agentContextFileSchema>

/** One best-practice fragment folded into the agent's system prompt. */
export const agentContextFragmentSchema = v.object({
  id: v.string(),
  /** The fragment body that was appended to the system prompt. */
  body: v.string(),
})
export type AgentContextFragment = v.InferOutput<typeof agentContextFragmentSchema>

/**
 * The complete, redacted context provided to one container-agent dispatch. A
 * deliberate allow-list projection of the dispatched job body + run context — it
 * NEVER carries credentials.
 */
export const agentContextSnapshotSchema = v.object({
  id: v.string(),
  workspaceId: v.string(),
  /** The run this dispatch belongs to. */
  executionId: v.string(),
  agentKind: v.string(),
  /** The step's index within the run's pipeline (keys the snapshot to a step). */
  stepIndex: v.number(),
  /** When the dispatch was captured (epoch ms). */
  createdAt: v.number(),
  /** The resolved model id the step ran on (`provider:model`), or null. */
  model: v.nullable(v.string()),
  /** The harness the job ran under (`pi` | `claude-code` | `codex`), or null. */
  harness: v.nullable(v.string()),
  /** The fully fragment-composed system prompt sent to the harness. */
  systemPrompt: v.string(),
  /** The assembled user prompt sent to the harness (with materialised context refs). */
  userPrompt: v.string(),
  /** The best-practice fragments folded into the system prompt (id + body). */
  fragments: v.array(agentContextFragmentSchema),
  /** The files injected into the container as context, with full content. */
  contextFiles: v.array(agentContextFileSchema),
  /**
   * Redacted structural bits useful for debugging — repo owner/name/branches, the
   * web-search flag, the infra spec, the run's decisions and revision feedback.
   * Never any token, secret, or credential-bearing URL.
   */
  extras: v.record(v.string(), v.unknown()),
})
export type AgentContextSnapshot = v.InferOutput<typeof agentContextSnapshotSchema>
