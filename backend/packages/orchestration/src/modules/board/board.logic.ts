import type { Block, BlockLevel, Position, ServiceConnection } from '@cat-factory/kernel'
import { connectionNeighborIds } from '@cat-factory/contracts'

// Pure board computations — no IO, no ports. They operate on plain in-memory
// block arrays so they can be exhaustively unit-tested and are reused verbatim
// by the BoardService and the execution engine.

/** Simple grid layout for the Nth child inside a container. */
export function gridSlot(n: number, cols = 2, cw = 200, ch = 170, x0 = 16, y0 = 12): Position {
  return { x: x0 + (n % cols) * cw, y: y0 + Math.floor(n / cols) * ch }
}

/** Tasks directly inside a container (a service or a module). */
export function tasksOf(blocks: Block[], containerId: string): Block[] {
  return blocks.filter((b) => b.parentId === containerId && b.level === 'task')
}

/** Modules (sub-frames) inside a service. */
export function modulesOf(blocks: Block[], serviceId: string): Block[] {
  return blocks.filter((b) => b.parentId === serviceId && b.level === 'module')
}

/** The top-level service a block ultimately belongs to. */
export function serviceOf(blocks: Block[], block: Block): Block | undefined {
  const byId = new Map(blocks.map((b) => [b.id, b]))
  let cur: Block | undefined = block
  while (cur && cur.level !== 'frame') {
    cur = cur.parentId ? byId.get(cur.parentId) : undefined
  }
  return cur
}

/**
 * Every descendant id of `rootId` (tasks, modules and their tasks), including
 * the root itself — used to cascade a delete.
 */
export function descendantIds(blocks: Block[], rootId: string): Set<string> {
  const doomed = new Set<string>([rootId])
  let grew = true
  while (grew) {
    grew = false
    for (const b of blocks) {
      if (b.parentId && doomed.has(b.parentId) && !doomed.has(b.id)) {
        doomed.add(b.id)
        grew = true
      }
    }
  }
  return doomed
}

/** Whether `parent` is a legal container for a block at `childLevel`. */
export function canReparent(childLevel: BlockLevel, parent: Block): boolean {
  if (childLevel === 'task') return parent.level === 'frame' || parent.level === 'module'
  if (childLevel === 'module') return parent.level === 'frame'
  // An epic may optionally be placed under a service/module (or live top-level); it is a
  // grouping node, never a container, so nothing reparents INTO it.
  if (childLevel === 'epic') return parent.level === 'frame' || parent.level === 'module'
  return false // frames are not nested
}

/** Tasks that belong to an epic via their `epicId` membership link. */
export function epicMembers(blocks: Block[], epicId: string): Block[] {
  return blocks.filter((b) => b.epicId === epicId)
}

/**
 * Whether adding the edge "`targetId` dependsOn `sourceId`" would close a cycle in the
 * dependency graph — i.e. `sourceId` already (transitively) depends on `targetId`. A DFS
 * from the source over existing `dependsOn` edges that reaches the target means the new
 * edge would make the graph cyclic, so the caller must reject it. Returns false for a
 * self-edge (the caller rejects that separately with a clearer message).
 */
export function wouldCreateCycle(blocks: Block[], targetId: string, sourceId: string): boolean {
  if (targetId === sourceId) return false
  const byId = new Map(blocks.map((b) => [b.id, b]))
  const seen = new Set<string>()
  const stack = [sourceId]
  while (stack.length) {
    const id = stack.pop() as string
    if (id === targetId) return true
    if (seen.has(id)) continue
    seen.add(id)
    const node = byId.get(id)
    if (node) stack.push(...node.dependsOn)
  }
  return false
}

/**
 * Whether every dependency of `taskId` is satisfied (each `dependsOn` block is `done`).
 * A missing dependency block (e.g. deleted out of band) is treated as satisfied — the
 * engine never blocks forever on an edge it can't resolve. The block's own status is
 * irrelevant; this asks only about its blockers.
 */
export function dependenciesMet(blocks: Block[], taskId: string): boolean {
  const byId = new Map(blocks.map((b) => [b.id, b]))
  const task = byId.get(taskId)
  if (!task) return true
  return task.dependsOn.every((depId) => {
    const dep = byId.get(depId)
    return !dep || dep.status === 'done'
  })
}

/** The unfinished blockers of `taskId` (dependencies not yet `done`), for error messages. */
export function unmetDependencies(blocks: Block[], taskId: string): Block[] {
  const byId = new Map(blocks.map((b) => [b.id, b]))
  const task = byId.get(taskId)
  if (!task) return []
  return task.dependsOn
    .map((depId) => byId.get(depId))
    .filter((b): b is Block => !!b && b.status !== 'done')
}

/**
 * Why a service frame's `serviceConnections` patch is invalid, or null when it is fine.
 * Targets are validated against the caller-resolved blocks (`resolveTarget` — the
 * cross-home-aware lookup, so a service mounted from another home workspace connects
 * too): each must resolve to a `service`-type frame that isn't the owning frame, and
 * appear at most once. Cycles between services are deliberately LEGAL (A↔B mutual
 * calls are ordinary architecture; nothing deadlocks on them — the later merge/provision
 * ordering falls back to a deterministic order inside a cycle).
 */
export function serviceConnectionsError(
  frameId: string,
  connections: ServiceConnection[],
  resolveTarget: (id: string) => Block | undefined,
): string | null {
  const seen = new Set<string>()
  for (const connection of connections) {
    const targetId = connection.serviceBlockId
    if (targetId === frameId) return 'A service cannot be connected to itself'
    if (seen.has(targetId)) return `Duplicate connection to service '${targetId}'`
    seen.add(targetId)
    const target = resolveTarget(targetId)
    if (!target) return `Connection target '${targetId}' does not exist on this board`
    if (target.level !== 'frame' || target.type !== 'service') {
      return `Connection target '${target.title}' is not a service (frontends bind services via their backend bindings instead)`
    }
  }
  return null
}

/**
 * Why a task's `involvedServiceIds` patch is invalid, or null when it is fine. Each id
 * must be a connection NEIGHBOR of the task's enclosing service frame — undirected,
 * because a task on either endpoint of a connection may need the other service spun up
 * or changed — and never the own frame (it is always implicitly involved). Ids that
 * merely went stale later (a connection removed after selection) are filtered at read
 * time instead, so this guards only the write.
 */
export function involvedServiceIdsError(
  blocks: Block[],
  task: Block,
  involvedServiceIds: string[],
): string | null {
  const frame = serviceOf(blocks, task)
  if (!frame) return 'The task is not inside a service frame'
  const neighbors = connectionNeighborIds(blocks, frame.id)
  const seen = new Set<string>()
  for (const id of involvedServiceIds) {
    if (id === frame.id) return `'${frame.title}' is the task's own service and is always involved`
    if (seen.has(id)) return `Duplicate involved service '${id}'`
    seen.add(id)
    if (!neighbors.has(id)) {
      return `Service '${id}' is not connected to '${frame.title}' — connect the services on the service frame first`
    }
  }
  return null
}
