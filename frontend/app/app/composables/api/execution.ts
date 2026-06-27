import {
  approveStepContract,
  cancelExecutionContract,
  exportExecutionLlmMetricsContract,
  getExecutionAgentContextContract,
  getExecutionLlmMetricsContract,
  mergeBlockContract,
  rejectStepContract,
  requestStepChangesContract,
  resolveDecisionContract,
  resolveStepExceededContract,
  restartExecutionContract,
  resumeSpendContract,
  startExecutionContract,
} from '@cat-factory/contracts'
import type { RequestStepChangesInput } from '@cat-factory/contracts'
import type { IterationCapChoice } from '~/types/execution'
import type { ApiContext } from './context'

/** Run lifecycle (start/cancel/decisions/approvals/restart) + LLM metrics + spend. */
export function executionApi({ send, sendWith, ws, pwHeaders }: ApiContext) {
  return {
    // ---- executions -------------------------------------------------------
    startExecution: (
      workspaceId: string,
      blockId: string,
      body: { pipelineId: string },
      password?: string,
    ) =>
      sendWith(pwHeaders(password), startExecutionContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { blockId },
        body,
      }),

    cancelExecution: (workspaceId: string, blockId: string) =>
      send(cancelExecutionContract, { pathPrefix: ws(workspaceId), pathParams: { blockId } }),

    mergeBlock: (workspaceId: string, blockId: string) =>
      send(mergeBlockContract, { pathPrefix: ws(workspaceId), pathParams: { blockId } }),

    resolveDecision: (
      workspaceId: string,
      executionId: string,
      decisionId: string,
      body: { choice: string },
      password?: string,
    ) =>
      sendWith(pwHeaders(password), resolveDecisionContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { executionId, decisionId },
        body,
      }),

    approveStep: (
      workspaceId: string,
      executionId: string,
      approvalId: string,
      body: { proposal?: string },
      password?: string,
    ) =>
      sendWith(pwHeaders(password), approveStepContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { executionId, approvalId },
        body,
      }),

    requestStepChanges: (
      workspaceId: string,
      executionId: string,
      approvalId: string,
      body: RequestStepChangesInput,
      password?: string,
    ) =>
      sendWith(pwHeaders(password), requestStepChangesContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { executionId, approvalId },
        body,
      }),

    rejectStep: (
      workspaceId: string,
      executionId: string,
      approvalId: string,
      body: { reason?: string },
    ) =>
      send(rejectStepContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { executionId, approvalId },
        body,
      }),

    // Resolve a companion step parked at its rework cap: one more round / proceed /
    // stop & reset (the companion analogue of resolveRequirementsExceeded).
    resolveCompanionExceeded: (
      workspaceId: string,
      executionId: string,
      approvalId: string,
      body: { choice: IterationCapChoice },
      password?: string,
    ) =>
      sendWith(pwHeaders(password), resolveStepExceededContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { executionId, approvalId },
        body,
      }),

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
      sendWith(pwHeaders(password), restartExecutionContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { executionId },
        body: { fromStepIndex },
      }),

    // ---- LLM observability (per-run model-call metrics) -------------------
    // The full per-call detail behind the board's step rollups. Empty when the
    // observability sink is not wired.
    getLlmMetrics: (workspaceId: string, executionId: string) =>
      send(getExecutionLlmMetricsContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { executionId },
      }),

    // The LLM-friendly export bundle (totals + per-agent insights + every call).
    exportLlmMetrics: (workspaceId: string, executionId: string) =>
      send(exportExecutionLlmMetricsContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { executionId },
      }),

    // The complete provided context per container-agent dispatch (composed prompts,
    // folded-in fragments, injected files). Empty when not wired / storing is off.
    getAgentContext: (workspaceId: string, executionId: string) =>
      send(getExecutionAgentContextContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { executionId },
      }),

    // ---- spend safeguard --------------------------------------------------
    resumeSpend: (workspaceId: string) =>
      send(resumeSpendContract, { pathPrefix: ws(workspaceId) }),
  }
}
