import { generateText } from 'ai'
import type { Block, RequirementReview, ReviewItemStatus } from '../../domain/types'
import { assertFound, ValidationError } from '../../domain/errors'
import type { BlockRepository } from '../../ports/repositories'
import type { Clock, IdGenerator } from '../../ports/runtime'
import type { ModelProvider, ModelRef } from '../../ports/model-provider'
import type { DocumentRepository } from '../../ports/document-repositories'
import type { TaskRepository } from '../../ports/task-repositories'
import type { RequirementReviewRepository } from '../../ports/requirement-review-repositories'
import {
  type RequirementsContext,
  INCORPORATE_SYSTEM_PROMPT,
  REVIEW_SYSTEM_PROMPT,
  buildIncorporatePrompt,
  buildReviewPrompt,
  coerceReviewItems,
  extractJson,
} from './requirements.logic'

export interface RequirementReviewServiceDependencies {
  requirementReviewRepository: RequirementReviewRepository
  blockRepository: BlockRepository
  idGenerator: IdGenerator
  clock: Clock
  /** Resolves the reviewer model; absent when no provider is configured. */
  modelProvider?: ModelProvider
  /** Which model to use for review + incorporation (the agents' default ref). */
  modelRef?: ModelRef
  /** Linked PRD/RFC documents (optional; only when the documents integration is on). */
  documentRepository?: DocumentRepository
  /** Linked tracker issues (optional; only when the task-source integration is on). */
  taskRepository?: TaskRepository
}

/** Settled items no longer need a human; both gate-pass the incorporate step. */
const SETTLED: ReviewItemStatus[] = ['resolved', 'dismissed']

/**
 * The requirements-review agent. Stateless and synchronous (no container, no
 * durable driver): a single LLM call reviews a block's collected requirements
 * and raises questions/challenges, humans answer them through plain mutations,
 * and a second LLM call folds the answers back into the block's description.
 *
 * The LLM is reached through the provider-agnostic {@link ModelProvider} port —
 * the same one the document planner uses — so this service never imports a
 * provider SDK or an API key. When no model is configured the review/incorporate
 * paths fail with a clear validation error (there is no useful deterministic
 * fallback for a reviewer); reads of an existing review still work.
 */
export class RequirementReviewService {
  constructor(private readonly deps: RequirementReviewServiceDependencies) {}

  /** Whether the LLM-backed review path is available. */
  get enabled(): boolean {
    return !!this.deps.modelProvider && !!this.deps.modelRef
  }

  /** The current review for a block, or null if none has been run. */
  async getForBlock(workspaceId: string, blockId: string): Promise<RequirementReview | null> {
    return this.deps.requirementReviewRepository.getByBlock(workspaceId, blockId)
  }

  /**
   * Run a fresh review of a block's collected requirements. Replaces any prior
   * review for the block (answers from a stale run don't carry over — the
   * requirements may have changed underneath them).
   */
  async review(workspaceId: string, blockId: string): Promise<RequirementReview> {
    const block = assertFound(
      await this.deps.blockRepository.get(workspaceId, blockId),
      'Block',
      blockId,
    )
    const { modelProvider, modelRef } = this.deps
    if (!modelProvider || !modelRef) {
      throw new ValidationError('No model is configured for the requirements reviewer')
    }

    const context = await this.gatherContext(workspaceId, block)
    let text: string
    try {
      const model = modelProvider.resolve(modelRef)
      const result = await generateText({
        model,
        system: REVIEW_SYSTEM_PROMPT,
        prompt: buildReviewPrompt(context),
        temperature: 0.2,
        maxOutputTokens: 5000,
      })
      text = result.text
    } catch {
      throw new ValidationError('The requirements reviewer model could not be reached')
    }

    const now = this.deps.clock.now()
    const items = coerceReviewItems(extractJson(text), () => this.deps.idGenerator.next('rri'), now)
    const review: RequirementReview = {
      id: this.deps.idGenerator.next('rrv'),
      blockId,
      status: 'ready',
      items,
      model: `${modelRef.provider}:${modelRef.model}`,
      incorporatedRequirements: null,
      createdAt: now,
      updatedAt: now,
    }

    await this.deps.requirementReviewRepository.deleteByBlock(workspaceId, blockId)
    await this.deps.requirementReviewRepository.upsert(workspaceId, review)
    return review
  }

