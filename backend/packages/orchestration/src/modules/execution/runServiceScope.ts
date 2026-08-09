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
 * One block-list read, shared with whatever else the caller does with it. A task outside any
 * service frame resolves to a scope with neither half set, which contracts'
 * `stepConditionSatisfied` reads as "nothing to judge" and runs the step.
 */
export async function resolveScopeForRun(
  listBlocks: (workspaceId: string) => Promise<Block[]>,
  workspaceId: string,
  block: Block,
): Promise<RunServiceScope> {
  const blocks = await listBlocks(workspaceId)
  const byId = new Map(blocks.map((b) => [b.id, b]))
  const own = frameOf(byId, block.id)
  if (!own) return { frontend: false, backend: false }
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
