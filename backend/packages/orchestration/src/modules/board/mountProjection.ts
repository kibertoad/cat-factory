import type {
  Block,
  ServiceRepository,
  WorkspaceMount,
  WorkspaceMountRepository,
} from '@cat-factory/kernel'
import { applyMountLayout } from '@cat-factory/kernel'

/**
 * The mount-projection reads: resolve THIS board's layout override for a service frame, and
 * project a block through it before a mutation response leaves the service.
 *
 * Extracted from `BoardService` following the established pattern (a small deps object, thin
 * delegates left behind). It earns its own module because it is the read half of the same
 * frame-geometry split that `layoutWrites.ts` writes — a frame's position/size live on its
 * per-board mount while every other block's live on the shared row — and `layoutWrites` already
 * consumes both of these as injected callbacks rather than reaching into the service.
 */
export interface MountProjectionDeps {
  /** Optional: in-org sharing unwired means every block projects as itself. */
  serviceRepository?: ServiceRepository
  workspaceMountRepository?: WorkspaceMountRepository
}

export function createMountProjection(deps: MountProjectionDeps) {
  /**
   * THIS workspace's mount for `block` when it is a service frame mounted here, else null (a
   * non-frame, a legacy/unregistered frame, or in-org sharing not wired). The mount carries the
   * frame's per-workspace layout override, so it is both what a frame move/resize WRITES and what
   * every frame-returning read must project through. Costs no query for a non-frame.
   */
  async function frameMount(workspaceId: string, block: Block): Promise<WorkspaceMount | null> {
    if (block.level !== 'frame') return null
    const services = deps.serviceRepository
    const mounts = deps.workspaceMountRepository
    if (!services || !mounts) return null
    // A frame block id does NOT uniquely identify a service: every seeded board carries the same
    // ids (`blk_auth`, …), so `getByFrameBlock` answers with an arbitrary one of them. Paired with
    // `mounts.get(thisWorkspace, thatServiceId)` that reads as "this frame has no mount here" on a
    // deployment with two seeded boards — and then a frame write lands on the block row that every
    // READ overrides with this board's mount (`WorkspaceService.composeBoard`), silently, in the
    // one direction that loses the write. So resolve the candidates for this frame id and keep the
    // one mounted HERE: two batched queries, no per-candidate round-trip.
    const candidates = await services.listByFrameBlocks([block.id])
    if (candidates.length === 0) return null
    const candidateIds = new Set(candidates.map((s) => s.id))
    // Intersect from THIS board's mounts rather than from the candidates' mounts. Both name the
    // same row, but `listByFrameBlocks` is not account-scoped — a colliding seeded id in another
    // org rides the candidate list — so asking for those services' mounts would hand a
    // mothership-mode node a service id its token does not hold, and the persistence RPC refuses
    // such a call CLOSED: every frame edit on the board would 404 rather than degrade. Keyed on
    // the acting workspace, this read is scoped by construction and bounded by this board.
    const mounted = await mounts.listByWorkspace(workspaceId)
    return mounted.find((m) => candidateIds.has(m.serviceId)) ?? null
  }

  /**
   * Project a block onto THIS workspace's board before returning it from a mutation. A service
   * frame's position/size are the mount's per-workspace layout override rather than fields of the
   * shared block (see {@link applyMountLayout}), so a response built from the block row alone
   * reports the coordinates the row happened to be created with — and the SPA, which upserts the
   * authoritative block a mutation returns, would jump the frame to that spot on every edit.
   * Pass-through for a non-frame.
   */
  async function projectForWorkspace(workspaceId: string, block: Block): Promise<Block> {
    return applyMountLayout(block, await frameMount(workspaceId, block))
  }

  return { frameMount, projectForWorkspace }
}
