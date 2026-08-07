import type { Block } from '@cat-factory/kernel'
import { ValidationError } from '@cat-factory/kernel'
import type { UpdateBlockInput } from '@cat-factory/contracts'
import {
  aprioriBranchesError,
  involvedServiceIdsError,
  serviceConnectionsError,
} from './board.logic.js'

// Validating + narrowing an inbound block patch against the block it targets, extracted from
// `BoardService.updateBlock` when the third of these crossed the file's size budget.
//
// One concern, stated once: `updateBlock` takes a partial patch that may name fields belonging to
// a DIFFERENT kind of block than the one addressed, and each such field has to be dropped rather
// than persisted as dead data nothing reads. Two of them additionally validate against state the
// patch cannot see (the board's other blocks), which is why this takes bound callbacks rather
// than being pure.
//
// The per-type FIELDS patch is deliberately NOT here: it changes the patch's shape and resolves a
// pull request against the provider, which is a different kind of work than deciding whether a
// key applies to this block. It lives in `taskTypeFieldsPatch.ts` and runs after these.
//
// The drops are silent by design and that is the ONE trap here: patching `serviceConnections` onto
// a task is not an error a caller should have to handle, because the SPA only ever offers the
// field where it applies. A drop that threw would turn an inspector's harmless over-send into a
// failed save.

/** What the narrowing needs from the service: two reads of blocks a patch may name. */
export interface BlockPatchNarrowingDeps {
  /** Every block homed in a workspace, for validating ids a patch names. */
  listByWorkspace: (homeWorkspaceId: string) => Promise<Block[]>
  /**
   * Resolve a block that may be homed in ANOTHER workspace (a mounted shared service), or null
   * when it cannot be reached. Cross-home aware, so an id the SPA legitimately offers is not
   * refused for living on the board it was mounted from.
   */
  resolveForeign: (workspaceId: string, id: string) => Promise<Block | null>
}

/** Where a patch targets the wrong kind of block, the field is dropped rather than persisted. */
function without<K extends keyof UpdateBlockInput>(
  patch: UpdateBlockInput,
  key: K,
): UpdateBlockInput {
  const { [key]: _dropped, ...rest } = patch
  return rest
}

