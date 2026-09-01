import {
  type Clock,
  type IdGenerator,
  type StoreAgentContextGate,
  createStoreAgentContextGate,
  noopLogger,
  normalizeCallPhase,
  priceRollupCells,
  redactSecrets,
  runBestEffort,
} from '@cat-factory/kernel'
import type {
  GroupCacheHandle,
  InlineLlmCall,
  Logger,
  HarnessCallMetric,
  LlmCallMetric,
  LlmCallMetricRepository,
  LlmRollupCell,
  LlmRateResolver,
  LlmTraceSink,
  WorkspaceSettingsCacheValue,
  WorkspaceSettingsRepository,
} from '@cat-factory/kernel'
import type { ExecutionInstance, LlmMetricsExport } from '@cat-factory/contracts'
import type { StoredPrompt } from './observability.logic.js'
import { buildLlmMetricsExport, computeStoredPrompt } from './observability.logic.js'
import { buildRunTraceSpans } from './runTraceSpans.logic.js'

export interface LlmObservabilityServiceDependencies {
  llmCallMetricRepository: LlmCallMetricRepository
  idGenerator: IdGenerator
  clock: Clock
  /**
   * Whether to persist the full text bodies with each metric. Defaults to true. When
   * false, every numeric field (tokens, timing, finish reason, message/tool counts)
   * is still recorded but the prompt AND the response/reasoning bodies are stored empty
   * — for deployments that must not retain the model content (prompts sent or replies
   * received). Governed by `LLM_RECORD_PROMPTS`.
   */
  recordPrompts?: boolean
  /**
   * Optional external trace sink (e.g. Langfuse). When wired, every recorded call is
   * ALSO emitted here as a generation — the same code path the inline executor's
   * instrumented model provider feeds, so proxied and inline calls land in one place.
   * Fan-out is best-effort and never blocks or breaks the local recording.
   */
  traceSink?: LlmTraceSink
  /**
   * Optional per-workspace settings source. When wired, prompt/response BODY capture is
   * ALSO gated on the workspace's `storeAgentContext` toggle (mirroring the agent-context
   * snapshot path), so a workspace that opted out doesn't retain prompt bodies here even
   * when prompt recording is on deployment-wide. Numeric telemetry is always recorded.
   * Absent ⇒ gate only on {@link recordPrompts} (existing behaviour).
   */
  workspaceSettingsRepository?: WorkspaceSettingsRepository
  /**
   * The shared {@link AppCaches.workspaceSettings} slice. When wired alongside the settings
   * repository, the shared body-capture gate resolves the row through it — this read runs per
   * recorded LLM call, so caching it (invalidated by `WorkspaceSettingsService.update`)
   * avoids a DB read per call. Absent ⇒ read live.
   */
  workspaceSettingsCache?: GroupCacheHandle<WorkspaceSettingsCacheValue>
  /**
   * Where the trace-sink fan-out below reports a drop. Absent ⇒ `noopLogger`, which is what a
   * unit test constructing this service standalone gets.
   */
  logger?: Logger
  /**
   * Per-1M rates for a `(provider, model)`, from the deployment's spend price table. Wired
   * here — rather than at each of the two rollup consumers — because both must agree on what a
   * run cost, and the store cannot answer it: a price table is configuration, not SQL.
   *
   * Absent ⇒ every rollup cell reports a NULL cost, which is the honest reading for a
   * deployment with no pricing wired and is distinct from a run that cost nothing.
   */
  modelRates?: LlmRateResolver
  /**
   * ISO 4217 currency {@link LlmObservabilityServiceDependencies.modelRates} is denominated in,
   * so a surface can LABEL the money it renders instead of assuming one. Travels with the rates
   * because it is a property of the same table: swapping the table's currency without the label
   * renders a correct number under the wrong symbol, which is worse than no number.
   */
  costCurrency?: string
}

