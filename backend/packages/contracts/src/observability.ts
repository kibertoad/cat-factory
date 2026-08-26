import * as v from 'valibot'
import { webSearchProviderSchema } from './execution.js'

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
  /**
   * Which slice of the run spent the call (`agent` / `validation-repair` /
   * `reproduction-repair` / …), carried from the producer that owns the phase boundary.
   * `''` = nothing could attribute it, which is a real slice rather than a hidden one.
   * Optional/defaulted so exports predating the phase axis still parse.
   */
  phase: v.optional(v.string(), ''),
  /**
   * The call's 0-based ordinal within its job's telemetry sequence, or null where the
   * producing channel has no turn concept (the proxy, which orders by `createdAt`).
   */
  turnIndex: v.optional(v.nullable(v.number()), null),
  /**
   * TRUE when the row carries only TOKENS and stands for no model call: the shortfall a harness CLI
   * leaves when it costs each turn's input but not its output, filed as its own row so a measured
   * turn is never inflated by tokens it did not produce.
   *
   * The SPA has to agree with the engine about this or the two disagree in public: the step rollup
   * counts calls without these rows, so a panel that lists them unmarked shows one more call than
   * the card beside it and nothing accounts for the difference. `turnIndex` cannot stand in: a
   * plain inline call is null there too. Optional/defaulted so an export predating the flag parses,
   * and false is the right default for every other producer.
   */
  spendOnly: v.optional(v.boolean(), false),
  messageCount: v.number(),
  /** Tools offered to the model (0 = the agent could not edit anything). */
  toolCount: v.number(),
  /** The `max_tokens` the request asked for (the output ceiling), or null. */
  requestMaxTokens: v.nullable(v.number()),
  /**
   * FRESH input tokens: the prompt the model processed from scratch, exclusive of both
   * cache classes. Total input = `promptTokens + cacheReadTokens + cacheWriteTokens`.
   */
  promptTokens: v.number(),
  /** Input tokens served from the provider's prefix cache (~0.1× base input). */
  cacheReadTokens: v.optional(v.number(), 0),
  /** Input tokens written INTO the cache this call (1.25–2× base input — dearer than fresh). */
  cacheWriteTokens: v.optional(v.number(), 0),
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
 * Upstream finish reasons that are not failures but warrant a warning: the model was cut short
 * by the output limit, or filtered.
 *
 * Lives HERE rather than in kernel (which re-exports it, so its SQL aggregations and the debug
 * surface's `?outcome=` predicate are unaffected) because the SPA has to make the same
 * judgement: the observability panel badges a call's outcome AND now filters the list by it, and
 * the SPA cannot see kernel. A hand-copied list on the frontend was already there, and the
 * moment the copy decides which rows a filter HIDES, drift stops being a wrong badge colour and
 * becomes calls the operator is told do not exist.
 */
export const LLM_WARNING_FINISH_REASONS = ['length', 'content_filter'] as const

/**
 * How one recorded model call turned out: THE outcome vocabulary, in the one place every layer
 * can see it.
 *
 * Four copies of this picklist existed before it landed here: kernel's `LlmCallOutcomeFilter`
 * (what a page may narrow to), the orchestration classifier's own union, `debugCallOutcomeSchema`
 * on the wire, and a hand-written list in the SPA. All four now derive from this one, because
 * the members are not merely a shared spelling: each store turns them into a SQL predicate and
 * the panel turns them into a filter, so a member that exists in one copy and not another is
 * rows an operator is told do not exist.
 */
export const llmCallOutcomeSchema = v.picklist(['ok', 'warning', 'error'])
export type LlmCallOutcome = v.InferOutput<typeof llmCallOutcomeSchema>

/**
 * Classify one call: `error` is a call that failed outright, `warning` a call that SUCCEEDED but
 * came back cut short or filtered, `ok` the rest.
 *
 * The two are kept apart because they need different fixes (a failed call is transport, proxy
 * or spend-gate trouble, while a truncated one is an output-limit or task-size conversation),
 * and collapsing them into one "not ok" bucket is what made the truncated calls invisible in the
 * summary they were already counted in.
 *
 * This is the ONLY implementation of the rule. The backend classified through its own copy in
 * `observability.logic.ts` and the SPA through a third, which is the arrangement that decides a
 * badge colour harmlessly right up to the day it decides which rows a filter hides.
 */
export function classifyLlmCallOutcome(call: {
  ok: boolean
  finishReason: string | null
}): LlmCallOutcome {
  if (!call.ok) return 'error'
  return isLlmWarningFinishReason(call.finishReason) ? 'warning' : 'ok'
}

/** Whether a finish reason is one of {@link LLM_WARNING_FINISH_REASONS}. */
export function isLlmWarningFinishReason(finishReason: string | null | undefined): boolean {
  return (
    finishReason != null && (LLM_WARNING_FINISH_REASONS as readonly string[]).includes(finishReason)
  )
}

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
  /**
   * The run phase that spent the call. Always supplied by the proxy emit (`''` when the
   * request carried no phase segment), so it is required here — the live row and the row the
   * panel later loads from the store must agree on the axis they are grouped by.
   */
  phase: v.string(),
  messageCount: v.number(),
  toolCount: v.number(),
  requestMaxTokens: v.nullable(v.number()),
  promptTokens: v.number(),
  // Always supplied by the proxy emit (unlike the persisted metric, which defaults them
  // for rows that predate delta storage), so they are required here — matching the SPA's
  // `LlmCallActivity` type, which derives them as required fields from `LlmCallMetric`.
  cacheReadTokens: v.number(),
  cacheWriteTokens: v.number(),
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
  /** Fresh (uncached) input tokens. */
  promptTokens: v.number(),
  /** Input tokens served from the prefix cache. */
  cacheReadTokens: v.number(),
  /** Input tokens written into the cache. */
  cacheWriteTokens: v.number(),
  /** (read + write) / (prompt + read + write), 0..1; null when there was no input at all. */
  cacheHitRate: v.nullable(v.number()),
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
  /**
   * Estimated money these tokens cost, in the run overview's `costCurrency`, priced per input
   * CLASS (a cache read at ~0.1x fresh input, a cache write at ~1.25x). A LIST-PRICE estimate,
   * not a bill: a subscription-harness run spent no per-token money and this reports what the
   * same tokens would have cost metered.
   *
   * `null` ⇒ the deployment could not price it (no rate for that model, or no price table
   * wired). Never `0` for that case, which would claim the work was free — and never a partial
   * sum: a total containing one unpriceable cell reports null rather than a smaller number
   * that looks complete.
   */
  costEstimate: v.nullable(v.number()),
})
export type LlmExportInsight = v.InferOutput<typeof llmExportInsightSchema>

