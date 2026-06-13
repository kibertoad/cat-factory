import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { Block, BlockStatus, BlockType } from '~/types/domain'
import { useWorkspaceStore } from '~/stores/workspace'

/**
 * The board: architecture blocks and the dependency edges between them. Blocks
 * are owned by the backend — this store is a hydrated cache. Read getters are
 * pure client logic; every mutation calls the API and applies the authoritative
 * block the server returns.
 */
export const useBoardStore = defineStore(
  'board',
  () => {
    const api = useApi()
    const blocks = ref<Block[]>([])

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

    const byId = computed(() => {
      const map = new Map<string, Block>()
      for (const b of blocks.value) map.set(b.id, b)
      return map
    })

    function getBlock(id: string) {
      return byId.value.get(id)
    }

    /** Top-level architecture blocks (the only ones drawn as Vue Flow nodes). */
    const frames = computed(() =>
      blocks.value.filter((b) => (b.level ?? 'frame') === 'frame'),
    )

    /** Direct children of a block, in insertion order. */
    function childrenOf(parentId: string) {
      return blocks.value.filter((b) => b.parentId === parentId)
    }

    /** Tasks directly inside a container (a service or a module). */
    function tasksOf(containerId: string) {
      return blocks.value.filter((b) => b.parentId === containerId && b.level === 'task')
    }

    /** Modules (sub-frames) inside a service. */
    function modulesOf(serviceId: string) {
      return blocks.value.filter((b) => b.parentId === serviceId && b.level === 'module')
    }

    /** Tasks anywhere under a container — directly, or nested inside its modules. */
    function allTasksUnder(containerId: string): Block[] {
      const direct = tasksOf(containerId)
      const nested = modulesOf(containerId).flatMap((m) => tasksOf(m.id))
      return [...direct, ...nested]
    }

    /** The top-level service a block ultimately belongs to. */
    function serviceOf(block: Block): Block | undefined {
      let cur: Block | undefined = block
      while (cur && cur.level !== 'frame') {
        cur = cur.parentId ? getBlock(cur.parentId) : undefined
      }
      return cur
    }

    /** All tasks across every service (used for the dependency picker). */
    const allTasks = computed(() => blocks.value.filter((b) => b.level === 'task'))

    /** A task's dependencies that are not yet merged (i.e. block it from running). */
    function unmetDeps(taskId: string) {
      const t = getBlock(taskId)
      if (!t) return [] as Block[]
      return t.dependsOn
        .map((id) => getBlock(id))
        .filter((b): b is Block => !!b && b.status !== 'done')
    }

    /** A task may run only once all of its dependencies have merged. */
    function isRunnable(taskId: string) {
      return unmetDeps(taskId).length === 0
    }

    /** Container status/progress are derived from the tasks under it (containers have no PR). */
    function frameProgress(frameId: string) {
      const tasks = allTasksUnder(frameId)
      if (tasks.length === 0) return getBlock(frameId)?.progress ?? 0
      const sum = tasks.reduce((n, t) => n + (t.status === 'done' ? 1 : t.progress), 0)
      return sum / tasks.length
    }

    /**
     * A frame is a long-lived service: it never reaches a terminal "done" —
     * tasks keep appearing. So its status reflects current *activity*, mapped
     * onto the shared status palette but capped below `done`:
     *   planned       → no tasks yet (empty)
     *   ready         → has tasks but nothing active (idle / caught up / "live")
     *   in_progress   → at least one task running or with an open PR
     *   blocked       → at least one task needs a decision
     */
    function frameStatus(frameId: string): BlockStatus {
      const tasks = allTasksUnder(frameId)
      if (tasks.length === 0) return 'planned'
      if (tasks.some((t) => t.status === 'blocked')) return 'blocked'
      if (tasks.some((t) => t.status === 'in_progress' || t.status === 'pr_ready')) return 'in_progress'
      return 'ready'
    }

    async function addBlock(type: BlockType, position: { x: number; y: number }): Promise<Block> {
      const block = await api.addFrame(useWorkspaceStore().requireId(), { type, position })
      upsert(block)
      return block
    }

    /** Simple grid layout for the Nth child inside a container. */
    function gridSlot(n: number, cols = 2, cw = 200, ch = 170, x0 = 16, y0 = 12) {
      return { x: x0 + (n % cols) * cw, y: y0 + Math.floor(n / cols) * ch }
    }

    /** Pixel size of a container's inner 2D canvas, derived from its children. */
    function containerSize(id: string): { w: number; h: number } {
      const b = getBlock(id)
      const isModule = b?.level === 'module'
      const TASK_W = 180
      const TASK_H = 160
      const headerH = isModule ? 30 : 0
      let w = isModule ? 200 : 360
      let inner = isModule ? 60 : 220
      for (const t of tasksOf(id)) {
        w = Math.max(w, t.position.x + TASK_W + 12)
        inner = Math.max(inner, t.position.y + TASK_H + 12)
      }
      for (const m of modulesOf(id)) {
        const s = containerSize(m.id)
        w = Math.max(w, m.position.x + s.w + 12)
        inner = Math.max(inner, m.position.y + s.h + 12)
      }
      return { w, h: inner + headerH }
    }

    /** Add a task inside a container (a service or a module). */
    async function addTask(containerId: string, title?: string): Promise<Block | undefined> {
      if (!getBlock(containerId)) return
      const block = await api.addTask(useWorkspaceStore().requireId(), containerId, { title })
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
      const block = await api.addModule(useWorkspaceStore().requireId(), serviceId, { name, position })
      upsert(block)
      return block
    }

    /** Move a block into a new container at a new local position. */
    async function reparentBlock(id: string, newParentId: string, position: { x: number; y: number }) {
      const b = getBlock(id)
      const parent = getBlock(newParentId)
      if (!b || !parent || b.id === newParentId) return
      // tasks may live in services or modules; modules only in services
      if (b.level === 'task' && parent.level !== 'frame' && parent.level !== 'module') return
      if (b.level === 'module' && parent.level !== 'frame') return
      upsert(await api.reparentBlock(useWorkspaceStore().requireId(), id, { parentId: newParentId, position }))
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
      byId,
      frames,
      allTasks,
      getBlock,
      childrenOf,
      tasksOf,
      modulesOf,
      allTasksUnder,
      serviceOf,
      containerSize,
      unmetDeps,
      isRunnable,
      frameProgress,
      frameStatus,
      addBlock,
      addTask,
      addModule,
      reparentBlock,
      removeBlock,
      moveBlock,
      updateBlock,
      toggleDependency,
      removeDependency,
    }
  },
)