/**
 * Defensive upper bound on a stored prompt/response body (characters). Real agent
 * prompts sit far below this; the cap exists only so a pathological body can't blow
 * past the store's per-row/value limit and make the whole metric fail to record
 * (which would drop the call from observability entirely). A truncated-but-recorded
 * body is strictly more useful than a silently dropped one.
 */
export const MAX_BODY_CHARS = 512 * 1024

/** Cap a body to {@link MAX_BODY_CHARS}, marking where it was cut. */
function clampBody(text: string): string {
  if (text.length <= MAX_BODY_CHARS) return text
  return `${text.slice(0, MAX_BODY_CHARS)}\n…[truncated ${text.length - MAX_BODY_CHARS} chars]`
}

/** Default cap on how many (newest) calls a list/export returns. */
const DEFAULT_LIST_LIMIT = 1000

/** What to store for a call's prompt when prompt recording is turned off: nothing. */
const EMPTY_STORED_PROMPT: StoredPrompt = { promptText: '', promptPrefixCount: 0, promptHash: '' }

/**
 * A prompt/response/reasoning body, either already in hand or resolvable on demand.
 *
 * Every use of a body here sits behind the `recordPrompts` + `storeAgentContext` gate, so a
 * deployment with prompt recording off (or a workspace that opted out) does work it then
 * discards: serialising a prompt array and scrubbing it, per call. A producer that HOLDS the
 * string passes it as one and nothing changes; a producer that would have to BUILD it passes
 * the thunk and pays only when the gate opens. The inline feeder is the case that matters —
 * it JSON-serialises the whole AI-SDK prompt, which on a judge or a reviewer carries a rubric
 * and a diff, inside a CPU-metered isolate.
 */
export type LlmCallBody = string | (() => string)

/** Resolve a {@link LlmCallBody}. Only ever called when the body is going to be kept. */
function resolveBody(body: LlmCallBody): string {
  return typeof body === 'string' ? body : body()
}

/**
 * Details of one proxied LLM call, handed in by the LLM proxy. The proxy owns the
 * timing (it wraps the upstream call): {@link totalMs} is the end-to-end time it
 * spent and {@link upstreamMs} the slice waiting on the model — the difference is
 * transport/proxy overhead, derived here so the two can never disagree.
 */
export interface RecordLlmCallInput {
  /**
   * The call's id. The proxy mints it so the same id is carried on the live `llmCall`
   * activity event AND this persisted row — the drill-down panel keys its lazy body
   * load by it. Optional: when omitted the service mints one (existing callers).
   */
  id?: string
  workspaceId: string
  executionId: string | null
  agentKind: string
  provider: string
  model: string
  streaming: boolean
  /**
   * Which slice of the run spent this call (`agent` / `validation-repair` / …), as reported by
   * the producer that owns the phase boundary. Normalised here through {@link normalizeCallPhase}
   * — the label reaches this service over HTTP on both producing paths (a proxy request path, a
   * runner pool's JSON), so neither may write the grouping key unchecked. Absent ⇒ `''`.
   */
  phase?: string
  /**
   * The call's 0-based ordinal in its job's telemetry sequence, when the producing channel has
   * one (the harness's job-scoped `seq`). Absent/undefined ⇒ null.
   */
  turnIndex?: number | null
  /**
   * TRUE when the row carries only tokens and stands for no model call, so `calls` excludes it
   * while every token sum keeps it. See {@link LlmCallMetric.spendOnly}. Absent ⇒ false: a
   * producer with no shortfall concept files calls.
   */
  spendOnly?: boolean
  /**
   * The gateway's own USD cost for this call, when the provider reports one (OpenRouter with
   * usage accounting on). Absent from every producer that does not report a cost, and absent is
   * NOT zero: see {@link LlmCallMetric.reportedCostUsd}.
   */
  reportedCostUsd?: number | null
  /** The upstream a gateway routed to; see {@link LlmCallMetric.upstreamProvider}. */
  upstreamProvider?: string | null
  messageCount: number
  toolCount: number
  requestMaxTokens: number | null
  /** FRESH (uncached) input tokens — exclusive of both cache classes below. */
  promptTokens: number
  /** Input tokens served from the provider's prefix cache. */
  cacheReadTokens: number
  /** Input tokens written into the provider's cache. */
  cacheWriteTokens: number
  completionTokens: number
  totalTokens: number
  finishReason: string | null
  /** End-to-end time the proxy spent on the call (ms). */
  totalMs: number
  /** Time spent waiting on the upstream model (ms). */
  upstreamMs: number
  ok: boolean
  httpStatus: number | null
  errorMessage: string | null
  promptText: LlmCallBody
  responseText: LlmCallBody
  /** The model's reasoning/thinking trace, when emitted on a separate channel (else ''). */
  reasoningText: LlmCallBody
}

