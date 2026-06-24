import type {
  AgentRunKind,
  BootstrapJob,
  BootstrapRepoInput,
  CreateReferenceArchitectureInput,
  ExecutionInstance,
  ReferenceArchitecture,
  UpdateReferenceArchitectureInput,
} from '~/types/domain'
import type { ApiContext } from './context'

/**
 * Repo bootstrap (reference architectures + bootstrap jobs) and the unified
 * agent-run failure/retry/stop surface shared by bootstrap + execution runs.
 */
export function bootstrapApi({ http, ws, pwHeaders }: ApiContext) {
  return {
    // ---- repo bootstrap ---------------------------------------------------
    listReferenceArchitectures: (workspaceId: string) =>
      http<ReferenceArchitecture[]>(`${ws(workspaceId)}/bootstrap/reference-architectures`),

    createReferenceArchitecture: (workspaceId: string, body: CreateReferenceArchitectureInput) =>
      http<ReferenceArchitecture>(`${ws(workspaceId)}/bootstrap/reference-architectures`, {
        method: 'POST',
        body,
      }),

    updateReferenceArchitecture: (
      workspaceId: string,
      id: string,
      body: UpdateReferenceArchitectureInput,
    ) =>
      http<ReferenceArchitecture>(`${ws(workspaceId)}/bootstrap/reference-architectures/${id}`, {
        method: 'PATCH',
        body,
      }),

    deleteReferenceArchitecture: (workspaceId: string, id: string) =>
      http(`${ws(workspaceId)}/bootstrap/reference-architectures/${id}`, { method: 'DELETE' }),

    bootstrapRepo: (workspaceId: string, body: BootstrapRepoInput) =>
      http<BootstrapJob>(`${ws(workspaceId)}/bootstrap/jobs`, { method: 'POST', body }),

    // ---- agent runs (unified failure + retry) -----------------------------
    // Retry any failed run (bootstrap or execution); the backend resolves the
    // kind from the unified `agent_runs` table and re-drives the right flow.
    retryAgentRun: (workspaceId: string, runId: string, password?: string) =>
      http<{ kind: AgentRunKind; run: ExecutionInstance | BootstrapJob }>(
        `${ws(workspaceId)}/agent-runs/${encodeURIComponent(runId)}/retry`,
        { method: 'POST', headers: pwHeaders(password) },
      ),

    // Explicitly stop a running run (bootstrap or execution): the backend kills the
    // per-run container and tears down the durable driver, then marks the run
    // terminally cancelled so the board stops showing it as running.
    stopAgentRun: (workspaceId: string, runId: string) =>
      http<{ kind: AgentRunKind; run: ExecutionInstance | BootstrapJob }>(
        `${ws(workspaceId)}/agent-runs/${encodeURIComponent(runId)}/stop`,
        { method: 'POST' },
      ),
  }
}
