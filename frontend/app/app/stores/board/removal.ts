import { useServicesStore } from '~/stores/services'
import { useWorkspaceStore } from '~/stores/workspace'
import type { BoardWriteContext, RemovalSnapshot } from './context'
import { UNDO_WINDOW_MS } from './context'

/**
 * The optimistic delete / deferred-commit / undo lifecycle for board blocks, extracted from the
 * `board` store setup. Operates on the shared {@link BoardWriteContext} state so behaviour is
 * identical to the original in-closure functions. `detach`/`reattach`/`removeBlock` are exposed on
 * the store (other stores delete a block through their own endpoint then `detach` here); `undoRemove`
 * stays internal — it is only wired into the delete toast's undo action.
 */
export function createBoardRemoval(ctx: BoardWriteContext) {
  const { blocks, getBlock, pendingRemovals, pendingDoomed, api, toast, tr } = ctx

  /**
   * Optimistically drop a block and its descendants from the cache, returning a
   * snapshot so the removal can be undone if the backend call fails. The server
   * cascades to descendants, so we mirror that here. Exposed for other stores
   * (e.g. recurring pipelines) that delete a block through their own endpoint.
   */
  function detach(id: string): RemovalSnapshot | null {
    if (!getBlock(id)) return null
    const doomed = new Set<string>([id])
    let grew = true
    while (grew) {
      grew = false
      for (const b of blocks.value) {
        if (b.parentId && doomed.has(b.parentId) && !doomed.has(b.id)) {
          doomed.add(b.id)
          grew = true
        }
      }
    }
    const removed = blocks.value.filter((b) => doomed.has(b.id))
    // Survivors that pointed at a doomed block (dependency edge, epic membership, or initiative
    // membership) lose that link — snapshot the originals so a failed delete restores them
    // faithfully. Mirrors the backend `pruneDanglingEdges` detach.
    const edges = blocks.value
      .filter(
        (b) =>
          !doomed.has(b.id) &&
          (b.dependsOn.some((d) => doomed.has(d)) ||
            (b.epicId != null && doomed.has(b.epicId)) ||
            (b.initiativeId != null && doomed.has(b.initiativeId))),
      )
      .map((b) => ({
        id: b.id,
        dependsOn: [...b.dependsOn],
        epicId: b.epicId ?? null,
        initiativeId: b.initiativeId ?? null,
      }))
    blocks.value = blocks.value.filter((b) => !doomed.has(b.id))
    for (const b of blocks.value) {
      if (b.dependsOn.some((d) => doomed.has(d))) {
        b.dependsOn = b.dependsOn.filter((d) => !doomed.has(d))
      }
      // A member of a deleted epic loses its membership (the task itself survives).
      if (b.epicId != null && doomed.has(b.epicId)) b.epicId = null
      // Likewise a task spawned by a deleted initiative loses its (non-structural) membership.
      if (b.initiativeId != null && doomed.has(b.initiativeId)) b.initiativeId = null
    }
    return { removed, edges }
  }

  /** Re-insert a detached subtree and restore its broken edges (delete rollback). */
  function reattach(snap: RemovalSnapshot) {
    for (const b of snap.removed) if (!getBlock(b.id)) blocks.value.push(b)
    const restored = new Set(snap.removed.map((b) => b.id))
    for (const e of snap.edges) {
      const b = getBlock(e.id)
      if (!b) continue
      // Re-establish only the links that pointed at a now-restored block, merged with
      // whatever the survivor gained meanwhile — so a delayed undo (the delete is deferred by
      // a window during which a live event may add edges) doesn't clobber a newer dependency /
      // epic / initiative link with the stale detach-time snapshot.
      const readd = e.dependsOn.filter((d) => restored.has(d) && !b.dependsOn.includes(d))
      if (readd.length) b.dependsOn = [...b.dependsOn, ...readd]
      if (b.epicId == null && e.epicId != null && restored.has(e.epicId)) b.epicId = e.epicId
      if (b.initiativeId == null && e.initiativeId != null && restored.has(e.initiativeId)) {
        b.initiativeId = e.initiativeId
      }
    }
  }

  /** Cancel a still-pending delete and restore the hidden subtree. */
  function undoRemove(id: string) {
    const pending = pendingRemovals.get(id)
    if (!pending) return
    clearTimeout(pending.timer)
    pendingRemovals.delete(id)
    for (const b of pending.snap.removed) pendingDoomed.delete(b.id)
    // Don't resurrect the subtree into a different workspace if the user navigated away
    // mid-window; the delete was already cancelled, which is the safe outcome there.
    if (useWorkspaceStore().workspaceId !== pending.wsId) return
    reattach(pending.snap)
  }

  /**
   * Delete a block. The subtree is hidden IMMEDIATELY (optimistic) so the board feels
   * instant, and the real backend delete is DEFERRED by {@link UNDO_WINDOW_MS} so the
   * accompanying "Deleted — Undo" toast can cancel it in place (a genuine undo, since
   * nothing was destroyed server-side yet). The subtree stays filtered out of any
   * hydrate/upsert in the meantime (see `applyPendingRemovals`). If the deferred
   * call ultimately fails we put the subtree back and surface an error toast.
   */
  function removeBlock(
    id: string,
    opts: { onCommit?: (wsId: string) => void | Promise<void> } = {},
  ) {
    const block = getBlock(id)
    const snap = detach(id)
    if (!block || !snap) return
    // Capture the workspace now: the deferred delete must target the workspace the block
    // was deleted from even if the user has since switched.
    const wsId = useWorkspaceStore().requireId()
    for (const b of snap.removed) pendingDoomed.add(b.id)

    const finalize = async () => {
      const pending = pendingRemovals.get(id)
      if (!pending) return
      pendingRemovals.delete(id)
      try {
        // Any irreversible side effect the delete implies (e.g. cancelling the block's run)
        // is deferred to here so it fires only once the delete truly commits — undo within
        // the window then leaves the run untouched instead of restoring an already-cancelled one.
        await opts.onCommit?.(pending.wsId)
        await api.removeBlock(pending.wsId, id)
        // A service frame's delete also reclaims its account-owned service server-side, but this
        // tab is not echoed its own coarse `board` event, so nothing re-hydrates the service
        // catalog here — drop the deleted service locally so the add-service picker stops flagging
        // its repo as "already on board" (a no-op for a task/module). Only after the commit, so a
        // still-linked repo is never briefly presented as addable.
        if (useWorkspaceStore().workspaceId === pending.wsId)
          useServicesStore().dropByFrameBlock(id)
        // Stop filtering the subtree only after the server has actually dropped it, so a
        // snapshot that raced the in-flight delete can't briefly resurrect it.
        for (const b of pending.snap.removed) pendingDoomed.delete(b.id)
      } catch (e) {
        for (const b of pending.snap.removed) pendingDoomed.delete(b.id)
        // Only restore into the board the block was deleted from; a mid-window workspace
        // switch must not inject the old subtree onto the workspace now on screen (it
        // re-hydrates from the server there on the next refresh anyway).
        if (useWorkspaceStore().workspaceId === pending.wsId) reattach(pending.snap)
        toast.add({
          title: tr('board.toast.deleteFailed'),
          description: e instanceof Error ? e.message : String(e),
          icon: 'i-lucide-triangle-alert',
          color: 'error',
        })
      }
    }
    const timer = setTimeout(() => void finalize(), UNDO_WINDOW_MS)
    pendingRemovals.set(id, { snap, timer, wsId })

    toast.add({
      title: tr('board.toast.deleted', { name: block.title }),
      icon: 'i-lucide-trash-2',
      color: 'neutral',
      duration: UNDO_WINDOW_MS,
      actions: [
        {
          label: tr('common.undo'),
          icon: 'i-lucide-undo-2',
          onClick: () => undoRemove(id),
        },
      ],
    })
  }

  return { detach, reattach, removeBlock }
}
