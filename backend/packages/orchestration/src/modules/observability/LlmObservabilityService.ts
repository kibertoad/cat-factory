import type { Clock, IdGenerator } from '@cat-factory/kernel'
import type {
  LlmCallMetric,
  LlmCallMetricRepository,
  LlmCallMetricSummary,
} from '@cat-factory/kernel'
import type { LlmMetricsExport } from '@cat-factory/contracts'
import { buildLlmMetricsExport } from './observability.logic.js'

export interface LlmObservabilityServiceDependencies {
  llmCallMetricRepository: LlmCallMetricRepository
  idGenerator: IdGenerator
  clock: Clock
}

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

  constructor({ llmCallMetricRepository, idGenerator, clock }: LlmObservabilityServiceDependencies) {
    this.repository = llmCallMetricRepository
    this.idGenerator = idGenerator
    this.clock = clock
  }

  /** Persist one metered call, assigning its id + timestamp and deriving the overhead. */
  async record(input: RecordLlmCallInput): Promise<void> {
    const overheadMs = Math.max(0, input.totalMs - input.upstreamMs)
    const metric: LlmCallMetric = {
      id: this.idGenerator.next('llm'),
      createdAt: this.clock.now(),
      overheadMs,
      ...input,
    }
    await this.repository.record(metric)
  }

  /** Every call recorded for a run, newest first (full prompt/response included). */
  listByExecution(workspaceId: string, executionId: string): Promise<LlmCallMetric[]> {
    return this.repository.listByExecution(workspaceId, executionId)
  }

  /** Per-agent-kind aggregates for a run, for the board step rollups. */
  summarizeByExecution(
    workspaceId: string,
    executionId: string,
  ): Promise<LlmCallMetricSummary[]> {
    return this.repository.summarizeByExecution(workspaceId, executionId)
  }

  /**
   * Build the LLM-friendly export for a run: a self-describing JSON bundle (totals +
   * per-agent insights + every call, with derived ratios) meant to be handed to a
   * model for analysis. Stamped with the service clock.
   */
  async exportForExecution(workspaceId: string, executionId: string): Promise<LlmMetricsExport> {
    const calls = await this.repository.listByExecution(workspaceId, executionId)
    return buildLlmMetricsExport(executionId, calls, this.clock.now())
  }
}
