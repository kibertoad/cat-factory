import {
  createReferenceArchitectureContract,
  deleteReferenceArchitectureContract,
  listReferenceArchitecturesContract,
  retryAgentRunContract,
  startBootstrapJobContract,
  stopAgentRunContract,
  updateReferenceArchitectureContract,
} from '@cat-factory/contracts'
import type {
  BootstrapRepoInput,
  CreateReferenceArchitectureInput,
  UpdateReferenceArchitectureInput,
} from '~/types/domain'
import type { ApiContext } from './context'

/**
 * Repo bootstrap (reference architectures + bootstrap jobs) and the unified
 * agent-run failure/retry/stop surface shared by bootstrap + execution runs.
 */
export function bootstrapApi({ send, sendWith, ws, pwHeaders }: ApiContext) {
  return {
    // ---- repo bootstrap ---------------------------------------------------
    listReferenceArchitectures: (workspaceId: string) =>
      send(listReferenceArchitecturesContract, { pathPrefix: ws(workspaceId) }),

    createReferenceArchitecture: (workspaceId: string, body: CreateReferenceArchitectureInput) =>
      send(createReferenceArchitectureContract, { pathPrefix: ws(workspaceId), body }),

    updateReferenceArchitecture: (
      workspaceId: string,
      id: string,
      body: UpdateReferenceArchitectureInput,
    ) =>
      send(updateReferenceArchitectureContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { id },
        body,
      }),

    deleteReferenceArchitecture: (workspaceId: string, id: string) =>
      send(deleteReferenceArchitectureContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { id },
      }),

    bootstrapRepo: (workspaceId: string, body: BootstrapRepoInput) =>
      send(startBootstrapJobContract, { pathPrefix: ws(workspaceId), body }),

    // ---- agent runs (unified failure + retry) -----------------------------
    // Retry any failed run (bootstrap or execution); the backend resolves the
    // kind from the unified `agent_runs` table and re-drives the right flow.
    retryAgentRun: (workspaceId: string, runId: string, password?: string) =>
      sendWith(pwHeaders(password), retryAgentRunContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { id: runId },
      }),

    // Explicitly stop a running run (bootstrap or execution): the backend kills the
    // per-run container and tears down the durable driver, then marks the run
    // terminally cancelled so the board stops showing it as running.
    stopAgentRun: (workspaceId: string, runId: string) =>
      send(stopAgentRunContract, { pathPrefix: ws(workspaceId), pathParams: { id: runId } }),
  }
}
