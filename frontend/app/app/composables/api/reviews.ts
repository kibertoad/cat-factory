import {
  acceptRequirementRecommendationContract,
  getBrainstormContract,
  getClarityReviewContract,
  getConsensusSessionContract,
  getRequirementReviewContract,
  incorporateBrainstormContract,
  incorporateClarityContract,
  incorporateRequirementsContract,
  proceedBrainstormContract,
  proceedClarityContract,
  proceedRequirementsContract,
  reRequestRequirementRecommendationContract,
  reReviewBrainstormContract,
  reReviewClarityContract,
  reReviewRequirementsContract,
  rejectRequirementRecommendationContract,
  replyBrainstormItemContract,
  replyClarityItemContract,
  replyRequirementItemContract,
  requestRequirementRecommendationsContract,
  resolveBrainstormExceededContract,
  resolveClarityExceededContract,
  resolveRequirementsExceededContract,
  updateBrainstormItemStatusContract,
  updateClarityItemStatusContract,
  updateRequirementItemStatusContract,
} from '@cat-factory/contracts'
import type {
  UpdateBrainstormItemStatusInput,
  UpdateClarityItemStatusInput,
} from '@cat-factory/contracts'
import type { ResolveClarityExceededChoice } from '~/types/clarity'
import type { BrainstormStage, ResolveBrainstormExceededChoice } from '~/types/brainstorm'
import type { ResolveRequirementsExceededChoice, ReviewItemStatus } from '~/types/requirements'
import type { ApiContext } from './context'

// The clarity/brainstorm item-status routes accept a narrower set than the full
// requirements `ReviewItemStatus` (no `recommend_requested`).
type ClarityItemStatus = UpdateClarityItemStatusInput['status']
type BrainstormItemStatus = UpdateBrainstormItemStatusInput['status']

/**
 * The two iterative gate reviewers (requirements + clarity) and the consensus
 * session read. Each reviewer follows the same answer → incorporate → re-review
 * → proceed/resolve-exceeded loop.
 */
