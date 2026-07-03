import type { Block } from '@cat-factory/kernel'
import { connectionNeighborIds } from '@cat-factory/contracts'

/**
 * The service-frame block enclosing a block, resolved from an already-loaded block map — a
 * bounded (the tree is at most frame → module → task), cycle-guarded walk up the `parentId`
 * chain. Returns the first ancestor that is a `frame` (or the topmost parent-less block, or the
 * last block reached if the map is missing a link). Pure: the caller owns the load, so this does
 * NO repository access — the point-read variant is `AgentContextBuilder.resolveServiceFrame`.
 */
export function frameOf(byId: ReadonlyMap<string, Block>, blockId: string): Block | null {
  let cursor = byId.get(blockId) ?? null
  for (let i = 0; cursor && i < 8; i++) {
    if (cursor.level === 'frame' || !cursor.parentId) return cursor
    cursor = byId.get(cursor.parentId) ?? null
  }
  return cursor
}

/**
 * The connected service frames "directly involved" in a task beyond its own — the shared read-time
 * STALE FILTER over `block.involvedServiceIds` used by BOTH the deployer fan-out
 * (`RunDispatcher.resolveDeployTargets`) and the agent-context resolution
 * (`AgentContextBuilder.resolveInvolvedServices`), so the two can't drift on which peers are valid.
 * Keeps only ids that (a) are not the own frame, (b) are STILL a connection neighbour of the own
 * frame, (c) are unique, and (d) resolve to a `service` `frame` block. A stale/removed connection
 * makes an id inert (dropped), never a run failure. Pure — the caller owns the block-list load.
 */
export function validInvolvedServiceFrames(
  blocks: readonly Block[],
  block: Block,
  ownFrameId: string,
): Block[] {
  if (block.level !== 'task') return []
  const ids = block.involvedServiceIds ?? []
  if (ids.length === 0) return []
  const byId = new Map(blocks.map((b) => [b.id, b]))
  const neighbors = connectionNeighborIds(blocks, ownFrameId)
  return ids
    .filter((id, i) => id !== ownFrameId && neighbors.has(id) && ids.indexOf(id) === i)
    .map((id) => byId.get(id))
    .filter((b): b is Block => !!b && b.level === 'frame' && b.type === 'service')
}
