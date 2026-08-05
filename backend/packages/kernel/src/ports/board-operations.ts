import type {
  AddEpicInput,
  AddFrameInput,
  AddModuleInput,
  AddTaskInput,
  BlockEditActor,
  UpdateBlockInput,
} from '@cat-factory/contracts'
import type { Block } from '../domain/types.js'

/**
 * The write-side board operations needed by integration packages (e.g.
 * DocumentLinkService) that materialise external structure onto the board.
 * A narrow port so the integrations package does not depend on the full
 * BoardService class.
 *
 * The two writes that can carry a task's merge preset take the {@link BlockEditActor} making
 * them, which is what refuses a selection relaxing the editor's own role policy (ADR 0037). It is
 * REQUIRED rather than defaulted so a new caller has to answer the question: an integration
 * materialising external structure has no workspace tier behind it and passes
 * `UNATTRIBUTED_BLOCK_EDITOR`, but that has to be said rather than inherited from a default.
 */
export interface BoardWritePort {
  addFrame(workspaceId: string, input: AddFrameInput): Promise<Block>
  addModule(workspaceId: string, frameId: string, input: AddModuleInput): Promise<Block>
  addTask(
    workspaceId: string,
    containerId: string,
    input: AddTaskInput,
    editor: BlockEditActor,
    createdBy?: string | null,
  ): Promise<Block>
  updateBlock(
    workspaceId: string,
    blockId: string,
    patch: UpdateBlockInput,
    editor: BlockEditActor,
  ): Promise<Block>
  /** Create an `epic`-level grouping node (used by the epic-import spawn). */
  addEpic(workspaceId: string, input: AddEpicInput): Promise<Block>
  /** Assign a task to an epic, or detach it (`epicId: null`). */
  assignToEpic(workspaceId: string, taskId: string, epicId: string | null): Promise<Block>
  /** Toggle a dependency edge: `targetId` dependsOn `sourceId`. */
  toggleDependency(workspaceId: string, targetId: string, sourceId: string): Promise<Block>
}
