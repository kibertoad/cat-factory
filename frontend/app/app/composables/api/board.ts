import {
  addEpicContract,
  addFrameContract,
  addModuleContract,
  addServiceFromRepoContract,
  addTaskContract,
  archiveBlockContract,
  assignEpicContract,
  clonePipelineContract,
  createPipelineContract,
  deletePipelineContract,
  listPipelinesContract,
  moveBlockContract,
  organizePipelineContract,
  removeBlockContract,
  reparentBlockContract,
  reseedPipelineContract,
  restoreBlockContract,
  toggleDependencyContract,
  updateBlockContract,
  updatePipelineContract,
} from '@cat-factory/contracts'
import type {
  CreatePipelineInput,
  UpdateBlockInput,
  UpdatePipelineInput,
} from '@cat-factory/contracts'
import type { BlockType, CreateTaskType, TaskTypeFields } from '~/types/domain'
import type { ApiContext, Position } from './context'

/** Board structure: block (frame/module/task) mutations + the pipeline library. */
export function boardApi({ send, ws }: ApiContext) {
  return {
    // ---- blocks -----------------------------------------------------------
    addFrame: (workspaceId: string, body: { type: BlockType; position: Position }) =>
      send(addFrameContract, { pathPrefix: ws(workspaceId), body }),

    // Import an existing GitHub repo as a service frame (no bootstrap run).
    addServiceFromRepo: (
      workspaceId: string,
      body: { repoGithubId: number; position?: Position; directory?: string; isMonorepo?: boolean },
    ) => send(addServiceFromRepoContract, { pathPrefix: ws(workspaceId), body }),

    addTask: (
      workspaceId: string,
      blockId: string,
      body: {
        title: string
        description?: string
        taskType?: CreateTaskType
        taskTypeFields?: TaskTypeFields
        riskPolicyId?: string
        modelPresetId?: string
        pipelineId?: string
        agentConfig?: Record<string, string>
        technical?: boolean
      },
    ) => send(addTaskContract, { pathPrefix: ws(workspaceId), pathParams: { blockId }, body }),

    addModule: (
      workspaceId: string,
      blockId: string,
      body: { name: string; position?: Position },
    ) => send(addModuleContract, { pathPrefix: ws(workspaceId), pathParams: { blockId }, body }),

    // Create an epic grouping node (optionally placed under a service/module).
    addEpic: (
      workspaceId: string,
      body: { title: string; description?: string; position: Position; parentId?: string },
    ) => send(addEpicContract, { pathPrefix: ws(workspaceId), body }),

    // Assign a task to an epic, or detach it (epicId: null).
    assignToEpic: (workspaceId: string, blockId: string, body: { epicId: string | null }) =>
      send(assignEpicContract, { pathPrefix: ws(workspaceId), pathParams: { blockId }, body }),

    updateBlock: (workspaceId: string, blockId: string, body: UpdateBlockInput) =>
      send(updateBlockContract, { pathPrefix: ws(workspaceId), pathParams: { blockId }, body }),

    moveBlock: (workspaceId: string, blockId: string, body: { position: Position }) =>
      send(moveBlockContract, { pathPrefix: ws(workspaceId), pathParams: { blockId }, body }),

    reparentBlock: (
      workspaceId: string,
      blockId: string,
      body: { parentId: string; position: Position },
    ) =>
      send(reparentBlockContract, { pathPrefix: ws(workspaceId), pathParams: { blockId }, body }),

    removeBlock: (workspaceId: string, blockId: string) =>
      send(removeBlockContract, { pathPrefix: ws(workspaceId), pathParams: { blockId } }),

    // Archive a service (hide it + its subtree, restorable with no expiry) instead of deleting.
    archiveBlock: (workspaceId: string, blockId: string) =>
      send(archiveBlockContract, { pathPrefix: ws(workspaceId), pathParams: { blockId } }),

    restoreBlock: (workspaceId: string, blockId: string) =>
      send(restoreBlockContract, { pathPrefix: ws(workspaceId), pathParams: { blockId } }),

    toggleDependency: (workspaceId: string, blockId: string, body: { sourceId: string }) =>
      send(toggleDependencyContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { blockId },
        body,
      }),

    // ---- pipelines --------------------------------------------------------
    listPipelines: (workspaceId: string) =>
      send(listPipelinesContract, { pathPrefix: ws(workspaceId) }),

    createPipeline: (workspaceId: string, body: CreatePipelineInput) =>
      send(createPipelineContract, { pathPrefix: ws(workspaceId), body }),

    updatePipeline: (workspaceId: string, pipelineId: string, body: UpdatePipelineInput) =>
      send(updatePipelineContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { pipelineId },
        body,
      }),

    clonePipeline: (workspaceId: string, pipelineId: string, body: { name?: string } = {}) =>
      send(clonePipelineContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { pipelineId },
        body,
      }),

    // Organize a pipeline in the library (labels / archive). The only mutation a built-in
    // accepts — it touches view metadata, not structure.
    organizePipeline: (
      workspaceId: string,
      pipelineId: string,
      body: { labels?: string[]; archived?: boolean },
    ) =>
      send(organizePipelineContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { pipelineId },
        body,
      }),

    removePipeline: (workspaceId: string, pipelineId: string) =>
      send(deletePipelineContract, { pathPrefix: ws(workspaceId), pathParams: { pipelineId } }),

    // Restore a built-in pipeline to its current catalog definition (adopt an improved
    // built-in, or repair a drifted/invalid one). Custom pipelines reject this.
    reseedPipeline: (workspaceId: string, pipelineId: string) =>
      send(reseedPipelineContract, { pathPrefix: ws(workspaceId), pathParams: { pipelineId } }),
  }
}
