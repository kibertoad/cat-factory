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
 * Which system a block's work belongs to, as a DISCRIMINATED result: the enclosing service frame
 * when there is one, else the positive reason there is not.
 *
 * Every prompt-assembling path needs this, and the two "no service" cases mean opposite things to
 * a prompt — a frame-level run has no owning service because it IS one, while a loose task has
 * none because the platform genuinely does not know which system it belongs to, and that second
 * case must be STATED (an unidentified product must never render like an obvious one, or a model
 * supplies its own). Keeping the derivation here, beside the walk that feeds it, is what stops the
 * container path and the inline reviewers from answering the question differently.
 */
export type OwnServiceContext =
  | { stated: true; frameId: string; title: string; description?: string }
  | { stated: false; reason: 'block-is-the-service' | 'not-under-a-service' }

/**
 * Derive the {@link OwnServiceContext} for a block from its already-resolved service frame (see
 * {@link resolveServiceFrameBlock}, whose result may be a non-frame topmost block when the block
 * sits outside any service — which is exactly why the `level` is re-checked here).
 */
export function describeOwnService(
  block: Pick<Block, 'id' | 'level'>,
  serviceFrame: Pick<Block, 'id' | 'level' | 'title' | 'description'> | null | undefined,
): OwnServiceContext {
  if (block.level === 'frame') return { stated: false, reason: 'block-is-the-service' }
  if (!serviceFrame || serviceFrame.level !== 'frame' || serviceFrame.id === block.id) {
    return { stated: false, reason: 'not-under-a-service' }
  }
  const description = serviceFrame.description?.trim()
  return {
    stated: true,
    frameId: serviceFrame.id,
    title: serviceFrame.title,
    ...(description ? { description } : {}),
  }
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
