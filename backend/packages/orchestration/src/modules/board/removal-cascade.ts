import type {
  Block,
  InitiativeRepository,
  ServiceRepository,
  WorkspaceMountRepository,
} from '@cat-factory/kernel'

/**
 * The SIDE-TABLE reclaims a block delete has to perform, extracted from
 * `BoardService.removeBlock` following the established controller-extraction pattern: one small
 * deps object of the optional repositories, and the service keeps a thin delegate call.
 * Behaviour-neutral — the order and the batching are exactly what ran inline.
 *
 * Extracted because `BoardService` sits ~20 lines under its file-size budget, and the delete
 * cascade is where it grows: every feature that adds a table keyed by a BLOCK id has to add a
 * reclaim here, or leave a phantom row that no UI can reach and every list read keeps returning.
 * Those reclaims are a cohesive concern of their own, so the next one gets a section in this file
 * rather than another branch in the delete path.
 *
 * Each reclaim is OPTIONAL on its repository being wired, and each is BATCHED — never a
 * point-write per doomed block (the repo's no-N+1 rule).
 */
export interface RemovalCascadeDeps {
  serviceRepository?: ServiceRepository
  workspaceMountRepository?: WorkspaceMountRepository
  initiativeRepository?: InitiativeRepository
}

export interface RemovalCascadeInput {
  /** The workspace that HOMES the deleted block (not necessarily the acting one). */
  homeWorkspaceId: string
  /** The id passed to `removeBlock` — may be dangling (already gone from `blocks`). */
  deletedId: string
  /** The home workspace's blocks, as loaded for the delete. */
  blocks: Block[]
  /** Every id the delete cascades over (the subtree, including the root). */
  doomed: Set<string>
}

/**
 * Drop the account-owned service (and every workspace's mount of it) for any doomed service
 * frame, so deleting a frame doesn't leave an orphaned service lingering in the org catalog
 * (mountable, badged, yet rendering nothing) on other boards.
 */
async function reclaimServices(
  deps: RemovalCascadeDeps,
  { deletedId, blocks, doomed }: RemovalCascadeInput,
): Promise<void> {
  const { serviceRepository, workspaceMountRepository } = deps
  if (!serviceRepository || !workspaceMountRepository) return
  const doomedServiceIds = new Set<string>()
  // One batched read for every doomed top-level frame's service, not a getByFrameBlock
  // per frame (N+1).
  const doomedFrameIds = blocks
    .filter((b) => doomed.has(b.id) && b.level === 'frame' && b.parentId === null)
    .map((b) => b.id)
  for (const service of await serviceRepository.listByFrameBlocks(doomedFrameIds)) {
    doomedServiceIds.add(service.id)
  }
  // The frame block may already be gone (the dangling case), so it isn't in `blocks` above —
  // look the service up directly by the deleted id too, so the orphaned service + its mounts
  // are still reclaimed rather than lingering in the org catalog forever.
  const danglingService = await serviceRepository.getByFrameBlock(deletedId)
  if (danglingService) doomedServiceIds.add(danglingService.id)
  if (doomedServiceIds.size === 0) return
  // Batched: clear every board's mount of the doomed services, then delete the services
  // (two queries, not a listByService + per-mount remove + per-service delete loop).
  const ids = [...doomedServiceIds]
  await workspaceMountRepository.removeByServices(ids)
  await serviceRepository.deleteMany(ids)
}

/**
 * Delete the `initiatives` entity anchored to any doomed initiative-level block, the same way the
 * doomed service frames' account-owned services are reclaimed above. Without this the 1:1 row
 * survives with a `block_id` pointing at a deleted block: the snapshot's `initiatives` list keeps
 * returning a phantom, its `(workspace_id, slug)` stays reserved (re-creating a same-title
 * initiative silently gets `<slug>-2`), and slice 3's `listExecuting` sweeper would re-drive a
 * dead initiative. One `list` read + bounded deletes (the doomed set holds at most the subtree's
 * few initiative blocks), never a per-block `getByBlock` loop.
 */
async function reclaimInitiatives(
  deps: RemovalCascadeDeps,
  { homeWorkspaceId, blocks, doomed }: RemovalCascadeInput,
): Promise<void> {
  const repo = deps.initiativeRepository
  if (!repo) return
  const doomedInitiativeBlockIds = new Set(
    blocks.filter((b) => doomed.has(b.id) && b.level === 'initiative').map((b) => b.id),
  )
  if (doomedInitiativeBlockIds.size === 0) return
  for (const initiative of await repo.list(homeWorkspaceId)) {
    if (doomedInitiativeBlockIds.has(initiative.blockId)) {
      await repo.delete(homeWorkspaceId, initiative.id)
    }
  }
}

/**
 * Run every side-table reclaim for a block delete, in the order `removeBlock` performed them
 * inline. Sequential on purpose: these are independent writes, but a burst of parallel deletes
 * against D1 buys nothing and makes a partial failure harder to reason about.
 */
export async function reclaimDoomedEntities(
  deps: RemovalCascadeDeps,
  input: RemovalCascadeInput,
): Promise<void> {
  await reclaimServices(deps, input)
  await reclaimInitiatives(deps, input)
}
