import type {
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
  addTask(workspaceId: string, containerId: string, input: AddTaskInput): Promise<Block>
  updateBlock(workspaceId: string, blockId: string, patch: UpdateBlockInput): Promise<Block>
}