/**
 * Run-wide totals over every recorded call, with the same derived ratios the per-agent
 * insights carry. Named (rather than inlined in the export below) because the remote
 * debugging surface's run overview reports exactly these numbers — folded from the same
 * SQL rollup — and a second, hand-copied totals shape would be free to drift from it.
 */
export const llmExportTotalsSchema = v.object({
  calls: v.number(),
  /** Fresh (uncached) input tokens. */
  promptTokens: v.number(),
  /** Input tokens served from the prefix cache. */
  cacheReadTokens: v.number(),
  /** Input tokens written into the cache. */
  cacheWriteTokens: v.number(),
  /** (read + write) / (prompt + read + write), 0..1; null when there was no input at all. */
  cacheHitRate: v.nullable(v.number()),
  completionTokens: v.number(),
  upstreamMs: v.number(),
  overheadMs: v.number(),
  /** Share of total latency spent in transport/proxy (0..1), or null with no timing. */
  transportOverheadRatio: v.nullable(v.number()),
  errors: v.number(),
  warnings: v.number(),
  truncatedCalls: v.number(),
  /**
   * Estimated money these tokens cost, in the run overview's `costCurrency`, priced per input
   * CLASS (a cache read at ~0.1x fresh input, a cache write at ~1.25x). A LIST-PRICE estimate,
   * not a bill: a subscription-harness run spent no per-token money and this reports what the
   * same tokens would have cost metered.
   *
   * `null` ⇒ the deployment could not price it (no rate for that model, or no price table
   * wired). Never `0` for that case, which would claim the work was free — and never a partial
   * sum: a total containing one unpriceable cell reports null rather than a smaller number
   * that looks complete.
   */
  costEstimate: v.nullable(v.number()),
})
export type LlmExportTotals = v.InferOutput<typeof llmExportTotalsSchema>

/**
 * One PHASE's slice of a run's model activity — the burn breakdown
 * (`docs/initiatives/token-burn-instrumentation.md`). Deliberately a SEPARATE shape from
 * {@link llmExportInsightSchema} rather than that shape with the key swapped: a phase has no
 * output ceiling of its own to report headroom against (a phase spans whatever requests its
 * loop made), and it carries the one figure only this axis can produce — the carry cost.
 */
