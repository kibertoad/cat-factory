import * as v from 'valibot'
import { agentFailureSchema, executionStatusSchema } from './execution.js'
import { runDiagnosticsSchema } from './run-provenance.js'
import {
  agentSearchQuerySchema,
  agentToolCallSchema,
  llmCallOutcomeSchema,
  llmExportInsightSchema,
  llmExportTotalsSchema,
  llmPhaseInsightSchema,
  toolCallOutcomeSchema,
  type LlmCallOutcome,
} from './observability.js'
import { provisioningLogEntrySchema } from './provisioning-logs.js'
import {
  cursorSchema,
  epochMsQuerySchema,
  pageLimitSchema,
  PUBLIC_MAX_PAGE_LIMIT,
} from './public-paging.js'
import { stepToolServersSchema } from './tool-servers.js'

// ---------------------------------------------------------------------------
// The REMOTE DEBUGGING surface (`/api/v1/debug/*`) — the telemetry + event-log reads an
// external operator (in practice an LLM asked to diagnose a run) needs to answer "why did
// this run fail / stall / cost that much", without a browser and without a database shell.
//
// Everything the SPA's observability drill-down shows already exists in the telemetry store;
// what was missing is a surface that can be walked by a client with a fixed context budget.
// That constraint — not the data model — is what shapes every schema below:
//
//  1. **A response's size is computable BEFORE the request.** Every list is keyset-paginated
//     with a hard `limit` ceiling, and the only unbounded values (prompts, responses, injected
//     files) are returned as {@link debugTextSchema}, whose `chars` is capped by an explicit
//     query parameter. So a caller can bound a page at `limit × fields × bodyChars` and know
//     it will not be handed a 40 MB run.
//  2. **Fan-out lists never carry bodies; bodies are always a point read.** A page of 100
//     agent-context snapshots would be hundreds of megabytes, so the list projections carry
//     SIZES (`*Chars`) and identity only. The caller sweeps cheaply, then zooms into the two
//     rows that matter. The one exception is a deliberately opt-in `bodyChars` preview on the
//     LLM-call list, because "did this call come back empty?" is a triage question that a
//     size alone answers ambiguously (a reasoning-only turn has a large `reasoningChars`
//     and an empty response).
//     Finding WHICH rows matter is a server-side job too: the LLM-call list takes a
//     `contains` search (SQL LIKE over the bodies) so locating a known marker across
//     thousands of calls costs one request, not a paged sweep of every body through the
//     caller's own context — which would be the multi-hundred-megabyte dump re-entering
//     through the side door.
//  3. **Truncation is always REPORTED, never silent.** Every {@link debugTextSchema} states
//     what it returned and what exists, so a model reasoning over the payload can tell "the
//     agent said nothing" from "we only showed you the first 2 kB".
//  4. **The overview is a MAP, not a dump.** `GET /debug/runs/:runId` costs a handful of SQL
//     aggregates and no body reads at all, and its `sinks` block tells the caller which of
//     the four detail endpoints have anything in them — so the expensive reads are only ever
//     issued for data that exists.
//
// Scope: the whole surface is `read`-scoped (see `publicApiAuth`). It is deliberately NOT
// `admin`-gated — `admin` on this API also merges pull requests and deletes tasks, so
// requiring it would mean handing a debugging agent a destructive key, which is strictly
// worse. Prompt/response BODIES remain governed by the capture-time switches
// (`LLM_RECORD_PROMPTS` + the per-workspace `storeAgentContext`): an operator who does not
// want model text retained turns those off and this surface has nothing to serve.
// ---------------------------------------------------------------------------

// ---- shared query primitives ---------------------------------------------
// Query params arrive as STRINGS, so each is digit-checked BEFORE the numeric coercion:
// `Number()` alone also accepts `1e9`, `0x64` and `' '`, which would read as plausible
// values rather than the 400 a malformed request deserves. The `maxValue` ceilings are what
// make the bounds real backstops rather than suggestions.

/** Hard ceiling on rows one page may return: the surface-wide one, never a second number. */
export const DEBUG_MAX_PAGE_LIMIT = PUBLIC_MAX_PAGE_LIMIT

/** Hard ceiling on the per-field body preview a LIST may inline. */
export const DEBUG_MAX_PREVIEW_CHARS = 4_000

/** Hard ceiling on the per-field body a POINT READ may return. */
export const DEBUG_MAX_BODY_CHARS = 200_000

/**
 * Hard ceiling on a point read's slice offset — comfortably above the store's own per-body
 * cap (512 kB), so every stored character is reachable, while still rejecting a garbage
 * offset instead of quietly serving an empty slice for it.
 */
export const DEBUG_MAX_BODY_OFFSET = 2_000_000

/** Hard ceiling on a `contains` search term's length. */
export const DEBUG_MAX_SEARCH_CHARS = 256

/**
 * Per-field preview budget on a LIST. Defaults to 0 — a sweep costs no body bytes at all,
 * and a caller opts into previews only once it knows which rows it cares about.
 */
const previewCharsSchema = v.pipe(
  v.string(),
  v.regex(/^\d+$/, 'Must be a whole number'),
  v.transform(Number),
  v.number(),
  v.integer(),
  v.minValue(0),
  v.maxValue(DEBUG_MAX_PREVIEW_CHARS),
)

/** Per-field body budget on a POINT READ. Absent ⇒ the full stored body, up to the ceiling. */
const bodyCharsSchema = v.pipe(
  v.string(),
  v.regex(/^\d+$/, 'Must be a whole number'),
  v.transform(Number),
  v.number(),
  v.integer(),
  v.minValue(0),
  v.maxValue(DEBUG_MAX_BODY_CHARS),
)

/**
 * 0-based code-point offset a point read's slices start at. Absent ⇒ 0 (the head). This is
 * what makes the MIDDLE and TAIL of a large body reachable: without it, a leading slice is
 * the only window this surface can serve, and the diagnostic payload of a long delta — the
 * last tool result the model saw, the end of a captured build log — sits at the end.
 */