export function reviewsApi({ send, ws }: ApiContext) {
  return {
    // ---- requirements review (stateless reviewer agent) ------------------
    // The current review for a block (null when none has been run). A 503 means
    // the feature is unconfigured (the panel hides on any error here).
    getRequirementReview: (workspaceId: string, blockId: string) =>
      send(getRequirementReviewContract, { pathPrefix: ws(workspaceId), pathParams: { blockId } }),

    // The latest consensus session for a block (`{ session: null }` when none / consensus
    // off). The live transcript also arrives via the `consensus` stream event.
    getConsensusSession: (workspaceId: string, blockId: string) =>
      send(getConsensusSessionContract, { pathPrefix: ws(workspaceId), pathParams: { blockId } }),

    replyRequirementItem: (workspaceId: string, reviewId: string, itemId: string, reply: string) =>
      send(replyRequirementItemContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { reviewId, itemId },
        body: { reply },
      }),

    setRequirementItemStatus: (
      workspaceId: string,
      reviewId: string,
      itemId: string,
      status: ReviewItemStatus,
    ) =>
      send(updateRequirementItemStatusContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { reviewId, itemId },
        body: { status },
      }),

    // Incorporate the answers ASYNCHRONOUSLY (every finding must be answered or dismissed).
    // The durable driver folds them and re-reviews in the background. Optional `feedback` is
    // the "do it differently" lever when redoing a merge. Returns the `incorporating` review
    // at once; a notification calls the user back only if the re-review needs input.
    incorporateRequirements: (workspaceId: string, blockId: string, feedback?: string) =>
      send(incorporateRequirementsContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { blockId },
        body: feedback ? { feedback } : {},
      }),

    // Re-review the incorporated document (one more reviewer pass). On convergence the
    // parked run advances; otherwise the response carries the next cycle / cap state.
    reReviewRequirements: (workspaceId: string, blockId: string) =>
      send(reReviewRequirementsContract, { pathPrefix: ws(workspaceId), pathParams: { blockId } }),

    // Proceed: settle the requirements and advance the parked run (all findings dismissed).
    proceedRequirements: (workspaceId: string, blockId: string) =>
      send(proceedRequirementsContract, { pathPrefix: ws(workspaceId), pathParams: { blockId } }),

    // Resolve a review that hit its iteration cap: extra-round / proceed / stop-reset.
    resolveRequirementsExceeded: (
      workspaceId: string,
      blockId: string,
      choice: ResolveRequirementsExceededChoice,
    ) =>
      send(resolveRequirementsExceededContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { blockId },
        body: { choice },
      }),

    // Ask the Requirement Writer to recommend grounded answers for a batch of findings (by
    // item id). Returns the review with `pending` placeholder recommendations; they fill in
    // (`ready`) asynchronously via the `requirements` stream as the Writer produces each.
    requestRecommendations: (
      workspaceId: string,
      blockId: string,
      itemIds: string[],
      note?: string,
    ) =>
      send(requestRequirementRecommendationsContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { blockId },
        body: { itemIds, ...(note ? { note } : {}) },
      }),

    // Accept a recommendation (becomes the finding's answer), reject it, or re-request it
    // with a "do it differently" note.
    acceptRecommendation: (workspaceId: string, reviewId: string, recId: string) =>
      send(acceptRequirementRecommendationContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { reviewId, recId },
      }),

    rejectRecommendation: (workspaceId: string, reviewId: string, recId: string) =>
      send(rejectRequirementRecommendationContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { reviewId, recId },
      }),

    reRequestRecommendation: (workspaceId: string, reviewId: string, recId: string, note: string) =>
      send(reRequestRequirementRecommendationContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { reviewId, recId },
        body: { note },
      }),

    // ---- clarity review (bug-report triage reviewer agent) ---------------
    // The current review for a block (null when none has been run). A 503 means
    // the feature is unconfigured (the panel hides on any error here).
    getClarityReview: (workspaceId: string, blockId: string) =>
      send(getClarityReviewContract, { pathPrefix: ws(workspaceId), pathParams: { blockId } }),

    replyClarityItem: (workspaceId: string, reviewId: string, itemId: string, reply: string) =>
      send(replyClarityItemContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { reviewId, itemId },
        body: { reply },
      }),

    setClarityItemStatus: (
      workspaceId: string,
      reviewId: string,
      itemId: string,
      status: ClarityItemStatus,
    ) =>
      send(updateClarityItemStatusContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { reviewId, itemId },
        body: { status },
      }),

    // Incorporate the answers ASYNCHRONOUSLY (every finding must be answered or dismissed).
    // The durable driver folds them and re-reviews in the background. Optional `feedback` is
    // the "do it differently" lever when redoing a merge. Returns the `incorporating` review
    // at once; a notification calls the user back only if the re-review needs input.
    incorporateClarity: (workspaceId: string, blockId: string, feedback?: string) =>
      send(incorporateClarityContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { blockId },
        body: feedback ? { feedback } : {},
      }),

    // Re-review the clarified report (one more reviewer pass). On convergence the parked run
    // advances; otherwise the response carries the next cycle / cap state.
    reReviewClarity: (workspaceId: string, blockId: string) =>
      send(reReviewClarityContract, { pathPrefix: ws(workspaceId), pathParams: { blockId } }),

    // Proceed: settle the clarity review and advance the parked run (all findings dismissed).
    proceedClarity: (workspaceId: string, blockId: string) =>
      send(proceedClarityContract, { pathPrefix: ws(workspaceId), pathParams: { blockId } }),

    // Resolve a review that hit its iteration cap: extra-round / proceed / stop-reset.
    resolveClarityExceeded: (
      workspaceId: string,
      blockId: string,
      choice: ResolveClarityExceededChoice,
    ) =>
      send(resolveClarityExceededContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { blockId },
        body: { choice },
      }),

    // ---- brainstorm (structured-dialogue agent, stage-scoped) ------------
    // The current session for a block + stage (null when none has been run). A 503 means
    // the feature is unconfigured (the panel hides on any error here).
    getBrainstorm: (workspaceId: string, blockId: string, stage: BrainstormStage) =>
      send(getBrainstormContract, { pathPrefix: ws(workspaceId), pathParams: { blockId, stage } }),

    replyBrainstormItem: (workspaceId: string, sessionId: string, itemId: string, reply: string) =>
      send(replyBrainstormItemContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { sessionId, itemId },
        body: { reply },
      }),

    setBrainstormItemStatus: (
      workspaceId: string,
      sessionId: string,
      itemId: string,
      status: BrainstormItemStatus,
    ) =>
      send(updateBrainstormItemStatusContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { sessionId, itemId },
        body: { status },
      }),

    // Incorporate the picks ASYNCHRONOUSLY (the durable driver folds + re-runs).
    incorporateBrainstorm: (
      workspaceId: string,
      blockId: string,
      stage: BrainstormStage,
      feedback?: string,
    ) =>
      send(incorporateBrainstormContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { blockId, stage },
        body: feedback ? { feedback } : {},
      }),

    // Re-run the brainstorm against the converged direction (one more pass).
    reReviewBrainstorm: (workspaceId: string, blockId: string, stage: BrainstormStage) =>
      send(reReviewBrainstormContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { blockId, stage },
      }),

    // Proceed: settle the brainstorm and advance the parked run (all options dismissed).
    proceedBrainstorm: (workspaceId: string, blockId: string, stage: BrainstormStage) =>
      send(proceedBrainstormContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { blockId, stage },
      }),

    // Resolve a session that hit its iteration cap: extra-round / proceed / stop-reset.
    resolveBrainstormExceeded: (
      workspaceId: string,
      blockId: string,
      stage: BrainstormStage,
      choice: ResolveBrainstormExceededChoice,
    ) =>
      send(resolveBrainstormExceededContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { blockId, stage },
        body: { choice },
      }),
  }
}