export const llmPhaseInsightSchema = v.object({
  /**
   * The phase label, or `''` for the UNATTRIBUTED slice (an older harness image, an inline
   * call, the un-phased proxy path). A real row, never omitted: dropping it would under-report
   * the run while the table still looked complete.
   */
  phase: v.string(),
  /** Model calls (turns) spent in this phase. */
  calls: v.number(),
  /** Fresh (uncached) input tokens. */
  promptTokens: v.number(),
  /** Input tokens served from the prefix cache. */
  cacheReadTokens: v.number(),
  /** Input tokens written into the cache. */
  cacheWriteTokens: v.number(),
  /** (read + write) / (prompt + read + write), 0..1; null when there was no input at all. */
  cacheHitRate: v.nullable(v.number()),
  completionTokens: v.number(),
  /**
   * Carry-cost proxy in token-turns: `Σ (a call's total input) x (turns left in its
   * conversation after it)`. What a plain token sum cannot say — how much of the run's cost
   * this phase INFLICTED on the turns that followed it, rather than merely spent itself.
   * Compare phases of one run against each other; the absolute number means nothing.
   */
  carryCostTokens: v.number(),
  /**
   * Share of the run's total carry cost this phase accounts for, 0..1. Null only when the RUN
   * carried nothing (a single-turn conversation charges no carry cost at all, so the share has
   * no denominator); a phase that itself carried nothing inside a run that did reports `0`.
   */
  carryCostShare: v.nullable(v.number()),
  upstreamMs: v.number(),
  overheadMs: v.number(),
  errors: v.number(),
  warnings: v.number(),
  truncatedCalls: v.number(),
  /**
   * Estimated money these tokens cost, in the run overview's `costCurrency`, priced per input
   * CLASS (a cache read at ~0.1x fresh input, a cache write at ~1.25x). A LIST-PRICE estimate,
   * not a bill: a subscription-harness run spent no per-token money and this reports what the
   * same tokens would have cost metered.
   *
   * `null` ⇒ the deployment could not price it (no rate for that model, or no price table
   * wired). Never `0` for that case, which would claim the work was free — and never a partial
   * sum: a total containing one unpriceable cell reports null rather than a smaller number
   * that looks complete.
   */
  costEstimate: v.nullable(v.number()),
})
export type LlmPhaseInsight = v.InferOutput<typeof llmPhaseInsightSchema>

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
  totals: llmExportTotalsSchema,
  insights: v.array(llmExportInsightSchema),
  calls: v.array(llmCallMetricSchema),
  /**
   * True when the run had more calls than the export's row cap, so `calls` (and every figure
   * folded from it) covers only the newest slice.
   *
   * Stated rather than left to be inferred from `calls.length`: a reader who does not know the
   * cap cannot tell a complete bundle from a truncated one, and a bundle handed to a model for
   * "why did this run spend so much?" is exactly where a partial total gets quoted as a whole.
   * The money figures decline to answer at all when this is true (`costEstimate` is null);
   * the token counts remain the partial sums they always were, now labelled as such.
   */
  truncated: v.boolean(),
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
  /**
   * The file body as written into the container, secret-scrubbed before storage. A
   * secret-shaped file (`.env`, `*.pem`, an SSH key, …) has its whole body replaced by a
   * placeholder rather than stored; any other body is passed through the shape scrubber.
   */
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
  /** The files injected into the container as context, with secret-scrubbed content. */
  contextFiles: v.array(agentContextFileSchema),
  /**
   * Redacted structural bits useful for debugging — repo owner/name/branches, the
   * web-search flag, the infra spec, the run's decisions and revision feedback. Deep
   * secret-scrubbed before storage (the free-text values, e.g. decisions/feedback, may
   * embed a token), so it never carries a token, secret, or credential-bearing URL.
   */
  extras: v.record(v.string(), v.unknown()),
})
export type AgentContextSnapshot = v.InferOutput<typeof agentContextSnapshotSchema>

// ---------------------------------------------------------------------------
// Agent-search-query observability: one row per web search a container agent
// performed through the backend search proxy. Recorded best-effort, gated by the
// same double switch as agent-context snapshots (the deployment `LLM_RECORD_PROMPTS`
// AND the per-workspace `storeAgentContext` setting), and pruned on the same
// telemetry retention window. Surfaced on demand in the observability drill-down.
// ---------------------------------------------------------------------------

/** One web search a container agent performed during a run, via the search proxy. */
export const agentSearchQuerySchema = v.object({
  id: v.string(),
  workspaceId: v.string(),
  /** The run this search belongs to. */
  executionId: v.string(),
  /** The agent kind that issued the search (`coder`, `ci-fixer`, …). */
  agentKind: v.string(),
  /** The upstream backend that served the search, or null when it couldn't be resolved. */
  provider: v.nullable(webSearchProviderSchema),
  /** The search query text as issued to the upstream. */
  query: v.string(),
  /** How many results the upstream returned (0 on an upstream failure). */
  resultCount: v.number(),
  /** When the search was performed (epoch ms). */
  createdAt: v.number(),
})
export type AgentSearchQuery = v.InferOutput<typeof agentSearchQuerySchema>

// ---------------------------------------------------------------------------
// Tool-call trajectory: one row per tool invocation inside an agent's loop, in the
// order the agent made them. Where `agent_context_snapshots` keeps what an agent was
// GIVEN and `llm_call_metrics` what each model call cost, this keeps what the agent
// DID with it — the "how" behind a diff, which was previously reconstructible only by
// diffing consecutive prompts against each other.
//
// Bodies (`args`/`result`) ride the same double gate as the other two body-bearing
// sinks (deployment `LLM_RECORD_PROMPTS` AND the per-workspace `storeAgentContext`),
// which is why {@link agentToolCallSchema.bodies} exists: a withheld body and a tool
// that genuinely took no arguments are different facts and must not render alike.
// ---------------------------------------------------------------------------

/**
 * Why a tool call's `args`/`result` are empty.
 *
 * `stored` ⇒ the bodies were captured, so an empty one means the call really carried
 * nothing. `withheld` ⇒ recording was off (deployment switch or workspace opt-out) or
 * the producing harness image predates body capture, so nothing can be concluded from
 * the empty strings. The distinction is the whole point of the field: without it an
 * opted-out workspace's trajectory reads as a run whose every tool took no arguments.
 */
export const toolCallBodiesStateSchema = v.picklist(['stored', 'withheld'])
export type ToolCallBodiesState = v.InferOutput<typeof toolCallBodiesStateSchema>