export function createBlockPatchNarrowing(deps: BlockPatchNarrowingDeps) {
  return {
    /**
     * `serviceFragmentIds` is a service-level (frame) setting the engine only reads off the owning
     * service frame; dropped on non-frames so it never persists as dead data (the inspector only
     * exposes the picker on frames anyway).
     */
    serviceFragmentIds(patch: UpdateBlockInput, block: Block): UpdateBlockInput {
      if (patch.serviceFragmentIds === undefined || block.level === 'frame') return patch
      return without(patch, 'serviceFragmentIds')
    },

    /**
     * `referenceRepos` is a DOCUMENT-task-only attachment (read-only reference repos for the
     * `doc-writer` agent): the inspector shows the picker only for `taskType === 'document'`, and
     * the executor consumes it only for the doc-writer kind. Dropped on any other block. The repo
     * identities are self-contained (contract-capped), so there is nothing to cross-validate.
     */
    referenceRepos(patch: UpdateBlockInput, block: Block): UpdateBlockInput {
      const isDocumentTask = block.level === 'task' && block.taskType === 'document'
      if (patch.referenceRepos === undefined || isDocumentTask) return patch
      return without(patch, 'referenceRepos')
    },

    /**
     * `aprioriBranches` is a task-level input (pre-existing branches of the target repo). Dropped
     * on non-tasks; the cross-entry invariants are checked by {@link aprioriBranchInvariants},
     * which must also run when only `involvedServiceIds` moves.
     */
    aprioriBranches(patch: UpdateBlockInput, block: Block): UpdateBlockInput {
      if (patch.aprioriBranches === undefined || block.level === 'task') return patch
      return without(patch, 'aprioriBranches')
    },

    /**
     * Validate + narrow the `serviceConnections` patch field. It lives only on service-type frames
     * (the consumer end of each edge), so it is dropped on any other block for the same
     * never-persist-dead-data reason as `serviceFragmentIds`. On a service frame with edges each
     * target is resolved from ONE home-workspace read; only ids not homed here (a service mounted
     * from another workspace) fall back to the cross-home-aware per-id resolve, a bounded
     * user-authored list, not a data-sized loop. Throws {@link ValidationError} on an invalid edge.
     */
    async serviceConnections(
      patch: UpdateBlockInput,
      block: Block,
      id: string,
      homeWorkspaceId: string,
      workspaceId: string,
    ): Promise<UpdateBlockInput> {
      if (patch.serviceConnections === undefined) return patch
      if (block.level !== 'frame' || block.type !== 'service') {
        return without(patch, 'serviceConnections')
      }
      if (patch.serviceConnections.length) {
        const homeBlocks = await deps.listByWorkspace(homeWorkspaceId)
        const byId = new Map(homeBlocks.map((b) => [b.id, b]))
        const resolved = new Map<string, Block>()
        for (const { serviceBlockId } of patch.serviceConnections) {
          if (byId.has(serviceBlockId) || resolved.has(serviceBlockId)) continue
          const found = await deps.resolveForeign(workspaceId, serviceBlockId)
          if (found) resolved.set(serviceBlockId, found)
        }
        const error = serviceConnectionsError(
          id,
          patch.serviceConnections,
          (targetId) => byId.get(targetId) ?? resolved.get(targetId),
        )
        if (error) throw new ValidationError(error)
      }
      return patch
    },

    /**
     * Validate + narrow the `involvedServiceIds` patch field: a task-level selection drawn from the
     * enclosing service frame's connection neighbors, dropped on non-tasks. On a task each selected
     * id is validated against the same universe the SPA offers: a connection neighbor can be a
     * service mounted from another workspace, so each id not homed here is resolved (cross-home
     * aware) and folded in, making an INCOMING edge from a mounted foreign consumer count as a
     * neighbor too. A bounded user-authored list (contract-capped), not a data-sized loop. Throws
     * {@link ValidationError} on an invalid selection.
     */
    async involvedServiceIds(
      patch: UpdateBlockInput,
      block: Block,
      homeWorkspaceId: string,
      workspaceId: string,
    ): Promise<UpdateBlockInput> {
      if (patch.involvedServiceIds === undefined) return patch
      if (block.level !== 'task') return without(patch, 'involvedServiceIds')
      if (patch.involvedServiceIds.length) {
        const homeBlocks = await deps.listByWorkspace(homeWorkspaceId)
        const byId = new Set(homeBlocks.map((b) => b.id))
        const foreign: Block[] = []
        for (const sid of patch.involvedServiceIds) {
          if (byId.has(sid)) continue
          byId.add(sid)
          const found = await deps.resolveForeign(workspaceId, sid)
          if (found) foreign.push(found)
        }
        const error = involvedServiceIdsError(
          [...homeBlocks, ...foreign],
          block,
          patch.involvedServiceIds,
        )
        if (error) throw new ValidationError(error)
      }
      return patch
    },

    /**
     * The multi-repo exclusion is a cross-field invariant (a `working` branch is barred once a task
     * involves peer services), so it must be re-checked whenever EITHER field is patched: otherwise
     * adding `involvedServiceIds` to a task that already carries a working branch would slip past
     * the guard. Revalidates against the effective branch list + involved set on a task.
     */
    aprioriBranchInvariants(patch: UpdateBlockInput, block: Block): void {
      if (block.level !== 'task') return
      if (patch.aprioriBranches === undefined && patch.involvedServiceIds === undefined) return
      const branches = patch.aprioriBranches ?? block.aprioriBranches ?? []
      const involved = patch.involvedServiceIds ?? block.involvedServiceIds ?? []
      const error = aprioriBranchesError(branches, block, involved.length > 0)
      if (error) throw new ValidationError(error)
    },
  }
}

export type BlockPatchNarrowing = ReturnType<typeof createBlockPatchNarrowing>