/**
 * The LLM observability sink. The proxy meters every container-agent model call
 * here; the engine rolls the per-run aggregates onto pipeline steps for the board,
 * and a query endpoint lists the full per-call detail for the drill-down panel. It
 * is the observability sibling of {@link SpendService} (which keeps only billed
 * totals): this keeps the full prompt/response, the output-limit headroom and the
 * transport-vs-execution latency split. Wired only when a metric repository is
 * present, so tests and unconfigured facades are unaffected.
 */
export class LlmObservabilityService {
  private readonly repository: LlmCallMetricRepository
  private readonly idGenerator: IdGenerator
  private readonly clock: Clock
  private readonly recordPrompts: boolean
  private readonly traceSink?: LlmTraceSink
  /**
   * The per-workspace `storeAgentContext` half of the double gate, built from the SHARED kernel
   * factory the inline path also uses so the two cannot drift apart again — they already had,
   * and the inline half was exporting the bodies of a workspace that had opted out.
   */
  private readonly bodiesEnabled: StoreAgentContextGate
  private readonly log: Logger
  private readonly modelRates: LlmRateResolver | undefined
  private readonly costCurrency: string | undefined

  constructor({
    llmCallMetricRepository,
    idGenerator,
    clock,
    recordPrompts = true,
    traceSink,
    workspaceSettingsRepository,
    workspaceSettingsCache,
    logger,
    modelRates,
    costCurrency,
  }: LlmObservabilityServiceDependencies) {
    this.repository = llmCallMetricRepository
    this.idGenerator = idGenerator
    this.clock = clock
    this.recordPrompts = recordPrompts
    this.traceSink = traceSink
    this.bodiesEnabled = createStoreAgentContextGate({
      repository: workspaceSettingsRepository,
      cache: workspaceSettingsCache,
    })
    this.log = (logger ?? noopLogger).child({ service: 'llmObservability' })
    this.modelRates = modelRates
    this.costCurrency = costCurrency
  }

  /**
   * The currency this service's rollup costs are denominated in, or null when nothing prices
   * them. Read by the rollup consumers so the amount and its label come from ONE place.
   */
  get rollupCurrency(): string | null {
    return this.modelRates ? (this.costCurrency ?? null) : null
  }

