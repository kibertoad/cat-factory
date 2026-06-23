import type { Block, RequirementReview, RequirementReviewItem } from '@cat-factory/kernel'
import type { DocumentRepository, TaskRepository } from '@cat-factory/kernel'
import type { RequirementReviewRepository } from '@cat-factory/kernel'
import { REVIEW_SYSTEM_PROMPT, REWORK_SYSTEM_PROMPT } from '@cat-factory/agents'
import {
  type IterativeReviewDeps,
  IterativeReviewService,
  type ReviewCommon,
  type ReviewRepository,
} from '../review/IterativeReviewService.js'
import {
  type RequirementsContext,
  buildReviewPrompt,
  buildReworkPrompt,
} from './requirements.logic.js'

export interface RequirementReviewServiceDependencies extends IterativeReviewDeps {
  requirementReviewRepository: RequirementReviewRepository
  /** Linked PRD/RFC documents (optional; only when the documents integration is on). */
  documentRepository?: DocumentRepository
  /** Linked tracker issues (optional; only when the task-source integration is on). */
  taskRepository?: TaskRepository
}

/**
 * The requirements-review agent: a single LLM call reviews a block's collected requirements
 * (description + linked PRD/RFC docs + tracker issues) and raises questions/challenges,
 * humans answer them, and a second LLM call folds the answers into a standardized
 * requirements document. The whole iterative loop lives in {@link IterativeReviewService};
 * this class supplies only the requirements-specific subject, prompts and document field.
 */
export class RequirementReviewService extends IterativeReviewService<
  RequirementReview,
  RequirementsContext
> {
  protected readonly repository: ReviewRepository<RequirementReview>
  private readonly documentRepository?: DocumentRepository
  private readonly taskRepository?: TaskRepository

  constructor(deps: RequirementReviewServiceDependencies) {
    super(deps)
    this.repository = deps.requirementReviewRepository
    this.documentRepository = deps.documentRepository
    this.taskRepository = deps.taskRepository
  }

  protected readonly entityName = 'Requirement review'
  protected readonly reviewerLabel = 'requirements reviewer'
  protected readonly reviewAgentKind = 'requirements-review'
  protected readonly reworkAgentKind = 'requirements-rework'
  protected readonly reviewSystemPrompt = REVIEW_SYSTEM_PROMPT
  protected readonly reworkSystemPrompt = REWORK_SYSTEM_PROMPT
  protected readonly reviewIdPrefix = 'rrv'
  protected readonly itemIdPrefix = 'rri'
  protected readonly revisedNoun = 'revised requirements'
  protected readonly truncationMessage =
    'The reworked requirements were cut off before completion (model output limit ' +
    'reached). Try splitting this work into smaller tasks, then rework again.'
  protected readonly notificationType = 'requirement_review' as const
  protected readonly notificationSubject = 'The reviewer'

  protected notificationTitle(block: Block): string {
    return `Requirements review: ${block.title}`
  }

  protected buildReviewPrompt(ctx: RequirementsContext): string {
    return buildReviewPrompt(ctx)
  }

  protected buildReworkPrompt(ctx: RequirementsContext, items: RequirementReviewItem[]): string {
    return buildReworkPrompt(ctx, items)
  }

  protected applyIncorporatedDoc(ctx: RequirementsContext, doc: string): void {
    ctx.incorporatedDoc = doc
  }

  protected applyFeedback(ctx: RequirementsContext, feedback: string): void {
    ctx.reworkFeedback = feedback
  }

  protected readDoc(review: RequirementReview): string | null {
    return review.incorporatedRequirements
  }

  protected withDoc(review: RequirementReview, doc: string): RequirementReview {
    return { ...review, incorporatedRequirements: doc }
  }

  protected newReview(common: ReviewCommon): RequirementReview {
    return { ...common, incorporatedRequirements: null }
  }

  /** Assemble the block's collected requirements + any linked docs/issues. */
  protected async gatherContext(workspaceId: string, block: Block): Promise<RequirementsContext> {
    const docs = this.documentRepository
      ? (await this.documentRepository.listByBlock(workspaceId, block.id)).map((d) => ({
          title: d.title,
          url: d.url,
          excerpt: d.excerpt,
        }))
      : []
    const tasks = this.taskRepository
      ? (await this.taskRepository.listByBlock(workspaceId, block.id)).map((t) => ({
          key: t.externalId,
          title: t.title,
          status: t.status,
          type: t.type,
          description: t.description,
        }))
      : []
    return {
      block: { title: block.title, type: block.type, description: block.description },
      docs,
      tasks,
    }
  }
}
