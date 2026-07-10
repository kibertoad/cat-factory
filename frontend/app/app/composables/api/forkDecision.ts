import { chooseForkContract, getForkDecisionContract } from '@cat-factory/contracts'
import type { ApiContext } from './context'

/**
 * The implementation-fork decision phase: before the Coder writes code the read-only
 * proposer surfaces materially different approaches on the run's coder step and the run
 * parks. These endpoints read the surfaced approaches and record the human's choice (a
 * proposed fork or their own free-text approach); choosing re-runs the Coder with the chosen
 * approach folded in. The read returns null when no coder step carries fork state.
 */
export function forkDecisionApi({ send, ws }: ApiContext) {
  return {
    // The live fork-decision state for a run (null when no coder step carries one).
    getForkDecision: (workspaceId: string, executionId: string) =>
      send(getForkDecisionContract, { pathPrefix: ws(workspaceId), pathParams: { executionId } }),

    // Choose an implementation approach — a proposed fork id or a custom approach (+ note).
    chooseFork: (
      workspaceId: string,
      executionId: string,
      body: { forkId?: string | null; custom?: string | null; note?: string | null },
    ) =>
      send(chooseForkContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { executionId },
        body,
      }),
  }
}