const bodyOffsetSchema = v.pipe(
  v.string(),
  v.regex(/^\d+$/, 'Must be a whole number'),
  v.transform(Number),
  v.number(),
  v.integer(),
  v.minValue(0),
  v.maxValue(DEBUG_MAX_BODY_OFFSET),
)

/**
 * A literal substring to search bodies for, matched case-insensitively in SQL. Deliberately
 * NOT trimmed and NOT a pattern language: the caller is grepping for verbatim tool-error
 * text, and a term that behaved as a wildcard on one runtime only would be a parity bug.
 */
const containsSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(DEBUG_MAX_SEARCH_CHARS))

/** A non-negative integer query filter (step indexes). */
const nonNegativeIntQuerySchema = v.pipe(
  v.string(),
  v.regex(/^\d+$/, 'Must be a whole number'),
  v.transform(Number),
  v.number(),
  v.integer(),
  v.minValue(0),
)

/**
 * A bounded slice of a stored text body, and enough metadata to know what was left out.
 *
 * This is THE reason the surface is safe to hand to a model: a bare truncated string is
 * indistinguishable from a short one, so a reader would confidently conclude "the agent
 * returned nothing" from a payload that merely hit its budget. `totalChars` is always the
 * full stored length, measured in SQL, even when `text` is empty.
 */
export const debugTextSchema = v.object({
  /** The returned slice — `chars` characters of the stored body, starting at `offset`. */
  text: v.string(),
  /**
   * Characters actually returned in {@link debugTextSchema} `text`, in Unicode CODE POINTS —
   * the unit SQL `length()`/`substr()` measure in (an emoji counts once, not twice).
   */
  chars: v.number(),
  /**
   * 0-based code-point position `text` starts at within the stored body — 0 unless the caller
   * asked for a later window via `?bodyOffset=`. Clamped to `totalChars`, so
   * `offset + chars <= totalChars` always holds.
   */
  offset: v.number(),
  /** Characters stored for this field (the full code-point length, regardless of what was returned). */
  totalChars: v.number(),
  /** True when `chars < totalChars`, i.e. `text` is not the entire stored body. */
  truncated: v.boolean(),
  /**
   * 0-based code-point offset of the first case-insensitive occurrence of the request's
   * `?contains=` term in this body, or null when the term occurs only in a sibling body.
   * Present ONLY on rows of a searched list — pair it with the point read's `?bodyOffset=`
   * to jump straight to the match without transferring the bytes before it.
   */
  matchOffset: v.optional(v.nullable(v.number())),
})
export type DebugText = v.InferOutput<typeof debugTextSchema>

// ---------------------------------------------------------------------------
// 1. Run index — `GET /api/v1/debug/runs`
// ---------------------------------------------------------------------------

/**
 * The lean run projection every debug list/overview leads with. Deliberately a SUMMARY, not
 * the internal `ExecutionInstance`: a run's persisted `detail` blob carries per-step gate,
 * judge, follow-up, container and validation state that is megabytes on a long run and means
 * nothing to an external caller. What survives is what identifies a run and says whether it
 * is worth opening.
 */
export const debugRunSummarySchema = v.object({
  runId: v.string(),
  /** The board block the run is anchored on (a task, a service frame, or a headless anchor). */
  blockId: v.string(),
  pipelineId: v.string(),
  pipelineName: v.string(),
  status: executionStatusSchema,
  /** Epoch-ms creation stamp — also the value the keyset cursor is minted from. */
  createdAt: v.number(),
  /** Index of the step the run is currently on. */
  currentStep: v.number(),
  /** How many steps the run's pipeline has. */
  stepCount: v.number(),
  /** Structured failure diagnostics when the run failed; null otherwise. */
  failure: v.nullable(agentFailureSchema),
})
export type DebugRunSummary = v.InferOutput<typeof debugRunSummarySchema>

/** Query params for `GET /api/v1/debug/runs`. */
export const listDebugRunsQuerySchema = v.object({
  /** Filter to one internal execution status (`running`/`blocked`/`paused`/`done`/`failed`/…). */
  status: v.optional(executionStatusSchema),
  /** Inclusive lower bound on the run's `createdAt`. */
  since: v.optional(epochMsQuerySchema),
  /** Cap on rows returned (default 25, hard max {@link DEBUG_MAX_PAGE_LIMIT}). */
  limit: v.optional(pageLimitSchema),
  /** Opaque keyset cursor from a previous page's `nextCursor`. */
  cursor: v.optional(cursorSchema),
})
export type ListDebugRunsQuery = v.InferOutput<typeof listDebugRunsQuerySchema>

export const debugRunListSchema = v.object({
  runs: v.array(debugRunSummarySchema),
  /** Cursor for the next page, or null when this was the last page. */
  nextCursor: v.nullable(v.string()),
})
export type DebugRunList = v.InferOutput<typeof debugRunListSchema>

// ---------------------------------------------------------------------------
// 2. Run overview — `GET /api/v1/debug/runs/:runId`
// ---------------------------------------------------------------------------

/**
 * One step of the run, projected to what a diagnosis actually reads. The internal
 * `PipelineStep` carries two dozen per-kind state blobs (gate, judge, follow-ups, container,
 * validation, reproduction, …) that are megabytes on a long run and meaningless without the
 * engine's vocabulary; what survives here is the step's identity, its clocks, and the two
 * things that explain a stuck step — whether its container kept dying, and what killed it.
 */
