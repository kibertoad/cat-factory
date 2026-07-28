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
  /**
   * FRESH (uncached) input tokens: what the model processed from scratch, exclusive of
   * BOTH cache classes. Every population site normalises to this — subtracting the cached
   * share on the providers that report an inclusive prompt count (OpenAI/DeepSeek), or
   * reading the already-exclusive field on those that report the classes separately
   * (Anthropic). Total input = `promptTokens + cacheReadTokens + cacheWriteTokens`.
   */
  promptTokens: number
  /**
   * Input tokens served from the provider's prompt cache, across the field names providers
   * use. Priced at roughly 0.1× base input — cheap, but NOT free and not weightless: they
   * occupy the context window exactly like fresh tokens do. 0 when the provider reported
   * none or does not cache.
   */
  cacheReadTokens: number
  /**
   * Input tokens WRITTEN into the provider's cache on this call (Anthropic's
   * `cache_creation_input_tokens`). Priced at 1.25–2× base input, i.e. dearer than fresh,
   * which is why it is a class of its own rather than lumped with the reads: summed
   * together, a loop that keeps invalidating and re-writing the prefix is indistinguishable
   * from one that rides a warm cache. 0 on providers with no separate write class.
   */
  cacheWriteTokens: number
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
  /**
   * The model's reasoning / "thinking" trace, when it emits one on a separate channel
   * (AI SDK `reasoningText`; OpenAI-compatible `reasoning_content` / `reasoning`).
   * Empty for non-reasoning models. Captured so a turn that spends its whole output
   * budget thinking and returns empty {@link responseText} is still diagnosable
   * (otherwise those tokens look like they vanished).
   */
  reasoningText: string
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
  /** Sum of FRESH (uncached) input tokens — exclusive of both cache classes. */
  promptTokens: number
  /** Sum of input tokens served from the provider's prefix cache. */
  cacheReadTokens: number
  /** Sum of input tokens written into the provider's cache. */
  cacheWriteTokens: number
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

/**
 * A stored text body sliced to a caller's budget, plus the length of what is stored. The
 * two travel together because they answer different questions and one without the other
 * misleads: an empty `text` with `totalChars: 0` means the model returned nothing, while an
 * empty `text` with `totalChars: 40000` means the caller asked for no body bytes.
 *
 * `totalChars` is computed in SQL (`length(col)`), so a page that asks for no bodies still
 * reports every size without the text columns ever leaving the store.
 */
export interface LlmCallBodySlice {
  /** The leading `min(budget, totalChars)` characters of the stored body. */
  text: string
  /** Full stored length of the body. */
  totalChars: number
}

/**
 * One row of a BOUNDED page over the call log — the shape the remote debugging surface
 * reads. It is {@link LlmCallMetric} with the three unbounded text columns replaced by
 * budgeted slices (and the chain hash, which is storage bookkeeping, dropped).
 *
 * It exists alongside {@link LlmCallMetric} rather than replacing it because the two reads
 * genuinely differ: the metrics EXPORT needs whole bodies and the intact delta chain so it
 * can reconstruct full prompts, while a page walked by a remote client must never be able
 * to return more bytes than the caller budgeted for.
 */
export interface LlmCallMetricPage extends Omit<
  LlmCallMetric,
  'promptText' | 'responseText' | 'reasoningText' | 'promptHash'
> {
  /** The messages this call APPENDED (see {@link LlmCallMetric.promptText}), sliced. */
  prompt: LlmCallBodySlice
  response: LlmCallBodySlice
  reasoning: LlmCallBodySlice
}

/** Outcome classes a call page may narrow to, applied in SQL. */
export type LlmCallOutcomeFilter = 'ok' | 'warning' | 'error'