/**
 * Which tool calls a trajectory read is narrowed to.
 *
 * Two members rather than the model call's three ({@link debugCallOutcomeSchema} in
 * `debug-api.ts` also has `warning`): a tool either reported success or it did not, and there
 * is no finish reason in between. Kept a picklist rather than a boolean because it rides a
 * QUERY STRING, where `ok=false` and `ok=` and an absent `ok` are three spellings a reader has
 * to hold apart, and only the absent one means "no filter".
 *
 * A tool-EXECUTION error is the failure class no LLM rollup can see: the model call that asked
 * for it still reports `ok` with a clean finish reason, so a run whose edit loop is stuck on a
 * failing tool reads as perfectly healthy telemetry right up to the moment it dies. Narrowing
 * to `error` is what turns that from a walk of the whole trajectory into one request.
 */
export const toolCallOutcomeSchema = v.picklist(['ok', 'error'])
export type ToolCallOutcome = v.InferOutput<typeof toolCallOutcomeSchema>

/** One tool invocation an agent made during a run, in trajectory order. */
export const agentToolCallSchema = v.object({
  id: v.string(),
  workspaceId: v.string(),
  /** The run this call belongs to. */
  executionId: v.string(),
  /** The agent kind whose loop made the call (`coder`, `ci-fixer`, …). */
  agentKind: v.string(),
  /**
   * The dispatch (container job) the call was made in. One run's step can dispatch more
   * than once (a re-run, a gate's fixer rounds, a Ralph iteration), so this is what
   * narrows a read to ONE of them. It is NOT a sort key: a job id is a string
   * (`<executionId>-<agentKind>`, plus `-<epoch>` past the first dispatch), so ordering by
   * it sorts a run's dispatches by agent-kind spelling and its re-runs `-10` before `-2`.
   * The trajectory orders by `(startedAt, seq, id)` server-side; see the
   * `AgentToolCallRepository.listByExecution` contract in kernel.
   */
  jobId: v.string(),
  /**
   * The call's 0-based ordinal within its dispatch. It restarts at zero on every dispatch,
   * so it separates the calls sharing a {@link startedAt} millisecond rather than ordering
   * the run on its own.
   */
  seq: v.number(),
  /** The tool the agent invoked (`edit_file`, `bash`, `todo`, …). */
  tool: v.string(),
  /** Epoch ms the tool call started. */
  startedAt: v.number(),
  /** Epoch ms the tool call ended. */
  endedAt: v.number(),
  /** Whether the tool reported success (a failing call is kept: a stall is a trajectory). */
  ok: v.boolean(),
  /** Whether {@link args}/{@link result} were captured at all. */
  bodies: toolCallBodiesStateSchema,
  /**
   * The tool's arguments as the agent supplied them, secret-scrubbed and capped at
   * capture time. Serialised JSON for a structured tool call; `''` when `bodies` is
   * `withheld`, or when the call genuinely took none.
   */
  args: v.string(),
  /**
   * What the tool returned, secret-scrubbed and capped at capture time. `''` when
   * `bodies` is `withheld`, or when the tool returned nothing.
   */
  result: v.string(),
  /**
   * Characters dropped from {@link args} and {@link result} by the capture cap, so a
   * reader can tell a short command from the head of a long one. 0 when nothing was cut.
   */
  argsDropped: v.number(),
  resultDropped: v.number(),
  /** When the call was recorded (epoch ms) — the keyset the pages order by. */
  createdAt: v.number(),
})
export type AgentToolCall = v.InferOutput<typeof agentToolCallSchema>

// ---------------------------------------------------------------------------
// Platform-operator observability: deployment-level aggregate health, the dual of
// the per-run detail above. Where the schemas above describe ONE run, these describe
// the WHOLE deployment (scoped to an account) over a time window — run outcomes,
// failure taxonomy, live/parked depth, duration stats + a bucketed trend. Every
// number is a SQL rollup over `agent_runs` behind the kernel `PlatformMetricsRepository`
// port; this schema is the wire projection the admin dashboard renders.
// ---------------------------------------------------------------------------

/**
 * The time window the dashboard aggregates over. `1h`/`24h`/`7d` are scanned live off
 * `agent_runs`; `30d`/`90d` are served from the DAILY ROLLUP table the retention sweep
 * materialises, because a fine-grained scan over a quarter of run history is exactly the
 * "load rows and reduce" cost the rollup exists to avoid. Which source answered is carried
 * on the projection ({@link platformTrendSourceSchema}) rather than left to be inferred.
 *
 * The rollup-backed windows are INCLUSIVE of the day their start falls in, so a `30d` window
 * covers 30 or 31 calendar days depending on the time of day it is read, where the live windows
 * are exact to the millisecond. A day is the smallest bucket that table can answer, and dropping
 * the partial oldest day would under-report it by more than including it over-reports; `since`
 * on the projection is still the exact window start, so a reader is never told otherwise.
 */
export const platformObservabilityWindowSchema = v.picklist(['1h', '24h', '7d', '30d', '90d'])
export type PlatformObservabilityWindow = v.InferOutput<typeof platformObservabilityWindowSchema>

