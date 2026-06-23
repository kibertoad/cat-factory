import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { Block, BlockType } from '~/types/domain'
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
  /** Survivors whose `dependsOn` lost an edge to a removed block (originals to restore). */
  edges: { id: string; dependsOn: string[] }[]
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
      mergePresetId?: string
      pipelineId?: string
      agentConfig?: Record<string, string>
    },
  ): Promise<Block | undefined> {
    if (!getBlock(containerId)) return
    const block = await api.addTask(useWorkspaceStore().requireId(), containerId, {
      title,
      description,
      ...(options?.mergePresetId ? { mergePresetId: options.mergePresetId } : {}),
      ...(options?.pipelineId ? { pipelineId: options.pipelineId } : {}),
      ...(options?.agentConfig ? { agentConfig: options.agentConfig } : {}),
    })
    upsert(block)
    return block
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
    upsert(
      await api.reparentBlock(useWorkspaceStore().requireId(), id, {
        parentId: newParentId,
        position,
      }),
    )
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
    // Survivors that pointed at a doomed block lose that edge — snapshot the originals.
    const edges = blocks.value
      .filter((b) => !doomed.has(b.id) && b.dependsOn.some((d) => doomed.has(d)))
      .map((b) => ({ id: b.id, dependsOn: [...b.dependsOn] }))
    blocks.value = blocks.value.filter((b) => !doomed.has(b.id))
    for (const b of blocks.value) {
      if (b.dependsOn.some((d) => doomed.has(d))) {
        b.dependsOn = b.dependsOn.filter((d) => !doomed.has(d))
      }
    }
    return { removed, edges }
  }

  /** Re-insert a detached subtree and restore its broken edges (delete rollback). */
  function reattach(snap: RemovalSnapshot) {
    for (const b of snap.removed) if (!getBlock(b.id)) blocks.value.push(b)
    for (const e of snap.edges) {
      const b = getBlock(e.id)
      if (b) b.dependsOn = e.dependsOn
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

  /** Toggle a dependency edge target -> source (target dependsOn source). */
  async function toggleDependency(targetId: string, sourceId: string) {
    if (targetId === sourceId || !getBlock(targetId)) return
    upsert(await api.toggleDependency(useWorkspaceStore().requireId(), targetId, { sourceId }))
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
    reparentBlock,
    detach,
    reattach,
    removeBlock,
    moveBlock,
    updateBlock,
    toggleDependency,
    removeDependency,
  }
})
