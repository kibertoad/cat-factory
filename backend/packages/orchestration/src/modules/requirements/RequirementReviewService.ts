import { generateText } from 'ai'
import type { Block, RequirementReview, ReviewItemStatus } from '@cat-factory/kernel'
import { assertFound, ValidationError } from '@cat-factory/kernel'
import type { BlockRepository } from '@cat-factory/kernel'
import type { Clock, IdGenerator } from '@cat-factory/kernel'
import type { ModelProvider, ModelRef } from '@cat-factory/kernel'
import type { DocumentRepository } from '@cat-factory/kernel'
import type { TaskRepository } from '@cat-factory/kernel'
import type { RequirementReviewRepository } from '@cat-factory/kernel'
import { REVIEW_SYSTEM_PROMPT } from '@cat-factory/agents'
import {
  type RequirementsContext,
  INCORPORATE_SYSTEM_PROMPT,
  buildIncorporatePrompt,
  buildReviewPrompt,
  coerceReviewItems,
  extractJson,
} from './requirements.logic.js'

export interface RequirementReviewServiceDependencies {
  requirementReviewRepository: RequirementReviewRepository
  blockRepository: BlockRepository
  idGenerator: IdGenerator
  clock: Clock
  /** Resolves the reviewer model; absent when no provider is configured. */
  modelProvider?: ModelProvider
  /**
   * Default model ref when the block pins none — the agents' routing default,
   * which itself resolves to the Cloudflare Workers AI flavour unless a direct
   * provider key is configured (so the reviewer runs on Cloudflare by default,
   * like the container Pi agent).
   */
  modelRef?: ModelRef
  /**
   * Resolve a block's selected model id to a ref, honouring the direct/Cloudflare
   * fallback — the same deployment-aware resolver the agent executor uses. When a
   * block pins a model the reviewer runs it; otherwise it falls back to `modelRef`.
   */
  resolveBlockModel?: (modelId: string | undefined) => ModelRef | undefined
  /**
   * Resolve the workspace's per-agent-kind default model id, consulted when the
   * block pins none — so the reviewer honours a workspace default for the
   * `requirements` kind exactly like a pipeline step. Absent → `modelRef` is used.
   */
  resolveWorkspaceModelDefault?: (
    workspaceId: string,
    agentKind: string,
  ) => Promise<string | undefined>
  /** Linked PRD/RFC documents (optional; only when the documents integration is on). */
  documentRepository?: DocumentRepository
  /** Linked tracker issues (optional; only when the task-source integration is on). */
  taskRepository?: TaskRepository
}

/** Settled items no longer need a human; both gate-pass the incorporate step. */
const SETTLED: ReviewItemStatus[] = ['resolved', 'dismissed']

/** The agent kind the reviewer runs as — keys its per-workspace default model. */
const REQUIREMENTS_AGENT_KIND = 'requirements'

/**
 * The requirements-review agent. Stateless and synchronous (no container, no
 * durable driver): a single LLM call reviews a block's collected requirements
 * and raises questions/challenges, humans answer them through plain mutations,
 * and a second LLM call folds the answers back into the block's description.
 *
 * The LLM is reached through the provider-agnostic {@link ModelProvider} port —
 * the same one the document planner uses — so this service never imports a
 * provider SDK or an API key. The model is resolved exactly like an agent step:
 * a model pinned on the block wins, else the agents' routing default, which falls
 * back to Cloudflare Workers AI when no direct provider key is set — so the
 * reviewer runs on Cloudflare by default (like the container Pi agent) with no
 * key required. Reads of an existing review work regardless.
 */
export class RequirementReviewService {
  constructor(private readonly deps: RequirementReviewServiceDependencies) {}

  /** Whether the LLM-backed review path is available. */
  get enabled(): boolean {
    return !!this.deps.modelProvider && !!this.deps.modelRef
  }

  /**
   * The model to run for a block, with the same precedence as a pipeline step: the
   * block's pinned selection wins, else the workspace's per-kind default for the
   * `requirements` kind, else the routing default. Each candidate id is run through
   * {@link resolveBlockModel} so a stale id falls through to the next source.
   */
  private async modelFor(workspaceId: string, block: Block): Promise<ModelRef | undefined> {
    const fromBlock = this.deps.resolveBlockModel?.(block.modelId)
    if (fromBlock) return fromBlock
    const defaultId = await this.deps.resolveWorkspaceModelDefault?.(
      workspaceId,
      REQUIREMENTS_AGENT_KIND,
    )
    const fromDefault = this.deps.resolveBlockModel?.(defaultId)
    if (fromDefault) return fromDefault
    return this.deps.modelRef
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
    const { modelProvider } = this.deps
    const ref = await this.modelFor(workspaceId, block)
    if (!modelProvider || !ref) {
      throw new ValidationError('No model is configured for the requirements reviewer')
    }

    const context = await this.gatherContext(workspaceId, block)
    let text: string
    try {
      const model = modelProvider.resolve(ref)
      const result = await generateText({
        model,
        system: REVIEW_SYSTEM_PROMPT,
        prompt: buildReviewPrompt(context),
        temperature: 0.2,
        maxOutputTokens: 5000,
      })
      text = result.text
    } catch (e) {
      // Surface the real cause (binding missing, rate limit, provider error)
      // rather than masking every failure behind one vague message.
      throw new ValidationError(
        `The requirements reviewer (${ref.provider}:${ref.model}) failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      )
    }

    const now = this.deps.clock.now()
    const items = coerceReviewItems(extractJson(text), () => this.deps.idGenerator.next('rri'), now)
    const review: RequirementReview = {
      id: this.deps.idGenerator.next('rrv'),
      blockId,
      status: 'ready',
      items,
      model: `${ref.provider}:${ref.model}`,
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
    const { modelProvider } = this.deps
    const ref = await this.modelFor(workspaceId, block)
    if (!modelProvider || !ref) {
      throw new ValidationError('No model is configured for the requirements reviewer')
    }

    const context = await this.gatherContext(workspaceId, block)
    let revised: string
    try {
      const model = modelProvider.resolve(ref)
      const result = await generateText({
        model,
        system: INCORPORATE_SYSTEM_PROMPT,
        prompt: buildIncorporatePrompt(context, review.items),
        temperature: 0.2,
        maxOutputTokens: 5000,
      })
      revised = result.text.trim()
    } catch (e) {
      throw new ValidationError(
        `The requirements reviewer (${ref.provider}:${ref.model}) failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      )
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
      },
      docs,
      tasks,
    }
  }
}
