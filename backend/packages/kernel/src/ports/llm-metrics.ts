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
  /**
   * WHICH slice of the run spent this call: the agent's own edit loop (`agent`), a pre-PR
   * validation repair round (`validation-repair`), a reproduction-proof repair round
   * (`reproduction-repair`), … — the axis a per-phase rollup groups by (see
   * `docs/initiatives/token-burn-instrumentation.md`). Carried from the producer that OWNS
   * the boundary (the harness drives those loops itself) and normalised through
   * `normalizeCallPhase`; never reconstructed downstream from timestamps.
   *
   * `''` when nothing could attribute it — a REAL slice of the rollup, not a dropped row.
   */
  phase: string
  /**
   * The call's ordinal within its job's telemetry sequence (0-based), so a rollup can order a
   * phase's calls by TURN without parsing it back out of {@link id}. It is the harness's
   * job-scoped `seq` — the same number the row id is minted from.
   *
   * `null` where the producing channel has no turn concept: the LLM proxy sees one HTTP call
   * at a time with no job-scoped counter, so its rows order by {@link createdAt} instead.
   * Deliberately not faked from a message count — an envelope is not a turn.
   */
  turnIndex: number | null
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
 * The numeric aggregate every rollup grain carries — the run's totals, one agent kind's,
 * one phase's, or one `(agentKind, phase)` cell's. Named apart from
 * {@link LlmCallMetricSummary} because the store computes the FINEST grain once and the
 * coarser ones are folded from it (`domain/llm-rollup.ts`): a second SQL pass per grain
 * would be free to disagree with the breakdown it sits next to.
 */
export interface LlmCallRollupTotals {
  /** Number of calls (turns) recorded in this cell. */
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
  /**
   * CARRY COST proxy, in token-turns: `Σ (this call's total input) × (turns left in its
   * conversation after it)`. It answers the question a plain token sum cannot — how much a
   * phase's context is DRAGGED ALONG by everything that follows it. A phase that loads a
   * large tree early and then hands over is cheap by its own token count and expensive here;
   * a late phase of the same size is the reverse. That contrast is what decides
   * `token-burn-instrumentation` Slice 4's "prefix size dominates" vs "turn count dominates".
   *
   * The conversation, not the run, is the partition: the delta chain is keyed by
   * `(workspace, execution, agentKind)`, so a merger step's turns do not carry a coder step's
   * context and must not be counted as if they did.
   *
   * It is a PROXY, deliberately: it re-counts tokens the model saw once per subsequent turn,
   * which is exactly the re-send it is measuring, so it is comparable BETWEEN phases of a run
   * and meaningless as an absolute. Being a product of two sums it outgrows a 32-bit integer
   * on any real run — every store aggregates it as a 64-bit sum.
   */
  carryCostTokens: number
}

/**
 * One `(agentKind, phase)` cell of a run's model activity — the finest grain the store
 * aggregates, and the only one it computes. Attached to the matching pipeline step for
 * at-a-glance board display (folded up to the kind) and grouped by phase for the burn
 * breakdown (`docs/initiatives/token-burn-instrumentation.md`). Computed by SQL
 * aggregation — it never reads the heavy prompt/response text columns.
 *
 * `phase` is `''` for a call nothing could attribute (an older harness image, an inline
 * call, the un-phased proxy path). That is a REAL cell of the breakdown, never dropped.
 */
export interface LlmCallMetricSummary extends LlmCallRollupTotals {
  agentKind: string
  phase: string
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
  /** `min(budget, remaining)` characters of the stored body, starting at the slice offset. */
  text: string
  /** Full stored length of the body. */
  totalChars: number
  /**
   * 0-based CODE-POINT offset of the first case-insensitive occurrence of the page query's
   * `contains` term in THIS body, or null when the term does not occur here (the row matched
   * via a sibling body). Only set when the query searched — a plain page carries no offsets.
   * Computed in SQL (`instr`/`position`, both of which count characters like `substr` does),
   * so it composes directly with a point read's slice offset: a caller jumps to the match
   * without transferring the bytes before it.
   */
  matchOffset?: number | null
}

/**
 * Escape a literal term for use inside a SQL `LIKE`/`ILIKE` pattern with `\` as the escape
 * character (Postgres' default; SQLite is told via `ESCAPE '\'`). Shared by both runtime
 * stores so a term containing `%`/`_` narrows to the literal text on each, never to a
 * wildcard match on one runtime only.
 */