  /**
   * Persist one metered call, assigning its id + timestamp and deriving the overhead.
   * When prompt recording is enabled, the prompt is stored as a DELTA against the
   * previous call in the same `(execution, agentKind)` conversation — a container
   * agent re-sends its whole growing history every call, so storing only the new
   * messages collapses ~21× of redundant prompt bytes (see `computeStoredPrompt`). The
   * full prompt is rebuilt on export. The chain-tip lookup is off the response path
   * (the proxy records via `waitUntil`), so the extra read is free of user latency.
   * When prompt recording is disabled (`recordPrompts: false`) the prompt body is
   * stored empty and the chain-tip read is skipped entirely — the numeric telemetry is
   * still recorded.
   */
  async record(rawInput: RecordLlmCallInput): Promise<void> {
    // Prompt/response BODIES are kept only when recording is on deployment-wide AND (when a
    // settings source is wired) the workspace hasn't opted out via `storeAgentContext` —
    // the same double gate the agent-context snapshot path uses. Numeric telemetry is
    // always recorded regardless.
    //
    // Resolved FIRST, before the bodies are touched at all: a body may be a thunk the
    // producer would rather not run (the inline feeder serialises the whole AI-SDK prompt),
    // and scrubbing a body this gate is about to drop is work nobody reads either way.
    const recordBodies = this.recordPrompts && (await this.bodiesEnabled(rawInput.workspaceId))
    // Unlike the agent-context snapshot (a structural allow-list), the prompt/response
    // bodies captured here are free text that can contain a credential the agent read or
    // echoed. Scrub known secret shapes BEFORE anything is stored, delta-chained, or
    // fanned out to the external trace sink — the redacted text is what every downstream
    // consumer sees. Done up front so the delta chain stays consistent (each tip is
    // already redacted) and Langfuse never receives a raw secret.
    const scrub = (body: LlmCallBody): string =>
      recordBodies ? (redactSecrets(resolveBody(body)) ?? '') : ''
    const input = {
      ...rawInput,
      promptText: scrub(rawInput.promptText),
      responseText: scrub(rawInput.responseText),
      reasoningText: scrub(rawInput.reasoningText),
      // errorMessage is a free-text upstream/proxy error string that is kept as diagnostic
      // metadata even when bodies are dropped (like httpStatus/finishReason) AND fanned out
      // to the trace sink — so it too must be scrubbed. An upstream 4xx/5xx message can
      // echo an `Authorization` header or a signed URL; redacting here keeps the one
      // exchange field that isn't gated on `recordBodies` from leaking a secret shape.
      errorMessage: redactSecrets(rawInput.errorMessage),
    }
    const overheadMs = Math.max(0, input.totalMs - input.upstreamMs)
    const stored = recordBodies
      ? await this.computeStoredPromptForChain(input)
      : EMPTY_STORED_PROMPT
    const metric: LlmCallMetric = {
      createdAt: this.clock.now(),
      ...input,
      // Derived/bounded fields last, so they win over any same-named input field.
      // `id` here (not above `...input`) so an absent `input.id` falls back to a mint
      // rather than being spread in as `undefined`.
      id: input.id ?? this.idGenerator.next('llm'),
      overheadMs,
      // Normalised to null rather than left as `undefined`: the row is persisted by two
      // repositories whose column is nullable, and an absent key would bind as SQL NULL on one
      // and be rejected on the other. `??` and not a truthiness test, because a genuinely free
      // call reports 0 and that is a fact worth keeping apart from "nobody said".
      reportedCostUsd: input.reportedCostUsd ?? null,
      upstreamProvider: input.upstreamProvider ?? null,
      phase: normalizeCallPhase(input.phase),
      turnIndex: input.turnIndex ?? null,
      spendOnly: input.spendOnly === true,
      promptText: clampBody(stored.promptText),
      promptPrefixCount: stored.promptPrefixCount,
      promptHash: stored.promptHash,
      // Response + reasoning are bodies too: drop them (not just the prompt) when body
      // recording is off, so an opted-out workspace / prompts-off deployment retains none
      // of the model exchange, only the numeric telemetry.
      responseText: recordBodies ? clampBody(input.responseText) : '',
      reasoningText: recordBodies ? clampBody(input.reasoningText) : '',
    }
    await this.repository.record(metric)
    // Fan out to the external trace sink (Langfuse), if wired. We send the FULL prompt
    // (not the stored delta) so the trace is self-contained, honouring the same
    // `recordPrompts` privacy switch as the local store. Best-effort and NON-blocking:
    // dispatched without awaiting (like the inline feeder) so the sink's network round
    // trip never extends the metering path, and isolated so a sink failure can't break
    // local recording. The sink itself swallows + logs and bounds its own request.
    const traceSink = this.traceSink
    if (traceSink) {
      const endedAt = metric.createdAt
      // One `runBestEffort` covers both halves of what used to be a `try` wrapping a
      // `.catch(() => {})`: it swallows a SYNCHRONOUS throw from the sink as well as a
      // rejected fan-out, and names whichever one happened.
      void runBestEffort(this.log, 'traceSink.recordGeneration', () =>
        Promise.resolve(
          traceSink.recordGeneration({
            workspaceId: input.workspaceId,
            executionId: input.executionId,
            agentKind: input.agentKind,
            provider: input.provider,
            model: input.model,
            startedAt: Math.max(0, endedAt - input.upstreamMs),
            endedAt,
            promptTokens: input.promptTokens,
            cacheReadTokens: input.cacheReadTokens,
            cacheWriteTokens: input.cacheWriteTokens,
            completionTokens: input.completionTokens,
            totalTokens: input.totalTokens,
            finishReason: input.finishReason,
            ok: input.ok,
            errorMessage: input.errorMessage,
            input: recordBodies ? input.promptText : '',
            // Fall back to the reasoning trace when the turn produced no response text
            // (a thinking model that spent its budget reasoning) so the trace isn't blank.
            output: recordBodies ? input.responseText || input.reasoningText : '',
          }),
        ),
      )
    }
  }

