import type { Clock, IdGenerator } from '@cat-factory/kernel'
import type {
  HarnessCallMetric,
  LlmCallMetric,
  LlmCallMetricRepository,
  LlmCallMetricSummary,
  LlmTraceSink,
} from '@cat-factory/kernel'
import type { LlmMetricsExport } from '@cat-factory/contracts'
import type { StoredPrompt } from './observability.logic.js'
import { buildLlmMetricsExport, computeStoredPrompt } from './observability.logic.js'

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
export const DEFAULT_LIST_LIMIT = 1000

/** What to store for a call's prompt when prompt recording is turned off: nothing. */
const EMPTY_STORED_PROMPT: StoredPrompt = { promptText: '', promptPrefixCount: 0, promptHash: '' }

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
  messageCount: number
  toolCount: number
  requestMaxTokens: number | null
  promptTokens: number
  cachedPromptTokens: number
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
  promptText: string
  responseText: string
  /** The model's reasoning/thinking trace, when emitted on a separate channel (else ''). */
  reasoningText: string
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

  constructor({
    llmCallMetricRepository,
    idGenerator,
    clock,
    recordPrompts = true,
    traceSink,
  }: LlmObservabilityServiceDependencies) {
    this.repository = llmCallMetricRepository
    this.idGenerator = idGenerator
    this.clock = clock
    this.recordPrompts = recordPrompts
    this.traceSink = traceSink
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
  async record(input: RecordLlmCallInput): Promise<void> {
    const overheadMs = Math.max(0, input.totalMs - input.upstreamMs)
    const stored = this.recordPrompts
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
      promptText: clampBody(stored.promptText),
      promptPrefixCount: stored.promptPrefixCount,
      promptHash: stored.promptHash,
      // The privacy switch governs ALL captured bodies, not just the prompt: a response
      // (which can echo verbatim repo source) and a reasoning trace are model content the
      // same as the prompt, so both are stored empty when recording is off.
      responseText: this.recordPrompts ? clampBody(input.responseText) : '',
      reasoningText: this.recordPrompts ? clampBody(input.reasoningText) : '',
    }
    await this.repository.record(metric)
    // Fan out to the external trace sink (Langfuse), if wired. We send the FULL prompt
    // (not the stored delta) so the trace is self-contained, honouring the same
    // `recordPrompts` privacy switch as the local store. Best-effort and NON-blocking:
    // dispatched without awaiting (like the inline feeder) so the sink's network round
    // trip never extends the metering path, and isolated so a sink failure can't break
    // local recording. The sink itself swallows + logs and bounds its own request.
    if (this.traceSink) {
      const endedAt = metric.createdAt
      try {
        void Promise.resolve(
          this.traceSink.recordGeneration({
            workspaceId: input.workspaceId,
            executionId: input.executionId,
            agentKind: input.agentKind,
            provider: input.provider,
            model: input.model,
            startedAt: Math.max(0, endedAt - input.upstreamMs),
            endedAt,
            promptTokens: input.promptTokens,
            completionTokens: input.completionTokens,
            totalTokens: input.totalTokens,
            finishReason: input.finishReason,
            ok: input.ok,
            errorMessage: input.errorMessage,
            input: this.recordPrompts ? input.promptText : '',
            // Fall back to the reasoning trace when the turn produced no response text
            // (a thinking model that spent its budget reasoning) so the trace isn't blank.
            output: this.recordPrompts ? input.responseText || input.reasoningText : '',
          }),
        ).catch(() => {})
      } catch {
        // Swallowed: the sink itself logs; observability never breaks the proxy.
      }
    }
  }

  /**
   * Resolve this call's prompt to a delta against the chain tip of its
   * `(workspace, execution, agentKind)` conversation (or the full array when it can't
   * be chained). Only reached when prompt recording is enabled.
   */
  private async computeStoredPromptForChain(input: RecordLlmCallInput): Promise<StoredPrompt> {
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

  /** Per-agent-kind aggregates for a run, for the board step rollups. */
  summarizeByExecution(workspaceId: string, executionId: string): Promise<LlmCallMetricSummary[]> {
    return this.repository.summarizeByExecution(workspaceId, executionId)
  }

  /**
   * Build the LLM-friendly export for a run: a self-describing JSON bundle (totals +
   * per-agent insights + every call, with derived ratios) meant to be handed to a
   * model for analysis. Stamped with the service clock.
   */
  async exportForExecution(workspaceId: string, executionId: string): Promise<LlmMetricsExport> {
    const calls = await this.listByExecution(workspaceId, executionId)
    return buildLlmMetricsExport(executionId, calls, this.clock.now())
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
 * minted a deterministic id (`<jobId>-hc-<index>`) so a durable-driver replay re-records
 * idempotently (duplicate ids are rejected by the store) rather than duplicating rows.
 */
export function makeHarnessCallRecorder(
  service: LlmObservabilityService,
): (input: HarnessCallsRecordInput) => Promise<void> {
  return async ({ workspaceId, executionId, agentKind, provider, model, jobId, calls }) => {
    for (const [index, call] of calls.entries()) {
      await service.record({
        ...(jobId ? { id: `${jobId}-hc-${index}` } : {}),
        workspaceId,
        executionId,
        agentKind,
        provider,
        model: call.model ?? model,
        streaming: true,
        messageCount: call.messageCount,
        toolCount: 0,
        requestMaxTokens: null,
        promptTokens: call.inputTokens,
        cachedPromptTokens: call.cachedInputTokens,
        completionTokens: call.outputTokens,
        totalTokens: call.inputTokens + call.outputTokens,
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
