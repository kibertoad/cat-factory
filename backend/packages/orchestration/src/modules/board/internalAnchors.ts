import type { Block, BlockRepository, IdGenerator } from '@cat-factory/kernel'

// The HEADLESS internal anchor lifecycle, extracted from BoardService as a cohesive collaborator
// following the established pattern (one small deps object of bound call-backs, thin delegates left
// behind; see publicBoardReads.ts and layoutWrites.ts).
//
// An anchor is a top-level `internal: true` block that exists only to give a public-API run
// (an external "initiative breakdown") something to hang off, because the engine drives every run
// from a block. It is not board state and never becomes any: `composeBoard` and every public read
// filter it out, and kernel's `deliverableBoardBlock` refuses it as a real-time payload, so it
// renders nowhere on any board at any point in its life.
//
// The group belongs together because that invisibility is one contract with four halves and no
// single method states it: nothing here emits a `boardChanged` (a card must never flash onto a live
// board), the read confines an external key to the runs IT created, the delete exists because an
// invisible orphan would otherwise accumulate unnoticed, and the count is the cap that stops one
// leaked key spinning up unbounded LLM runs. Split across the board service they read as four
// unrelated one-liners that each look safe to change.

export interface InternalAnchorDeps {
  blockRepository: Pick<BlockRepository, 'insert' | 'get' | 'deleteMany' | 'countActiveInternal'>
  idGenerator: IdGenerator
  /** Throws when the workspace does not exist; bound from the owning service. */
  requireWorkspace(workspaceId: string): Promise<unknown>
}

export function createInternalAnchors(deps: InternalAnchorDeps) {
  /**
   * Create the anchor for one public-API run. Returns the block so the caller can start an
   * execution on it; the engine then writes status onto it like any other block.
   */
  async function createInternalTask(
    workspaceId: string,
    input: { title: string; description: string },
  ): Promise<Block> {
    await deps.requireWorkspace(workspaceId)
    const block: Block = {
      id: deps.idGenerator.next('task'),
      title: input.title.trim() || 'Initiative',
      // `type` is the service/repo CLASSIFICATION (frontend/service/library/…), orthogonal to the
      // `level` hierarchy; there is no task-specific BlockType. This anchor is a standalone,
      // never-rendered, repo-less `level:'task'` block, so `type` is irrelevant to it: 'service'
      // is just the neutral default (a normal task inherits its parent service's type instead).
      type: 'service',
      description: input.description ?? '',
      position: { x: 0, y: 0 },
      status: 'planned',
      progress: 0,
      dependsOn: [],
      executionId: null,
      level: 'task',
      parentId: null,
      internal: true,
    }
    await deps.blockRepository.insert(workspaceId, block)
    return block
  }

  /**
   * Fetch an anchor by id, or null when no block with that id exists in the workspace OR it is not
   * `internal`. The public-API job reads use this to confine an external key to the runs IT
   * created, never an arbitrary board execution that merely shares the key's workspace.
   */
  async function getInternalTask(workspaceId: string, blockId: string): Promise<Block | null> {
    const block = await deps.blockRepository.get(workspaceId, blockId)
    return block?.internal ? block : null
  }

  /**
   * Roll the anchor back when the run it was created for fails to start, so a failed dispatch
   * never leaves an orphan behind: it renders nowhere and is invisible to the cap below, so it
   * would just accumulate. An anchor has no children/service subtree, so a direct delete is enough.
   */
  async function deleteInternalTask(workspaceId: string, blockId: string): Promise<void> {
    await deps.blockRepository.deleteMany(workspaceId, [blockId])
  }

  /**
   * How many of the workspace's anchored runs are still in flight: the concurrency backstop the
   * public API checks before starting another. A SQL `COUNT`, not a load-and-count.
   */
  function countActiveInternalTasks(workspaceId: string): Promise<number> {
    return deps.blockRepository.countActiveInternal(workspaceId)
  }

  return { createInternalTask, getInternalTask, deleteInternalTask, countActiveInternalTasks }
}
