import type { Block } from './types.js'

/**
 * Walk a block up to its owning SERVICE FRAME (frame → module → task), cycle-guarded. Pure over
 * an injected point-read `get` (bound to a workspace by the caller) so every service-frame
 * resolver — the engine's `AgentContextBuilder` and the `TestSecretsService` alike — walks the
 * tree ONE way instead of hand-copying the loop. The tree is at most frame → module → task, so
 * the walk is bounded to 8 hops as a cycle guard. Returns the frame block, the topmost block
 * reached when the walk hits a parentless non-frame, or null when the starting block is absent.
 *
 * Pass `start` (the block whose id is `blockId`) when the caller ALREADY holds the starting
 * block — the walk then begins from it and skips the initial point-read of `blockId`, so a
 * hot path that has the block in hand reuses this one loop instead of re-copying it.
 */
export async function resolveServiceFrameBlock(
  get: (blockId: string) => Promise<Block | null>,
  blockId: string,
  start?: Block | null,
): Promise<Block | null> {
  let current = start ?? (await get(blockId))
  for (let i = 0; current && i < 8; i++) {
    if (current.level === 'frame' || !current.parentId) return current
    current = await get(current.parentId)
  }
  return current ?? null
}

/**
 * The best-practice fragment ids that apply to a block's run — the SINGLE source of truth shared
 * by every run-time fold path (the engine's `AgentContextBuilder` and the requirements-review
 * grounding), so the two can't drift. A TASK (or module) OWNS its selection outright: its inherited
 * service standards are materialised onto `fragmentIds` at creation and a per-task removal must
 * stick, so ONLY a FRAME-level run folds in the service's own `serviceFragmentIds` (there the
 * resolved service frame IS the block). Service standards first, then the block's own pins; deduped,
 * stable order. Pass the block's resolved service frame (via {@link resolveServiceFrameBlock}); it
 * is read only for a frame-level block, where it equals the block itself.
 */
export function applicableFragmentIds(
  block: Pick<Block, 'level' | 'fragmentIds'>,
  serviceFrame: Pick<Block, 'serviceFragmentIds'> | null | undefined,
): string[] {
  const serviceIds = block.level === 'frame' ? (serviceFrame?.serviceFragmentIds ?? []) : []
  const ids: string[] = []
  const seen = new Set<string>()
  for (const id of [...serviceIds, ...(block.fragmentIds ?? [])]) {
    if (seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  return ids
}
