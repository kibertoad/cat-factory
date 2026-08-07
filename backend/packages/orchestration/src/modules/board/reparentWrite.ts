import type { BlockEditActor, ReparentInput } from '@cat-factory/contracts'
import type {
  Block,
  BlockRepository,
  BlockType,
  BoardChange,
  ExecutionRepository,
  ServiceRepository,
  WorkspaceMountRepository,
} from '@cat-factory/kernel'
import { assertFound, ValidationError } from '@cat-factory/kernel'
import type { BoardChangeReason } from './board.logic.js'
import { canReparent, descendantIds, serviceOf } from './board.logic.js'
import { pruneDanglingEdges } from './removal-cascade.js'
import type { RiskPolicySelectionGuard } from './riskPolicySelectionGuard.js'

/**
 * The board's REPARENT write (moving a block into a new container), extracted from `BoardService`
 * following the established controller-extraction pattern: one small deps object of bound
 * callbacks, and the service keeps a thin delegate.
 *
 * It is its own collaborator rather than a third layout write, because it is not a layout write at
 * all. Where those split ONE block's geometry between a mount override and the row, this moves a
 * whole SUBTREE between parents, and in the cross-home case between physical workspaces. It carries
 * the rows and their executions, re-stamps the service scope key, prunes the edges that then
 * dangle, and decides whether the destination's merge policy is one the mover may put the task
 * under.
 */
export interface BoardReparentDeps {
  blockRepository: BlockRepository
  executionRepository: ExecutionRepository
  /** Absent ⇒ sharing isn't wired, so blocks are plain workspace-local and never re-stamped. */
  serviceRepository?: ServiceRepository
  workspaceMountRepository?: WorkspaceMountRepository
  /** Refuses a move that would drop a role-scoped merge restriction (ADR 0037). */
  riskPolicySelection: RiskPolicySelectionGuard
  /** 404s an unknown board before anything is written. */
  requireWorkspace: (workspaceId: string) => Promise<unknown>
  /** The block plus the workspace that HOMES it (which may not be the acting one). */
  resolveBlock: (
    workspaceId: string,
    id: string,
  ) => Promise<{ homeWorkspaceId: string; block: Block }>
  /** The service id a block placed under `container` belongs to, or undefined. */
  serviceForContainer: (blocks: Block[], container: Block) => Promise<string | undefined>
  /** The doc-repo containment rule, shared with `addTask`. */
  assertTaskTypeAllowed: (frame: Block | undefined, taskType: Block['taskType']) => void
  emitBoardChanged: (
    originWorkspaceId: string,
    change: BoardChange & { reason: BoardChangeReason },
  ) => Promise<void>
}