export const debugRunStepSchema = v.object({
  index: v.number(),
  agentKind: v.string(),
  /** Lifecycle state (`pending` / `working` / `waiting_decision` / `done` / …). */
  state: v.string(),
  progress: v.number(),
  /** The resolved model this step dispatched on, when the engine recorded one. */
  model: v.nullable(v.string()),
  /** Whether the pipeline skipped this step. */
  skipped: v.boolean(),
  /** Epoch ms the step first began executing; null until it starts. */
  startedAt: v.nullable(v.number()),
  /** Epoch ms the step finished; null until it completes. */
  finishedAt: v.nullable(v.number()),
  /**
   * Epoch ms of the container agent's last observed sign of life. The field that separates a
   * genuinely-active-but-quiet step (a reviewer reading hundreds of files) from a wedged one,
   * which no other clock here can distinguish. Null on non-container steps.
   */
  lastActivityAt: v.nullable(v.number()),
  /** Live/last subtask counts for an async container step; null when none were reported. */
  subtasks: v.nullable(
    v.object({ completed: v.number(), inProgress: v.number(), total: v.number() }),
  ),
  /** Characters of prose output the step produced (0 ⇒ it produced none). */
  outputChars: v.number(),
  /** Whether the step produced a structured result (`step.custom`). */
  hasStructuredResult: v.boolean(),
  /** How many times this step's container was evicted/crashed and automatically re-dispatched. */
  evictionRecoveries: v.number(),
  /**
   * How many times this step's push to the work branch was refused (the branch had moved under it)
   * and the step was automatically re-dispatched to resume the branch as it now stands.
   *
   * Here for the same reason `evictionRecoveries` is: the recovery is INVISIBLE in every other
   * signal. The run reports as a clean success, and the only trace that a whole agent run was spent
   * twice (in tokens and in wall clock) is this counter, which is exactly the question a
   * post-mortem on "why did this step cost double" starts from.
   */
  branchContentionRecoveries: v.number(),
  /**
   * The post-mortem retained from the FIRST container death on this step (exit state plus a
   * scrubbed log tail). Null when the step's containers never died. Bounded like every other
   * body on this surface.
   */
  firstEvictionDetail: v.nullable(debugTextSchema),
  /**
   * What the step's dispatch did with the tool servers (MCP) its agent kind declared: the ones it
   * wired, and the ones it dropped with the reason. Absent when the step's current attempt holds
   * no dispatch-recorded resolution, which is a different fact from both lists being empty and
   * from the step never having run (see {@link stepToolServersSchema}).
   *
   * On this surface rather than only on the run surface because "the agent never had the tool" and
   * "the agent had it and did not call it" are the same symptom to a diagnosing reader, and the
   * tool-call trajectory can only show the second. Small and closed, so it is returned whole
   * rather than sized.
   */
  toolServers: v.optional(stepToolServersSchema),
})
export type DebugRunStep = v.InferOutput<typeof debugRunStepSchema>

/**
 * Whether one telemetry sink has anything for this run, and how much. The point of the block
 * is to stop a caller issuing four detail requests to discover three of them are empty —
 * `available: false` means the sink's repository is not wired on this deployment, so a zero
 * count there is "we never recorded this", not "nothing happened".
 *
 * Availability is REPOSITORY presence only. The capture-time gates (`LLM_RECORD_PROMPTS`, the
 * per-workspace `storeAgentContext`) act at record time and are invisible here: a workspace
 * that opted out of capture reads `available: true, count: 0`.
 */
export const debugSinkStatusSchema = v.object({
  available: v.boolean(),
  count: v.number(),
})
export type DebugSinkStatus = v.InferOutput<typeof debugSinkStatusSchema>

// How many of the run's tool calls FAILED is deliberately NOT a field here. It is one number the
// other four sinks have no analogue for, and it lives on the `toolCalls` rollup beside the
// breakdown it is folded from (`totals.failures`), because that rollup and the sink's `count` come
// out of ONE aggregate pass. A second copy on the sink status could only ever be a second read of
// the same rows, which is how a `failed` above its own `count` gets published.

/** Severity of a derived diagnostic signal. */
export const debugSignalSeveritySchema = v.picklist(['info', 'warning', 'error'])
export type DebugSignalSeverity = v.InferOutput<typeof debugSignalSeveritySchema>

/**
 * A precomputed diagnostic hint. These are derivations the caller could make itself from the
 * rollups — which is exactly why they are here: a model that has to rediscover "13 of 40 calls
 * were truncated" by arithmetic over a payload will sometimes get it wrong, and will always
 * spend context doing it. `code` is machine-readable and stable; `message` restates it in
 * prose so the payload is useful with no external key.
 */
export const debugSignalSchema = v.object({
  code: v.string(),
  severity: debugSignalSeveritySchema,
  message: v.string(),
  /** How many occurrences the signal counts (truncated calls, failed provisions, …); null when it counts nothing. */
  count: v.nullable(v.number()),
  /** The agent kind the signal is about, when it is scoped to one. */
  agentKind: v.nullable(v.string()),
  /** The step index the signal is about, when it is scoped to one. */
  stepIndex: v.nullable(v.number()),
})
export type DebugSignal = v.InferOutput<typeof debugSignalSchema>

/**
 * What every level of the tool-call rollup counts, plus the ratio the counts only mean
 * something as.
 *
 * `failureRate` is null where nothing was called, never 0: a run that made no tool calls has
 * no failure rate, and a clean 0% would file it beside a run whose every call worked — the
 * same number for "nothing happened" and "everything worked".
 */
const toolCallCountsSchema = {
  calls: v.number(),
  /**
   * Calls that came back `ok: false`: the TOOL failed inside the container (a rejected edit,
   * a non-zero command, malformed arguments), which is invisible in the LLM rollup beside it,
   * where every one of those turns still reports a healthy model call.
   */
  failures: v.number(),
  /** `failures / calls`, or null when there were no calls. */
  failureRate: v.nullable(v.number()),
} as const

/** The run's tool activity in total. */
export const debugToolCallTotalsSchema = v.object(toolCallCountsSchema)
export type DebugToolCallTotals = v.InferOutput<typeof debugToolCallTotalsSchema>

/** One tool's slice of it, folded across the agent kinds that called it. */
export const debugToolInsightSchema = v.object({ tool: v.string(), ...toolCallCountsSchema })
export type DebugToolInsight = v.InferOutput<typeof debugToolInsightSchema>

