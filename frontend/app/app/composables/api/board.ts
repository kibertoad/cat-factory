import type { Block, BlockType, CreateTaskType, Pipeline, TaskTypeFields } from '~/types/domain'
import type { ApiContext, Position } from './context'

/** Board structure: block (frame/module/task) mutations + the pipeline library. */
export function boardApi({ http, ws }: ApiContext) {
  return {
    // ---- blocks -----------------------------------------------------------
    addFrame: (workspaceId: string, body: { type: BlockType; position: Position }) =>
      http<Block>(`${ws(workspaceId)}/blocks`, { method: 'POST', body }),

    // Import an existing GitHub repo as a service frame (no bootstrap run).
    addServiceFromRepo: (
      workspaceId: string,
      body: { repoGithubId: number; position?: Position; directory?: string; isMonorepo?: boolean },
    ) => http<Block>(`${ws(workspaceId)}/blocks/from-repo`, { method: 'POST', body }),

    addTask: (
      workspaceId: string,
      blockId: string,
      body: {
        title: string
        description?: string
        taskType?: CreateTaskType
        taskTypeFields?: TaskTypeFields
        mergePresetId?: string
        pipelineId?: string
        agentConfig?: Record<string, string>
      },
    ) => http<Block>(`${ws(workspaceId)}/blocks/${blockId}/tasks`, { method: 'POST', body }),

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

    createPipeline: (
      workspaceId: string,
      body: {
        name: string
        agentKinds: string[]
        gates?: boolean[]
        thresholds?: (number | null)[]
        enabled?: boolean[]
      },
    ) => http<Pipeline>(`${ws(workspaceId)}/pipelines`, { method: 'POST', body }),

    updatePipeline: (
      workspaceId: string,
      pipelineId: string,
      body: {
        name?: string
        agentKinds?: string[]
        gates?: boolean[]
        thresholds?: (number | null)[]
        enabled?: boolean[]
      },
    ) => http<Pipeline>(`${ws(workspaceId)}/pipelines/${pipelineId}`, { method: 'PATCH', body }),

    clonePipeline: (workspaceId: string, pipelineId: string, body: { name?: string } = {}) =>
      http<Pipeline>(`${ws(workspaceId)}/pipelines/${pipelineId}/clone`, {
        method: 'POST',
        body,
      }),

    removePipeline: (workspaceId: string, pipelineId: string) =>
      http(`${ws(workspaceId)}/pipelines/${pipelineId}`, { method: 'DELETE' }),
  }
}
