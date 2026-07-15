import { getPrReviewContract, resolvePrReviewContract } from '@cat-factory/contracts'
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

    // Resolve a parked PR review: the curated finding selection + how it was resolved.
    resolvePrReview: (
      workspaceId: string,
      executionId: string,
      body: { action?: 'finish'; findingIds?: string[] },
    ) =>
      send(resolvePrReviewContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { executionId },
        body,
      }),
  }
}
