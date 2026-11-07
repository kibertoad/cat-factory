import type { Block, BlockRepository, WorkspaceMountRepository } from '@cat-factory/kernel'
import { assertFound } from '@cat-factory/kernel'

export interface BlockHomesDeps {
  blockRepository: BlockRepository
  /** Optional: with in-org sharing unwired, only a board's own blocks resolve. */
  workspaceMountRepository?: WorkspaceMountRepository
}

/**
 * Which workspace physically homes a block a board acts on. A block created locally is homed
 * here; a block owned by a subject (service or project) this board MOUNTS is homed on that
 * subject's home board, so a shared board acts on the one shared copy.
 */
export function createBlockHomes(deps: BlockHomesDeps) {
  /** The home of a block owned by a subject this board mounts, else null. */
  async function mountedHome(
    workspaceId: string,
    id: string,
  ): Promise<{ homeWorkspaceId: string; block: Block } | null> {
    if (!deps.workspaceMountRepository) return null
    const found = await deps.blockRepository.findById(id)
    if (!found?.ownerId) return null
    const mount = await deps.workspaceMountRepository.get(workspaceId, found.ownerId)
    return mount ? { homeWorkspaceId: found.workspaceId, block: found.block } : null
  }

  /**
   * The block and its home, for a mutation. 404s when this board neither homes the block nor
   * mounts its owner.
   */
  async function resolveBlock(
    workspaceId: string,
    id: string,
  ): Promise<{ homeWorkspaceId: string; block: Block }> {
    const local = await deps.blockRepository.get(workspaceId, id)
    if (local) return { homeWorkspaceId: workspaceId, block: local }
    return assertFound(await mountedHome(workspaceId, id), 'Block', id)
  }

  /**
   * The home to run a removal against. Never 404s, since deletion is idempotent: anything this
   * board neither homes nor mounts (a row already gone included) resolves to this board, so the
   * caller's cleanup can only touch this board's own data.
   */
  async function resolveHomeForRemoval(workspaceId: string, id: string): Promise<string> {
    const local = await deps.blockRepository.get(workspaceId, id)
    if (local) return workspaceId
    return (await mountedHome(workspaceId, id))?.homeWorkspaceId ?? workspaceId
  }

  return { resolveBlock, resolveHomeForRemoval }
}