/** One agent kind's slice of it, folded across the tools it called. */
export const debugToolCallKindInsightSchema = v.object({
  agentKind: v.string(),
  ...toolCallCountsSchema,
})
export type DebugToolCallKindInsight = v.InferOutput<typeof debugToolCallKindInsightSchema>

/**
 * The run's tool-EXECUTION activity, aggregated in SQL at the `(agentKind, tool)` grain and
 * re-cut along each axis. The counterpart of the `llm` block, and the half of a run's health
 * that block structurally cannot report: a tool that fails inside the container leaves every
 * model call around it looking perfectly healthy.
 *
 * Both breakdowns are folds over ONE aggregate, so they total identically to each other and to
 * `totals` by construction, and both lead with the most-failed row: a run's busiest tool is
 * almost never its broken one, and the caller reading this is looking for the broken one.
 * `GET /debug/runs/:runId/tool-calls?outcome=error` is the drill-down into any row of it.
 */
export const debugToolCallRollupSchema = v.object({
  totals: debugToolCallTotalsSchema,
  byTool: v.array(debugToolInsightSchema),
  byAgentKind: v.array(debugToolCallKindInsightSchema),
})
export type DebugToolCallRollup = v.InferOutput<typeof debugToolCallRollupSchema>

/**
 * The run's diagnostic map: identity, per-step state, what each telemetry sink holds, the
 * SQL-aggregated LLM and tool-call rollups, and the derived signals. Composed from aggregates
 * only — it reads no prompt, response or context body, so it stays cheap enough to be the
 * first call a debugging client always makes.
 */
export const debugRunOverviewSchema = v.object({
  /** Schema marker so a consuming model knows the shape without external docs. */
  kind: v.literal('cat-factory.run-debug-overview'),
  version: v.literal(1),
  /** When this projection was computed (epoch ms). */
  generatedAt: v.number(),
  run: debugRunSummarySchema,
  steps: v.array(debugRunStepSchema),
  /**
   * Where and on what the run's most recent step dispatched (backend, model, repo,
   * control-plane host) and how that dispatch ended if it never reached a running job, when
   * the engine recorded it. Null for a run that has not dispatched a step yet.
   */
  diagnostics: v.nullable(runDiagnosticsSchema),
  sinks: v.object({
    llmCalls: debugSinkStatusSchema,
    agentContext: debugSinkStatusSchema,
    searchQueries: debugSinkStatusSchema,
    toolCalls: debugSinkStatusSchema,
    provisioningLog: debugSinkStatusSchema,
  }),
  /**
   * The run's model activity, aggregated in SQL. `byAgentKind` reuses the same insight shape
   * the LLM-metrics export publishes, derived ratios included, so the two never disagree.
   *
   * `byPhase` re-cuts the SAME aggregate along the other axis — WHICH slice of the run's work
   * spent the tokens (the agent's edit loop, a validation repair round, a reproduction-proof
   * round, …) — with the carry cost that says how much each phase burdened the turns after it.
   * It is the axis a caller asked "why did this trivial task cost a million tokens" needs, and
   * `byAgentKind` cannot answer it: one coder step contains every phase. Both are folds over
   * one `GROUP BY`, so their totals agree by construction. Rows are ordered by descending
   * carry cost — the expensive slice first, which is what the caller is looking for.
   */
  llm: v.object({
    totals: llmExportTotalsSchema,
    byAgentKind: v.array(llmExportInsightSchema),
    byPhase: v.array(llmPhaseInsightSchema),
    /**
     * ISO 4217 currency every `costEstimate` above is denominated in, or null when this
     * deployment prices nothing (in which case those costs are null too). Carried once, here,
     * rather than repeated on every row: it is a property of the price table, not of a row.
     */
    costCurrency: v.nullable(v.string()),
  }),
  /**
   * What the run's agents DID with their tools, and how much of it failed. Counted from the
   * same rows `sinks.toolCalls` counts, in the same pass, so the two can never disagree.
   */
  toolCalls: debugToolCallRollupSchema,
  signals: v.array(debugSignalSchema),
})
export type DebugRunOverview = v.InferOutput<typeof debugRunOverviewSchema>

// ---------------------------------------------------------------------------
// 3./4. LLM calls — `GET /api/v1/debug/runs/:runId/llm-calls`, `GET /api/v1/debug/llm-calls/:callId`
// ---------------------------------------------------------------------------

/**
 * Classification of a recorded call, precomputed so a caller need not re-derive it.
 *
 * THE SAME picklist the panel badges and both filters narrow by ({@link llmCallOutcomeSchema}),
 * aliased rather than restated: two declarations of one closed vocabulary is a member added to
 * one and missing from the other, and on this surface that reads as a debug client being told a
 * whole class of call does not exist.
 */
export const debugCallOutcomeSchema = llmCallOutcomeSchema
export type DebugCallOutcome = LlmCallOutcome

/** Chronological direction a call page walks in. */
export const debugCallOrderSchema = v.picklist(['newest', 'oldest'])
export type DebugCallOrder = v.InferOutput<typeof debugCallOrderSchema>

/** How the single-call point read presents the prompt delta. */
export const debugCallViewSchema = v.picklist(['raw', 'messages'])
export type DebugCallView = v.InferOutput<typeof debugCallViewSchema>

/**
 * One message of a parsed prompt delta (`?view=messages` on the point read). The parse is
 * LENIENT — both telemetry producers store `JSON.stringify` of a `{ role, content }` array,
 * but the content shapes differ (OpenAI-style strings/parts/`tool_calls` from the proxy,
 * vendor content blocks from the harness transcript), so unrecognised parts degrade to a
 * `[type]` placeholder rather than failing the message.
 */