export function escapeLikePattern(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

/** The slice window a point read applies to each stored body, in code points. */
export interface LlmCallBodyWindow {
  /** Max characters to return per body; omit for the whole body from `offset` on. */
  chars?: number
  /** 0-based code-point offset the slice starts at; omit for 0 (the head). */
  offset?: number
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
   * Narrow to one PHASE's calls (see {@link LlmCallMetric.phase}) — an exact match, applied in
   * SQL like {@link LlmCallPageQuery.agentKind}. `''` is a queryable value, not "no filter": it
   * selects the unattributed slice, which is the only way to ask "what did the un-phased
   * channels spend" without paging the whole run.
   */
  phase?: string
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
  /**
   * Narrow to calls whose prompt delta, response or reasoning contains this literal substring,
   * matched case-insensitively IN SQL — the grep a debugging client roots a stuck tool loop
   * with, collapsed to one indexed-scan query instead of paging every body through the caller.
   * `%`/`_` in the term match literally (escaped via {@link escapeLikePattern}). Case folding
   * is ASCII on SQLite (`LIKE`'s default) and locale-aware on Postgres (`ILIKE`); conformance
   * pins the ASCII behaviour the two share. Matched rows report a per-body
   * {@link LlmCallBodySlice.matchOffset}.
   */
  contains?: string
}

/**
 * A bounded, keyset-paginated query over ONE run's calls returning the rows WHOLE — the
 * mothership-mode READ-THROUGH read (`POST /internal/telemetry/read`,
 * docs/initiatives/mothership-mode.md, PR 5).
 *
 * It is not {@link LlmCallPageQuery} with `bodyChars: Infinity`: that page returns
 * {@link LlmCallMetricPage} rows, whose whole contract is that a body is a SLICE plus the
 * length of what was sliced. The read-through has to reconstitute exactly what a direct
 * repository call would have returned to `listByExecution`, so it needs the stored
 * {@link LlmCallMetric} itself. It is not `listByExecution` either, which takes a row cap and
 * no cursor: a node fetching a long run's calls in one un-resumable response is the bulk read
 * this bucket exists to forbid.
 *
 * Newest-first, like every other read of a run's calls, so a caller that stops early has the
 * rows a reader looks at first.
 */
export interface LlmCallRunPageQuery {
  executionId: string
  /** Narrow to one step kind's conversation, applied in SQL. */
  agentKind?: string
  /** Hard cap on rows returned. */
  limit: number
  /**
   * EXCLUSIVE keyset on the `(createdAt, id)` composite the ordering uses, for the same reason
   * {@link LlmCallPageQuery.cursor} is composite — a same-millisecond burst is routine, and a
   * timestamp-only cursor would silently drop rows from the next page.
   */
  cursor?: { createdAt: number; id: string }
}

/**
 * One completed INLINE (non-proxied) LLM call, as the instrumented model provider observes it.
 *
 * A container agent reaches its model through the LLM proxy (or, on a subscription harness,
 * through the harness's own stream), and both of those producers own a wire boundary that
 * carries facts an inline call simply does not have — a job-scoped turn ordinal, a run phase,
 * an HTTP status, a transport-vs-model latency split. So this is a deliberately NARROWER shape
 * than {@link LlmCallMetric}: it states only what a direct AI-SDK call can honestly report, and
 * the layer that adapts it onto the store fills the rest with the values that mean "not
 * applicable" rather than inventing them.
 *
 * `workspaceId` is REQUIRED here even though the inline observability tag makes it optional:
 * the metric store is workspace-scoped, so an untagged call has nowhere to land. That is a
 * reason for a caller to tag its call, not for this port to widen — the provider keeps such a
 * call on the trace-sink path instead of recording an unattributable row.
 */
export interface InlineLlmCall {
  workspaceId: string
  /** The run this call belongs to, or null for a one-shot call outside a run. */
  executionId: string | null
  /** The call site (`doc-researcher`, `requirements-writer`, `sandbox:judge`, …). */
  agentKind: string
  provider: string
  model: string
  /** Number of chat messages in the request. */
  messageCount: number
  /** Number of tools offered in the request (0 = the model can't call anything). */
  toolCount: number
  /** The output ceiling the request asked for, or null when it named none. */
  requestMaxTokens: number | null
  /**
   * This call's ordinal within the ONE inline step that produced it, or absent where there is
   * no turn concept to report.
   *
   * A plain `generateText` is one call and has none — it omits this, and the row stores
   * `turn_index` NULL so it orders by `createdAt` exactly like a proxied row. An inline step
   * served by a HARNESS CLI is the case that has one: the CLI runs a whole tool loop behind a
   * single SDK call and reports each model call it made, so those rows carry the ordinal the
   * stream gave them. Never faked from a message count — an envelope is not a turn.
   */
  turnIndex?: number
  /** FRESH (uncached) input tokens — exclusive of both cache classes. */
  promptTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  completionTokens: number
  totalTokens: number
  finishReason: string | null
  /**
   * Wall-clock the SDK call took (ms). ONE number, not the proxy path's `totalMs`/`upstreamMs`
   * pair: an inline call has no proxy hop between the caller and the model, so there is no
   * transport overhead to split out and a second field could only ever restate this one.
   */
  durationMs: number
  ok: boolean
  errorMessage: string | null
  /**
   * The request messages serialised as JSON (the FULL prompt — the store owns the delta).
   *
   * A THUNK, not a string, because every body here sits behind the recorder's
   * `LLM_RECORD_PROMPTS` + `storeAgentContext` gate and the caller cannot see that gate — the
   * whole point of {@link InlineLlmCallRecorder} owning it is that the rule lives in one
   * place. Handing over the work instead of the result lets a deployment with recording off
   * skip serialising an AI-SDK prompt array (on a judge or a reviewer: a rubric and a diff)
   * that would be dropped on the next line, without the caller having to know why.
   */
  promptText: InlineLlmCallBody
  responseText: InlineLlmCallBody
  /** The model's reasoning trace when it arrived on a separate channel, else ''. */
  reasoningText: InlineLlmCallBody
}

/**
 * One prompt/response/reasoning body of an inline call, resolved by the recorder ONLY when the
 * body gate says it will be kept. Never called more than once per body.
 */
export type InlineLlmCallBody = () => string

/**
 * Persist one inline LLM call into the same store the proxy and the subscription harnesses
 * write to, so `ObservabilityPanel`, the per-step rollups and the `/api/v1/debug/*` surface
 * see judge / consensus / inline-agent-kind calls alongside container ones.
 *
 * Implemented by the orchestration `LlmObservabilityService` (via `makeInlineCallRecorder`),
 * which owns secret scrubbing, the `LLM_RECORD_PROMPTS` + per-workspace `storeAgentContext`
 * body gate, the prompt delta chain AND the external trace-sink fan-out. That last one is why
 * a provider wired with a recorder must NOT also emit to a trace sink for the same call: the
 * recorder's own fan-out is the emit, and doing both would double every inline generation.
 *
 * MUST NOT throw into its caller — observability never breaks LLM work.
 */
export type InlineLlmCallRecorder = (call: InlineLlmCall) => Promise<void>

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
   * Append a BATCH of metered calls in one round trip, ignoring any whose id is already
   * stored. Same first-write-wins semantics as {@link LlmCallMetricRepository.record}, and
   * the same "only a duplicate id is ignored" rule — a batch must not become the one place a
   * malformed row is silently dropped.
   *
   * This exists for the mothership-mode telemetry INGEST (`POST /internal/telemetry/ingest`,
   * docs/initiatives/mothership-mode.md, PR 5), which uploads a finished run's locally
   * captured calls. Looping {@link LlmCallMetricRepository.record} over that batch would be
   * the banned N+1 write; a store implements this as one chunked multi-row insert.
   *
   * An empty batch is a no-op, not an error — the ingest drains until a page comes back empty.
   */
  recordMany(metrics: LlmCallMetric[]): Promise<void>
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
   * One BOUNDED, keyset-paginated page of a run's calls with the bodies WHOLE — the read the
   * mothership-mode read-through walks (see {@link LlmCallRunPageQuery} for why neither
   * {@link LlmCallMetricRepository.listPage} nor
   * {@link LlmCallMetricRepository.listByExecution} can serve it).
   */
  listRunPage(workspaceId: string, query: LlmCallRunPageQuery): Promise<LlmCallMetric[]>
  /**
   * One call by id, each body sliced to the window (omit for the whole stored bodies). The
   * window's `offset` is what makes the TAIL of a large body reachable — the last tool result
   * in a long delta, the end of a build log — without transferring the bytes before it; the
   * slice happens in SQL (`substr(col, offset + 1, chars)`), like the page's.
   * Keyed by the call's own id — the page hands the caller that id, so requiring the run id
   * too would only create a mismatched pair that 404s inexplicably. Scoped to the workspace,
   * so a foreign id is indistinguishable from a missing one.
   */
  get(workspaceId: string, id: string, body?: LlmCallBodyWindow): Promise<LlmCallMetricPage | null>
  /**
   * Per-`(agentKind, phase)` aggregates for a run — the board rollups AND the per-phase
   * burn breakdown, from ONE `GROUP BY`. Aggregates in SQL and deliberately selects no text
   * columns, so it is cheap to run on every emit.
   *
   * It returns the FINEST grain rather than one shape per consumer: the coarser views (a
   * step's per-kind rollup, the run's per-phase breakdown, the run totals) are pure folds
   * over this result (`domain/llm-rollup.ts`). A second aggregate per grain would double the
   * cost of an emit and could only ever disagree with the breakdown beside it.
   */
  summarizeByExecution(workspaceId: string, executionId: string): Promise<LlmCallMetricSummary[]>
  /**
   * Retention: delete rows older than `epochMs` (exclusive), returning how many
   * were removed. The full request/response bodies make this table heavy, so it is
   * pruned to a configured window alongside the other unbounded tables.
   */
  deleteOlderThan(epochMs: number): Promise<number>
}
