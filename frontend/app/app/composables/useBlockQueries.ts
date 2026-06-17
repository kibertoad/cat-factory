import { computed, type Ref } from 'vue'
import type { Block, BlockStatus } from '~/types/domain'

/**
 * Pure, read-only queries over a board's blocks. Extracted from the board store
 * so the (sizeable) derivation logic — hierarchy traversal, status/progress
 * rollups and container sizing — lives in one focused, independently testable
 * place. The store wires these against its reactive `blocks` cache and re-exposes
 * them unchanged, so callers and tests are unaffected.
 */
export function useBlockQueries(blocks: Ref<Block[]>) {
  const byId = computed(() => {
    const map = new Map<string, Block>()
    for (const b of blocks.value) map.set(b.id, b)
    return map
  })

  function getBlock(id: string) {
    return byId.value.get(id)
  }

  /** Top-level architecture blocks (the only ones drawn as Vue Flow nodes). */
  const frames = computed(() => blocks.value.filter((b) => (b.level ?? 'frame') === 'frame'))

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
    if (tasks.some((t) => t.status === 'in_progress' || t.status === 'pr_ready'))
      return 'in_progress'
    return 'ready'
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

  return {
    byId,
    getBlock,
    frames,
    allTasks,
    childrenOf,
    tasksOf,
    modulesOf,
    allTasksUnder,
    serviceOf,
    unmetDeps,
    isRunnable,
    frameProgress,
    frameStatus,
    containerSize,
  }
}
