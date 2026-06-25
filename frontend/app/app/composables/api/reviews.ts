import type { ClarityReview, ResolveClarityExceededChoice } from '~/types/clarity'
import type { ConsensusSession } from '~/types/consensus'
import type {
  RequirementReview,
  ResolveRequirementsExceededChoice,
  ReviewItemStatus,
} from '~/types/requirements'
import type { ApiContext } from './context'

/**
 * The two iterative gate reviewers (requirements + clarity) and the consensus
 * session read. Each reviewer follows the same answer → incorporate → re-review
 * → proceed/resolve-exceeded loop.
 */
export function reviewsApi({ http, ws }: ApiContext) {
  return {
    // ---- requirements review (stateless reviewer agent) ------------------
    // The current review for a block (null when none has been run). A 503 means
    // the feature is unconfigured (the panel hides on any error here).
    getRequirementReview: (workspaceId: string, blockId: string) =>
      http<RequirementReview | null>(
        `${ws(workspaceId)}/blocks/${encodeURIComponent(blockId)}/requirement-review`,
      ),

    // The latest consensus session for a block (`{ session: null }` when none / consensus
    // off). The live transcript also arrives via the `consensus` stream event.
    getConsensusSession: (workspaceId: string, blockId: string) =>
      http<{ session: ConsensusSession | null }>(
        `${ws(workspaceId)}/blocks/${encodeURIComponent(blockId)}/consensus-session`,
      ),

    replyRequirementItem: (workspaceId: string, reviewId: string, itemId: string, reply: string) =>
      http<RequirementReview>(
        `${ws(workspaceId)}/requirement-reviews/${encodeURIComponent(reviewId)}/items/${encodeURIComponent(itemId)}/reply`,
        { method: 'POST', body: { reply } },
      ),

    setRequirementItemStatus: (
      workspaceId: string,
      reviewId: string,
      itemId: string,
      status: ReviewItemStatus,
    ) =>
      http<RequirementReview>(
        `${ws(workspaceId)}/requirement-reviews/${encodeURIComponent(reviewId)}/items/${encodeURIComponent(itemId)}`,
        { method: 'PATCH', body: { status } },
      ),

    // Incorporate the answers ASYNCHRONOUSLY (every finding must be answered or dismissed).
    // The durable driver folds them and re-reviews in the background. Optional `feedback` is
    // the "do it differently" lever when redoing a merge. Returns the `incorporating` review
    // at once; a notification calls the user back only if the re-review needs input.
    incorporateRequirements: (workspaceId: string, blockId: string, feedback?: string) =>
      http<RequirementReview>(
        `${ws(workspaceId)}/blocks/${encodeURIComponent(blockId)}/requirement-review/incorporate`,
        { method: 'POST', body: feedback ? { feedback } : {} },
      ),

    // Re-review the incorporated document (one more reviewer pass). On convergence the
    // parked run advances; otherwise the response carries the next cycle / cap state.
    reReviewRequirements: (workspaceId: string, blockId: string) =>
      http<RequirementReview>(
        `${ws(workspaceId)}/blocks/${encodeURIComponent(blockId)}/requirement-review/re-review`,
        { method: 'POST' },
      ),

    // Proceed: settle the requirements and advance the parked run (all findings dismissed).
    proceedRequirements: (workspaceId: string, blockId: string) =>
      http<RequirementReview>(
        `${ws(workspaceId)}/blocks/${encodeURIComponent(blockId)}/requirement-review/proceed`,
        { method: 'POST' },
      ),

    // Resolve a review that hit its iteration cap: extra-round / proceed / stop-reset.
    resolveRequirementsExceeded: (
      workspaceId: string,
      blockId: string,
      choice: ResolveRequirementsExceededChoice,
    ) =>
      http<RequirementReview>(
        `${ws(workspaceId)}/blocks/${encodeURIComponent(blockId)}/requirement-review/resolve-exceeded`,
        { method: 'POST', body: { choice } },
      ),

    // Ask the Requirement Writer to recommend grounded answers for a batch of findings (by
    // item id). Returns the review with `ready` recommendations for the human to act on.
    requestRecommendations: (workspaceId: string, blockId: string, itemIds: string[]) =>
      http<RequirementReview | null>(
        `${ws(workspaceId)}/blocks/${encodeURIComponent(blockId)}/requirement-review/recommend`,
        { method: 'POST', body: { itemIds } },
      ),

    // Accept a recommendation (becomes the finding's answer), reject it, or re-request it
    // with a "do it differently" note.
    acceptRecommendation: (workspaceId: string, reviewId: string, recId: string) =>
      http<RequirementReview>(
        `${ws(workspaceId)}/requirement-reviews/${encodeURIComponent(reviewId)}/recommendations/${encodeURIComponent(recId)}/accept`,
        { method: 'POST' },
      ),

    rejectRecommendation: (workspaceId: string, reviewId: string, recId: string) =>
      http<RequirementReview>(
        `${ws(workspaceId)}/requirement-reviews/${encodeURIComponent(reviewId)}/recommendations/${encodeURIComponent(recId)}/reject`,
        { method: 'POST' },
      ),

    reRequestRecommendation: (
      workspaceId: string,
      reviewId: string,
      recId: string,
      note: string,
    ) =>
      http<RequirementReview>(
        `${ws(workspaceId)}/requirement-reviews/${encodeURIComponent(reviewId)}/recommendations/${encodeURIComponent(recId)}/re-request`,
        { method: 'POST', body: { note } },
      ),

    // ---- clarity review (bug-report triage reviewer agent) ---------------
    // The current review for a block (null when none has been run). A 503 means
    // the feature is unconfigured (the panel hides on any error here).
    getClarityReview: (workspaceId: string, blockId: string) =>
      http<ClarityReview | null>(
        `${ws(workspaceId)}/blocks/${encodeURIComponent(blockId)}/clarity-review`,
      ),

    replyClarityItem: (workspaceId: string, reviewId: string, itemId: string, reply: string) =>
      http<ClarityReview>(
        `${ws(workspaceId)}/clarity-reviews/${encodeURIComponent(reviewId)}/items/${encodeURIComponent(itemId)}/reply`,
        { method: 'POST', body: { reply } },
      ),

    setClarityItemStatus: (
      workspaceId: string,
      reviewId: string,
      itemId: string,
      status: ReviewItemStatus,
    ) =>
      http<ClarityReview>(
        `${ws(workspaceId)}/clarity-reviews/${encodeURIComponent(reviewId)}/items/${encodeURIComponent(itemId)}`,
        { method: 'PATCH', body: { status } },
      ),

    // Incorporate the answers ASYNCHRONOUSLY (every finding must be answered or dismissed).
    // The durable driver folds them and re-reviews in the background. Optional `feedback` is
    // the "do it differently" lever when redoing a merge. Returns the `incorporating` review
    // at once; a notification calls the user back only if the re-review needs input.
    incorporateClarity: (workspaceId: string, blockId: string, feedback?: string) =>
      http<ClarityReview>(
        `${ws(workspaceId)}/blocks/${encodeURIComponent(blockId)}/clarity-review/incorporate`,
        { method: 'POST', body: feedback ? { feedback } : {} },
      ),

    // Re-review the clarified report (one more reviewer pass). On convergence the parked run
    // advances; otherwise the response carries the next cycle / cap state.
    reReviewClarity: (workspaceId: string, blockId: string) =>
      http<ClarityReview>(
        `${ws(workspaceId)}/blocks/${encodeURIComponent(blockId)}/clarity-review/re-review`,
        { method: 'POST' },
      ),

    // Proceed: settle the clarity review and advance the parked run (all findings dismissed).
    proceedClarity: (workspaceId: string, blockId: string) =>
      http<ClarityReview>(
        `${ws(workspaceId)}/blocks/${encodeURIComponent(blockId)}/clarity-review/proceed`,
        { method: 'POST' },
      ),

    // Resolve a review that hit its iteration cap: extra-round / proceed / stop-reset.
    resolveClarityExceeded: (
      workspaceId: string,
      blockId: string,
      choice: ResolveClarityExceededChoice,
    ) =>
      http<ClarityReview>(
        `${ws(workspaceId)}/blocks/${encodeURIComponent(blockId)}/clarity-review/resolve-exceeded`,
        { method: 'POST', body: { choice } },
      ),
  }
}
