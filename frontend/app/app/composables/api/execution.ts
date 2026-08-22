import {
  approveStepContract,
  cancelExecutionContract,
  exportExecutionLlmMetricsContract,
  getExecutionAgentContextContract,
  getExecutionContract,
  getExecutionLlmMetricsContract,
  getExecutionSearchQueriesContract,
  getExecutionToolCallFailuresContract,
  getExecutionToolCallsContract,
  getWorkspaceUsageContract,
  mergeBlockContract,
  rejectStepContract,
  requestStepChangesContract,
  resolveDecisionContract,
  resolveStepExceededContract,
  restartExecutionContract,
  resumeSpendContract,
  startAgentKindExecutionContract,
  startExecutionContract,
} from '@cat-factory/contracts'
import type { RequestStepChangesInput, RunMode } from '@cat-factory/contracts'
import type { IterationCapChoice } from '~/types/execution'
import type { ReviewEffort } from '~/types/merge'
import type { ApiContext } from './context'

/** Run lifecycle (start/cancel/decisions/approvals/restart) + LLM metrics + spend. */
export function executionApi({ send, sendWith, ws, pwHeaders }: ApiContext) {
  return {
    // ---- executions -------------------------------------------------------
    startExecution: (
      workspaceId: string,
      blockId: string,
      // `mode: 'dry_run'` REQUESTS a sandboxed run (the pipeline runs and opens its PR, but
      // nothing merges). Omitted ⇒ live. The task's merge preset can force a sandbox regardless
      // of what is asked here, so the response's `mode` is what the run actually got.
      body: { pipelineId: string; mode?: RunMode },
      password?: string,
    ) =>
      sendWith(pwHeaders(password), startExecutionContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { blockId },
        body,
      }),

    /**
     * One run, WHOLE. The board snapshot serves a lean projection that withholds each step's
     * captured prose, so a step-detail overlay fetches the run it is about through here before
     * rendering. See `projectExecutionForBoard`.
     */
    getExecution: (workspaceId: string, executionId: string) =>
      send(getExecutionContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { executionId },
      }),

    /**
     * Start ONE agent kind against a block — a run with no pipeline behind it (the service
     * frame's "Map service" action, the environment wizard's deep analysis). Gated on the
     * personal password exactly as a pipeline start is: the kind leases a personal subscription
     * the same way a pipeline step does.
     */
    startAgentKindExecution: (
      workspaceId: string,
      blockId: string,
      agentKind: string,
      password?: string,
    ) =>
      sendWith(pwHeaders(password), startAgentKindExecutionContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { blockId },
        body: { agentKind },
      }),

    cancelExecution: (workspaceId: string, blockId: string) =>
      send(cancelExecutionContract, { pathPrefix: ws(workspaceId), pathParams: { blockId } }),

    // `reviewEffort` records the reviewer-effort tag onto the block's merge track record in the
    // same request as the merge (see the notification `act` counterpart). Always optional.
    mergeBlock: (workspaceId: string, blockId: string, reviewEffort?: ReviewEffort | null) =>
      send(mergeBlockContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { blockId },
        body: reviewEffort === undefined ? {} : { reviewEffort },
      }),

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

    // The web searches each container agent performed in a run (query, provider,
    // result count). Empty when not wired / storing is off.
    getSearchQueries: (workspaceId: string, executionId: string) =>
      send(getExecutionSearchQueriesContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { executionId },
      }),

    // The tool-call trajectory: what the run's agents DID, oldest first. The half of a
    // failure no model call reports: a tool that errors leaves the call that asked for it
    // reporting `ok`. Bounded, and says so via `truncated`. Empty when the sink is not wired /
    // storing is off. The BROWSE read: fetched when the trajectory is opened, since it carries
    // every argument and result the run captured.
    getToolCalls: (workspaceId: string, executionId: string) =>
      send(getExecutionToolCallsContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { executionId },
      }),

    // The run's failing tool calls plus its exact `{ total, failed }`, counted in SQL rather
    // than off any list. The panel's headline read, made on open: cheap enough to front the
    // page, and exact enough that it never disagrees with the debug overview on a long run.
    getToolCallFailures: (workspaceId: string, executionId: string) =>
      send(getExecutionToolCallFailuresContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { executionId },
      }),

    // ---- spend safeguard --------------------------------------------------
    resumeSpend: (workspaceId: string) =>
      send(resumeSpendContract, { pathPrefix: ws(workspaceId) }),

    // ---- usage report -----------------------------------------------------
    getUsage: (workspaceId: string) =>
      send(getWorkspaceUsageContract, { pathPrefix: ws(workspaceId) }),
  }
}
