import type {
  Block,
  BlockType,
  ExecutionInstance,
  Pipeline,
  Workspace,
  WorkspaceSnapshot,
} from '~/types/domain'

type Position = { x: number; y: number }

/**
 * Thin typed client over the cat-factory backend (a Hono worker). Every method
 * maps to one REST endpoint; the request/response shapes mirror
 * `@cat-factory/contracts`, so responses drop straight into the Pinia stores.
 *
 * The base URL comes from runtime config (`NUXT_PUBLIC_API_BASE`), defaulting to
 * the local wrangler dev server — see `nuxt.config.ts`.
 */
export function useApi() {
  const apiBase = useRuntimeConfig().public.apiBase
  const http = $fetch.create({ baseURL: apiBase })

  const ws = (workspaceId: string) => `/workspaces/${encodeURIComponent(workspaceId)}`

  return {
    // ---- workspaces -------------------------------------------------------
    listWorkspaces: () => http<Workspace[]>('/workspaces'),

    createWorkspace: (body: { name?: string; seed?: boolean } = {}) =>
      http<WorkspaceSnapshot>('/workspaces', { method: 'POST', body }),

    getWorkspace: (workspaceId: string) => http<WorkspaceSnapshot>(ws(workspaceId)),

    deleteWorkspace: (workspaceId: string) => http(ws(workspaceId), { method: 'DELETE' }),

    // ---- blocks -----------------------------------------------------------
    addFrame: (workspaceId: string, body: { type: BlockType; position: Position }) =>
      http<Block>(`${ws(workspaceId)}/blocks`, { method: 'POST', body }),

    addTask: (workspaceId: string, blockId: string, body: { title?: string } = {}) =>
      http<Block>(`${ws(workspaceId)}/blocks/${blockId}/tasks`, { method: 'POST', body }),

    addModule: (
      workspaceId: string,
      blockId: string,
      body: { name: string; position?: Position },
    ) => http<Block>(`${ws(workspaceId)}/blocks/${blockId}/modules`, { method: 'POST', body }),

    updateBlock: (workspaceId: string, blockId: string, body: Partial<Block>) =>
      http<Block>(`${ws(workspaceId)}/blocks/${blockId}`, { method: 'PATCH', body }),

    moveBlock: (workspaceId: string, blockId: string, body: { position: Position }) =>
      http<Block>(`${ws(workspaceId)}/blocks/${blockId}/move`, { method: 'POST', body }),

    reparentBlock: (
      workspaceId: string,
      blockId: string,
      body: { parentId: string; position: Position },
    ) => http<Block>(`${ws(workspaceId)}/blocks/${blockId}/reparent`, { method: 'POST', body }),

    removeBlock: (workspaceId: string, blockId: string) =>
      http(`${ws(workspaceId)}/blocks/${blockId}`, { method: 'DELETE' }),

    toggleDependency: (workspaceId: string, blockId: string, body: { sourceId: string }) =>
      http<Block>(`${ws(workspaceId)}/blocks/${blockId}/dependencies`, { method: 'POST', body }),

    // ---- pipelines --------------------------------------------------------
    listPipelines: (workspaceId: string) => http<Pipeline[]>(`${ws(workspaceId)}/pipelines`),

    createPipeline: (workspaceId: string, body: { name: string; agentKinds: string[] }) =>
      http<Pipeline>(`${ws(workspaceId)}/pipelines`, { method: 'POST', body }),

    removePipeline: (workspaceId: string, pipelineId: string) =>
      http(`${ws(workspaceId)}/pipelines/${pipelineId}`, { method: 'DELETE' }),

    // ---- executions -------------------------------------------------------
    startExecution: (workspaceId: string, blockId: string, body: { pipelineId: string }) =>
      http<ExecutionInstance>(`${ws(workspaceId)}/blocks/${blockId}/executions`, {
        method: 'POST',
        body,
      }),

    cancelExecution: (workspaceId: string, blockId: string) =>
      http<Block>(`${ws(workspaceId)}/blocks/${blockId}/executions`, { method: 'DELETE' }),

    mergeBlock: (workspaceId: string, blockId: string) =>
      http<Block>(`${ws(workspaceId)}/blocks/${blockId}/merge`, { method: 'POST' }),

    tick: (workspaceId: string, body: { ticks?: number } = {}) =>
      http<ExecutionInstance[]>(`${ws(workspaceId)}/tick`, { method: 'POST', body }),

    resolveDecision: (
      workspaceId: string,
      executionId: string,
      decisionId: string,
      body: { choice: string },
    ) =>
      http<ExecutionInstance>(
        `${ws(workspaceId)}/executions/${executionId}/decisions/${decisionId}`,
        { method: 'POST', body },
      ),

    // ---- spend safeguard --------------------------------------------------
    resumeSpend: (workspaceId: string) =>
      http<ExecutionInstance[]>(`${ws(workspaceId)}/spend/resume`, { method: 'POST' }),
  }
}