export const debugPromptMessageSchema = v.object({
  /**
   * The message's absolute position in the FULL conversation (`elidedLeadingMessages` +
   * its position in the delta), so two calls' parsed views line up without arithmetic.
   */
  index: v.number(),
  /** The message's role verbatim (`system` / `user` / `assistant` / `tool` / …), `unknown` when absent. */
  role: v.string(),
  /** The message's `name` field (a named tool/function turn), when the producer recorded one. */
  name: v.nullable(v.string()),
  /** The tool invocation a tool-result turn answers, when the producer recorded the id. */
  toolCallId: v.nullable(v.string()),
  /** Tool invocations an assistant turn requested: the tool's name plus its budgeted serialized arguments. */
  toolCalls: v.array(v.object({ name: v.string(), args: debugTextSchema })),
  /** The message's textual content, budgeted INDEPENDENTLY of every other message's. */
  content: debugTextSchema,
})
export type DebugPromptMessage = v.InferOutput<typeof debugPromptMessageSchema>

/**
 * One recorded model call. The three body fields are always PRESENT but empty unless the
 * caller asked for a preview — their `totalChars` is measured in SQL either way, so a
 * zero-cost sweep still shows exactly how much text each call holds.
 *
 * `prompt` is the call's DELTA — only the messages this call appended to its conversation.
 * That is how the store keeps prompts (a container agent re-sends its whole growing history
 * every turn, so storing the full array per call is ~21x redundant), and it is also the right
 * shape for reading: walk one agent kind's calls with `order=oldest` and the concatenated
 * deltas ARE the conversation, with no prefix re-sent to the caller either.
 */
export const debugLlmCallSchema = v.object({
  callId: v.string(),
  runId: v.nullable(v.string()),
  agentKind: v.string(),
  provider: v.string(),
  model: v.string(),
  createdAt: v.number(),
  outcome: debugCallOutcomeSchema,
  ok: v.boolean(),
  httpStatus: v.nullable(v.number()),
  errorMessage: v.nullable(v.string()),
  finishReason: v.nullable(v.string()),
  streaming: v.boolean(),
  /**
   * WHICH slice of the run spent this call: the agent's own edit loop (`agent`), a pre-PR
   * validation repair round (`validation-repair`), a reproduction-proof repair round
   * (`reproduction-repair`), … Stamped by whoever owns the loop boundary, never reconstructed
   * from timestamps, which is why it is worth reading rather than inferring.
   *
   * `''` means the call could not be attributed — an older harness image, an inline call, or the
   * un-phased proxy path. That is a REAL slice, not a gap: a run whose calls are all `''` was
   * metered by something that has no phase concept, NOT one that spent nothing outside the agent.
   */
  phase: v.string(),
  /**
   * The call's ordinal within its job's telemetry sequence (0-based), so a phase's calls can be
   * ordered by TURN rather than by wall clock.
   *
   * `null` where the producing channel has no turn concept — the LLM proxy sees one HTTP request
   * at a time with no job-scoped counter. Deliberately not faked to 0, which would read as "the
   * first turn" and sort every proxied call to the front of its phase.
   */
  turnIndex: v.nullable(v.number()),
  /** Messages in the FULL request (not just the delta below). */
  messageCount: v.number(),
  /** Tools offered to the model (0 ⇒ the agent could not edit anything). */
  toolCount: v.number(),
  requestMaxTokens: v.nullable(v.number()),
  /** FRESH (uncached) input tokens — exclusive of both cache classes below. */
  promptTokens: v.number(),
  /** Input tokens served from the provider's prefix cache (priced around 0.1x fresh). */
  cacheReadTokens: v.number(),
  /**
   * Input tokens WRITTEN into the provider's cache (priced 1.25-2x fresh). Kept apart from
   * the reads because summed together, a loop that keeps invalidating and re-writing its
   * prefix is indistinguishable from one riding a warm cache — and telling those apart is
   * often the whole question when a run costs more than it should.
   */
  cacheWriteTokens: v.number(),
  completionTokens: v.number(),
  totalTokens: v.number(),
  upstreamMs: v.number(),
  overheadMs: v.number(),
  totalMs: v.number(),
  /** Leading messages elided from `prompt` because an earlier call in the chain stored them. */
  elidedLeadingMessages: v.number(),
  /** The messages this call APPENDED, as JSON (see the note above). */
  prompt: debugTextSchema,
  /** The assistant's visible reply. */
  response: debugTextSchema,
  /** The model's separate reasoning channel, when it emits one. */
  reasoning: debugTextSchema,
  /**
   * The prompt delta parsed into per-message rows, each budgeted independently — present only
   * on a `?view=messages` point read. `null` there means the stored delta did not parse as a
   * message array (the raw `prompt` is served instead, so the view degrades rather than
   * returning nothing); absent means the caller did not ask for the view. Independent budgets
   * are the point: in the raw view one enormous leading tool result must be paid for before
   * anything after it is visible, while here every message shows its head. The response's
   * worst case stays computable — `(messageCount − elidedLeadingMessages) × bodyChars`, both
   * factors already on the list row.
   */
  promptMessages: v.optional(v.nullable(v.array(debugPromptMessageSchema))),
})
export type DebugLlmCall = v.InferOutput<typeof debugLlmCallSchema>

