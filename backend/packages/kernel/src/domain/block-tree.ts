import type { Block } from './types.js'

/**
 * Walk a block up to its owning SERVICE FRAME (frame → module → task), cycle-guarded. Pure over
 * an injected point-read `get` (bound to a workspace by the caller) so every service-frame
 * resolver — the engine's `AgentContextBuilder` and the `TestSecretsService` alike — walks the
 * tree ONE way instead of hand-copying the loop. The tree is at most frame → module → task, so
 * the walk is bounded to 8 hops as a cycle guard. Returns the frame block, the topmost block
 * reached when the walk hits a parentless non-frame, or null when the starting block is absent.
 */
export async function resolveServiceFrameBlock(
  get: (blockId: string) => Promise<Block | null>,
  blockId: string,
): Promise<Block | null> {
  let current = await get(blockId)
  for (let i = 0; current && i < 8; i++) {
    if (current.level === 'frame' || !current.parentId) return current
    current = await get(current.parentId)
  }
  return current ?? null
}
