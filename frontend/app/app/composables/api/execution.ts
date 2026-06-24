import type { Block, ExecutionInstance } from '~/types/domain'
import type {
  IterationCapChoice,
  LlmCallMetric,
  LlmMetricsExport,
  ReviewComment,
} from '~/types/execution'
import type { ApiContext } from './context'

/** Run lifecycle (start/cancel/decisions/approvals/restart) + LLM metrics + spend. */
export function executionApi({ http, ws, pwHeaders }: ApiContext) {
  return {
    // ---- executions -------------------------------------------------------
    startExecution: (
      workspaceId: string,
      blockId: string,
      body: { pipelineId: string },
      password?: string,
    ) =>
      http<ExecutionInstance>(`${ws(workspaceId)}/blocks/${blockId}/executions`, {
        method: 'POST',
        body,
        headers: pwHeaders(password),
      }),

    cancelExecution: (workspaceId: string, blockId: string) =>
      http<Block>(`${ws(workspaceId)}/blocks/${blockId}/executions`, { method: 'DELETE' }),

    mergeBlock: (workspaceId: string, blockId: string) =>
      http<Block>(`${ws(workspaceId)}/blocks/${blockId}/merge`, { method: 'POST' }),

    resolveDecision: (
      workspaceId: string,
      executionId: string,
      decisionId: string,
      body: { choice: string },
      password?: string,
    ) =>
      http<ExecutionInstance>(
        `${ws(workspaceId)}/executions/${executionId}/decisions/${decisionId}`,
        { method: 'POST', body, headers: pwHeaders(password) },
      ),

    approveStep: (
      workspaceId: string,
      executionId: string,
      approvalId: string,
      body: { proposal?: string },
      password?: string,
    ) =>
      http<ExecutionInstance>(
        `${ws(workspaceId)}/executions/${executionId}/steps/${approvalId}/approve`,
        { method: 'POST', body, headers: pwHeaders(password) },
      ),

    requestStepChanges: (
      workspaceId: string,
      executionId: string,
      approvalId: string,
      body: { feedback?: string; comments?: ReviewComment[] },
      password?: string,
    ) =>
      http<ExecutionInstance>(
        `${ws(workspaceId)}/executions/${executionId}/steps/${approvalId}/request-changes`,
        { method: 'POST', body, headers: pwHeaders(password) },
      ),

    rejectStep: (
      workspaceId: string,
      executionId: string,
      approvalId: string,
      body: { reason?: string },
    ) =>
      http<ExecutionInstance>(
        `${ws(workspaceId)}/executions/${executionId}/steps/${approvalId}/reject`,
        { method: 'POST', body },
      ),

    // Resolve a companion step parked at its rework cap: one more round / proceed /
    // stop & reset (the companion analogue of resolveRequirementsExceeded).
    resolveCompanionExceeded: (
      workspaceId: string,
      executionId: string,
      approvalId: string,
      body: { choice: IterationCapChoice },
      password?: string,
    ) =>
      http<ExecutionInstance>(
        `${ws(workspaceId)}/executions/${executionId}/steps/${approvalId}/resolve-exceeded`,
        { method: 'POST', body, headers: pwHeaders(password) },
      ),

    // Restart a run from a chosen step: re-run from `fromStepIndex` onward (resetting
    // that step + later steps' iteration counters) while keeping the earlier steps'
    // outputs as handoff context. Like retry it may need the initiator's personal
    // password for an individual-usage (Claude) block, prompted + retried on a 428.
    restartFromStep: (
      workspaceId: string,
      executionId: string,
      fromStepIndex: number,
      password?: string,
    ) =>
      http<ExecutionInstance>(`${ws(workspaceId)}/executions/${executionId}/restart`, {
        method: 'POST',
        body: { fromStepIndex },
        headers: pwHeaders(password),
      }),

    // ---- LLM observability (per-run model-call metrics) -------------------
    // The full per-call detail behind the board's step rollups. Empty when the
    // observability sink is not wired.
    getLlmMetrics: (workspaceId: string, executionId: string) =>
      http<{ executionId: string; calls: LlmCallMetric[] }>(
        `${ws(workspaceId)}/executions/${encodeURIComponent(executionId)}/llm-metrics`,
      ),

    // The LLM-friendly export bundle (totals + per-agent insights + every call).
    exportLlmMetrics: (workspaceId: string, executionId: string) =>
      http<LlmMetricsExport>(
        `${ws(workspaceId)}/executions/${encodeURIComponent(executionId)}/llm-metrics/export`,
      ),

    // ---- spend safeguard --------------------------------------------------
    resumeSpend: (workspaceId: string) =>
      http<ExecutionInstance[]>(`${ws(workspaceId)}/spend/resume`, { method: 'POST' }),
  }
}