/** Query params for `GET /api/v1/debug/runs/:runId/llm-calls`. */
export const listDebugLlmCallsQuerySchema = v.object({
  /** Narrow to one step kind's conversation (`coder`, `ci-fixer`, …), applied in SQL. */
  agentKind: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120))),
  /**
   * Narrow to one PHASE's calls (`agent`, `validation-repair`, `reproduction-repair`, …), an
   * exact match applied in SQL. This is how "what did the repair rounds cost" is answered in one
   * request rather than by paging the run and grouping client-side.
   *
   * Unlike `agentKind` the EMPTY string is accepted and meaningful: it selects the unattributed
   * slice (an older harness image, an inline call, the un-phased proxy path), which is otherwise
   * unreachable as a query.
   */
  phase: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(120))),
  /** Narrow to failing or warning (truncated / filtered) calls only. */
  outcome: v.optional(debugCallOutcomeSchema),
  /**
   * Narrow to calls whose prompt delta, response or reasoning CONTAINS this literal substring,
   * matched case-insensitively in SQL. This is the surface's grep — the way a caller finds a
   * tool-validation error, a repeated apology, or any known marker across thousands of calls
   * in ONE request instead of paging every body through its own context. Matched rows report
   * a per-body `matchOffset`; wildcards (`%`/`_`) match literally.
   */
  contains: v.optional(containsSchema),
  /** `newest` (default) for triage; `oldest` to read a conversation forwards. */
  order: v.optional(debugCallOrderSchema),
  /** Cap on rows returned (default 25, hard max {@link DEBUG_MAX_PAGE_LIMIT}). */
  limit: v.optional(pageLimitSchema),
  cursor: v.optional(cursorSchema),
  /**
   * Per-field body preview budget, 0..{@link DEBUG_MAX_PREVIEW_CHARS}. Default 0: the sweep
   * returns sizes only. Bodies are sliced IN SQL, so an un-previewed page never reads the
   * text columns out of the store at all.
   */
  bodyChars: v.optional(previewCharsSchema),
})
export type ListDebugLlmCallsQuery = v.InferOutput<typeof listDebugLlmCallsQuerySchema>

export const debugLlmCallListSchema = v.object({
  calls: v.array(debugLlmCallSchema),
  nextCursor: v.nullable(v.string()),
})
export type DebugLlmCallList = v.InferOutput<typeof debugLlmCallListSchema>

/** Query params for the single-call point read. */
export const getDebugLlmCallQuerySchema = v.object({
  /**
   * Per-field budget, 0..{@link DEBUG_MAX_BODY_CHARS}. Absent ⇒ the ceiling itself: a body
   * longer than {@link DEBUG_MAX_BODY_CHARS} is still cut (and says so via `truncated`).
   * Under `view=messages` this is the PER-MESSAGE content budget.
   */
  bodyChars: v.optional(bodyCharsSchema),
  /**
   * 0-based code-point offset the body slices start at (raw view only; a parsed message view
   * always reads each message whole and budgets its head). Pair with a searched list row's
   * `matchOffset` to read the text AROUND a match — the `grep -C` of this surface.
   */
  bodyOffset: v.optional(bodyOffsetSchema),
  /**
   * `raw` (default) returns the delta as stored JSON; `messages` parses it into per-message
   * rows with independent budgets (see `promptMessages`). Falls back to `raw` semantics when
   * the stored delta does not parse.
   */
  view: v.optional(debugCallViewSchema),
})
export type GetDebugLlmCallQuery = v.InferOutput<typeof getDebugLlmCallQuerySchema>

// ---------------------------------------------------------------------------
// 5./6. Agent context — `GET /api/v1/debug/runs/:runId/agent-context`,
//                       `GET /api/v1/debug/agent-context/:snapshotId`
// ---------------------------------------------------------------------------

/**
 * One captured dispatch, SIZES ONLY. A snapshot carries the whole composed system prompt, the
 * whole user prompt, every folded fragment body and the full content of every injected
 * context file — a single row can be megabytes, so the list never inlines any of it (there is
 * no `bodyChars` here on purpose: a truncated prefix of a fragment ARRAY answers no question a
 * size does not, and the point read is one hop away).
 */
export const debugAgentContextEntrySchema = v.object({
  snapshotId: v.string(),
  agentKind: v.string(),
  /** The step index within the run's pipeline this dispatch belongs to. */
  stepIndex: v.number(),
  createdAt: v.number(),
  model: v.nullable(v.string()),
  harness: v.nullable(v.string()),
  systemPromptChars: v.number(),
  userPromptChars: v.number(),
  /**
   * Serialized size of the best-practice fragments folded into the system prompt, and of the
   * files injected into the container as `.cat-context/*` (their bodies included).
   *
   * Sizes rather than element counts on purpose: counting the entries of those two JSON
   * columns means either parsing them — which reads the very bodies this projection exists to
   * avoid — or calling `json_array_length` on a column where one malformed row would fail the
   * whole page. For "is there a lot in here, and did it change between attempts", a length
   * answers just as well; the point read gives the actual arrays.
   */
  fragmentsChars: v.number(),
  contextFilesChars: v.number(),
})
export type DebugAgentContextEntry = v.InferOutput<typeof debugAgentContextEntrySchema>

/** Query params for `GET /api/v1/debug/runs/:runId/agent-context`. */
export const listDebugAgentContextQuerySchema = v.object({
  /** Narrow to one step's dispatches (a step re-dispatched on retry records one snapshot each). */
  stepIndex: v.optional(nonNegativeIntQuerySchema),
  limit: v.optional(pageLimitSchema),
  cursor: v.optional(cursorSchema),
})
export type ListDebugAgentContextQuery = v.InferOutput<typeof listDebugAgentContextQuerySchema>

export const debugAgentContextListSchema = v.object({
  snapshots: v.array(debugAgentContextEntrySchema),
  nextCursor: v.nullable(v.string()),
})
export type DebugAgentContextList = v.InferOutput<typeof debugAgentContextListSchema>

/** One folded best-practice fragment, with its body bounded. */
export const debugAgentContextFragmentSchema = v.object({
  id: v.string(),
  body: debugTextSchema,
})
export type DebugAgentContextFragment = v.InferOutput<typeof debugAgentContextFragmentSchema>

/** One injected context file, with its (already secret-scrubbed) body bounded. */
export const debugAgentContextFileSchema = v.object({
  path: v.string(),
  title: v.string(),
  url: v.string(),
  content: debugTextSchema,
})
export type DebugAgentContextFile = v.InferOutput<typeof debugAgentContextFileSchema>

/**
 * The full context one dispatch was provided. Every body is budgeted independently so one
 * enormous injected file cannot crowd out the prompts a reader actually came for.
 */
