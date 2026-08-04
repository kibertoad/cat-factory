import type {
  Block,
  BlockRepository,
  DocumentRepository,
  InitiativeRepository,
  ServiceConnection,
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
  documentRepository?: DocumentRepository
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
 * Detach every document attached to a doomed block, so the delete doesn't leave a link naming a
 * block that is gone.
 *
 * Unlike the reclaims above this deletes NOTHING: the document is a projection of a page (or an
 * uploaded body) that outlives the task it was attached to, and re-attaching it elsewhere is the
 * normal next step. What must not survive is the LINK, because a document row carries exactly one
 * `linked_block_id`. Left stale it makes the document look permanently spoken for by a task
 * nobody can open, which the attach guard would then have to refuse on
 * (`DocumentLinkService.assertNotHeldElsewhere` treats a dangling link as free precisely so
 * pre-existing rows are not wedged; this stops new ones being made).
 *
 * One batched write over the whole doomed subtree, never a detach per block.
 */
async function detachDoomedDocuments(
  deps: RemovalCascadeDeps,
  { homeWorkspaceId, deletedId, doomed }: RemovalCascadeInput,
): Promise<void> {
  const repo = deps.documentRepository
  if (!repo) return
  // `deletedId` joins the set for the dangling case: the block row may already be gone (so it is
  // absent from `doomed`'s source list) while its document links live on.
  await repo.detachBlocks(homeWorkspaceId, [...new Set([...doomed, deletedId])])
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
  await detachDoomedDocuments(deps, input)
}

/**
 * After a set of blocks leaves `homeWorkspaceId` (deleted, or moved to another workspace),
 * drop the now-dangling references on the surviving blocks in one pass: dependency edges
 * pointing into `removed`, and epic membership whose epic was removed (the member task itself
 * survives — epic grouping is non-structural, never cascaded). Shared by the delete and the
 * reparent/detach paths so they can't drift.
 *
 * Lives here rather than on `BoardService` for the reason stated above: it is a removal-cascade
 * concern, and this is where that concern's next member goes. It takes the block repository
 * rather than reading one off `this`.
 */
export async function pruneDanglingEdges(
  blockRepository: BlockRepository,
  homeWorkspaceId: string,
  survivors: Block[],
  removed: Set<string>,
): Promise<void> {
  for (const b of survivors) {
    if (removed.has(b.id)) continue
    const patch: {
      dependsOn?: string[]
      epicId?: string | null
      initiativeId?: string | null
      serviceConnections?: ServiceConnection[]
      involvedServiceIds?: string[]
    } = {}
    const next = b.dependsOn.filter((d) => !removed.has(d))
    if (next.length !== b.dependsOn.length) patch.dependsOn = next
    if (b.epicId && removed.has(b.epicId)) patch.epicId = null
    // Initiative membership is non-structural (epic-style): a task the loop spawned
    // isn't a descendant of the deleted initiative block, so detach the dangling link
    // here the same way epic membership is pruned above.
    if (b.initiativeId && removed.has(b.initiativeId)) patch.initiativeId = null
    // Service-connection edges into the removed set, and task selections of a removed
    // involved service, dangle the same way dependency edges do — drop them here too.
    const connections = (b.serviceConnections ?? []).filter((c) => !removed.has(c.serviceBlockId))
    if (connections.length !== (b.serviceConnections ?? []).length) {
      patch.serviceConnections = connections
    }
    const involved = (b.involvedServiceIds ?? []).filter((sid) => !removed.has(sid))
    if (involved.length !== (b.involvedServiceIds ?? []).length) {
      patch.involvedServiceIds = involved
    }
    if (Object.keys(patch).length) {
      await blockRepository.update(homeWorkspaceId, b.id, patch)
    }
  }
}
