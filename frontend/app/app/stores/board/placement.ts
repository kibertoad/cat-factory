import type { UpdateBlockInput } from '@cat-factory/contracts'
import { useServicesStore } from '~/stores/services'
import { useWorkspaceStore } from '~/stores/workspace'
import { createBoardDependencies } from './dependencies'
import { moveRefusalKey } from './moveRefusal'
import type { Block } from '~/types/domain'
import type { BoardWriteContext } from './context'
import { UNDO_WINDOW_MS } from './context'

/** A field `updateBlock` may patch: the contract's key set, nothing wider. */
type PatchKey = keyof UpdateBlockInput
/** The pre-patch values of the fields one call touches, for the rollback. */
type PatchSnapshot = Partial<Record<PatchKey, unknown>>

/**
 * View a block through the patch key set, for the optimistic write's snapshot + rollback.
 *
 * A plain widening, not an assertion: the rollback is inherently keyed by whatever the caller
 * put in the patch, so it has to index the block dynamically, and this bounds that indexing to
 * the contract instead of the `Record<string, unknown>` it used to widen to. Two patch keys
 * (`customTaskTypeFields` / `builtinTaskTypeFields`) are request-only, since the server folds
 * them into the block's `taskTypeFields`, so the view is `Partial`: they read as absent going in
 * and are cleared again by a rollback, which is what the untyped version did.
 */
function blockAsPatchable(block: Block): PatchSnapshot {
  return block
}

/**
 * The board's placement (drag/drop/reparent) and per-block edit operations — the writes that
 * move a block or patch its fields, including the dependency edges. Extracted from
 * {@link createBoardMutations} (which keeps the creation writes) along the same seam: each
 * closes over the shared {@link BoardWriteContext} so behaviour is identical to the original
 * in-closure functions, and the split is purely to keep every function within the size budget.
 */
