import type { Block } from '@cat-factory/kernel'
import { LIVE_EXECUTION_STATUSES } from '@cat-factory/kernel'
import type { CoreDependencies } from '../container.js'

// The inline callers' run-context seam, extracted from `modules.ts` (which is at its size budget):
// every module factory that builds an inline LLM caller — the iterative reviewers, the doc and
// initiative interviewers, the judges, the fork-decision chat, the tester quality companion —
// binds this one resolver, and `engine-collaborators.ts` binds it too. See `../inlineScope.ts` for
// the pure half that turns what this returns into a `ModelScope`.

/**
 * Resolve a block's ACTIVE run (execution id + initiator), so an inline subscription reviewer
 * served through a leased per-run activation can lease it. `{}` when the block has no active run
 * (an off-path inspector review with no pipeline) — the caller then resolves on a workspace-only
 * scope (pooled lease).
 *
 * **`block.executionId` is the block's LAST run, not necessarily a live one**: nothing clears it
 * when a run settles (the board reads it to show the run a task last had), so the LIVE check is
 * what makes "active" true rather than merely documented. It matters twice over, because the
 * resolved scope is read for two different things:
 *
 * - CREDENTIALS: a per-run personal activation is cleared at terminal and swept on TTL, so leasing
 *   against a settled run's id can only fail — and fail confusingly, since the id looks valid.
 *   Dropping it turns that into the accurate "requires an active run" refusal.
 * - ATTRIBUTION: the inline telemetry wrap falls back to `scope.executionId` for a call whose own
 *   tag names no run, so a stale id would file that call's spend into a FINISHED run's token
 *   rollup and `/api/v1/debug/runs/*`. Unlike a null execution id, nothing about a
 *   wrong-but-plausible one looks wrong to whoever reads it later.
 *
 * The initiator is kept either way: it is a durable fact about the block's last run, the API-key
 * pool and the user's local model endpoints scope by it, and it names nobody incorrectly.
 */
export function resolveBlockRunContext(
  deps: CoreDependencies,
): (workspaceId: string, block: Block) => Promise<{ executionId?: string; userId?: string }> {
  return async (workspaceId, block) => {
    if (!block.executionId) return {}
    const instance = await deps.executionRepository.get(workspaceId, block.executionId)
    // The complement of the terminal statuses, shared with `listLive` / `countActiveByWorkspace`,
    // so a status added later has to be classified there rather than silently reading as live.
    const live =
      !!instance && (LIVE_EXECUTION_STATUSES as readonly string[]).includes(instance.status)
    return {
      ...(live ? { executionId: block.executionId } : {}),
      ...(instance?.initiatedBy ? { userId: instance.initiatedBy } : {}),
    }
  }
}
