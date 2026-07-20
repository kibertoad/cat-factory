import {
  challengePrReviewFindingContract,
  dismissPrReviewFindingContract,
  getPrReviewContract,
  resolvePrReviewContract,
} from '@cat-factory/contracts'
import type { ApiContext } from './context'

/**
 * The PR deep-review phase: the read-only `pr-reviewer` agent slices an open pull request and
 * surfaces prioritized findings on the run's `pr-reviewer` step, then the run parks for a human
 * to SELECT which findings matter. These endpoints read the surfaced findings and record the
 * human's curated selection + resolution. The read returns null when no `pr-reviewer` step
 * carries review state.
 */
export function prReviewApi({ send, ws }: ApiContext) {
  return {
    // The live PR-review state for a run (null when no pr-reviewer step carries one).
    getPrReview: (workspaceId: string, executionId: string) =>
      send(getPrReviewContract, { pathPrefix: ws(workspaceId), pathParams: { executionId } }),

    // Resolve a parked PR review: the curated finding selection + how it was resolved
    // (`finish` completes it, `fix` feeds a Fixer, `post` publishes inline PR comments).
    resolvePrReview: (
      workspaceId: string,
      executionId: string,
      body: { action?: 'finish' | 'fix' | 'post'; findingIds?: string[] },
    ) =>
      send(resolvePrReviewContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { executionId },
        body,
      }),

    // Dismiss a parked finding entirely (drops it + prunes it from the selection).
    dismissPrReviewFinding: (workspaceId: string, executionId: string, findingId: string) =>
      send(dismissPrReviewFindingContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { executionId, findingId },
      }),

    // Challenge a parked finding — dispatch the Challenge Investigator (optional specific concern).
    challengePrReviewFinding: (
      workspaceId: string,
      executionId: string,
      findingId: string,
      body: { question?: string },
    ) =>
      send(challengePrReviewFindingContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { executionId, findingId },
        body,
      }),
  }
}