export function createBoardPlacement(ctx: BoardWriteContext) {
  const { blocks, getBlock, upsert, api, toast, tr } = ctx

  /**
   * Move a block into a new container at a new local position. Drag-reparent commits
   * silently on a small overshoot, so a successful move (into a *different* container,
   * not an undo of one) offers a one-click undo back to its previous home.
   */
  async function reparentBlock(
    id: string,
    newParentId: string,
    position: { x: number; y: number },
    opts: { undoable?: boolean } = { undoable: true },
  ) {
    const b = getBlock(id)
    const parent = getBlock(newParentId)
    if (!b || !parent || b.id === newParentId) return
    // tasks may live in services or modules; modules only in services
    if (b.level === 'task' && parent.level !== 'frame' && parent.level !== 'module') return
    if (b.level === 'module' && parent.level !== 'frame') return
    // Optimistic: drop the block into the new container immediately so it doesn't
    // briefly snap back to its old home while the request is in flight. Snapshot
    // the old home so a rejected reparent restores it rather than leaving the
    // block in the wrong container (a structural lie that survives until re-hydrate).
    const prevParentId = b.parentId
    const prevPosition = b.position
    const name = b.title
    b.parentId = newParentId
    b.position = position
    try {
      upsert(
        await api.reparentBlock(useWorkspaceStore().requireId(), id, {
          parentId: newParentId,
          position,
        }),
      )
      // Offer an undo back to the previous container (a drag overshoot is easy). The undo
      // move is itself non-undoable so the toast doesn't ping-pong.
      if (opts.undoable && prevParentId) {
        toast.add({
          title: tr('board.toast.moved', { name }),
          icon: 'i-lucide-move',
          color: 'neutral',
          duration: UNDO_WINDOW_MS,
          actions: [
            {
              label: tr('common.undo'),
              icon: 'i-lucide-undo-2',
              onClick: () =>
                void reparentBlock(id, prevParentId, prevPosition, { undoable: false }),
            },
          ],
        })
      }
    } catch (e) {
      b.parentId = prevParentId
      b.position = prevPosition
      // A cross-home drag can be refused on merge-preset grounds, which is a condition the mover
      // can act on rather than a fault. The backend sends the machine-readable reason and no
      // translated prose, so map it here; anything else keeps the raw message as the last resort.
      const refusal = moveRefusalKey(e)
      toast.add({
        title: tr('board.toast.moveFailed'),
        description: refusal ? tr(refusal) : e instanceof Error ? e.message : String(e),
        icon: 'i-lucide-triangle-alert',
        color: 'error',
      })
    }
  }

  /**
   * Local-only optimistic position update during an active drag — no persistence.
   * A drag fires this on every pointer move so the block tracks the cursor without
   * a per-move API round-trip; the final position is committed once via
   * {@link moveBlock} (or {@link reparentBlock}) on release. Persisting every move
   * raced: out-of-order responses to the burst of in-flight writes could land a
   * stale position last, snapping the block back after the user let go.
   */
  function previewMove(id: string, position: { x: number; y: number }) {
    const b = getBlock(id)
    if (b) b.position = position
  }

  async function moveBlock(id: string, position: { x: number; y: number }) {
    const b = getBlock(id)
    if (!b) return
    const prevPosition = b.position
    b.position = position // optimistic: keep the drag feeling instant
    try {
      // A mounted service frame's position is a PER-WORKSPACE layout override on the mount, not
      // on the (shared) block — so route a frame drag there. Other moves write the block.
      const services = useServicesStore()
      const mount = services.serviceByFrameBlock[id]
        ? services.byServiceId[services.serviceByFrameBlock[id]!.id]
        : undefined
      if (mount) {
        await services.updateLayout(mount.serviceId, position)
        return
      }
      upsert(await api.moveBlock(useWorkspaceStore().requireId(), id, { position }))
    } catch (e) {
      // Restore the pre-drag position — a rejected move must not leave the block at a
      // spot the server never stored (a lie that survives until the next re-hydrate).
      b.position = prevPosition
      toast.add({
        title: tr('board.toast.moveFailed'),
        description: e instanceof Error ? e.message : String(e),
        icon: 'i-lucide-triangle-alert',
        color: 'error',
      })
    }
  }

  /**
   * Translate every DIRECT child of a container — the client half of the compensation the
   * backend's `shiftChildPositions` applies. A child's position is relative to its container's
   * content origin, so moving that origin (a north/west border drag) has to move the children
   * the other way or the contents slide with the border. Grandchildren ride their module.
   */
  function shiftChildren(parentId: string, dx: number, dy: number) {
    if (!dx && !dy) return
    for (const child of blocks.value) {
      if (child.parentId !== parentId) continue
      child.position = { x: child.position.x + dx, y: child.position.y + dy }
    }
  }

  /**
   * Local-only geometry update during an active border drag — the resize counterpart of
   * {@link previewMove}, and for the same reason: persisting every pointer move would let an
   * out-of-order response land a stale size after the user let go. Takes ABSOLUTE bounds and
   * derives the origin delta itself, so a caller can drive it from a running drag without
   * tracking what it has already applied. {@link resizeBlock} commits the final bounds once.
   */
  function previewResize(
    id: string,
    position: { x: number; y: number },
    size?: { w: number; h: number },
  ) {
    const b = getBlock(id)
    if (!b) return
    shiftChildren(id, b.position.x - position.x, b.position.y - position.y)
    b.position = position
    b.size = size
  }

  /**
   * Commit a border-drag resize: ONE call carrying both halves of the geometry, because only an
   * operation that sees the origin delta can translate the container's children with it (see
   * `BoardService.resizeBlock`). `from` is the pre-drag geometry — a rejected resize replays it
   * through {@link previewResize}, which undoes the child translation by the same arithmetic that
   * applied it, so a failure can't leave the contents offset from a box the server never stored.
   */
  async function resizeBlock(
    id: string,
    bounds: { position: { x: number; y: number }; size: { w: number; h: number } },
    from: { position: { x: number; y: number }; size?: { w: number; h: number } },
  ) {
    const b = getBlock(id)
    if (!b) return
    previewResize(id, bounds.position, bounds.size)
    try {
      upsert(await api.resizeBlock(useWorkspaceStore().requireId(), id, bounds))
    } catch (e) {
      previewResize(id, from.position, from.size)
      toast.add({
        title: tr('board.toast.resizeFailed'),
        description: e instanceof Error ? e.message : String(e),
        icon: 'i-lucide-triangle-alert',
        color: 'error',
      })
    }
  }

  /**
   * Patch the user-editable fields of a block (title, features, threshold…).
   *
   * Returns whether the patch was PERSISTED. Both failure modes are already reported here (an
   * unknown block is a no-op, a rejected write rolls back and toasts), so an inspector control
   * firing and forgetting stays correct. A caller that goes on to ASSERT what the patch achieved
   * must read it, or it announces links the rollback has just undone.
   */
  async function updateBlock(id: string, patch: UpdateBlockInput): Promise<boolean> {
    const b = getBlock(id)
    if (!b) return false
    // Snapshot ONLY the fields this patch touches so a rejected write restores them exactly
    // (a patch may set several at once) rather than leaving a stale optimistic value stuck on
    // screen with no feedback — the same rollback contract the other mutations here follow.
    // `Object.keys` is typed `string[]`, so the key set is narrowed to the patch contract once
    // here; every read and write below then goes through `PatchKey`, and a key outside the
    // contract cannot reach the block.
    const keys = Object.keys(patch) as PatchKey[]
    const prev: PatchSnapshot = {}
    const before = blockAsPatchable(b)
    for (const key of keys) prev[key] = before[key]
    Object.assign(b, patch) // optimistic
    try {
      upsert(await api.updateBlock(useWorkspaceStore().requireId(), id, patch))
      return true
    } catch (e) {
      // Re-resolve the block: a live event may have replaced its object reference (`upsert`
      // swaps in a fresh one) while the write was in flight, so `b` can be stale. Only revert
      // fields that still hold OUR optimistic value, so a newer server value that landed
      // mid-flight isn't clobbered by the rollback.
      const live = getBlock(id)
      if (live) {
        const cur = blockAsPatchable(live)
        for (const key of keys) {
          if (cur[key] === patch[key]) cur[key] = prev[key]
        }
      }
      toast.add({
        title: tr('board.toast.updateFailed'),
        description: e instanceof Error ? e.message : String(e),
        icon: 'i-lucide-triangle-alert',
        color: 'error',
      })
      return false
    }
  }

  // The dependency-edge writes, split along the same seam into a sibling factory over the same
  // context; re-exposed here so every existing caller is unchanged.
  const { toggleDependency, removeDependency } = createBoardDependencies(ctx)

  return {
    reparentBlock,
    previewMove,
    moveBlock,
    previewResize,
    resizeBlock,
    updateBlock,
    toggleDependency,
    removeDependency,
  }
}
