import type { Position, ResizeBlockInput } from '@cat-factory/contracts'
import type {
  Block,
  BlockRepository,
  BoardChange,
  WorkspaceMount,
  WorkspaceMountRepository,
} from '@cat-factory/kernel'
import { applyMountLayout, assertFound } from '@cat-factory/kernel'
import type { BoardChangeReason } from './board.logic.js'

/**
 * The board's LAYOUT writes — where a container sits and how big it is — extracted from
 * `BoardService` following the established controller-extraction pattern: one small deps object of
 * bound callbacks, and the service keeps thin delegates. Behaviour-neutral for `moveBlock`.
 *
 * They belong together because both have to answer the same awkward question: a service frame's
 * position is a PER-BOARD override on its mount, while every other block's lives on the row, so
 * each write has two destinations and only one of them is the shared block. Keeping them apart
 * meant that split reasoning was stated twice; `resizeBlock` then adds the child translation on
 * top of it, which is what pushed the service past its file-size budget.
 */
export interface BoardLayoutDeps {
  blockRepository: BlockRepository
  workspaceMountRepository?: WorkspaceMountRepository
  /** 404s an unknown board before anything is written. */
  requireWorkspace: (workspaceId: string) => Promise<unknown>
  /** The block plus the workspace that HOMES it (which may not be the acting one). */
  resolveBlock: (
    workspaceId: string,
    id: string,
  ) => Promise<{ homeWorkspaceId: string; block: Block }>
  /** THIS board's mount for a service frame, else null — the per-board layout override. */
  frameMount: (workspaceId: string, block: Block) => Promise<WorkspaceMount | null>
  /** Project a mutation's response onto THIS board (a frame's geometry comes from its mount). */
  projectForWorkspace: (workspaceId: string, block: Block) => Promise<Block>
  emitBoardChanged: (
    originWorkspaceId: string,
    change: BoardChange & { reason: BoardChangeReason },
  ) => Promise<void>
}

export function createBoardLayoutWrites(deps: BoardLayoutDeps) {
  async function moveBlock(
    workspaceId: string,
    id: string,
    position: Position,
    originConnectionId?: string | null,
  ): Promise<Block> {
    await deps.requireWorkspace(workspaceId)
    const { homeWorkspaceId, block } = await deps.resolveBlock(workspaceId, id)
    // A service frame's board position is a PER-WORKSPACE layout override carried on the mount
    // (the snapshot renders frames from the mount, so the same shared frame can sit at a
    // different spot on each board). Write it onto THIS workspace's mount — for a home frame as
    // much as one mounted from elsewhere — and leave the shared block untouched.
    const mount = await deps.frameMount(workspaceId, block)
    if (mount) {
      // `frameMount` only resolves a mount when the mount repository is wired.
      await deps.workspaceMountRepository?.update(workspaceId, mount.serviceId, { position })
      // The frame's position is this workspace's private layout override: other boards mounting
      // the service keep their own spot, so this signal is origin-only, and carries no payload
      // for the same reason (the new coordinates are true of THIS board alone).
      await deps.emitBoardChanged(workspaceId, { reason: 'block-moved', originConnectionId })
      // Project the mount's SIZE override on too: a response carrying the block's own size would
      // resize the frame the moment the user finishes dragging it.
      return applyMountLayout(block, { position, size: mount.size })
    }
    // A non-frame block, or a legacy frame with no mount: move the shared block at its home.
    await deps.blockRepository.update(homeWorkspaceId, id, { position })
    // Origin = the block's HOME so moving a shared block fans the new position out to all mounts.
    // The moved block states the whole change (its position lives on the row, which is why this
    // branch was taken at all), so it rides along and other boards patch it without a refresh.
    const moved = assertFound(await deps.blockRepository.get(homeWorkspaceId, id), 'Block', id)
    await deps.emitBoardChanged(homeWorkspaceId, {
      reason: 'block-moved',
      block: moved,
      originConnectionId,
    })
    return moved
  }

  /**
   * Apply the new bounds of a container dragged by one of its borders.
   *
   * Dragging the north or west border moves the container's content ORIGIN, and a child's
   * position is stored relative to that origin — so without a compensating translation the whole
   * content would slide with the border instead of the border extending past it. This is the one
   * write that knows both halves, which is why it is its own operation rather than a `move` plus
   * an `update`: it derives the origin delta from the CURRENT position and shifts the direct
   * children by the inverse, in one arithmetic UPDATE (never a per-child loop).
   *
   * Where the bounds land differs by level, exactly as for {@link moveBlock} and
   * {@link updateBlock}: a service frame's position is THIS board's mount override, everything
   * else lives on the block row. The children always live on rows at the block's home.
   *
   * A frame mounted on more than one board is a deliberate, stated compromise: the children are
   * shared and the mount position is per-board, so the other boards see the same growth on the
   * OPPOSITE border. Nothing is clipped or lost — their content shifts by exactly as much as
   * their box does — and the alternative (fanning a layout change out to boards that did not ask
   * for it) contradicts what the per-board override is for.
   */
  async function resizeBlock(
    workspaceId: string,
    id: string,
    bounds: ResizeBlockInput,
    originConnectionId?: string | null,
  ): Promise<Block> {
    await deps.requireWorkspace(workspaceId)
    const { homeWorkspaceId, block } = await deps.resolveBlock(workspaceId, id)
    const mount = await deps.frameMount(workspaceId, block)
    // The position the drag started from — the mount's for a frame rendered off one, else the
    // row's. Reading it here rather than trusting a client-supplied delta keeps the shift
    // consistent with what is actually stored when two tabs resize the same frame.
    const from = mount?.position ?? block.position
    const dx = bounds.position.x - from.x
    const dy = bounds.position.y - from.y
    // Children move OPPOSITE the origin so they stay where the user sees them. A pure east/south
    // drag has no origin delta, so this is a no-op there and the repo skips the statement.
    await deps.blockRepository.shiftChildPositions(homeWorkspaceId, id, -dx, -dy)
    await deps.blockRepository.update(
      homeWorkspaceId,
      id,
      mount ? { size: bounds.size } : { size: bounds.size, position: bounds.position },
    )
    if (mount) {
      await deps.workspaceMountRepository?.update(workspaceId, mount.serviceId, {
        position: bounds.position,
      })
    }
    // Coarse, because the children moved too: a `block-updated` signal carrying the container
    // alone would let every other board re-render it at its new size with its contents still at
    // the old offsets. Origin = the block's HOME so a shared service fans out to every mount.
    await deps.emitBoardChanged(homeWorkspaceId, {
      reason: 'block-updated',
      originConnectionId,
    })
    return deps.projectForWorkspace(
      workspaceId,
      assertFound(await deps.blockRepository.get(homeWorkspaceId, id), 'Block', id),
    )
  }

  return { moveBlock, resizeBlock }
}
