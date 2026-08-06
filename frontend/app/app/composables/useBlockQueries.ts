import { computed, type Ref } from 'vue'
import type { Block, BlockStatus } from '~/types/domain'
import { LANE_GEOMETRY } from '~/utils/laneGeometry'

/**
 * Pure, read-only queries over a board's blocks. Extracted from the board store
 * so the (sizeable) derivation logic — hierarchy traversal, status/progress
 * rollups and container sizing — lives in one focused, independently testable
 * place. The store wires these against its reactive `blocks` cache and re-exposes
 * them unchanged, so callers and tests are unaffected.
 */
export function useBlockQueries(blocks: Ref<Block[]>) {
  /**
   * Single-pass indexes rebuilt once per `blocks` change: id → block,
   * parentId → children (insertion order), epicId → members. Every per-frame
   * query reads these instead of re-scanning the whole array, so a streamed
   * single-block upsert costs ~O(children touched) rather than O(frames × N).
   */
  const index = computed(() => {
    const byId = new Map<string, Block>()
    const childrenByParent = new Map<string, Block[]>()
    const membersByEpic = new Map<string, Block[]>()
    for (const b of blocks.value) {
      byId.set(b.id, b)
      if (b.parentId) {
        const siblings = childrenByParent.get(b.parentId)
        if (siblings) siblings.push(b)
        else childrenByParent.set(b.parentId, [b])
      }
      if (b.epicId) {
        const members = membersByEpic.get(b.epicId)
        if (members) members.push(b)
        else membersByEpic.set(b.epicId, [b])
      }
    }
    return { byId, childrenByParent, membersByEpic }
  })

  const byId = computed(() => index.value.byId)

  function getBlock(id: string) {
    return index.value.byId.get(id)
  }

  /** Top-level architecture blocks (the only ones drawn as Vue Flow nodes). */
  const frames = computed(() => blocks.value.filter((b) => (b.level ?? 'frame') === 'frame'))

  /** Direct children of a block, in insertion order. */
  function childrenOf(parentId: string) {
    return index.value.childrenByParent.get(parentId) ?? []
  }

  /** Tasks directly inside a container (a service or a module). */
  function tasksOf(containerId: string) {
    return childrenOf(containerId).filter((b) => b.level === 'task')
  }

  /** Modules (sub-frames) inside a service. */
  function modulesOf(serviceId: string) {
    return childrenOf(serviceId).filter((b) => b.level === 'module')
  }

  /** Initiative containers inside a service (frame children, like modules). */
  function initiativesOf(serviceId: string) {
    return childrenOf(serviceId).filter((b) => b.level === 'initiative')
  }

  /** Tasks anywhere under a container — directly, or nested inside its modules. */
  function allTasksUnder(containerId: string): Block[] {
    const direct = tasksOf(containerId)
    const nested = modulesOf(containerId).flatMap((m) => tasksOf(m.id))
    return [...direct, ...nested]
  }

  /**
   * Every block nested under a container (transitive), excluding the container
   * itself — the exact set a delete cascades over. Used to state the blast radius
   * in the delete confirmation. Structural children only (via `parentId`), so a
   * non-structural epic membership is not counted.
   */
  function descendantsOf(id: string): Block[] {
    const out: Block[] = []
    const stack = [...childrenOf(id)]
    while (stack.length > 0) {
      const b = stack.pop()!
      out.push(b)
      stack.push(...childrenOf(b.id))
    }
    return out
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

  /** Epic grouping nodes (non-structural; group tasks via their `epicId`). */
  const epics = computed(() => blocks.value.filter((b) => b.level === 'epic'))

  /** The tasks that belong to an epic (anywhere on the board) via their `epicId`. */
  function epicMembers(epicId: string): Block[] {
    return index.value.membersByEpic.get(epicId) ?? []
  }

  /** The epic a task belongs to, if any. */
  function epicOf(task: Block): Block | undefined {
    return task.epicId ? getBlock(task.epicId) : undefined
  }

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
    // Initiative containers are frame children too: a frame holding only an initiative
    // is NOT empty, and an active (planning/executing → block `in_progress`) or blocked
    // initiative drives the frame's activity dot just like a task does.
    const inits = initiativesOf(frameId)
    if (tasks.length === 0 && inits.length === 0) return 'planned'
    if (tasks.some((t) => t.status === 'blocked') || inits.some((i) => i.status === 'blocked'))
      return 'blocked'
    if (
      tasks.some((t) => t.status === 'in_progress' || t.status === 'pr_ready') ||
      inits.some((i) => i.status === 'in_progress')
    )
      return 'in_progress'
    return 'ready'
  }

  /**
   * The natural extent of a frame's inner canvas — the smallest size that fits its swimlanes
   * and its initiative band. This is the floor a resizable frame can never be dragged below.
   *
   * Task positions are deliberately NOT consulted any more. Tasks are laid out in status
   * lanes, so the frame's size is a function of the LANE GEOMETRY, not of where cards happen
   * to sit, and each lane SCROLLS rather than growing without bound. That decoupling is what
   * fixes the old behaviour where a service accumulating work grew a taller and taller frame
   * until it dwarfed its neighbours, and it is also what keeps this function pure over blocks:
   * a lane's population depends on run state, which this layer cannot see and must not need to.
   */
  function contentSize(id: string): { w: number; h: number } {
    const b = getBlock(id)
    // A module is no longer drawn as a box (its tasks appear in the frame's lanes, grouped by
    // module name), so it has no canvas of its own. A minimal size keeps any incidental caller
    // honest rather than returning zero, which would read as "measured, and empty".
    if (b?.level === 'module') return { w: LANE_GEOMETRY.laneWidth, h: 0 }

    // Initiative cards sit in a wrapping band above the lanes, one fixed row height each.
    const perRow = Math.max(
      1,
      Math.floor(LANE_GEOMETRY.canvasWidth / LANE_GEOMETRY.initiativeWidth),
    )
    const initiativeRows = Math.ceil(initiativesOf(id).length / perRow)

    return {
      w: LANE_GEOMETRY.canvasWidth,
      h:
        initiativeRows * LANE_GEOMETRY.initiativeHeight +
        LANE_GEOMETRY.laneBodyHeight +
        LANE_GEOMETRY.laneHeaderHeight +
        LANE_GEOMETRY.doneStripHeight,
    }
  }

  /**
   * Pixel size of a container's inner 2D canvas. The content extent is the floor;
   * a frame the user has resized (dragging its borders) uses its stored `size`
   * when that is larger, so an explicit size grows the frame but never shrinks it
   * below its contents.
   */
  function containerSize(id: string): { w: number; h: number } {
    const content = contentSize(id)
    const stored = getBlock(id)?.size
    if (!stored) return content
    return { w: Math.max(content.w, stored.w), h: Math.max(content.h, stored.h) }
  }

  return {
    byId,
    getBlock,
    frames,
    allTasks,
    epics,
    epicMembers,
    epicOf,
    childrenOf,
    tasksOf,
    modulesOf,
    initiativesOf,
    allTasksUnder,
    descendantsOf,
    serviceOf,
    unmetDeps,
    isRunnable,
    frameProgress,
    frameStatus,
    contentSize,
    containerSize,
  }
}
