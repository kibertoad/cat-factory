import type { Block } from '@cat-factory/kernel'
import { type RunServiceScope, resolveRunServiceScope } from '@cat-factory/contracts'
import { frameOf, validInvolvedServiceFrames } from './frame.logic.js'

/**
 * What a run may CHANGE, reduced to the frontend/backend scope its conditional steps read
 * (`stepOptions.condition`, see contracts' `stepRunConditionSchema`).
 *
 * The services a run may change are its own — the service FRAME enclosing the block, the one
 * `resolveRepoTarget` resolves the repo from — plus the task's INVOLVED services, which are the
 * peers a multi-repo run checks out and edits. Anything else on the board is not in scope: a
 * frontend elsewhere in the workspace is not evidence that this task touches a UI.
 *
 * The involved-peer term cannot currently widen the answer, and that is a fact about the board
 * rather than about this function: an involved service must be a connection neighbour, and only a
 * `service`-type frame may declare or be named by a connection, so every peer is a non-frontend and
 * only ever re-confirms `backend`. It stays because it is the honest definition of "what may this
 * run change" — the same one the deployer fan-out and the agent context read through the shared
 * stale filter — and it is what would carry a peer type the connection model later admits.
 *
 * One block-list read, shared with whatever else the caller does with it. A task outside any
 * service frame resolves to a scope with neither half set, which contracts'
 * `stepConditionSatisfied` reads as "nothing to judge" and runs the step.
 *
 * That empty answer is why the resolved ancestor is CHECKED to be a frame rather than trusted.
 * `frameOf` does not return null for a block with no frame ancestor: it falls back to the topmost
 * parent-less block, which for an orphan task is the TASK ITSELF, and for a broken parent chain is
 * whichever module it stopped on. Passing either into the reduction classifies it by its own
 * `type` — `service` on an ordinary task — so the fail-safe branch above would be unreachable and
 * an unclassifiable task would silently drop its UI pass instead of running both.
 */
export async function resolveScopeForRun(
  listBlocks: (workspaceId: string) => Promise<Block[]>,
  workspaceId: string,
  block: Block,
): Promise<RunServiceScope> {
  const blocks = await listBlocks(workspaceId)
  const byId = new Map(blocks.map((b) => [b.id, b]))
  const own = frameOf(byId, block.id)
  if (own?.level !== 'frame') return { frontend: false, backend: false }
  return resolveRunServiceScope([own, ...validInvolvedServiceFrames(blocks, block, own.id)])
}

/**
 * Whether any step of a chain declares a run condition. The guard that keeps the block-list read
 * off every run: the overwhelming majority of pipelines are unconditional, and a scope nobody
 * consults is a query nobody needed.
 */
export function chainHasConditionalStep(
  stepOptions: readonly ({ condition?: unknown } | null | undefined)[] | undefined,
): boolean {
  return !!stepOptions?.some((o) => o?.condition)
}