  /**
   * Close a settled run's external trace by emitting the PARENTS its generations and tool
   * spans have been naming all along: the run's root span and one span per agent kind that
   * ran. Called from the engine's single terminal hook, so a run reaching `done`/`failed` by
   * any of its four routes lands here exactly the same way.
   *
   * Best-effort and never throwing, like every other fan-out from this service: a trace whose
   * root is missing is a degraded trace, and must never be a failed run. A sink that groups by
   * something other than span parentage (Langfuse) simply omits the method and nothing here
   * changes for it.
   *
   * AWAITED, where the per-call `recordGeneration` fan-out above is deliberately not. The two
   * are on opposite sides of the same trade: a generation is one span among thousands on the
   * metering hot path, so its round trip must never extend that path, and losing one costs one
   * span. These are the PARENTS every other span of the run already named, they are emitted
   * once per run on a path that has already committed the run's state, and losing them orphans
   * the whole trace rather than thinning it. The wait is bounded by the sink's own per-request
   * timeout, and on the Worker it is also what keeps the export from being cut off when the
   * isolate finishes.
   */
  async recordRunTrace(workspaceId: string, instance: ExecutionInstance): Promise<void> {
    const traceSink = this.traceSink
    if (!traceSink?.recordRunSpans) return
    const spans = buildRunTraceSpans(workspaceId, instance)
    if (!spans) return
    await runBestEffort(this.log, 'traceSink.recordRunSpans', () =>
      Promise.resolve(traceSink.recordRunSpans?.(spans.run, spans.steps)),
    )
  }

  /**
   * Resolve this call's prompt to a delta against the chain tip of its
   * `(workspace, execution, agentKind)` conversation (or the full array when it can't
   * be chained). Only reached when prompt recording is enabled.
   */
  private async computeStoredPromptForChain(input: {
    workspaceId: string
    executionId: string | null
    agentKind: string
    /** Already resolved and scrubbed — a chain tip must never hold an unredacted body. */
    promptText: string
  }): Promise<StoredPrompt> {
    const prev =
      input.executionId != null
        ? await this.repository.latestChainTip(
            input.workspaceId,
            input.executionId,
            input.agentKind,
          )
        : null
    return computeStoredPrompt(input.promptText, prev)
  }

  /**
   * Calls recorded for a run, newest first (full prompt/response included), capped
   * at {@link DEFAULT_LIST_LIMIT} so a long run can't produce an unbounded payload.
   */
  listByExecution(
    workspaceId: string,
    executionId: string,
    limit: number = DEFAULT_LIST_LIMIT,
  ): Promise<LlmCallMetric[]> {
    return this.repository.listByExecution(workspaceId, executionId, limit)
  }

