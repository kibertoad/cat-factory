import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { Block, BlockType, CreateTaskType, TaskTypeFields } from '~/types/domain'
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
  /** Survivors whose `dependsOn`/`epicId` lost an edge to a removed block (originals to restore). */
  edges: { id: string; dependsOn: string[]; epicId: string | null }[]
}

export const useBoardStore = defineStore('board', () => {
  const api = useApi()
  const toast = useToast()
  const blocks = ref<Block[]>([])

  // Pure derivations (hierarchy, status/progress, sizing) live in the composable.
  const queries = useBlockQueries(blocks)
  const { getBlock } = queries

  /** Replace the cached blocks with a server snapshot. */
  function hydrate(next: Block[]) {
    blocks.value = next
  }

  /** Insert or replace a block returned by the backend. */
  function upsert(block: Block) {
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
    opts?: { directory?: string; isMonorepo?: boolean },
  ): Promise<Block> {
    const block = await api.addServiceFromRepo(useWorkspaceStore().requireId(), {
      repoGithubId,
      ...(opts?.directory ? { directory: opts.directory } : {}),
      ...(opts?.isMonorepo !== undefined ? { isMonorepo: opts.isMonorepo } : {}),
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
        title: 'Could not change epic',
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

  /** Move a block into a new container at a new local position. */
  async function reparentBlock(
    id: string,
    newParentId: string,
    position: { x: number; y: number },
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
    b.parentId = newParentId
    b.position = position
    try {
      upsert(
        await api.reparentBlock(useWorkspaceStore().requireId(), id, {
          parentId: newParentId,
          position,
        }),
      )
    } catch (e) {
      b.parentId = prevParentId
      b.position = prevPosition
      toast.add({
        title: 'Could not move',
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
    // Survivors that pointed at a doomed block (dependency edge or epic membership) lose
    // that link — snapshot the originals so a failed delete restores them faithfully.
    const edges = blocks.value
      .filter(
        (b) =>
          !doomed.has(b.id) &&
          (b.dependsOn.some((d) => doomed.has(d)) || (b.epicId != null && doomed.has(b.epicId))),
      )
      .map((b) => ({ id: b.id, dependsOn: [...b.dependsOn], epicId: b.epicId ?? null }))
    blocks.value = blocks.value.filter((b) => !doomed.has(b.id))
    for (const b of blocks.value) {
      if (b.dependsOn.some((d) => doomed.has(d))) {
        b.dependsOn = b.dependsOn.filter((d) => !doomed.has(d))
      }
      // A member of a deleted epic loses its membership (the task itself survives).
      if (b.epicId != null && doomed.has(b.epicId)) b.epicId = null
    }
    return { removed, edges }
  }

  /** Re-insert a detached subtree and restore its broken edges (delete rollback). */
  function reattach(snap: RemovalSnapshot) {
    for (const b of snap.removed) if (!getBlock(b.id)) blocks.value.push(b)
    for (const e of snap.edges) {
      const b = getBlock(e.id)
      if (b) {
        b.dependsOn = e.dependsOn
        b.epicId = e.epicId
      }
    }
  }

  /**
   * Delete a block. The subtree is hidden IMMEDIATELY (optimistic) so the board
   * feels instant; if the backend rejects the delete we put it back and surface a
   * toast rather than silently leaving a ghost.
   */
  async function removeBlock(id: string) {
    const snap = detach(id)
    if (!snap) return
    try {
      await api.removeBlock(useWorkspaceStore().requireId(), id)
    } catch (e) {
      reattach(snap)
      toast.add({
        title: 'Could not delete',
        description: e instanceof Error ? e.message : String(e),
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
    b.position = position // optimistic: keep the drag feeling instant
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
  }

  /** Patch the user-editable fields of a block (title, features, threshold…). */
  async function updateBlock(id: string, patch: Partial<Block>) {
    const b = getBlock(id)
    if (!b) return
    Object.assign(b, patch) // optimistic
    upsert(await api.updateBlock(useWorkspaceStore().requireId(), id, patch))
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
        title: 'Could not link tasks',
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
