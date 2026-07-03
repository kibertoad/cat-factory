import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { UpdateBlockInput } from '@cat-factory/contracts'
import type {
  Block,
  BlockType,
  CreateTaskType,
  FrameRepoType,
  TaskTypeFields,
} from '~/types/domain'
import { useServicesStore } from '~/stores/services'
import { useWorkspaceStore } from '~/stores/workspace'
import { useBlockQueries } from '~/composables/useBlockQueries'

/**
 * The board: architecture blocks and the dependency edges between them. Blocks
 * are owned by the backend — this store is a hydrated cache. Read getters are
 * pure client logic (see {@link useBlockQueries}); every mutation calls the API
 * and applies the authoritative block the server returns.
 */
/** A detached subtree captured before an optimistic delete, restored on failure. */
interface RemovalSnapshot {
  /** The removed block + all its descendants, in their original order. */
  removed: Block[]
  /**
   * Survivors whose `dependsOn`/`epicId`/`initiativeId` lost an edge to a removed block
   * (originals to restore on rollback).
   */
  edges: { id: string; dependsOn: string[]; epicId: string | null; initiativeId: string | null }[]
}

export const useBoardStore = defineStore('board', () => {
  const api = useApi()
  const toast = useToast()
  // Stores run outside a component `setup`, so resolve translations through the Nuxt app's
  // global i18n instance (the same handle `plugins/locale.client.ts` uses) rather than
  // `useI18n()`, which requires an active component instance.
  const nuxtApp = useNuxtApp()
  const tr = (key: string, params?: Record<string, unknown>): string =>
    (nuxtApp.$i18n as { t: (k: string, p?: Record<string, unknown>) => string }).t(
      key,
      params ?? {},
    )
  const blocks = ref<Block[]>([])

  // Pure derivations (hierarchy, status/progress, sizing) live in the composable.
  const queries = useBlockQueries(blocks)
  const { getBlock } = queries

  /**
   * How long a deleted block stays undoable. The backend delete is DEFERRED for this
   * window (a real "undo", not a client illusion) — the block is hidden immediately but
   * only actually deleted once the window elapses, so undo just cancels the pending call.
   */
  const UNDO_WINDOW_MS = 6000
  /**
   * Blocks hidden by an optimistic delete whose backend call hasn't fired yet, keyed by
   * the deleted root's id. Their subtree stays filtered out of every incoming server
   * snapshot (`hydrate`) and single-block live event (`upsert`) for the undo window, so a
   * coarse refresh or a stray event can't resurrect a block the user just deleted.
   */
  const pendingRemovals = new Map<
    string,
    { snap: RemovalSnapshot; timer: ReturnType<typeof setTimeout>; wsId: string }
  >()
  // Flat set of every id in a pending removal (root + descendants), for O(1) checks in the
  // hot upsert path. Kept in lockstep with `pendingRemovals`.
  const pendingDoomed = new Set<string>()

  /**
   * Drop any pending-removal subtree from a reconciled block list and prune survivors'
   * edges to it — the same detach the backend will perform once the deferred delete fires.
   * Applied to every hydrate so the undo window survives a full refresh.
   */
  function applyPendingRemovals(list: Block[]): Block[] {
    if (pendingDoomed.size === 0) return list
    const survivors = list.filter((b) => !pendingDoomed.has(b.id))
    for (const b of survivors) {
      if (b.dependsOn.some((d) => pendingDoomed.has(d))) {
        b.dependsOn = b.dependsOn.filter((d) => !pendingDoomed.has(d))
      }
      if (b.epicId != null && pendingDoomed.has(b.epicId)) b.epicId = null
      if (b.initiativeId != null && pendingDoomed.has(b.initiativeId)) b.initiativeId = null
    }
    return survivors
  }

  /**
   * Reconcile the cached blocks against a server snapshot, reusing the existing
   * object for any block whose content is unchanged. The server stays authoritative
   * (it replaces optimistic edits and drops deleted blocks), but an unchanged block
   * keeps its identity, so a coarse full-refresh doesn't hand every frame/task a new
   * object reference and force the whole board to re-render — only genuinely changed
   * blocks invalidate. Blocks are emitted in a stable order by the backend mapper, so
   * a per-block JSON compare is a reliable, cheap (refresh is debounced) equality check.
   */
  // Per-object serialization cache, keyed by block identity so it self-invalidates: a
  // block we keep (same reference) stays cached, while a fresh/`upsert`ed object isn't in
  // the map and is re-serialized. Lets a hydrate stringify each kept block once (the
  // incoming snapshot) rather than twice (existing + incoming).
  const serialized = new WeakMap<Block, string>()
  function jsonFor(b: Block): string {
    let s = serialized.get(b)
    if (s === undefined) {
      s = JSON.stringify(b)
      serialized.set(b, s)
    }
    return s
  }
  function hydrate(next: Block[]) {
    const prev = new Map(blocks.value.map((b) => [b.id, b]))
    const reconciled = next.map((n) => {
      const existing = prev.get(n.id)
      return existing && jsonFor(existing) === jsonFor(n) ? existing : n
    })
    // Keep blocks the user just deleted hidden while their delete is still pending.
    blocks.value = applyPendingRemovals(reconciled)
  }

  /** Insert or replace a block returned by the backend. */
  function upsert(block: Block) {
    // A live event for a block awaiting its deferred delete must not resurrect it.
    if (pendingDoomed.has(block.id)) return
    const i = blocks.value.findIndex((b) => b.id === block.id)
    if (i >= 0) blocks.value[i] = block
    else blocks.value.push(block)
  }

  async function addBlock(type: BlockType, position: { x: number; y: number }): Promise<Block> {
    const block = await api.addFrame(useWorkspaceStore().requireId(), { type, position })
    upsert(block)
    return block
  }

  /**
   * Import an existing GitHub repo (the App is installed + it's projected) as a
   * service frame, with no bootstrap run. The backend links the repo to the new
   * frame and returns it `ready`; we upsert it onto the board.
   */
  async function addServiceFromRepo(
    repoGithubId: number,
    opts?: {
      directory?: string
      isMonorepo?: boolean
      type?: FrameRepoType
      position?: { x: number; y: number }
    },
  ): Promise<Block> {
    const block = await api.addServiceFromRepo(useWorkspaceStore().requireId(), {
      repoGithubId,
      ...(opts?.directory ? { directory: opts.directory } : {}),
      ...(opts?.isMonorepo !== undefined ? { isMonorepo: opts.isMonorepo } : {}),
      ...(opts?.type ? { type: opts.type } : {}),
      ...(opts?.position ? { position: opts.position } : {}),
    })
    upsert(block)
    return block
  }

  /**
   * Add a task inside a container (a service or a module). The user supplies the
   * title (and optional description) — the task is created in `planned` state and
   * is not launched until the user explicitly starts a pipeline on it.
   */
  async function addTask(
    containerId: string,
    title: string,
    description?: string,
    options?: {
      taskType?: CreateTaskType
      taskTypeFields?: TaskTypeFields
      mergePresetId?: string
      modelPresetId?: string
      pipelineId?: string
      agentConfig?: Record<string, string>
      technical?: boolean
    },
  ): Promise<Block | undefined> {
    if (!getBlock(containerId)) return
    const block = await api.addTask(useWorkspaceStore().requireId(), containerId, {
      title,
      description,
      ...(options?.taskType ? { taskType: options.taskType } : {}),
      ...(options?.taskTypeFields ? { taskTypeFields: options.taskTypeFields } : {}),
      ...(options?.mergePresetId ? { mergePresetId: options.mergePresetId } : {}),
      ...(options?.modelPresetId ? { modelPresetId: options.modelPresetId } : {}),
      ...(options?.pipelineId ? { pipelineId: options.pipelineId } : {}),
      ...(options?.agentConfig ? { agentConfig: options.agentConfig } : {}),
      ...(options?.technical ? { technical: true } : {}),
    })
    upsert(block)
    return block
  }

  /**
   * Add an epic grouping node. Epics are non-structural: they group tasks via the tasks'
   * `epicId`, so this just drops a new `epic`-level block on the board.
   */
  async function addEpic(
    title: string,
    position: { x: number; y: number },
    options?: { description?: string; parentId?: string },
  ): Promise<Block> {
    const block = await api.addEpic(useWorkspaceStore().requireId(), {
      title,
      position,
      ...(options?.description ? { description: options.description } : {}),
      ...(options?.parentId ? { parentId: options.parentId } : {}),
    })
    upsert(block)
    return block
  }

  /** Assign a task to an epic, or detach it (epicId: null). */
  async function assignToEpic(taskId: string, epicId: string | null) {
    const t = getBlock(taskId)
    if (!t) return
    const prev = t.epicId ?? null
    t.epicId = epicId // optimistic
    try {
      upsert(await api.assignToEpic(useWorkspaceStore().requireId(), taskId, { epicId }))
    } catch (e) {
      t.epicId = prev
      toast.add({
        title: tr('board.toast.epicFailed'),
        description: e instanceof Error ? e.message : String(e),
        icon: 'i-lucide-triangle-alert',
        color: 'error',
      })
    }
  }

  /** Add a module (sub-frame) inside a service. */
  async function addModule(
    serviceId: string,
    name: string,
    position?: { x: number; y: number },
  ): Promise<Block | undefined> {
    if (!getBlock(serviceId)) return
    const block = await api.addModule(useWorkspaceStore().requireId(), serviceId, {
      name,
      position,
    })
    upsert(block)
    return block
  }

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
      toast.add({
        title: tr('board.toast.moveFailed'),
        description: e instanceof Error ? e.message : String(e),
        icon: 'i-lucide-triangle-alert',
        color: 'error',
      })
    }
  }

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

  /**
   * Delete a block. The subtree is hidden IMMEDIATELY (optimistic) so the board feels
   * instant, and the real backend delete is DEFERRED by {@link UNDO_WINDOW_MS} so the
   * accompanying "Deleted — Undo" toast can cancel it in place (a genuine undo, since
   * nothing was destroyed server-side yet). The subtree stays filtered out of any
   * hydrate/upsert in the meantime (see {@link applyPendingRemovals}). If the deferred
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

  /** Patch the user-editable fields of a block (title, features, threshold…). */
  async function updateBlock(id: string, patch: UpdateBlockInput) {
    const b = getBlock(id)
    if (!b) return
    // Snapshot ONLY the fields this patch touches so a rejected write restores them exactly
    // (a patch may set several at once) rather than leaving a stale optimistic value stuck on
    // screen with no feedback — the same rollback contract the other mutations here follow.
    const prev: Record<string, unknown> = {}
    const patchRecord = patch as Record<string, unknown>
    const record = b as unknown as Record<string, unknown>
    for (const key of Object.keys(patch)) prev[key] = record[key]
    Object.assign(b, patch) // optimistic
    try {
      upsert(await api.updateBlock(useWorkspaceStore().requireId(), id, patch))
    } catch (e) {
      // Re-resolve the block: a live event may have replaced its object reference (`upsert`
      // swaps in a fresh one) while the write was in flight, so `b` can be stale. Only revert
      // fields that still hold OUR optimistic value, so a newer server value that landed
      // mid-flight isn't clobbered by the rollback.
      const cur = getBlock(id) as unknown as Record<string, unknown> | undefined
      if (cur) {
        for (const key of Object.keys(patch)) {
          if (cur[key] === patchRecord[key]) cur[key] = prev[key]
        }
      }
      toast.add({
        title: tr('board.toast.updateFailed'),
        description: e instanceof Error ? e.message : String(e),
        icon: 'i-lucide-triangle-alert',
        color: 'error',
      })
    }
  }

  /**
   * Toggle a dependency edge target -> source (target dependsOn source). The backend
   * rejects an edge that would close a cycle (422) — surface that as a toast rather than
   * letting it throw unhandled out of a board gesture.
   */
  async function toggleDependency(targetId: string, sourceId: string) {
    if (targetId === sourceId || !getBlock(targetId)) return
    try {
      upsert(await api.toggleDependency(useWorkspaceStore().requireId(), targetId, { sourceId }))
    } catch (e) {
      toast.add({
        title: tr('board.toast.linkFailed'),
        description: e instanceof Error ? e.message : String(e),
        icon: 'i-lucide-triangle-alert',
        color: 'error',
      })
    }
  }

  /** Remove a dependency edge target -> source if it exists. */
  async function removeDependency(targetId: string, sourceId: string) {
    const t = getBlock(targetId)
    if (!t || !t.dependsOn.includes(sourceId)) return
    // the backend exposes a single toggle; the edge exists, so toggling removes it
    upsert(await api.toggleDependency(useWorkspaceStore().requireId(), targetId, { sourceId }))
  }

  return {
    blocks,
    hydrate,
    upsert,
    ...queries,
    addBlock,
    addServiceFromRepo,
    addTask,
    addModule,
    addEpic,
    assignToEpic,
    reparentBlock,
    detach,
    reattach,
    removeBlock,
    previewMove,
    moveBlock,
    updateBlock,
    toggleDependency,
    removeDependency,
  }
})
