import {
  LLM_WARNING_FINISH_REASONS,
  type LlmCallMetric,
  type LlmCallMetricRepository,
  type LlmCallMetricSummary,
} from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'

// `length` and `content_filter` as a SQL list literal, derived from the shared
// constant so the warning classification matches the service + the Node store.
const WARNING_REASONS_SQL = LLM_WARNING_FINISH_REASONS.map((r) => `'${r}'`).join(', ')

interface MetricRow {
  id: string
  workspace_id: string
  execution_id: string | null
  agent_kind: string
  provider: string
  model: string
  created_at: number
  streaming: number
  message_count: number
  tool_count: number
  request_max_tokens: number | null
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  finish_reason: string | null
  upstream_ms: number
  overhead_ms: number
  total_ms: number
  ok: number
  http_status: number | null
  error_message: string | null
  prompt_text: string
  response_text: string
}

function rowToMetric(row: MetricRow): LlmCallMetric {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    executionId: row.execution_id,
    agentKind: row.agent_kind,
    provider: row.provider,
    model: row.model,
    createdAt: row.created_at,
    streaming: row.streaming === 1,
    messageCount: row.message_count,
    toolCount: row.tool_count,
    requestMaxTokens: row.request_max_tokens,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    totalTokens: row.total_tokens,
    finishReason: row.finish_reason,
    upstreamMs: row.upstream_ms,
    overheadMs: row.overhead_ms,
    totalMs: row.total_ms,
    ok: row.ok === 1,
    httpStatus: row.http_status,
    errorMessage: row.error_message,
    promptText: row.prompt_text,
    responseText: row.response_text,
  }
}

/** D1-backed sink for LLM observability (see migration 0026). */
export class D1LlmCallMetricRepository implements LlmCallMetricRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async record(metric: LlmCallMetric): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO llm_call_metrics
           (id, workspace_id, execution_id, agent_kind, provider, model, created_at,
            streaming, message_count, tool_count, request_max_tokens,
            prompt_tokens, completion_tokens, total_tokens, finish_reason,
            upstream_ms, overhead_ms, total_ms, ok, http_status, error_message,
            prompt_text, response_text)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        metric.id,
        metric.workspaceId,
        metric.executionId,
        metric.agentKind,
        metric.provider,
        metric.model,
        metric.createdAt,
        metric.streaming ? 1 : 0,
        metric.messageCount,
        metric.toolCount,
        metric.requestMaxTokens,
        metric.promptTokens,
        metric.completionTokens,
        metric.totalTokens,
        metric.finishReason,
        metric.upstreamMs,
        metric.overheadMs,
        metric.totalMs,
        metric.ok ? 1 : 0,
        metric.httpStatus,
        metric.errorMessage,
        metric.promptText,
        metric.responseText,
      )
      .run()
  }

  async listByExecution(workspaceId: string, executionId: string): Promise<LlmCallMetric[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM llm_call_metrics
         WHERE workspace_id = ? AND execution_id = ?
         ORDER BY created_at DESC, id DESC`,
      )
      .bind(workspaceId, executionId)
      .all<MetricRow>()
    return (results ?? []).map(rowToMetric)
  }

  async summarizeByExecution(
    workspaceId: string,
    executionId: string,
  ): Promise<LlmCallMetricSummary[]> {
    // Aggregate-only: deliberately selects no prompt/response text, so this stays
    // cheap to run on every execution emit (it backs the live board rollups).
    const { results } = await this.db
      .prepare(
        `SELECT
           agent_kind                                                   AS agent_kind,
           COUNT(*)                                                     AS calls,
           COALESCE(SUM(prompt_tokens), 0)                              AS prompt_tokens,
           COALESCE(SUM(completion_tokens), 0)                          AS completion_tokens,
           COALESCE(MAX(completion_tokens), 0)                          AS peak_completion_tokens,
           MAX(request_max_tokens)                                      AS max_output_tokens,
           COALESCE(SUM(CASE WHEN finish_reason = 'length' THEN 1 ELSE 0 END), 0)         AS truncated_calls,
           COALESCE(SUM(upstream_ms), 0)                                AS upstream_ms,
           COALESCE(SUM(overhead_ms), 0)                                AS overhead_ms,
           COALESCE(SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END), 0)         AS errors,
           COALESCE(SUM(CASE WHEN ok = 1 AND finish_reason IN (${WARNING_REASONS_SQL}) THEN 1 ELSE 0 END), 0) AS warnings
         FROM llm_call_metrics
         WHERE workspace_id = ? AND execution_id = ?
         GROUP BY agent_kind`,
      )
      .bind(workspaceId, executionId)
      .all<{
        agent_kind: string
        calls: number
        prompt_tokens: number
        completion_tokens: number
        peak_completion_tokens: number
        max_output_tokens: number | null
        truncated_calls: number
        upstream_ms: number
        overhead_ms: number
        errors: number
        warnings: number
      }>()
    return (results ?? []).map((r) => ({
      agentKind: r.agent_kind,
      calls: r.calls,
      promptTokens: r.prompt_tokens,
      completionTokens: r.completion_tokens,
      peakCompletionTokens: r.peak_completion_tokens,
      maxOutputTokens: r.max_output_tokens,
      truncatedCalls: r.truncated_calls,
      upstreamMs: r.upstream_ms,
      overheadMs: r.overhead_ms,
      errors: r.errors,
      warnings: r.warnings,
    }))
  }

  async deleteOlderThan(epochMs: number): Promise<number> {
    // Range delete on idx_llm_call_metrics_created; bounded by the rows being pruned.
    const { meta } = await this.db
      .prepare('DELETE FROM llm_call_metrics WHERE created_at < ?')
      .bind(epochMs)
      .run()
    return meta.changes ?? 0
  }
}
