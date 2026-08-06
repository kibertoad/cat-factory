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

// The other half of this rule (which blocks a real-time event may CARRY, given that a frame's
// geometry is per-board) is `deliverableBoardBlock` in `./board-events.ts`, beside the wire-event
// assembly that is its only caller.