  /** Record a human's answer to one item (and flip it to `answered`). */
  async replyToItem(
    workspaceId: string,
    reviewId: string,
    itemId: string,
    reply: string,
  ): Promise<RequirementReview> {
    return this.mutateItem(workspaceId, reviewId, itemId, (item, now) => {
      item.reply = reply
      // Answering re-opens a settled item only implicitly via an explicit status
      // change; here we just move an untouched item forward to `answered`.
      if (item.status === 'open') item.status = 'answered'
      item.updatedAt = now
    })
  }

  /** Set an item's status (resolve / dismiss / reopen). */
  async setItemStatus(
    workspaceId: string,
    reviewId: string,
    itemId: string,
    status: ReviewItemStatus,
  ): Promise<RequirementReview> {
    return this.mutateItem(workspaceId, reviewId, itemId, (item, now) => {
      item.status = status
      item.updatedAt = now
    })
  }

  /**
   * Fold the answers back into the block's requirements. Requires every item to
   * be settled (resolved or dismissed); rewrites the block description from the
   * answers and marks the review `incorporated`. Returns the updated review and
   * the updated block.
   */
  async incorporate(
    workspaceId: string,
    reviewId: string,
  ): Promise<{ review: RequirementReview; block: Block }> {
    const review = assertFound(
      await this.deps.requirementReviewRepository.get(workspaceId, reviewId),
      'Requirement review',
      reviewId,
    )
    const block = assertFound(
      await this.deps.blockRepository.get(workspaceId, review.blockId),
      'Block',
      review.blockId,
    )
    const unsettled = review.items.filter((i) => !SETTLED.includes(i.status))
    if (unsettled.length > 0) {
      throw new ValidationError(
        `Resolve or dismiss all ${unsettled.length} remaining item(s) before incorporating`,
      )
    }
    const { modelProvider, modelRef } = this.deps
    if (!modelProvider || !modelRef) {
      throw new ValidationError('No model is configured for the requirements reviewer')
    }

    const context = await this.gatherContext(workspaceId, block)
    let revised: string
    try {
      const model = modelProvider.resolve(modelRef)
      const result = await generateText({
        model,
        system: INCORPORATE_SYSTEM_PROMPT,
        prompt: buildIncorporatePrompt(context, review.items),
        temperature: 0.2,
        maxOutputTokens: 5000,
      })
      revised = result.text.trim()
    } catch {
      throw new ValidationError('The requirements reviewer model could not be reached')
    }
    if (!revised) {
      throw new ValidationError('The reviewer produced no revised requirements')
    }

    const now = this.deps.clock.now()
    await this.deps.blockRepository.update(workspaceId, block.id, { description: revised })
    const updated: RequirementReview = {
      ...review,
      status: 'incorporated',
      incorporatedRequirements: revised,
      updatedAt: now,
    }
    await this.deps.requirementReviewRepository.upsert(workspaceId, updated)
    const nextBlock = assertFound(
      await this.deps.blockRepository.get(workspaceId, block.id),
      'Block',
      block.id,
    )
    return { review: updated, block: nextBlock }
  }

  // ---- internals ----------------------------------------------------------

  private async mutateItem(
    workspaceId: string,
    reviewId: string,
    itemId: string,
    mutate: (item: RequirementReview['items'][number], now: number) => void,
  ): Promise<RequirementReview> {
    const review = assertFound(
      await this.deps.requirementReviewRepository.get(workspaceId, reviewId),
      'Requirement review',
      reviewId,
    )
    const item = review.items.find((i) => i.id === itemId)
    if (!item) throw new ValidationError(`Review item '${itemId}' not found`)
    const now = this.deps.clock.now()
    mutate(item, now)
    review.updatedAt = now
    await this.deps.requirementReviewRepository.upsert(workspaceId, review)
    return review
  }

  /** Assemble the block's collected requirements + any linked docs/issues. */
  private async gatherContext(workspaceId: string, block: Block): Promise<RequirementsContext> {
    const docs = this.deps.documentRepository
      ? (await this.deps.documentRepository.listByBlock(workspaceId, block.id)).map((d) => ({
          title: d.title,
          url: d.url,
          excerpt: d.excerpt,
        }))
      : []
    const tasks = this.deps.taskRepository
      ? (await this.deps.taskRepository.listByBlock(workspaceId, block.id)).map((t) => ({
          key: t.externalId,
          title: t.title,
          status: t.status,
          type: t.type,
          description: t.description,
        }))
      : []
    return {
      block: {
        title: block.title,
        type: block.type,
        description: block.description,
        features: block.features,
      },
      docs,
      tasks,
    }
  }
}
