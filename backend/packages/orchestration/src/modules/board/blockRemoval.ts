import type {
  Block,
  BlockRepository,
  BoardChange,
  DocumentRepository,
  ExecutionRepository,
  InitiativeRepository,
  PreloadedBlocks,
  ServiceRepository,
  TaskRepository,
  WorkspaceMountRepository,
} from '@cat-factory/kernel'
import { ValidationError } from '@cat-factory/kernel'
import { descendantIds, unfinishedTasksUnder } from './board.logic.js'
import type { BoardChangeReason } from './board.logic.js'
import { pruneDanglingEdges, reclaimDoomedEntities } from './removal-cascade.js'

/**
 * The block DELETE path, extracted from `BoardService` following the established
 * controller-extraction pattern: one small deps object of bound callbacks, and the service keeps
 * thin delegates. Behaviour-neutral for `removeBlock`.
 *
 * It is a cohesive unit because a delete is not one call. A caller has to REFUSE first, then tear
 * every run under the subtree down (containers, durable drivers, run rows), then remove the blocks
 * and the side-table rows they key: three steps sharing one board list and one home-workspace
 * resolution, whose ORDER is the whole correctness story. `removal-cascade.ts` next door owns the
 * side-table half of the last step; this owns the sequence around it.
 */
export interface BlockRemovalDeps {
  blockRepository: BlockRepository
  executionRepository: ExecutionRepository
  serviceRepository?: ServiceRepository
  workspaceMountRepository?: WorkspaceMountRepository
  initiativeRepository?: InitiativeRepository
  documentRepository?: DocumentRepository
  taskRepository?: TaskRepository
  /** 404s an unknown board before anything is read. */
  requireWorkspace: (workspaceId: string) => Promise<unknown>
  /**
   * The workspace that HOMES the id, falling back to the acting one. Never throws: a dangling id
   * must not block the cleanup of the rows that DO still exist.
   */
  resolveBlockHomeForRemoval: (workspaceId: string, id: string) => Promise<string>
  emitBoardChanged: (
    originWorkspaceId: string,
    change: BoardChange & { reason: BoardChangeReason },
  ) => Promise<void>
}