  /**
   * Per-`(agentKind, phase)` aggregates for a run, PRICED — the board step rollups and the
   * per-phase burn breakdown.
   *
   * The store groups one grain finer (it also splits by `(provider, model)`), because cost is a
   * function of the model and can only be computed while the model is still attached. This is
   * the ONE place that fold happens, so the board rollup and the debug overview cannot report
   * different money for the same run.
   */
  async summarizeByExecution(workspaceId: string, executionId: string): Promise<LlmRollupCell[]> {
    const cells = await this.repository.summarizeByExecution(workspaceId, executionId)
    // No rates wired ⇒ collapse the model dimension anyway, so every consumer sees the same
    // `(agentKind, phase)` shape regardless of whether this deployment can price it. The cost
    // stays null, which says "not priced here" rather than "cost nothing".
    return priceRollupCells(cells, this.modelRates)
  }

  /**
   * Build the LLM-friendly export for a run: a self-describing JSON bundle (totals +
   * per-agent insights + every call, with derived ratios) meant to be handed to a
   * model for analysis. Stamped with the service clock.
   */
  async exportForExecution(workspaceId: string, executionId: string): Promise<LlmMetricsExport> {
    // ONE row past the cap, so the bundle can SAY it is a slice instead of presenting the
    // newest 1000 calls as the whole run. A separate COUNT would be a second query for one
    // boolean, and inferring it from `calls.length === limit` guesses wrong on the run whose
    // call count lands exactly on the cap.
    const fetched = await this.listByExecution(workspaceId, executionId, DEFAULT_LIST_LIMIT + 1)
    const truncated = fetched.length > DEFAULT_LIST_LIMIT
    const calls = truncated ? fetched.slice(0, DEFAULT_LIST_LIMIT) : fetched
    // Priced from the SAME table the rollups use. The export costs each call individually
    // (it holds the rows), which is strictly finer than the rollup's per-cell arithmetic and
    // agrees with it: both price a class at its own tier. A truncated bundle prices nothing:
    // a slice's sum quoted as a run's cost is the failure the null rule exists to prevent.
    return buildLlmMetricsExport(executionId, calls, this.clock.now(), {
      rates: this.modelRates,
      truncated,
    })
  }
}

/** The per-job payload the container executor hands a subscription-harness telemetry recorder. */
export interface HarnessCallsRecordInput {
  workspaceId: string
  executionId: string | null
  agentKind: string
  /** The subscription vendor (claude/codex/glm/kimi/deepseek). */
  provider: string
  /** The dispatch model (`provider:model`); each call's own `model` wins when present. */
  model: string
  /**
   * The dispatch job id (per-step, deterministic across a durable driver's replays).
   * When present, each call's row is minted a deterministic id off it, so a replay that
   * re-runs the recorder inserts the SAME ids — a duplicate insert is rejected by the
   * store, leaving the run idempotent (no double rows, no mangled delta chain) even when
   * the executor's in-memory replay guard didn't survive an isolate eviction. Absent ⇒
   * the service mints a random id (fine for one-shot callers/tests).
   */
  jobId?: string
  calls: HarnessCallMetric[]
}

