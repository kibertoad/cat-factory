import type { Block, BlockLevel, Position } from '@cat-factory/kernel'

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
  return false // frames are not nested
}
