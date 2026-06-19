import type { Clock, IdGenerator } from '@cat-factory/kernel'
import type {
  LlmCallMetric,
  LlmCallMetricRepository,
  LlmCallMetricSummary,
} from '@cat-factory/kernel'
import type { LlmMetricsExport } from '@cat-factory/contracts'
import { buildLlmMetricsExport, computeStoredPrompt } from './observability.logic.js'

export interface LlmObservabilityServiceDependencies {
  llmCallMetricRepository: LlmCallMetricRepository
  idGenerator: IdGenerator
  clock: Clock
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

/**
 * Details of one proxied LLM call, handed in by the LLM proxy. The proxy owns the
 * timing (it wraps the upstream call): {@link totalMs} is the end-to-end time it
 * spent and {@link upstreamMs} the slice waiting on the model — the difference is
 * transport/proxy overhead, derived here so the two can never disagree.
 */
export interface RecordLlmCallInput {
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

  constructor({
    llmCallMetricRepository,
    idGenerator,
    clock,
  }: LlmObservabilityServiceDependencies) {
    this.repository = llmCallMetricRepository
    this.idGenerator = idGenerator
    this.clock = clock
  }

  /**
   * Persist one metered call, assigning its id + timestamp and deriving the overhead.
   * The prompt is stored as a DELTA against the previous call in the same
   * `(execution, agentKind)` conversation — a container agent re-sends its whole
   * growing history every call, so storing only the new messages collapses ~21× of
   * redundant prompt bytes (see `computeStoredPrompt`). The full prompt is rebuilt on
   * export. The chain-tip lookup is off the response path (the proxy records via
   * `waitUntil`), so the extra read is free of user latency.
   */
  async record(input: RecordLlmCallInput): Promise<void> {
    const overheadMs = Math.max(0, input.totalMs - input.upstreamMs)
    const prev =
      input.executionId != null
        ? await this.repository.latestChainTip(
            input.workspaceId,
            input.executionId,
            input.agentKind,
          )
        : null
    const stored = computeStoredPrompt(input.promptText, prev)
    const metric: LlmCallMetric = {
      id: this.idGenerator.next('llm'),
      createdAt: this.clock.now(),
      ...input,
      // Derived/bounded fields last, so they win over any same-named input field.
      overheadMs,
      promptText: clampBody(stored.promptText),
      promptPrefixCount: stored.promptPrefixCount,
      promptHash: stored.promptHash,
      responseText: clampBody(input.responseText),
    }
    await this.repository.record(metric)
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