/**
 * Where a window's outcome totals, trend and failure taxonomy came from: a live scan of
 * `agent_runs` (`runs`) or the daily rollup table (`daily-rollup`). Reported rather than
 * derived from the window, so a reader never has to know the routing table to know what it
 * is looking at, and so a rollup that has not run yet reads as missing data rather than as
 * a quiet deployment (see `rolledUpThrough`).
 */
export const platformTrendSourceSchema = v.picklist(['runs', 'daily-rollup'])
export type PlatformTrendSource = v.InferOutput<typeof platformTrendSourceSchema>

/** Run-outcome totals over the window (each a status bucket, plus the derived success rate). */
export const platformOutcomeTotalsSchema = v.object({
  /** All runs created in the window. */
  total: v.number(),
  done: v.number(),
  failed: v.number(),
  running: v.number(),
  blocked: v.number(),
  paused: v.number(),
  /** Anything not one of the above (e.g. `pending`). */
  other: v.number(),
  /** `done / (done + failed)`, 0..1; null when no run reached a terminal outcome. */
  successRate: v.nullable(v.number()),
})
export type PlatformOutcomeTotals = v.InferOutput<typeof platformOutcomeTotalsSchema>

/** One contiguous time bucket of the outcome trend (zero-filled, oldest first). */
export const platformTrendPointSchema = v.object({
  /** Epoch-ms start of the bucket. */
  start: v.number(),
  done: v.number(),
  failed: v.number(),
  /** Every other status in the bucket (running/blocked/paused/pending). */
  other: v.number(),
})
export type PlatformTrendPoint = v.InferOutput<typeof platformTrendPointSchema>

/** One failure-kind slice of the failed-run taxonomy. */
export const platformFailureSliceSchema = v.object({
  /** The `agentFailureKind` (or `unknown`); kept as a string so an out-of-enum value still renders. */
  kind: v.string(),
  count: v.number(),
})
export type PlatformFailureSlice = v.InferOutput<typeof platformFailureSliceSchema>

/**
 * One gate kind's attempt statistics over the window: the operator view of the
 * precheck-or-escalate loop that `ci` / `conflicts` / `post-release-health` (and a
 * deployment's own gates) run. Folded from the `gate_outcomes` projection, one row of which
 * is written when a gate SETTLES; the per-round detail stays on the run's `step.gate`.
 *
 * The numbers answer three different operator questions that a bare attempt count conflates:
 * how often the gate is satisfied with nothing spun up ({@link cleanPasses}, the whole point
 * of a precheck-first gate), how much helper-agent work the deployment is spending
 * ({@link attempts}), and how often that work runs out without fixing anything
 * ({@link exhausted}, the human hand-off).
 */
export const platformGateStatSchema = v.object({
  /** The gate step's agent kind (`ci` / `conflicts` / `post-release-health` / a custom one). */
  gateKind: v.string(),
  /** The helper agent this gate escalates to (`ci-fixer` / …), or null when it has none. */
  helperKind: v.nullable(v.string()),
  /** Gate steps that reached a terminal verdict in the window. */
  gates: v.number(),
  /** Of those, how many the precheck ultimately passed. */
  passed: v.number(),
  /** Of those, how many spent the attempt budget and handed off to a human. */
  exhausted: v.number(),
  /**
   * Gates that passed WITHOUT dispatching a helper at all. Reported separately from
   * {@link passed} because "the gate was green on the first look" and "the fixer got it green
   * on the third try" are the same `passed` and completely different platform health.
   */
  cleanPasses: v.number(),
  /** Helper-agent dispatches across every gate of this kind (the CI-fixer attempt count). */
  attempts: v.number(),
  /**
   * Helper dispatches whose own job FAILED (as opposed to finishing and leaving the precheck
   * still red). Kept apart because a fixer that keeps crashing is a platform fault, while a
   * fixer that runs clean and cannot fix the build is a product one.
   */
  helperFailures: v.number(),
})
export type PlatformGateStat = v.InferOutput<typeof platformGateStatSchema>