export function createBlockRemoval(deps: BlockRemovalDeps) {
  /**
   * Refuse a delete that would discard work in flight, and hand back the board list the refusal
   * was decided on.
   *
   * Its own entry point because a DELETE is three calls rather than one: the caller tears every run
   * under the subtree down FIRST (killing containers, cancelling durable drivers, deleting the run
   * rows), so a guard that fires only inside {@link removeBlock} fires after the history it exists
   * to protect is already gone, and the 422 then describes a board that no longer matches it.
   * Running the same judgement here is what makes a refused delete change NOTHING.
   *
   * The list comes back so the whole sequence still costs ONE board read: the teardown and the
   * remove both take it as `preloaded` (this loads it for the block's HOME, which is the workspace
   * `removeBlock` reuses it for). Neither step deletes a block, so it is still current when they
   * run.
   *
   * {@link removeBlock} keeps the same guard, and that is not a duplicated rule: it is the layer
   * that can see the subtree it judges, and it is reachable without this preflight.
   */
  async function assertRemovable(workspaceId: string, id: string): Promise<PreloadedBlocks> {
    await deps.requireWorkspace(workspaceId)
    const homeWorkspaceId = await deps.resolveBlockHomeForRemoval(workspaceId, id)
    const blocks = await deps.blockRepository.listByWorkspace(homeWorkspaceId)
    assertNoUnfinishedWork(blocks, id)
    return { workspaceId: homeWorkspaceId, blocks }
  }

  /**
   * Delete a block and all its descendants, dropping dangling dependencies.
   *
   * `opts.preloaded` lets the caller hand in a block list it already loaded (the delete path's
   * preflight lists the board immediately before this) so a locally-owned delete doesn't re-list
   * the whole board; it is reused ONLY when it was loaded for the same workspace this block homes
   * to (a mounted shared service homed elsewhere re-lists).
   */
  async function removeBlock(
    workspaceId: string,
    id: string,
    opts: { preloaded?: PreloadedBlocks } = {},
  ): Promise<void> {
    await deps.requireWorkspace(workspaceId)
    // Resolve the block at its home so a shared service's block can be deleted from any board
    // that mounts it (the delete then applies to the one shared copy everywhere). Deletion is
    // best-effort and idempotent: if the block row is already GONE (e.g. a half-deleted service
    // that left a dangling mount/repo-link/execution), we must NOT 404 — a thing not existing
    // can't be allowed to block cleanup of the related entities that do still exist. The resolve
    // never throws; it falls back to this workspace, and every cleanup below is scoped to that
    // home, so we tear down whatever references the id (+ its surviving descendants) without ever
    // touching another workspace's data.
    const homeWorkspaceId = await deps.resolveBlockHomeForRemoval(workspaceId, id)
    // Capture the boards this removal must reach BEFORE we delete the block + drop its service's
    // mounts (after which the block→service→mounts join can't resolve anything). The union of the
    // acting workspace and every workspace mounting the doomed service is then notified post-delete.
    const fanoutTargets = new Set<string>([workspaceId])
    if (deps.workspaceMountRepository) {
      for (const ws of await deps.workspaceMountRepository.listWorkspaceIdsMountingBlock(
        homeWorkspaceId,
        id,
      )) {
        fanoutTargets.add(ws)
      }
    }
    // Reuse the caller's list only when it was loaded for this block's home (the common
    // locally-owned delete); a mounted service homed elsewhere re-lists against its home.
    const blocks =
      opts.preloaded && opts.preloaded.workspaceId === homeWorkspaceId
        ? opts.preloaded.blocks
        : await deps.blockRepository.listByWorkspace(homeWorkspaceId)
    const doomed = descendantIds(blocks, id)

    assertNoUnfinishedWork(blocks, id)

    await deps.executionRepository.deleteByBlock(homeWorkspaceId, id)
    // Every SIDE-TABLE row keyed by a doomed block id — the account-owned service + its mounts,
    // and the initiative entity. Its own module (see `removal-cascade.ts`): each is an optional,
    // batched reclaim, and that is where the delete path grows, so a future block-keyed table
    // gets a section there rather than another branch in this function.
    await reclaimDoomedEntities(
      {
        ...(deps.serviceRepository ? { serviceRepository: deps.serviceRepository } : {}),
        ...(deps.workspaceMountRepository
          ? { workspaceMountRepository: deps.workspaceMountRepository }
          : {}),
        ...(deps.initiativeRepository ? { initiativeRepository: deps.initiativeRepository } : {}),
        ...(deps.documentRepository ? { documentRepository: deps.documentRepository } : {}),
        ...(deps.taskRepository ? { taskRepository: deps.taskRepository } : {}),
      },
      { homeWorkspaceId, deletedId: id, blocks, doomed },
    )
    await deps.blockRepository.deleteMany(homeWorkspaceId, [...doomed])

    await pruneDanglingEdges(deps.blockRepository, homeWorkspaceId, blocks, doomed)

    // The block + any shared service are now gone, so fan out per captured target (blockId is
    // unresolvable post-delete): every board that showed the block refreshes it away. There is
    // nothing to carry, and a delete CASCADES, so the refresh is the point.
    for (const ws of fanoutTargets) {
      await deps.emitBoardChanged(ws, { reason: 'block-removed' })
    }
  }

  return { assertRemovable, removeBlock }
}

/**
 * Refuse to DELETE a service frame that still has unfinished work: that would discard in-flight
 * tasks and their history, so the frame is archived instead (hidden, restorable with no expiry).
 *
 * Only a real, still-present top-level frame is guarded: a dangling / already-gone id (an
 * idempotent re-delete, a leaf task, a module) falls through to the ordinary cleanup.
 *
 * A free function because it runs TWICE on the delete path and must be the same rule both times:
 * once as the preflight that refuses before anything is torn down, and once inside the remove,
 * which is the layer that can see the subtree it judges.
 */
function assertNoUnfinishedWork(blocks: Block[], id: string): void {
  const target = blocks.find((b) => b.id === id)
  if (target?.level !== 'frame' || target.parentId !== null) return
  const unfinished = unfinishedTasksUnder(blocks, id)
  if (unfinished.length === 0) return
  // The `reason` is what makes this refusal actionable through a door with no prose to read:
  // `DELETE /api/v1/services/{serviceId}` answers it as a 422, and the caller's next move is to
  // delete those tasks (or archive instead), which it can only choose from the code.
  throw new ValidationError(
    `This service has ${unfinished.length} unfinished task(s); archive it instead of deleting.`,
    { reason: 'service_has_unfinished_tasks', unfinishedTasks: unfinished.length },
  )
}
