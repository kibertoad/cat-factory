import type { Block } from '@cat-factory/kernel'

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
