/**
 * Where a board-authoring surface creates: the containers a new task may land in, and how that
 * answer follows a live board.
 *
 * Pure so the reconcile below can be pinned by a unit test. `<TaskImportModal>` and
 * `<BugHuntModal>` ask the same two-part question (a source to read, a container to land in) and
 * are opened from the same frame-header buttons, so both read this through
 * {@link useContainerTargets} rather than each carrying its own copy.
 */
import type { Block } from '~/types/domain'

/** A container offered as a select item. */
export interface ContainerTarget {
  label: string
  value: string
}

/** Only a service frame or one of its modules can hold a task. */
export function isTaskContainer(block: Block | undefined): block is Block {
  return !!block && (block.level === 'frame' || block.level === 'module')
}

/**
 * The containers on offer, given the frame the surface was opened from (if any).
 *
 * Opened from a service frame the answer is SCOPED to that frame: the frame itself plus its
 * modules, each labelled by its own title because the frame is already named on the surface. The
 * frame settles WHICH SERVICE the work belongs to, which is the part a header button can answer;
 * it does not settle frame-or-which-module, so a frame that has modules still owes the user a
 * choice. Opened standalone there is no frame behind it, so every container on the board is a
 * candidate and a module carries its parent's title to keep the choice unambiguous.
 *
 * `pinned` is resolved through the board by the caller rather than trusted as an id, so a frame
 * deleted while the surface sat open widens back to the whole board instead of scoping to
 * something nothing can be created in.
 */
export function containerTargets(
  blocks: readonly Block[],
  pinned: Block | undefined,
): ContainerTarget[] {
  if (pinned) {
    // Modules cannot nest, so a pinned module is already the only answer.
    if (pinned.level === 'module') return [{ label: pinned.title, value: pinned.id }]
    const modules = blocks.filter((b) => b.level === 'module' && b.parentId === pinned.id)
    return [pinned, ...modules].map((b) => ({ label: b.title, value: b.id }))
  }
  const byId = new Map(blocks.map((b) => [b.id, b]))
  return blocks.filter(isTaskContainer).map((b) => ({
    label:
      b.level === 'module' ? `${byId.get(b.parentId ?? '')?.title ?? '?'} › ${b.title}` : b.title,
    value: b.id,
  }))
}

/**
 * The container a surface should hold as the board changes underneath it: the current selection
 * while it is still on offer, else the first one that is.
 *
 * Needed because "where does this land" is answered once, when the surface opens, and the board is
 * live: the frame it was opened from can be deleted, or a module added to it, while it sits there.
 * A selection left pointing at a deleted block is the worst of the three states, because nothing
 * looks wrong: the picker renders with nothing selected while the issue search under it is still
 * scoped to the block that is gone, and the create lands on an id the board no longer has.
 */
export function reconcileContainer(
  targets: readonly ContainerTarget[],
  selected: string | undefined,
): string | undefined {
  if (selected && targets.some((t) => t.value === selected)) return selected
  return targets[0]?.value
}