/**
 * Build the executor's `recordHarnessCalls` dependency: map a subscription harness's
 * per-call metrics (lifted from its CLI stream, bypassing the LLM proxy) onto the SAME
 * {@link LlmObservabilityService} the proxy feeds, so Claude Code / Codex calls land in
 * `llm_call_metrics` exactly like Pi's proxied calls. Records SEQUENTIALLY so the
 * prompt-delta chain (which reads the previous row's tip) stays ordered. The CLIs expose
 * no per-HTTP timing, so `totalMs`/`upstreamMs` are 0 (overhead derives 0); tool counts
 * aren't surfaced per call, so `toolCount` is 0. When a `jobId` is supplied each row is
 * minted a deterministic id (`<jobId>-hc-<seq>`) so RE-recording a call is a no-op at the
 * store rather than a duplicate row — which covers both a durable-driver replay and the
 * terminal write of calls the live poll drain already recorded.
 *
 * `seq` is the harness's job-scoped sequence number, stable across both channels a call
 * arrives on (the per-poll drain and the terminal result list). It falls back to the position
 * in this batch only for an older harness image that streams nothing — there the terminal list
 * is the sole channel, so its indices are already job-scoped.
 *
 * A metric flagged {@link HarnessCallMetric.standsForJob} is filed with a NULL `turnIndex`: it
 * carries the job's unattributed remainder rather than a turn, and a reader ordering a step's
 * calls by turn must not be handed a position it never occupied. Its ID still comes from `seq`,
 * so idempotency is unaffected — the same split `CliInlineLanguageModel` makes between its
 * per-call rows and its one step-level row.
 *
 * Whether that row is also a SPEND CORRECTION rather than a call is a SECOND question, and it is
 * read off {@link HarnessCallMetric.spendOnly} rather than re-derived from `standsForJob`: a
 * shortfall row filed by a CLI that narrated no turns at all is the job's only record and IS its
 * call. Deriving it here from the batch (`calls.some(c => !c.standsForJob)`) would get that wrong
 * in the routine case, since a job's calls arrive in the BATCHES the live drain delivers them in
 * and the terminal batch is regularly this row alone.
 */
export function makeHarnessCallRecorder(
  service: LlmObservabilityService,
): (input: HarnessCallsRecordInput) => Promise<void> {
  return async ({ workspaceId, executionId, agentKind, provider, model, jobId, calls }) => {
    for (const [index, call] of calls.entries()) {
      // `seq` is BOTH the row-id key and the turn ordinal, so they cannot drift apart: a
      // rollup ordering a phase's calls by turn sees exactly the sequence the ids encode.
      const turnIndex = call.seq ?? index
      await service.record({
        ...(jobId ? { id: `${jobId}-hc-${turnIndex}` } : {}),
        workspaceId,
        executionId,
        agentKind,
        provider,
        model: call.model ?? model,
        streaming: true,
        // Absent on an older harness image (no phase marker at all), which normalises to the
        // unattributed slice rather than being guessed at from the agent kind.
        ...(call.phase !== undefined ? { phase: call.phase } : {}),
        turnIndex: call.standsForJob ? null : turnIndex,
        // The producer's own answer, persisted so a rollup can act on it. A NULL `turnIndex`
        // cannot carry it: a plain inline call has one too, so a reader could not tell "no turn to
        // report" from "no call happened". Nor can `standsForJob` stand in — see above.
        spendOnly: call.spendOnly === true,
        messageCount: call.messageCount,
        toolCount: 0,
        requestMaxTokens: null,
        promptTokens: call.inputTokens,
        cacheReadTokens: call.cacheReadTokens,
        cacheWriteTokens: call.cacheWriteTokens,
        completionTokens: call.outputTokens,
        totalTokens:
          call.inputTokens + call.cacheReadTokens + call.cacheWriteTokens + call.outputTokens,
        finishReason: call.finishReason,
        totalMs: 0,
        upstreamMs: 0,
        ok: true,
        httpStatus: null,
        errorMessage: null,
        promptText: call.promptText,
        responseText: call.responseText,
        reasoningText: call.reasoningText,
      })
    }
  }
}

