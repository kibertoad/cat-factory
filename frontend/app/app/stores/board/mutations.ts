import type { UpdateBlockInput } from '@cat-factory/contracts'
import type {
  BlockType,
  CreateTaskType,
  FrameRepoType,
  TaskTypeFields,
  Block,
} from '~/types/domain'
import { useServicesStore } from '~/stores/services'
import { useWorkspaceStore } from '~/stores/workspace'
import type { BoardWriteContext } from './context'
import { UNDO_WINDOW_MS } from './context'

/**
 * The board's create / move / update / dependency write operations, extracted from the store
 * setup. Each closes over the shared {@link BoardWriteContext} (the authoritative block returned
 * by the API is applied via `upsert`) so behaviour is identical to the original in-closure
 * functions — the split is purely to keep every function within the size budget.
 */
export function createBoardMutations(ctx: BoardWriteContext) {
  const { getBlock, upsert, api, toast, tr } = ctx

  async function addBlock(type: BlockType, position: { x: number; y: number }): Promise<Block> {
    const block = await api.addFrame(useWorkspaceStore().requireId(), { type, position })
    upsert(block)
    return block
  }

  /**
   * Import an existing GitHub repo (the App is installed + it's projected) as a
   * service frame, with no bootstrap run. The backend links the repo to the new
   * frame and returns it `ready`; we upsert it onto the board. When the repo already
   * backs an org service, the backend MOUNTS that shared service here instead of
   * minting a rival — so refresh the snapshot to pull in the shared frame's subtree
   * + its mount layout (a fresh import has no subtree, but the reconcile is harmless).
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
    await useWorkspaceStore().refresh()
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
      riskPolicyId?: string
      modelPresetId?: string
      pipelineId?: string
      agentConfig?: Record<string, string>
      fragmentIds?: string[]
      technical?: boolean
    },
  ): Promise<Block | undefined> {
    if (!getBlock(containerId)) return
    const block = await api.addTask(useWorkspaceStore().requireId(), containerId, {
      title,
      description,
      ...(options?.taskType ? { taskType: options.taskType } : {}),
      ...(options?.taskTypeFields ? { taskTypeFields: options.taskTypeFields } : {}),
      ...(options?.riskPolicyId ? { riskPolicyId: options.riskPolicyId } : {}),
      ...(options?.modelPresetId ? { modelPresetId: options.modelPresetId } : {}),
      ...(options?.pipelineId ? { pipelineId: options.pipelineId } : {}),
      ...(options?.agentConfig ? { agentConfig: options.agentConfig } : {}),
      // Forward the selection when the caller provides one (the create form always does, even
      // when empty — an explicit clear the backend must honour rather than re-seed); omit only
      // when a caller doesn't manage fragments at all (then the backend seeds from the service).
      ...(options?.fragmentIds !== undefined ? { fragmentIds: options.fragmentIds } : {}),
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
   * Archive a service (hide it + its subtree, restorable with no expiry) — the non-destructive
   * alternative to deleting a service that still has unfinished tasks. The acting tab isn't
   * echoed its own coarse board event, so re-hydrate explicitly to drop the frame from the board
   * and surface it under the archived list.
   */
  async function archiveService(id: string) {
    await api.archiveBlock(useWorkspaceStore().requireId(), id)
    await useWorkspaceStore().refresh()
  }

  /** Restore an archived service back onto the board. Re-hydrates to pull its subtree back in. */
  async function restoreService(id: string) {
    await api.restoreBlock(useWorkspaceStore().requireId(), id)
    await useWorkspaceStore().refresh()
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
    try {
      upsert(await api.toggleDependency(useWorkspaceStore().requireId(), targetId, { sourceId }))
    } catch (e) {
      // Mirror `toggleDependency`: a failure must surface (and leave the edge visible) rather
      // than rejecting unhandled with no feedback.
      toast.add({
        title: tr('board.toast.unlinkFailed'),
        description: e instanceof Error ? e.message : String(e),
        icon: 'i-lucide-triangle-alert',
        color: 'error',
      })
    }
  }

  return {
    addBlock,
    addServiceFromRepo,
    addTask,
    addModule,
    addEpic,
    assignToEpic,
    reparentBlock,
    archiveService,
    restoreService,
    previewMove,
    moveBlock,
    updateBlock,
    toggleDependency,
    removeDependency,
  }
}
