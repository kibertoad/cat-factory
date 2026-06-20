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
export const useBoardStore = defineStore('board', () => {
  const api = useApi()
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
  async function addServiceFromRepo(repoGithubId: number): Promise<Block> {
    const block = await api.addServiceFromRepo(useWorkspaceStore().requireId(), { repoGithubId })
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
    options?: { mergePresetId?: string; pipelineId?: string },
  ): Promise<Block | undefined> {
    if (!getBlock(containerId)) return
    const block = await api.addTask(useWorkspaceStore().requireId(), containerId, {
      title,
      description,
      ...(options?.mergePresetId ? { mergePresetId: options.mergePresetId } : {}),
      ...(options?.pipelineId ? { pipelineId: options.pipelineId } : {}),
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

  async function removeBlock(id: string) {
    if (!getBlock(id)) return
    await api.removeBlock(useWorkspaceStore().requireId(), id)
    // the server cascades to descendants; mirror that in the local cache
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
    blocks.value = blocks.value.filter((b) => !doomed.has(b.id))
    for (const b of blocks.value) {
      b.dependsOn = b.dependsOn.filter((d) => !doomed.has(d))
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
    removeBlock,
    moveBlock,
    updateBlock,
    toggleDependency,
    removeDependency,
  }
})