/** A bounded, keyset-paginated query over one run's calls. */
export interface LlmCallPageQuery {
  executionId: string
  /** Narrow to one step kind's conversation. */
  agentKind?: string
  /**
   * Narrow to a single outcome class. `error` is `ok = 0`; `warning` is a successful call
   * whose finish reason is in {@link LLM_WARNING_FINISH_REASONS}; `ok` is the rest.
   */
  outcome?: LlmCallOutcomeFilter
  /**
   * Chronological direction. `newest` (the default) is triage order; `oldest` walks a
   * conversation forwards, which is how a caller reads an agent kind's prompt deltas back
   * into a transcript.
   */
  order?: 'newest' | 'oldest'
  /** Hard cap on rows returned. */
  limit: number
  /**
   * EXCLUSIVE keyset on the `(createdAt, id)` composite the ordering uses — not a bare
   * timestamp, because calls are recorded off the response path and a burst shares a
   * millisecond, which a timestamp-only cursor would silently drop from the next page.
   */
  cursor?: { createdAt: number; id: string }
  /**
   * Per-body slice budget in characters. 0 means the text columns are not read at all (only
   * their `length()`), so a sweep over a long run costs no body bytes.
   */
  bodyChars: number
}

export interface LlmCallMetricRepository {
  /**
   * Append one metered call, IGNORING a call whose {@link LlmCallMetric.id} is already stored.
   *
   * First write wins — never an update. Callers that mint a deterministic id (the harness-call
   * recorder's `<jobId>-hc-<seq>`) deliberately record the same call more than once: live as
   * the harness drains it, again in the job's terminal list, and again on a durable-driver
   * replay. Ignoring the repeat is what makes those paths idempotent. Overwriting instead
   * would corrupt the prompt-delta chain, whose stored delta is only meaningful against the
   * tip that preceded the row when it was FIRST written.
   *
   * Ignore ONLY a duplicate id. A store that also swallows other constraint violations (SQLite's
   * `INSERT OR IGNORE` does) would silently drop a malformed metric on one runtime while the
   * other throws.
   */
  record(metric: LlmCallMetric): Promise<void>
  /**
   * The most recent CHAINABLE call's tip for a `(workspaceId, executionId, agentKind)`
   * conversation, or null when there is none. Lets the sink store the next call's
   * prompt as a delta against this one. Cheap: one indexed row, no text columns.
   *
   * Rows with `messageCount === 0` are EXCLUDED: they carry no re-sendable prompt chain (a
   * subagent call, whose transcript isn't a request transcript), so they can never serve as a
   * tip. They interleave with the parent's calls in record order now that harness telemetry
   * streams live, and treating one as the tip would make every following parent call
   * unchainable — storing its whole prompt instead of a delta.
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
   * `agentKind` narrows to one step kind's calls IN SQL, so the `limit` is spent on
   * that kind's newest calls rather than on the run's other kinds crowding them out.
   */
  listByExecution(
    workspaceId: string,
    executionId: string,
    limit?: number,
    agentKind?: string,
  ): Promise<LlmCallMetric[]>
  /**
   * One BOUNDED, keyset-paginated page of a run's calls with each text body sliced to the
   * query's budget — the read the remote debugging surface walks. Distinct from
   * {@link LlmCallMetricRepository.listByExecution}, which returns whole bodies for the
   * export: this one can never return more bytes than `limit x 3 x bodyChars`, which is what
   * makes it safe to expose to a client that pages through a long run.
   *
   * Every filter (`agentKind`, `outcome`) and the slicing itself are applied IN SQL, so a
   * narrowed or un-previewed page does not read rows (or text columns) it will discard.
   */
  listPage(workspaceId: string, query: LlmCallPageQuery): Promise<LlmCallMetricPage[]>
  /**
   * One call by id, sliced to `bodyChars` (omit for the whole stored bodies). The point read
   * behind a page row, keyed by the call's own id — the page hands the caller that id, so
   * requiring the run id too would only create a mismatched pair that 404s inexplicably.
   * Scoped to the workspace, so a foreign id is indistinguishable from a missing one.
   */
  get(workspaceId: string, id: string, bodyChars?: number): Promise<LlmCallMetricPage | null>
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