/**
 * Build the instrumented model provider's `recordCall` dependency: map an INLINE (non-proxied)
 * LLM call onto the SAME {@link LlmObservabilityService} the proxy and the subscription
 * harnesses feed, so a judge, a consensus round, the requirements writer or an inline agent
 * kind (`doc-researcher`, `doc-outliner`, the document interviewer) lands in `llm_call_metrics`
 * exactly like a container call. Before this, every one of those was invisible to
 * `ObservabilityPanel`, to a step's token rollup and to `/api/v1/debug/*` — a run made entirely
 * of inline steps reported zero model activity no matter how many tokens it spent
 * (`docs/initiatives/observability-logging-gaps.md`, C2 coverage half).
 *
 * The sibling of {@link makeHarnessCallRecorder}, and it fills the store's proxy-shaped fields
 * the same deliberate way — with what an inline call actually knows rather than a plausible
 * guess:
 *
 * - `id` is left to the service to mint. The proxy mints its own so the live activity event and
 *   the row share one, and the harness derives one from `(jobId, seq)` so a durable replay is
 *   idempotent. An inline call has neither: it is a single awaited SDK call inside one service
 *   method, so there is no second channel to reconcile with and nothing to re-record.
 * - `streaming` is false — every inline site calls `generateText`, never `streamText`.
 * - `phase` is left absent ⇒ the unattributed `''` slice. Phases are boundaries the HARNESS
 *   owns inside a container run; an inline call sits outside all of them, and stamping one
 *   would file it under a loop it never ran in.
 * - `turnIndex` is null for a plain `generateText`, like the proxy's: there is no job-scoped
 *   counter there either, so those rows order by `createdAt`. An inline step served by a HARNESS
 *   CLI does have one — the CLI runs a tool loop behind the single SDK call and reports each
 *   model call it made — and passes it, so a run's inline turns order by turn like a container
 *   step's do.
 * - `httpStatus` is null: the AI SDK owns the transport, so a failure arrives as an exception
 *   whose message is already on `errorMessage` (scrubbed by the service) rather than a status.
 * - `upstreamMs` is the whole `durationMs`, which makes the derived overhead 0 — honestly so.
 *   Splitting transport from execution is the PROXY's observation; an inline call has no hop
 *   between the caller and the model, so any non-zero overhead here would be fabricated.
 *
 * Two consequences of sharing the store with the other two producers, both already safe:
 *
 * - **The delta chain is keyed `(workspace, execution, agentKind)`, which an inline call can
 *   share with a proxied or harness one** — an inline judge and a container agent under one
 *   run and one kind. Their prompts are different shapes entirely (the AI-SDK prompt array vs
 *   the vendor wire messages), but `computeStoredPrompt` HASH-VERIFIES the tip's prefix before
 *   eliding it, so a cross-producer tip degrades to storing the full array rather than
 *   corrupting a reconstruction. Interleaving costs compression, never correctness.
 * - **The bodies are passed as THUNKS**, so a deployment with `LLM_RECORD_PROMPTS` off (or a
 *   workspace that opted out) never pays to serialise a prompt the service is about to drop.
 *   The gate stays in ONE place — inside `record`, which resolves it before touching a body.
 */
export function makeInlineCallRecorder(
  service: LlmObservabilityService,
): (call: InlineLlmCall) => Promise<void> {
  return (call) =>
    service.record({
      workspaceId: call.workspaceId,
      executionId: call.executionId,
      agentKind: call.agentKind,
      provider: call.provider,
      model: call.model,
      streaming: false,
      turnIndex: call.turnIndex ?? null,
      spendOnly: call.spendOnly === true,
      reportedCostUsd: call.reportedCostUsd ?? null,
      upstreamProvider: call.upstreamProvider ?? null,
      messageCount: call.messageCount,
      toolCount: call.toolCount,
      requestMaxTokens: call.requestMaxTokens,
      promptTokens: call.promptTokens,
      cacheReadTokens: call.cacheReadTokens,
      cacheWriteTokens: call.cacheWriteTokens,
      completionTokens: call.completionTokens,
      totalTokens: call.totalTokens,
      finishReason: call.finishReason,
      totalMs: call.durationMs,
      upstreamMs: call.durationMs,
      ok: call.ok,
      httpStatus: null,
      errorMessage: call.errorMessage,
      promptText: call.promptText,
      responseText: call.responseText,
      reasoningText: call.reasoningText,
    })
}