/** The complete deployment-health projection the admin dashboard renders. */
export const platformObservabilitySchema = v.object({
  window: platformObservabilityWindowSchema,
  /** When the projection was computed (epoch ms). */
  generatedAt: v.number(),
  /** Start of the window (epoch ms) — `generatedAt - window`. */
  since: v.number(),
  outcomes: platformOutcomeTotalsSchema,
  /**
   * Which store answered the outcome totals, trend and failure taxonomy for this window.
   * `runs` = a live scan of `agent_runs`; `daily-rollup` = the pre-aggregated daily table.
   */
  source: platformTrendSourceSchema,
  /**
   * On a `daily-rollup` window: the newest day (epoch ms, UTC midnight) the rollup SWEEP has
   * covered, or NULL when no pass has ever completed.
   *
   * Null is the whole reason this field exists. A rollup that has never run and a deployment
   * that has never run anything both produce an empty series, and only one of them is a fact
   * about the platform, so the reader is told which, rather than being shown 90 days of
   * confident zeros. A value well behind `generatedAt` says the same thing more quietly: the
   * sweep is behind, and the tail of the window is not missing work but missing data.
   * Always null on a `runs` window, where there is no rollup in the path to be behind.
   *
   * It is the SWEEP's recorded coverage, not the newest rolled-up row, and DEPLOYMENT-wide
   * rather than per account. Deriving it from the rows cannot support either reading above: an
   * account idle for a fortnight and a wedged pass share a newest row, and an account created
   * yesterday and a rollup that never ran share an absence. Both pairs call for opposite
   * operator responses, so the number has to come from the thing being asked about.
   */
  rolledUpThrough: v.nullable(v.number()),
  trend: v.object({
    /** Width of each trend bucket (ms). */
    bucketMs: v.number(),
    points: v.array(platformTrendPointSchema),
  }),
  /** Failure taxonomy over the window, most frequent first. */
  failures: v.array(platformFailureSliceSchema),
  /**
   * Gate attempt statistics over the window, busiest gate first. Always a live read of the
   * `gate_outcomes` projection (it is small and not rolled up), so it is present on every
   * window; EMPTY means no gate settled in the window, which on a `daily-rollup` window may
   * simply mean the gate projection does not reach that far back.
   */
  gates: v.array(platformGateStatSchema),
  /** Live/parked run depth right now (a snapshot, not windowed). */
  live: v.object({
    running: v.number(),
    blocked: v.number(),
    paused: v.number(),
    pending: v.number(),
  }),
  /** Wall-clock duration over terminal runs in the window (ms). */
  durations: v.object({
    count: v.number(),
    avgMs: v.nullable(v.number()),
    minMs: v.nullable(v.number()),
    maxMs: v.nullable(v.number()),
    /**
     * Discrete (nearest-rank) duration percentiles (ms), null when no terminal runs. The
     * median plus the tail percentiles that expose slow-run outliers the average hides.
     */
    p50Ms: v.nullable(v.number()),
    p90Ms: v.nullable(v.number()),
    p99Ms: v.nullable(v.number()),
  }),
})
export type PlatformObservability = v.InferOutput<typeof platformObservabilitySchema>

// ---------------------------------------------------------------------------
// Platform-health alerting: the PUSH counterpart to the pull dashboard above. A
// periodic sweep evaluates the SAME {@link platformObservabilitySchema} projection per
// account against operator-configured thresholds and, when one is crossed, raises a
// `platform_health` notification (the dual of the `post-release-health` gate, which
// watches the USER's release — this watches the platform itself). These schemas are the
// machine-readable vocabulary the sweep emits: the reason set is the card's dedup identity,
// and it is carried on the notification payload so a future SPA mapping can localize the
// alert text (the `usePipelineErrorToast` pattern). Today the inbox renders the card's
// backend-composed title/body like every other notification type.
// ---------------------------------------------------------------------------

/**
 * Why a platform-health alert fired — a closed set of machine-readable reason codes. It is the
 * card's stable dedup identity AND the seam for a future localized rendering (the
 * `usePipelineErrorToast` pattern: the backend emits the code, the SPA maps it to i18n copy).
 * Each names one threshold over the account's windowed aggregate:
 *   - `failure_rate_high` — the run failure rate over the window exceeded the ceiling
 *                           (gated by a minimum terminal-run sample so a 1/1 blip is quiet).
 *   - `duration_p99_high` — the p99 wall-clock run duration exceeded the ceiling (a slow-run
 *                           tail the average hides).
 *   - `backlog_high`      — the live running/blocked/paused/pending depth exceeded the ceiling.
 *   - `throughput_stalled` — NO runs were created in the recent part of the window, while the
 *                           earlier part of the same window was busy. The condition that
 *                           exists because every other one reads a RATIO or a PERCENTILE over
 *                           runs, and all of them go silent at `total = 0` — so a deployment
 *                           that stopped accepting work entirely (a wedged queue, a dead
 *                           admission path, an expired credential) looked byte-for-byte
 *                           identical to a quiet healthy one.
 *   - `failure_kind_dominant` — one failure kind accounts for nearly all failures. 100%
 *                           `evicted` and 100% `agent` are the same `failure_rate_high` and
 *                           completely different incidents — infrastructure versus the model
 *                           — so the dominant kind is its own signal rather than a detail
 *                           buried in the dashboard.
 *   - `failure_kind_rate_high` — a NAMED failure kind crossed the ceiling an operator set for
 *                           that kind specifically (see {@link platformFailureKindRuleSchema}).
 *                           The dominant condition answers "is one cause swamping everything",
 *                           which no single ceiling can express for a kind that matters at 5%
 *                           and one that is routine at 40%: an eviction rate that never
 *                           approaches dominance is still the substrate failing, while a
 *                           `rejected` share of the same size is the product working as
 *                           designed. Which kinds carry a rule, and where each sits, is the
 *                           operator's judgement, so it is configuration rather than a
 *                           threshold the platform picks.
 *   - `sweep_degraded`    — a background sweeper has been failing repeatedly. Alerting on the
 *                           WATCHER, because a sweep that stopped running makes every signal
 *                           above stale without making any of them fire.
 */