export const debugAgentContextDetailSchema = v.object({
  snapshotId: v.string(),
  runId: v.string(),
  agentKind: v.string(),
  stepIndex: v.number(),
  createdAt: v.number(),
  model: v.nullable(v.string()),
  harness: v.nullable(v.string()),
  systemPrompt: debugTextSchema,
  userPrompt: debugTextSchema,
  fragments: v.array(debugAgentContextFragmentSchema),
  contextFiles: v.array(debugAgentContextFileSchema),
  /**
   * Redacted structural context (repo, branches, infra spec, the run's decisions and revision
   * feedback). Small and already deep-scrubbed at capture time, so it is returned whole.
   */
  extras: v.record(v.string(), v.unknown()),
})
export type DebugAgentContextDetail = v.InferOutput<typeof debugAgentContextDetailSchema>

/** Query params for the single-snapshot point read. */
export const getDebugAgentContextQuerySchema = v.object({
  /**
   * Per-body budget, 0..{@link DEBUG_MAX_BODY_CHARS}. Absent ⇒ the ceiling itself: a body
   * longer than {@link DEBUG_MAX_BODY_CHARS} is still cut (and says so via `truncated`).
   */
  bodyChars: v.optional(bodyCharsSchema),
  /**
   * 0-based code-point offset every body slice starts at. Applied to ALL of the snapshot's
   * bodies uniformly (it exists to reach the tail of ONE large body the index sized; the
   * others simply run out and return empty slices past their end).
   */
  bodyOffset: v.optional(bodyOffsetSchema),
})
export type GetDebugAgentContextQuery = v.InferOutput<typeof getDebugAgentContextQuerySchema>

// ---------------------------------------------------------------------------
// 7./8. Searches + the provisioning event log
// ---------------------------------------------------------------------------

/** Query params for the two small-row lists (`search-queries`, `logs`). */
export const listDebugPageQuerySchema = v.object({
  limit: v.optional(pageLimitSchema),
  cursor: v.optional(cursorSchema),
})
export type ListDebugPageQuery = v.InferOutput<typeof listDebugPageQuerySchema>

/**
 * The web searches the run's agents performed. Rows are small (the query text is capped at
 * 8 kB at capture time), so they are returned whole rather than as {@link debugTextSchema}.
 */
export const debugSearchQueryListSchema = v.object({
  queries: v.array(agentSearchQuerySchema),
  nextCursor: v.nullable(v.string()),
})
export type DebugSearchQueryList = v.InferOutput<typeof debugSearchQueryListSchema>

/**
 * Which order a run's tool calls come back in.
 *
 * `recent` (the default) is the newest-first keyset every other debug list serves: resumable
 * with a cursor, for sweeping a long run. `trajectory` is oldest-first by when each call
 * actually started — the order the agent worked in — bounded to `limit` and NOT resumable,
 * because it answers a question about the run's beginning rather than a walk of all of it.
 *
 * The server computes both. A client holding rows could try to sort them itself, and would get
 * it wrong in a way that looks right: `seq` restarts at zero on every dispatch, and `jobId` is
 * a string that sorts a run's dispatches by agent-kind spelling.
 */
export const toolCallOrderSchema = v.picklist(['recent', 'trajectory'])
export type ToolCallOrder = v.InferOutput<typeof toolCallOrderSchema>

/**
 * Query params for the tool-call trajectory list. It takes the small-row page params plus three
 * of its own: the {@link toolCallOrderSchema order}; a dispatch filter, because a run's step
 * can dispatch more than once (a re-run, a gate's fixer rounds, a Ralph iteration) and "what did
 * the third ci-fixer round actually do" is a different question from "what did this run do"; and
 * the {@link toolCallOutcomeSchema outcome} filter, which is how the overview's failure counts
 * are turned into the rows behind them.
 */
export const listDebugToolCallsQuerySchema = v.object({
  limit: v.optional(pageLimitSchema),
  cursor: v.optional(cursorSchema),
  jobId: v.optional(v.string()),
  order: v.optional(toolCallOrderSchema),
  /**
   * Narrow to the calls that FAILED (`error`) or the ones that did not (`ok`), applied in SQL
   * like every other narrowing here: a filter applied after the read has already paid for the
   * rows it discards, and spends the page's `limit` on them, which on this sink is the difference
   * between one request and paging a thousand-call trajectory to find the four rows that matter.
   *
   * It composes with both orders. `order=trajectory&outcome=error` is the failing calls in the
   * sequence the agent made them, which is how a stuck edit loop (the same tool failing the same
   * way, round after round) is told apart from one tool that failed once and was worked around.
   *
   * THE SAME param name and vocabulary as the llm-call list's `outcome`, deliberately: the two
   * drill-downs answer the same question about different sinks, and a reader who learned one
   * should not have to discover that the other spells it `ok=false`. A picklist rather than a
   * wire boolean for the reason a query param always is text, and so the set can gain a member
   * (a timeout, a refusal) without retyping a published field.
   */
  outcome: v.optional(toolCallOutcomeSchema),
})
export type ListDebugToolCallsQuery = v.InferOutput<typeof listDebugToolCallsQuerySchema>

/**
 * The tool calls the run's agents made: the TRAJECTORY, which is the half of "how did this diff
 * come about" that no diff and no prompt body answers.
 *
 * Rows come back WHOLE, bodies included, because a tool call's `args`/`result` are capped at
 * CAPTURE time rather than stored unbounded and sliced at read time (unlike a prompt), so the
 * page's size is `limit x cap` and computable before the request — the rule every endpoint here
 * obeys. `bodies` says whether they were retained at all, so an empty `args` on a `withheld` row
 * is read as an opt-out rather than as a tool that took no arguments.
 *
 * `nextCursor` is always null in `trajectory` order: that read is a bounded prefix by
 * construction, not one page of a walk.
 */
export const debugToolCallListSchema = v.object({
  toolCalls: v.array(agentToolCallSchema),
  nextCursor: v.nullable(v.string()),
})
export type DebugToolCallList = v.InferOutput<typeof debugToolCallListSchema>

