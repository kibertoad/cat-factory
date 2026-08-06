import type { Block, WorkspaceMount } from './types.js'

/**
 * Project a service frame's PER-WORKSPACE layout override onto the shared block.
 *
 * A frame's board position (and, when overridden, its size) lives on the {@link WorkspaceMount},
 * not on the block: the same shared service can sit at a different spot on every board that
 * mounts it, so the block row's own `position` is whatever it happened to be at creation and is
 * never updated afterwards. Any block handed to a board client therefore has to be projected
 * through here — the board snapshot composes the whole list this way, and a single-block mutation
 * response owes the caller the same view, or the SPA upserts a frame at coordinates no board is
 * actually showing it at.
 *
 * `layout` absent (a non-frame, an unregistered/legacy frame, or in-org sharing not wired) leaves
 * the block untouched. A mount with no size override leaves the block's own size in place.
 */
export function applyMountLayout(
  block: Block,
  layout: Pick<WorkspaceMount, 'position' | 'size'> | null | undefined,
): Block {
  if (!layout) return block
  const next: Block = { ...block, position: { x: layout.position.x, y: layout.position.y } }
  if (layout.size) next.size = { w: layout.size.w, h: layout.size.h }
  return next
}

/**
 * The block a real-time board event may carry as a PAYLOAD the client upserts verbatim, or `null`
 * when the change has to be delivered as a coarse "re-read your board" signal instead.
 *
 * One event reaches every workspace that mounts the affected service, and its payload is published
 * once for all of them. For a service frame that is unsatisfiable: the reader above explains why a
 * frame's position and size are per-board, so whichever mount a publisher projected through would
 * be wrong on every OTHER board and would jump the frame there, which is the same silent failure
 * `applyMountLayout` exists to prevent. A frame change is therefore announced without a payload and
 * each board re-reads its own projection.
 *
 * Every other level (task, module, epic, initiative) carries its geometry on the shared row, so a
 * single payload is correct everywhere it lands. Both facades' publishers project through here, so
 * the rule cannot hold on one runtime and drift on the other.
 */
export function deliverableBoardBlock(block: Block | null | undefined): Block | null {
  if (!block) return null
  return (block.level ?? 'frame') === 'frame' ? null : block
}