export const platformAlertReasonSchema = v.picklist([
  'failure_rate_high',
  'duration_p99_high',
  'backlog_high',
  'throughput_stalled',
  'failure_kind_dominant',
  'failure_kind_rate_high',
  'sweep_degraded',
])
export type PlatformAlertReason = v.InferOutput<typeof platformAlertReasonSchema>

/**
 * The windows the ALERT sweep may evaluate over: the live-scanned subset of
 * {@link platformObservabilityWindowSchema}. The rollup-backed `30d`/`90d` windows are
 * deliberately excluded: an alert is a statement about NOW, and a threshold averaged over a
 * quarter answers a question nobody pages on, while riding a table that is materialised at
 * best hourly.
 */
export const platformAlertWindowSchema = v.picklist(['1h', '24h', '7d'])
export type PlatformAlertWindow = v.InferOutput<typeof platformAlertWindowSchema>

/**
 * One PER-KIND alert rule: "page when `evicted` accounts for more than X% of the window's
 * failures". The generalisation of `failure_kind_dominant`, which is one ceiling applied to
 * whichever kind happens to be largest, into a ceiling an operator sets per kind.
 *
 * The share is measured against the window's FAILURES, the same denominator the dominant
 * condition and the dashboard's taxonomy use, so a rule reads off the taxonomy an operator is
 * already looking at rather than a second, differently-normalised number.
 *
 * {@link kind} is a plain string rather than the closed `agentFailureKindSchema` picklist, and
 * that is deliberate in both directions. Reading: a rule naming a kind that a later release
 * RETIRES must still parse, because this schema also decodes the stored blob, and a rule
 * rejected there would take the account's whole settings row down with it (the fallback is the
 * built-in defaults, so one stale rule would silently discard the model policy beside it).
 * Matching: the projection's own `kind` is a string for the same reason, so comparing strings is
 * comparing like with like. What a human is offered when AUTHORING one is the closed vocabulary,
 * in the settings panel, which is where a typo can still be caught before it is stored.
 */
/**
 * The most per-kind rules one config may carry, shared by every layer that bounds the list: the
 * schema below, the env parser that builds the deployment's, and the settings editor that warns
 * before a save the schema would refuse. A number restated per layer is a number that drifts,
 * and the layer that drifts low silently discards a rule an operator is counting on.
 */
export const MAX_FAILURE_KIND_RULES = 32

/**
 * The longest a rule's `kind` may be. Generous against the current vocabulary on purpose: it is
 * a bound on a string an operator types, not a statement about which kinds exist (which is
 * {@link isAgentFailureKind}, and is deliberately not enforced here — see below).
 */
export const MAX_FAILURE_KIND_LENGTH = 64

export const platformFailureKindRuleSchema = v.object({
  /** The `agentFailureKind` this rule watches, e.g. `evicted` (matched against the taxonomy). */
  kind: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(MAX_FAILURE_KIND_LENGTH)),
  /**
   * Share (0..1] of the window's failures this kind must reach before the rule fires. Excludes
   * 0 for the same reason {@link platformAlertThresholdOverridesSchema}'s dominant share does: a
   * ceiling of 0 is satisfied by any distribution, including one where the kind never occurred.
   */
  maxShare: v.pipe(v.number(), v.minValue(Number.EPSILON), v.maxValue(1)),
  /**
   * Failures OF THIS KIND the window must carry before the rule can fire. Absent ⇒ 1.
   *
   * The per-rule analogue of `minRuns`, and the reason a low ceiling is usable at all: the point
   * of a per-kind rule is to sit far below dominance (5% evictions is an incident), and at 5%
   * the shared minimum-run gate stops protecting anything — a window with the default 5 terminal
   * runs and a single eviction is already at 20%. This is what says "one is a blip".
   */
  minCount: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1_000_000))),
})
export type PlatformFailureKindRule = v.InferOutput<typeof platformFailureKindRuleSchema>

/**
 * Operator-tunable ceilings for the platform-health alert sweep. EVERY field is optional and
 * an absent one INHERITS the deployment's env-derived default rather than meaning zero. The
 * distinction matters here more than most places, because a zero is a live threshold in this
 * vocabulary ("alert on silence even in an idle window") and would page instantly.
 *
 * The bounds mirror the env parser's clamps (`resolvePlatformAlertConfig`), so a threshold
 * typed into the settings panel is refused at the write boundary for the same reasons an
 * env value is corrected at boot: a `stalledBuckets` of 0 makes "the last zero buckets were
 * empty" trivially true, and a `maxFailureKindShare` of 0 is satisfied by any distribution.
 */
