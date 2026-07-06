import type { Block, ModelScope } from '@cat-factory/kernel'

// Shared helper for the INLINE LLM callers (the iterative reviewers, the doc/initiative
// interviewers, the tester quality companion) that resolve a model per block. It folds the
// block's active run (execution id + initiator) into the {@link ModelScope}, so a facade that
// serves an inline subscription ref through a LEASED per-run activation (local mode's container
// inline backend) can lease the initiator's credential — the inline analogue of the container
// executor's per-run lease. Absent `resolveRunContext` (tests / no run context) ⇒ a
// workspace-only scope (pooled lease only), exactly as before.

/** Resolve the block's run/execution + initiator, or `{}` when it has no active run. */
export type ResolveBlockRunContext = (
  workspaceId: string,
  block: Block,
) => Promise<{ executionId?: string; userId?: string }>

/** Build the model scope for an inline call on `block`, folding in its run context when available. */
export async function scopeForBlockRun(
  workspaceId: string,
  block: Block,
  resolveRunContext?: ResolveBlockRunContext,
): Promise<ModelScope> {
  const run = await resolveRunContext?.(workspaceId, block)
  return {
    workspaceId,
    ...(run?.executionId ? { executionId: run.executionId } : {}),
    ...(run?.userId ? { userId: run.userId } : {}),
  }
}