export function createBoardReparentWrite(deps: BoardReparentDeps) {
  /**
   * Move a block into a new container at a new local position.
   *
   * `editor` is who is moving it, for the merge-preset guard: see the cross-home branch below.
   * Pass `UNATTRIBUTED_BLOCK_EDITOR` for a caller with no workspace tier (an engine path).
   */
  async function reparent(
    workspaceId: string,
    id: string,
    input: ReparentInput,
    editor: BlockEditActor,
    originConnectionId?: string | null,
  ): Promise<Block> {
    await deps.requireWorkspace(workspaceId)
    const { homeWorkspaceId: blockHome, block } = await deps.resolveBlock(workspaceId, id)
    if (id === input.parentId) throw new ValidationError('A block cannot contain itself')
    const { homeWorkspaceId: parentHome, block: parent } = await deps.resolveBlock(
      workspaceId,
      input.parentId,
    )
    if (!canReparent(block.level, parent)) {
      throw new ValidationError(`A ${block.level} cannot be placed inside a ${parent.level}`)
    }

    // The destination's enclosing frame drives two things: the doc-repo task gate (same as
    // addTask — drag-drop must not smuggle a feature/bug/recurring task into a doc frame) and
    // the moved task's inherited `type`, which is behavioural for the frame repo roles. Load
    // the parent's workspace blocks once here; the branches below reuse this list.
    const destBlocks = await deps.blockRepository.listByWorkspace(parentHome)
    const destFrame = serviceOf(destBlocks, parent)
    if (block.level === 'task') {
      deps.assertTaskTypeAllowed(destFrame, block.taskType)
    }
    // A task inherits its enclosing frame's type, so a move re-stamps it (no-op when unchanged
    // or when the destination isn't a resolvable frame). Non-task blocks keep their own type.
    const movedType: BlockType = block.level === 'task' && destFrame ? destFrame.type : block.type

    // Same physical home (the common case, incl. two of the workspace's own services): move in
    // place and re-stamp `service_id`, the physical scope key that decides which boards render
    // the subtree and where its events fan out. No-op re-stamp when sharing isn't wired or the
    // destination frame isn't a registered service. No preset guard here: the home decides which
    // library a `riskPolicyId` resolves against, so a move that keeps it re-decides nothing.
    if (blockHome === parentHome) {
      await deps.blockRepository.update(blockHome, id, {
        parentId: input.parentId,
        position: input.position,
        ...(movedType !== block.type ? { type: movedType } : {}),
      })
      if (deps.serviceRepository) {
        const destService = await deps.serviceForContainer(destBlocks, parent)
        await deps.blockRepository.setService(
          blockHome,
          [...descendantIds(destBlocks, id)],
          destService ?? null,
        )
      }
      // Origin = the block's HOME so the re-stamped subtree fans out to every mounting board. No
      // payload: a reparent moves the whole SUBTREE between parents, and the moved block alone
      // cannot state what its descendants' service stamps became.
      await deps.emitBoardChanged(blockHome, {
        reason: 'block-reparented',
        blockId: id,
        originConnectionId,
      })
      return assertFound(await deps.blockRepository.get(blockHome, id), 'Block', id)
    }

    // Cross-home: the block and its new parent belong to two services homed in different
    // workspaces (both mounted on this board). Keep the invariant that a service's blocks live
    // in its home workspace by MOVING the subtree's rows — and any executions on them — to the
    // destination service's home, re-stamped with the destination service.
    const srcBlocks = await deps.blockRepository.listByWorkspace(blockHome)
    const ids = [...descendantIds(srcBlocks, id)]
    const subtree = ids
      .map((bid) => srcBlocks.find((b) => b.id === bid))
      .filter((b): b is Block => b !== undefined)
    // BEFORE any write, and the reason this write takes an editor at all. A task's merge preset
    // resolves against the workspace that HOMES it, so carrying it to another home re-decides
    // which policy governs its runs without touching `riskPolicyId` or the preset library: the
    // swap the picker refuses, spelled as a drag. Every task in the moved subtree is judged, not
    // just the dragged block, because a module carries its tasks with it.
    await deps.riskPolicySelection.assertMayMove({
      fromWorkspaceId: blockHome,
      toWorkspaceId: parentHome,
      actor: editor,
      riskPolicyIds: subtree.filter((b) => b.level === 'task').map((b) => b.riskPolicyId),
    })

    // Capture the SOURCE service's mounting boards BEFORE the move (afterwards the subtree no
    // longer resolves to the source service), so every board that showed the block at its old
    // home can refresh it away. The destination side is reached by the post-move emit below.
    const sourceFanout = new Set<string>([blockHome])
    if (deps.workspaceMountRepository) {
      for (const ws of await deps.workspaceMountRepository.listWorkspaceIdsMountingBlock(
        blockHome,
        id,
      )) {
        sourceFanout.add(ws)
      }
    }
    const destService = (await deps.serviceForContainer(destBlocks, parent)) ?? null
    for (const b of subtree) {
      const moved =
        b.id === id
          ? { ...b, parentId: input.parentId, position: input.position, type: movedType }
          : b
      await deps.blockRepository.insert(parentHome, moved, destService)
      const exec = await deps.executionRepository.getByBlock(blockHome, b.id)
      if (exec) {
        await deps.executionRepository.deleteByBlock(blockHome, b.id)
        await deps.executionRepository.upsert(parentHome, exec)
      }
    }
    await deps.blockRepository.deleteMany(blockHome, ids)
    // Drop dependency + epic edges in the source workspace that now dangle to the moved subtree.
    await pruneDanglingEdges(deps.blockRepository, blockHome, srcBlocks, new Set(ids))
    // Destination side: origin = the new HOME so the moved subtree fans out to the destination
    // service's mounts (and that board). Source side: the block is gone from its old service, so
    // the block→service join can't resolve it anymore — notify the captured source boards
    // directly (origin-only) so they refresh the subtree away.
    await deps.emitBoardChanged(parentHome, {
      reason: 'block-reparented',
      blockId: id,
      originConnectionId,
    })
    for (const ws of sourceFanout) {
      if (ws !== parentHome) {
        await deps.emitBoardChanged(ws, { reason: 'block-reparented', originConnectionId })
      }
    }
    return assertFound(await deps.blockRepository.get(parentHome, id), 'Block', id)
  }

  return { reparent }
}