/**
 * The run's slice of the provisioning event log — every attempt to spin up or tear down the
 * throwaway infrastructure it ran on, with the verbatim (secret-scrubbed) provider error. This
 * is the half of "why did it fail" that no model call can answer: a run whose container never
 * came up has no LLM telemetry at all, and this is where its cause of death is written.
 */
export const debugLogListSchema = v.object({
  entries: v.array(provisioningLogEntrySchema),
  nextCursor: v.nullable(v.string()),
})
export type DebugLogList = v.InferOutput<typeof debugLogListSchema>

// ---------------------------------------------------------------------------
// 9. LLM export: `GET /api/v1/debug/runs/:runId/llm-export`
// ---------------------------------------------------------------------------

/** Which end of a long run the export's call rows are taken from. */
export const debugLlmExportOrderSchema = v.picklist(['oldest', 'newest'])
export type DebugLlmExportOrder = v.InferOutput<typeof debugLlmExportOrderSchema>

/** Query params for the run's LLM export bundle. */
export const getDebugLlmExportQuerySchema = v.object({
  /**
   * How many CALL ROWS to include, 1..{@link DEBUG_MAX_PAGE_LIMIT} (default 25, the call
   * list's own page default). The rollups below are unaffected: they are SQL aggregates over
   * the whole run whatever this says.
   */
  limit: v.optional(pageLimitSchema),
  /**
   * `oldest` (default) reads the run forwards, which is what an analysis of how it went wrong
   * wants; `newest` keeps the tail, which is where a run that died late says why. Reported back
   * on the bundle, because with `truncated` set it is what says WHICH end was kept.
   */
  order: v.optional(debugLlmExportOrderSchema),
  /**
   * Per-field body budget on each call row, 0..{@link DEBUG_MAX_PREVIEW_CHARS}. Default 0:
   * the bundle is numbers only. Bodies are sliced in SQL, so a bundle that asks for none never
   * reads the text columns out of the store, and the response's worst case stays
   * `limit x 3 x bodyChars`, the same arithmetic the call list publishes.
   */
  bodyChars: v.optional(previewCharsSchema),
})
export type GetDebugLlmExportQuery = v.InferOutput<typeof getDebugLlmExportQuerySchema>

/**
 * A run's model activity as ONE self-describing document: the rollups, then the individual
 * calls behind them. Meant to be handed straight to a model ("why did this run truncate /
 * spend / stall?"), which is what the app's own export button produces for a human doing the
 * same thing, and what an external caller previously had to assemble from the overview plus a
 * walk of the call list.
 *
 * Two properties are worth reading before quoting a number off it:
 *
 * - **The rollups are COMPLETE, the call rows are a window.** `totals`, `byAgentKind` and
 *   `byPhase` are SQL aggregates over every recorded call in the run and do not move with
 *   `limit`; `calls` is the bounded slice `limit`/`order` asked for. So a truncated bundle
 *   still reports what the run actually cost, which the internal export cannot (it folds its
 *   numbers from the rows it holds, and declines to price them at all once they are a slice).
 * - **`truncated` is stated, never inferred.** A reader who does not know the cap cannot tell
 *   a complete bundle from a windowed one, and this is exactly the document where a partial
 *   sum gets quoted as a whole.
 * - **`available` separates "nothing recorded" from "nothing happened".** Same fact the run
 *   overview publishes as `sinks.llmCalls.available`, and needed here for a stronger reason:
 *   this bundle is composed to be handed straight to a model, and a deployment that retains no
 *   LLM telemetry would otherwise produce a document byte-identical to a run that made no
 *   model calls at all, which reads as a diagnosis.
 */
export const debugLlmExportSchema = v.object({
  /** Schema marker so a consuming model knows the shape without external docs. */
  kind: v.literal('cat-factory.run-llm-export'),
  version: v.literal(1),
  runId: v.string(),
  /** When this bundle was composed (epoch ms). */
  generatedAt: v.number(),
  /**
   * Whether this deployment retains LLM telemetry at all: REPOSITORY presence, the same
   * reading as {@link debugSinkStatusSchema}'s own field, so `false` means every number below
   * is an absence of RECORDS rather than an absence of activity.
   *
   * Carried as a bare boolean rather than a second `debugSinkStatus`, because the count this
   * sink's status would pair it with is already `llm.totals.calls`, aggregated in the same
   * pass. A second copy of one number could only ever be a second read of the same rows.
   *
   * The capture-time gates (`LLM_RECORD_PROMPTS`, the per-workspace `storeAgentContext`) are
   * invisible here exactly as they are on the overview: a workspace that opted out of body
   * capture still reads `true`, with its call rows carrying no bodies.
   */
  available: v.boolean(),
  /**
   * The run's model activity, aggregated in SQL over EVERY recorded call: the same fold the
   * run overview publishes, from the same rollup, so the two documents cannot disagree.
   */
  llm: v.object({
    totals: llmExportTotalsSchema,
    byAgentKind: v.array(llmExportInsightSchema),
    byPhase: v.array(llmPhaseInsightSchema),
    /**
     * ISO 4217 currency every `costEstimate` above is denominated in, or null when this
     * deployment prices nothing (in which case those costs are null too).
     */
    costCurrency: v.nullable(v.string()),
  }),
  /** Which end of the run {@link debugLlmExportSchema.entries.calls} was taken from. */
  order: debugLlmExportOrderSchema,
  /**
   * True when the run holds more calls than `limit`, so `calls` covers only the `order` end of
   * it. The rollups above are unaffected; page the full sequence through
   * `GET /api/v1/debug/runs/:runId/llm-calls`, which is resumable.
   */
  truncated: v.boolean(),
  /** The individual calls, in `order`, with bodies only where `bodyChars` asked for them. */
  calls: v.array(debugLlmCallSchema),
})
export type DebugLlmExport = v.InferOutput<typeof debugLlmExportSchema>
