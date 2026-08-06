import type { WorkspaceEvent } from '@cat-factory/contracts'
import type { Block, BlockLevel, BootstrapJob } from './types.js'

/**
 * One board change, as handed to an {@link ExecutionEventPublisher}.
 *
 * `blockId` identifies a block of the AFFECTED SERVICE so the change can be fanned out to every
 * workspace that mounts it (in-org sharing); omit it for a genuinely board-wide signal, which then
 * reaches the originating workspace only. When {@link block} is given its id serves as the subject,
 * so a caller holding the block never restates it. It is a BACKEND concern, resolved before the
 * publish and never put on the wire: see {@link boardChangeSubject}.
 *
 * `block` is the DELIVERY shape, and it is what separates a targeted change from a coarse one. Give
 * it only when the change is FULLY described by that one block: the client then upserts it and pays
 * nothing, where a coarse signal costs a whole board snapshot. Leave it absent when the change is
 * structural (a removal, a reparent, a cascade) and the client must re-read to see the new shape.
 * What may actually RIDE is decided once, at the wire, by {@link deliverableBoardBlock}.
 *
 * `originConnectionId` (when known) is the realtime connection that caused the change: the
 * transport skips delivering the echo back to it, so a client never refreshes off its own move
 * (which would snap an in-flight drag back to a stale position).
 */
export interface BoardChange {
  reason: string
  blockId?: string | null
  block?: Block | null
  originConnectionId?: string | null
}

/**
 * The block whose service a change fans out from: the named one, else the carried one's id.
 *
 * Resolved in ONE place because two callers need the same answer from opposite ends
 * (`FanOutEventPublisher` expanding the change to its mounting workspaces, and the conformance
 * recorder standing in for a facade publisher), and a subject rule that disagreed between them
 * would read as a fan-out the suite says happens and production does not.
 */
export function boardChangeSubject(change: BoardChange): string | null {
  return change.blockId ?? change.block?.id ?? null
}

/**
 * Whether a level's board geometry is a PER-BOARD override (on the `WorkspaceMount`) rather than a
 * field of the shared block row.
 *
 * Exhaustive over {@link BlockLevel} on purpose: a level added later cannot compile until someone
 * has answered where its position lives, which is the only way to keep {@link deliverableBoardBlock}
 * from silently carrying the next per-board level the way it once carried frames.
 */
const GEOMETRY_IS_PER_BOARD: Record<BlockLevel, boolean> = {
  frame: true,
  module: false,
  task: false,
  epic: false,
  initiative: false,
}

/**
 * The block a real-time board event may carry as a PAYLOAD the client upserts verbatim, or `null`
 * when the change has to be delivered as a coarse "re-read your board" signal instead.
 *
 * Two blocks are refused, for unrelated reasons that share this one gate because both are about
 * what may reach a browser:
 *
 * - A SERVICE FRAME. One event reaches every workspace that mounts the affected service and its
 *   payload is published once for all of them, so whichever mount a publisher projected through
 *   would be wrong on every OTHER board and would jump the frame there — the same silent failure
 *   `applyMountLayout` exists to prevent, arriving by a different door. Announced without a payload
 *   instead, so each board re-reads its own projection.
 * - A HEADLESS INTERNAL ANCHOR block (a public-API run's own "task"). `composeBoard` filters it out
 *   of every snapshot, so a live push would materialise a top-level ghost card carrying the
 *   external caller's brief that no subsequent read can ever remove. `RunStateMachine.emitInstance`
 *   makes the same refusal for the per-instance event; this is its board-event twin.
 *
 * Every other block carries its geometry on the shared row and is visible to the board anyway, so a
 * single payload is correct everywhere it lands. Both facades' publishers project through here, so
 * the rule cannot hold on one runtime and drift on the other.
 */
export function deliverableBoardBlock(block: Block | null | undefined): Block | null {
  if (!block) return null
  if (block.internal) return null
  // Withheld unless the level is a KNOWN row-geometry one: an unrecognised value (a newer
  // publisher, a garbled row) costs a coarse refresh, which is always correct, where guessing it
  // deliverable silently misplaces the block on every board the fan-out reaches.
  return GEOMETRY_IS_PER_BOARD[block.level] === false ? block : null
}

/**
 * Assemble the `board` wire event both facades publish.
 *
 * The assembly lives here rather than in each facade because the interesting part of it is the
 * {@link deliverableBoardBlock} call: symmetry between the runtimes is a rule
 * (`CLAUDE.md`: "Keep the runtimes symmetric"), and two hand-copied literals only ever agree by
 * inspection. `blockId` deliberately does NOT ride: it is how the backend resolved which
 * workspaces to publish to, already spent by the time this is called.
 */
export function boardWireEvent(change: BoardChange, at: number): WorkspaceEvent {
  return {
    type: 'board',
    reason: change.reason,
    block: deliverableBoardBlock(change.block),
    at,
  }
}

/**
 * Assemble the `bootstrap` wire event both facades publish.
 *
 * The block is a service FRAME on every path that has one, so {@link deliverableBoardBlock} refuses
 * it and the event carries the JOB alone. That is not a hole: `BootstrapService` pairs each frame
 * transition with a coarse `boardChanged` naming it, so the board still learns that the
 * "bootstrapping…" card appeared, went ready, or went blocked — it just re-reads its own mount
 * instead of upserting coordinates the frame is not at on any board.
 */
export function bootstrapWireEvent(
  job: BootstrapJob,
  block: Block | null | undefined,
  at: number,
): WorkspaceEvent {
  return { type: 'bootstrap', job, block: deliverableBoardBlock(block), at }
}
