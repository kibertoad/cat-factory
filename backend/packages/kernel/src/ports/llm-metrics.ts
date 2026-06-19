// Persistence port for LLM observability. Every container agent talks to a model
// only through the runtime-neutral LLM proxy (the single chokepoint that sees the
// full prompt, the upstream response/usage, the model lock + output limit, and the
// upstream timing), so the proxy records one of these per call. Unlike the spend
// ledger (which keeps only billed token totals), this captures the full request +
// response, the output-limit headroom, and the latency split between transport
// (proxy) overhead and actual model execution — so a run can be inspected end to
// end. The domain depends only on this interface; each runtime facade implements it
// (D1 on Cloudflare, Drizzle/Postgres on Node).

/**
 * Upstream finish reasons that are not failures but warrant a warning: the model
 * was cut short by the output limit, or filtered. Shared by the service's
 * classification and each repo's summary aggregation so the two runtimes agree.
 */
export const LLM_WARNING_FINISH_REASONS = ['length', 'content_filter'] as const

/** One proxied LLM call, with its full prompt/response and timing breakdown. */
export interface LlmCallMetric {
  id: string
  workspaceId: string
  /** The run this call belongs to (null only for calls outside a run). */
  executionId: string | null
  agentKind: string
  provider: string
  model: string
  /** When the call completed (epoch ms). */
  createdAt: number
  /** Whether the upstream call was streamed (SSE) rather than buffered. */
  streaming: boolean
  /** Number of chat messages in the request. */
  messageCount: number
  /** Number of tools offered in the request (0 = the agent can't edit anything). */
  toolCount: number
  /** The `max_tokens` the request asked for (the effective output ceiling), or null. */
  requestMaxTokens: number | null
  /** Prompt (input) tokens the model reported. */
  promptTokens: number
  /** Completion (output) tokens the model reported. */
  completionTokens: number
  /** Total tokens the model reported. */
  totalTokens: number
  /** The upstream finish reason (`stop` | `length` | `tool_calls` | `content_filter` | …), or null. */
  finishReason: string | null
  /** Time spent waiting on the upstream model (ms) — the actual execution. */
  upstreamMs: number
  /** Transport/proxy overhead (ms): the call's total time minus {@link upstreamMs}. */
  overheadMs: number
  /** End-to-end time the proxy spent on this call (ms). */
  totalMs: number
  /** Whether the call succeeded (a 2xx upstream response). */
  ok: boolean
  /** The upstream HTTP status, when the call reached an upstream (null for in-process / refusals). */
  httpStatus: number | null
  /** A short error message when {@link ok} is false, else null. */
  errorMessage: string | null
  /**
   * The request messages serialised as JSON — stored as a DELTA: only the messages
   * this call appended beyond {@link promptPrefixCount}. When `promptPrefixCount` is
   * 0 this is the full array. Reconstruct the full prompt by replaying a chain's
   * deltas (see `reconstructPrompts` in orchestration).
   */
  promptText: string
  /**
   * Number of leading messages elided from {@link promptText} (already stored by an
   * earlier call in this conversation chain). 0 ⇒ {@link promptText} is the full array.
   */
  promptPrefixCount: number
  /**
   * Hash of this call's FULL messages array, used to verify that the NEXT call in the
   * chain genuinely extends this one before its prefix is elided.
   */
  promptHash: string
  /** The full assistant response text (concatenated for streamed calls). */
  responseText: string
}

/**
 * Per-agent-kind aggregate over a run's calls, attached to the matching pipeline
 * step for at-a-glance board display. Computed by SQL aggregation — it never reads
 * the heavy prompt/response text columns.
 */
export interface LlmCallMetricSummary {
  agentKind: string
  /** Number of calls recorded for this agent kind in the run. */
  calls: number
  /** Sum of prompt (input) tokens. */
  promptTokens: number
  /** Sum of completion (output) tokens. */
  completionTokens: number
  /** The largest single completion the model produced (closest approach to the limit). */
  peakCompletionTokens: number
  /** The output ceiling in effect (max requested `max_tokens`), or null when unknown. */
  maxOutputTokens: number | null
  /** Calls cut short by the output limit (`finish_reason === 'length'`). */
  truncatedCalls: number
  /** Sum of model execution time (ms). */
  upstreamMs: number
  /** Sum of transport/proxy overhead (ms). */
  overheadMs: number
  /** Calls that failed (non-2xx / refused / in-process error). */
  errors: number
  /** Calls that produced a warning (truncated or content-filtered) but did not fail. */
  warnings: number
}

/** The most recent call's chain tip for delta prompt storage. */
export interface LlmPromptChainTip {
  /** The call's full message count. */
  messageCount: number
  /** The call's {@link LlmCallMetric.promptHash}. */
  promptHash: string
}

export interface LlmCallMetricRepository {
  /** Append one metered call. */
  record(metric: LlmCallMetric): Promise<void>
  /**
   * The most recent call's chain tip for a `(workspaceId, executionId, agentKind)`
   * conversation, or null when there is none. Lets the sink store the next call's
   * prompt as a delta against this one. Cheap: one indexed row, no text columns.
   */
  latestChainTip(
    workspaceId: string,
    executionId: string,
    agentKind: string,
  ): Promise<LlmPromptChainTip | null>
  /**
   * Calls recorded for a run, newest first (full prompt/response included). `limit`
   * caps the rows returned (the bodies are heavy) — newest `limit` calls; omit for
   * all. Callers pass a bound so a long run can't produce an unbounded payload.
   */
  listByExecution(
    workspaceId: string,
    executionId: string,
    limit?: number,
  ): Promise<LlmCallMetric[]>
  /**
   * Per-agent-kind aggregates for a run, for the board rollups. Aggregates in SQL
   * and deliberately selects no text columns, so it is cheap to run on every emit.
   */
  summarizeByExecution(workspaceId: string, executionId: string): Promise<LlmCallMetricSummary[]>
  /**
   * Retention: delete rows older than `epochMs` (exclusive), returning how many
   * were removed. The full request/response bodies make this table heavy, so it is
   * pruned to a configured window alongside the other unbounded tables.
   */
  deleteOlderThan(epochMs: number): Promise<number>
}
