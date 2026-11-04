import type { RefinedRequirementsWritebackResult } from '@cat-factory/contracts'
import {
  type Clock,
  ConflictError,
  type IssueWritebackProvider,
  type Logger,
  noopLogger,
  type OperationalMetrics,
  type RefinedRequirementsWritebackTrigger,
  type RequirementReview,
  type RequirementReviewRepository,
  runBestEffort,
} from '@cat-factory/kernel'

export interface RefinedRequirementsPublisherDependencies {
  requirementReviewRepository: RequirementReviewRepository
  issueWriteback: Pick<IssueWritebackProvider, 'writeRefinedRequirements'>
  operationalMetrics: OperationalMetrics
  clock: Clock
  logger?: Logger
}

/**
 * Writes a block's refined requirements into the description of each tracker issue the task was
 * imported from, and records what happened on each so the review window can show it.
 *
 * Two entry points share one path: {@link publish} on a person's click, which refuses when there
 * is nothing to write, and {@link onReviewSettled} when the requirements review settles and the
 * run moves on, which runs only when the workspace opted in and can never fail the run. The
 * writeback provider owns the per-issue fan-out, the vendor formats and the content comparison
 * that makes a repeat a no-op.
 */
export class RefinedRequirementsPublisher {
  private readonly log: Logger

  constructor(private readonly deps: RefinedRequirementsPublisherDependencies) {
    this.log = (deps.logger ?? noopLogger).child({ service: 'refinedRequirementsPublisher' })
  }

  async publish(workspaceId: string, blockId: string): Promise<RefinedRequirementsWritebackResult> {
    const review = await this.deps.requirementReviewRepository.getByBlock(workspaceId, blockId)
    const document = writableDocument(review)
    if (!review || !document) {
      throw new ConflictError(
        'This task has no refined requirements to write yet.',
        'refined_requirements_unavailable',
      )
    }
    const result = await this.write(workspaceId, blockId, review, document, 'manual')
    if (result === 'disabled' || result.issues.length === 0) {
      throw new ConflictError(
        'This task has no linked tracker issue to update.',
        'no_linked_issues',
      )
    }
    return result
  }

  /**
   * The review gate settled and the run is moving on: write the approved document when the
   * workspace's setting asks for it. Best-effort, so a tracker outage costs the writeback and
   * never the run; the per-issue outcome is recorded either way.
   */
  async onReviewSettled(workspaceId: string, blockId: string): Promise<void> {
    await runBestEffort(
      this.log,
      'refinedRequirements.automaticWriteback',
      async () => {
        const review = await this.deps.requirementReviewRepository.getByBlock(workspaceId, blockId)
        const document = writableDocument(review)
        if (!review || !document) return
        await this.write(workspaceId, blockId, review, document, 'automatic')
      },
      { workspaceId, blockId },
    )
  }

  private async write(
    workspaceId: string,
    blockId: string,
    review: RequirementReview,
    document: string,
    trigger: RefinedRequirementsWritebackTrigger,
  ): Promise<RefinedRequirementsWritebackResult | 'disabled'> {
    const result = await this.deps.issueWriteback.writeRefinedRequirements(
      workspaceId,
      blockId,
      document,
      trigger,
    )
    if (result === 'disabled' || result.issues.length === 0) return result
    for (const issue of result.issues) {
      this.deps.operationalMetrics.increment('writeback.requirements_description', {
        trigger,
        outcome: issue.outcome,
      })
    }
    const failed = result.issues.filter((issue) => issue.outcome === 'failed')
    if (failed.length > 0) {
      this.log.warn('refined requirements were not written to some linked issues', {
        workspaceId,
        blockId,
        trigger,
        failed: failed.map((issue) => `${issue.source}:${issue.externalId}`),
      })
    }
    // The tracker writes are done; recording them is what the window reads, and a store hiccup
    // here must not turn a landed write into a refused request.
    await runBestEffort(
      this.log,
      'refinedRequirements.recordWriteback',
      () =>
        this.deps.requirementReviewRepository.recordIssueWriteback(workspaceId, review.id, {
          trigger,
          at: this.deps.clock.now(),
          issues: result.issues,
        }),
      { workspaceId, blockId },
    )
    return result
  }
}

/** The document a writeback may use: the settled one, never one a fold is rewriting right now. */
function writableDocument(review: RequirementReview | null): string | null {
  if (!review?.incorporatedRequirements || review.status === 'incorporating') return null
  return review.incorporatedRequirements
}
