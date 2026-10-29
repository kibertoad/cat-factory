import type { RefinedRequirementsPostResult } from '@cat-factory/contracts'
import {
  ConflictError,
  type IssueWritebackProvider,
  type RequirementReviewRepository,
} from '@cat-factory/kernel'

export interface RefinedRequirementsPublisherDependencies {
  requirementReviewRepository: RequirementReviewRepository
  issueWriteback: Pick<IssueWritebackProvider, 'postRefinedRequirements'>
}

/**
 * Posts a block's refined requirements back to the tracker issue(s) the task was imported from,
 * on a person's request. It resolves WHICH document and refuses when there is none to post; the
 * writeback provider owns the per-issue fan-out, the idempotency marker and the vendor formats.
 */
export class RefinedRequirementsPublisher {
  constructor(private readonly deps: RefinedRequirementsPublisherDependencies) {}

  async publish(workspaceId: string, blockId: string): Promise<RefinedRequirementsPostResult> {
    const review = await this.deps.requirementReviewRepository.getByBlock(workspaceId, blockId)
    // While a fold is running, the stored document is the one about to be replaced.
    if (!review?.incorporatedRequirements || review.status === 'incorporating') {
      throw new ConflictError(
        'This task has no refined requirements to post yet.',
        'refined_requirements_unavailable',
      )
    }
    const result = await this.deps.issueWriteback.postRefinedRequirements(workspaceId, blockId, {
      reviewId: review.id,
      document: review.incorporatedRequirements,
    })
    if (result.issues.length === 0) {
      throw new ConflictError(
        'This task has no linked tracker issue to post to.',
        'no_linked_issues',
      )
    }
    return result
  }
}