export const platformAlertThresholdOverridesSchema = v.object({
  /** Minimum terminal runs before the failure-rate + dominant-kind alerts can fire. */
  minRuns: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100_000))),
  /** Run failure rate (0..1) at or above which `failure_rate_high` fires. */
  maxFailureRate: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(1))),
  /** p99 wall-clock run duration (ms) at or above which `duration_p99_high` fires. */
  maxP99DurationMs: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(30 * 24 * 60 * 60_000)),
  ),
  /** Live running/blocked/paused/pending depth at or above which `backlog_high` fires. */
  maxBacklog: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1_000_000))),
  /** Trailing empty trend buckets before `throughput_stalled` can fire. */
  stalledBuckets: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1_000))),
  /**
   * Runs the earlier part of the window must have carried before a stall counts. `0` is a
   * meaningful setting ("this deployment should never be quiet"), which is why the floor here
   * is 0 and not 1, unlike every other count in this object.
   */
  minStalledPriorRuns: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(1_000_000)),
  ),
  /**
   * Share (0..1] of the window's failures one kind must reach for `failure_kind_dominant`.
   * The floor excludes 0 on its own (a share of 0 is satisfied by any distribution, so it would
   * page constantly), which is why there is no separate `notValue(0)` beside it.
   */
  maxFailureKindShare: v.optional(v.pipe(v.number(), v.minValue(Number.EPSILON), v.maxValue(1))),
  /** Consecutive failed passes of one sweeper before `sweep_degraded` fires. */
  maxSweepFailures: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(10_000))),
  /**
   * Per-kind ceilings driving `failure_kind_rate_high` (see
   * {@link platformFailureKindRuleSchema}).
   *
   * The one field here that is a LIST rather than a scalar, which changes what overriding it
   * means: a stored list REPLACES the deployment's rules wholesale rather than merging into
   * them, so an account that wants the deployment's rules plus one of its own restates all of
   * them. Merging per kind would leave an account unable to DROP a rule it disagrees with, and
   * silently reinstating a deployment rule an account had removed is the worse of the two
   * failure modes for a pager. An EMPTY list is therefore a real setting ("no per-kind rules
   * for this account"), distinct from absent, exactly like the zeros elsewhere in this object.
   *
   * Bounded, and unique by kind: two rules on one kind would fire twice for one condition, and
   * the second is invariably an edit somebody meant to replace the first.
   */
  failureKindRules: v.optional(
    v.pipe(
      v.array(platformFailureKindRuleSchema),
      v.maxLength(MAX_FAILURE_KIND_RULES),
      v.check(
        (rules) => new Set(rules.map((rule) => rule.kind)).size === rules.length,
        'Each failure kind may carry at most one alert rule.',
      ),
    ),
  ),
})
export type PlatformAlertThresholdOverrides = v.InferOutput<
  typeof platformAlertThresholdOverridesSchema
>

/**
 * An account's stored platform-health alert settings: the settings-UI half of the alert
 * config, layered over the deployment's env-derived defaults so an operator can retune a
 * threshold without a redeploy.
 *
 * `enabled` can only turn the account's alerts OFF, never on: the env switch
 * (`PLATFORM_ALERTS`) decides whether the SWEEP RUNS AT ALL on this deployment, and no stored
 * row can start a timer that was never started. Saying so here rather than pretending the
 * setting is symmetric is what keeps the panel from offering a toggle that silently does
 * nothing on a deployment that never opted in.
 */
export const platformAlertSettingsSchema = v.object({
  /** `false` mutes this account's alerts. Absent ⇒ follow the deployment switch. */
  enabled: v.optional(v.boolean()),
  /** The window each condition is evaluated over. Absent ⇒ the deployment default. */
  window: v.optional(platformAlertWindowSchema),
  /** Per-condition ceilings; each absent field inherits the deployment default. */
  thresholds: v.optional(platformAlertThresholdOverridesSchema),
})
export type PlatformAlertSettings = v.InferOutput<typeof platformAlertSettingsSchema>

/** One fired platform-health alert: the tripped condition, its observed value + threshold. */
export const platformAlertSchema = v.object({
  reason: platformAlertReasonSchema,
  /** The observed value that crossed the threshold (a rate 0..1, ms, or a count by reason). */
  value: v.number(),
  /** The configured threshold it crossed (same unit as {@link value}). */
  threshold: v.number(),
  /**
   * The failure kind this alert is about, on a KIND-SCOPED condition (`failure_kind_rate_high`);
   * absent on every other reason, which are about the deployment as a whole.
   *
   * It is part of what the condition SAYS, not a decoration: several rules can fire at once and
   * they share a reason code, so an alert without it names a rule the reader cannot identify, and
   * a firing set that swapped `evicted` for `timeout` would look unchanged.
   */
  kind: v.optional(v.string()),
})
export type PlatformAlert = v.InferOutput<typeof platformAlertSchema>

/**
 * One failed run behind a `platform_health` card, so the alert deep-links to the EVIDENCE
 * rather than only to the dashboard. Carried on the notification payload, always scoped to
 * the card's own workspace (a card in one workspace must never link into another's run).
 *
 * Captured at the moment the firing set CHANGES, not refreshed every sweep: the payload is
 * the card's dedup identity, so a list that churned with each new failure would re-deliver
 * the alert (and re-toast the inbox) for the entire length of an incident.
 */
export const platformFailingRunSchema = v.object({
  /** The run id, which is what the SPA opens. */
  executionId: v.string(),
  /** The block the run belongs to, so the SPA can reveal it on the board. Null if unset. */
  blockId: v.nullable(v.string()),
  /** The run's `failure.kind` (or `unknown`): why this one is in the list. */
  failureKind: v.string(),
  /** When the run was created (epoch ms). */
  createdAt: v.number(),
})
export type PlatformFailingRun = v.InferOutput<typeof platformFailingRunSchema>
