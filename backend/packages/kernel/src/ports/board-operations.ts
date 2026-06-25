import type {
  AddEpicInput,
  AddFrameInput,
  AddModuleInput,
  AddTaskInput,
  UpdateBlockInput,
} from '@cat-factory/contracts'
import type { Block } from '../domain/types.js'

/**
 * The write-side board operations needed by integration packages (e.g.
 * DocumentLinkService) that materialise external structure onto the board.
 * A narrow port so the integrations package does not depend on the full
 * BoardService class.
 */
export interface BoardWritePort {
  addFrame(workspaceId: string, input: AddFrameInput): Promise<Block>
  addModule(workspaceId: string, frameId: string, input: AddModuleInput): Promise<Block>
  addTask(
    workspaceId: string,
    containerId: string,
    input: AddTaskInput,
    createdBy?: string | null,
  ): Promise<Block>
  updateBlock(workspaceId: string, blockId: string, patch: UpdateBlockInput): Promise<Block>
  /** Create an `epic`-level grouping node (used by the epic-import spawn). */
  addEpic(workspaceId: string, input: AddEpicInput): Promise<Block>
  /** Assign a task to an epic, or detach it (`epicId: null`). */
  assignToEpic(workspaceId: string, taskId: string, epicId: string | null): Promise<Block>
  /** Toggle a dependency edge: `targetId` dependsOn `sourceId`. */
  toggleDependency(workspaceId: string, targetId: string, sourceId: string): Promise<Block>
}
