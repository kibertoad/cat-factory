import type { Logger, ResolveBinaryArtifactStore } from '@cat-factory/kernel'
import { noopLogger, runBestEffort } from '@cat-factory/kernel'

/**
 * What every path that deletes or moves a block needs to carry the artifacts anchored on it (a
 * task's attached images are retained until their block goes). Absent store ⇒ nothing to do.
 */
export interface BlockArtifactDeps {
  resolveBinaryArtifactStore?: ResolveBinaryArtifactStore
  logger?: Logger
}

/**
 * Reclaim the artifacts anchored on blocks that were just deleted, rows and bytes.
 *
 * Runs AFTER the block rows go and is best-effort: the blocks are gone either way, and a blob
 * backend that is briefly down must not turn a delete into an error the board then disagrees
 * with. What it leaves behind is the age sweep's to reclaim (`artifactRetention.ts`).
 */
export function reclaimBlockArtifacts(
  deps: BlockArtifactDeps,
  workspaceId: string,
  blockIds: readonly string[],
): Promise<void> {
  if (!deps.resolveBinaryArtifactStore || !blockIds.length) return Promise.resolve()
  const resolve = deps.resolveBinaryArtifactStore
  return runBestEffort(
    deps.logger ?? noopLogger,
    'block delete: reclaim artifacts',
    async () => {
      const store = await resolve(workspaceId)
      await store?.pruneByBlocks(workspaceId, blockIds)
    },
    { workspaceId, blocks: blockIds.length },
  )
}

/**
 * Carry the artifacts anchored on blocks that moved to another home workspace, so a task's images
 * follow it to where every reader lists them.
 *
 * Run while the blocks exist in BOTH homes (after the insert at the destination, before the
 * delete at the source), so the age sweep never sees either side as orphaned. Best-effort for the
 * same reason as {@link reclaimBlockArtifacts}; a row left behind is reclaimed by that sweep.
 */
export function moveBlockArtifacts(
  deps: BlockArtifactDeps,
  workspaceIds: readonly [from: string, to: string],
  blockIds: readonly string[],
): Promise<void> {
  if (!deps.resolveBinaryArtifactStore || !blockIds.length) return Promise.resolve()
  const resolve = deps.resolveBinaryArtifactStore
  return runBestEffort(
    deps.logger ?? noopLogger,
    'block move: carry artifacts',
    async () => {
      const store = await resolve(workspaceIds[0])
      await store?.moveBlocks(workspaceIds, blockIds)
    },
    { fromWorkspaceId: workspaceIds[0], toWorkspaceId: workspaceIds[1], blocks: blockIds.length },
  )
}
