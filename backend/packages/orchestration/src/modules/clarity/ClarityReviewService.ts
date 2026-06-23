import { generateText } from 'ai'
import type {
  Block,
  ClarityReview,
  RequirementConcernLevel,
  RequirementReviewItem,
  ReviewItemStatus,
} from '@cat-factory/kernel'
import {
  assertFound,
  DEFAULT_MAX_REQUIREMENT_ITERATIONS,
  inlineModelRef,
  ValidationError,
} from '@cat-factory/kernel'
import type { BlockRepository } from '@cat-factory/kernel'
import type { Clock, IdGenerator } from '@cat-factory/kernel'
import type { ModelProvider, ModelProviderResolver, ModelRef } from '@cat-factory/kernel'
import type { ClarityReviewRepository } from '@cat-factory/kernel'
import type { NotificationService } from '../notifications/NotificationService.js'
import {
  CLARITY_REVIEW_SYSTEM_PROMPT,
  CLARITY_REWORK_SYSTEM_PROMPT,
  catFactoryObservability,
} from '@cat-factory/agents'
import {
  type ClarityContext,
  type ReviewDisposition,
  buildClarityPrompt,
  buildClarityReworkPrompt,
  coerceReviewItems,
  disposeReview,
  extractJson,
} from './clarity.logic.js'

/** Map a reviewer pass's disposition to the review status it parks (or advances) at. */
function statusForDisposition(d: ReviewDisposition): ClarityReview['status'] {
  if (d === 'auto-pass') return 'incorporated'
  if (d === 'exceeded') return 'exceeded'
  return 'ready'
}

export interface ClarityReviewServiceDependencies {
  clarityReviewRepository: ClarityReviewRepository
  blockRepository: BlockRepository
  idGenerator: IdGenerator
  clock: Clock
  /** Resolve a {@link ModelProvider} for a workspace's credential scope. Preferred. */
  modelProviderResolver?: ModelProviderResolver
  /** Static reviewer model provider (e.g. a fake in tests). Used when no resolver is set. */
  modelProvider?: ModelProvider
  /** Default model ref when the block pins none — the agents' routing default. */
  modelRef?: ModelRef
  /** Resolve a block's selected model id to a ref (the deployment-aware resolver). */
  resolveBlockModel?: (modelId: string | undefined) => ModelRef | undefined
  /** Resolve the workspace's per-agent-kind default model id (consulted when the block pins none). */
  resolveWorkspaceModelDefault?: (
    workspaceId: string,
    agentKind: string,
  ) => Promise<string | undefined>
  /** Raises a `clarity_review` notification when a review yields findings. Optional. */
  notificationService?: NotificationService
}

const isOpen = (i: RequirementReviewItem): boolean => i.status === 'open'

/** Output budget for the clarity-rework generation (a full standard-format bug report). */
const REWORK_MAX_OUTPUT_TOKENS = 16_000

/**
 * The agent kind the reviewer runs as — keys its per-workspace default model. Must match
 * the catalog archetype kind, the seeded pipelines' step kind, and the observability tag.
 */
const CLARITY_AGENT_KIND = 'clarity-review'

/**
 * The clarity-review (bug-report triage) agent. Stateless and synchronous (no container,
 * no durable driver): a single LLM call triages a block's bug report for fixability and
 * raises findings, humans answer them through plain mutations, and a second LLM call folds
 * the answers into a clarified report. Mirrors {@link RequirementReviewService} exactly,
 * differing only in subject (a bug report, optionally enriched by an upstream investigator)
 * and the persisted document field (`clarifiedReport`).
 */
export class ClarityReviewService {
  constructor(private readonly deps: ClarityReviewServiceDependencies) {}

  /** Whether the LLM-backed review path is available. */
  get enabled(): boolean {
    return (!!this.deps.modelProviderResolver || !!this.deps.modelProvider) && !!this.deps.modelRef
  }

  private async providerFor(workspaceId: string): Promise<ModelProvider | undefined> {
    if (this.deps.modelProviderResolver) {
      return this.deps.modelProviderResolver.forScope({ workspaceId })
    }
    return this.deps.modelProvider
  }

  private async modelFor(workspaceId: string, block: Block): Promise<ModelRef | undefined> {
    const fallback = this.deps.modelRef
    const resolve = (ref: ModelRef): ModelRef => inlineModelRef(ref, fallback ?? ref)
    const fromBlock = this.deps.resolveBlockModel?.(block.modelId)
    if (fromBlock) return resolve(fromBlock)
    const defaultId = await this.deps.resolveWorkspaceModelDefault?.(
      workspaceId,
      CLARITY_AGENT_KIND,
    )
    const fromDefault = this.deps.resolveBlockModel?.(defaultId)
    if (fromDefault) return resolve(fromDefault)
    return fallback
  }

  /** The current review for a block, or null if none has been run. */
  async getForBlock(workspaceId: string, blockId: string): Promise<ClarityReview | null> {
    return this.deps.clarityReviewRepository.getByBlock(workspaceId, blockId)
  }

  /**
   * Run a fresh triage of a block's bug report (iteration 1). Replaces any prior review for
   * the block. The `investigation` (an upstream investigator's enriched prose report) is the
   * primary triage subject when present. The returned review's `status` encodes the
   * disposition: `incorporated` (auto-pass), `ready` (findings to answer) or `exceeded`.
   */
  async review(
    workspaceId: string,
    blockId: string,
    opts: {
      maxIterations?: number
      concernThreshold?: RequirementConcernLevel
      investigation?: string
    } = {},
  ): Promise<ClarityReview> {
    const block = assertFound(
      await this.deps.blockRepository.get(workspaceId, blockId),
      'Block',
      blockId,
    )
    const maxIterations = opts.maxIterations ?? DEFAULT_MAX_REQUIREMENT_ITERATIONS
    const concernThreshold = opts.concernThreshold ?? 'none'
    const { ref, items } = await this.runReviewer(workspaceId, block, {
      investigation: opts.investigation,
    })
    const now = this.deps.clock.now()
    const disposition = disposeReview(items, { iteration: 1, maxIterations, concernThreshold })
    const review: ClarityReview = {
      id: this.deps.idGenerator.next('clr'),
      blockId,
      status: statusForDisposition(disposition),
      items,
      model: `${ref.provider}:${ref.model}`,
      clarifiedReport: null,
      iteration: 1,
      maxIterations,
      createdAt: now,
      updatedAt: now,
    }

    await this.deps.clarityReviewRepository.deleteByBlock(workspaceId, blockId)
    await this.deps.clarityReviewRepository.upsert(workspaceId, review)
    if (disposition !== 'auto-pass') await this.notifyFindings(workspaceId, block, items.length)
    return review
  }

  /**
   * Re-review the block against its current clarified report (one more pass; `iteration`
   * increments). Keeps the review id + the document; replaces the items with fresh findings.
   */
  async reReview(
    workspaceId: string,
    reviewId: string,
    opts: { concernThreshold?: RequirementConcernLevel } = {},
  ): Promise<ClarityReview> {
    const review = assertFound(
      await this.deps.clarityReviewRepository.get(workspaceId, reviewId),
      'Clarity review',
      reviewId,
    )
    const block = assertFound(
      await this.deps.blockRepository.get(workspaceId, review.blockId),
      'Block',
      review.blockId,
    )
    const concernThreshold = opts.concernThreshold ?? 'none'
    const { ref, items } = await this.runReviewer(workspaceId, block, {
      clarifiedDoc: review.clarifiedReport ?? undefined,
    })
    const now = this.deps.clock.now()
    const iteration = (review.iteration ?? 1) + 1
    const maxIterations = review.maxIterations ?? DEFAULT_MAX_REQUIREMENT_ITERATIONS
    const disposition = disposeReview(items, { iteration, maxIterations, concernThreshold })
    const updated: ClarityReview = {
      ...review,
      status: statusForDisposition(disposition),
      items,
      model: `${ref.provider}:${ref.model}`,
      iteration,
      maxIterations,
      updatedAt: now,
    }
    await this.deps.clarityReviewRepository.upsert(workspaceId, updated)
    if (disposition !== 'auto-pass') await this.notifyFindings(workspaceId, block, items.length)
    return updated
  }

  /** Run the reviewer LLM over the bug report (or, on a re-review, its clarified report). */
  private async runReviewer(
    workspaceId: string,
    block: Block,
    opts: { investigation?: string; clarifiedDoc?: string } = {},
  ): Promise<{ ref: ModelRef; items: RequirementReviewItem[] }> {
    const modelProvider = await this.providerFor(workspaceId)
    const ref = await this.modelFor(workspaceId, block)
    if (!modelProvider || !ref) {
      throw new ValidationError('No model is configured for the clarity reviewer')
    }
    const context = this.gatherContext(block, opts)
    let text: string
    try {
      const model = modelProvider.resolve(ref)
      const result = await generateText({
        model,
        system: CLARITY_REVIEW_SYSTEM_PROMPT,
        prompt: buildClarityPrompt(context),
        temperature: 0.2,
        maxOutputTokens: 5000,
        providerOptions: catFactoryObservability({ agentKind: 'clarity-review', workspaceId }),
      })
      text = result.text
    } catch (e) {
      throw new ValidationError(
        `The clarity reviewer (${ref.provider}:${ref.model}) failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      )
    }
    const now = this.deps.clock.now()
    const items = coerceReviewItems(
      extractJson(text),
      () => this.deps.idGenerator.next('clri'),
      now,
    )
    return { ref, items }
  }

  /** Tell people to react to a review's findings. Best-effort, only when there ARE findings. */
  private async notifyFindings(
    workspaceId: string,
    block: Block,
    findingCount: number,
  ): Promise<void> {
    if (findingCount <= 0 || !this.deps.notificationService) return
    try {
      await this.deps.notificationService.raise(workspaceId, {
        type: 'clarity_review',
        blockId: block.id,
        executionId: null,
        title: `Bug-report triage: ${block.title}`,
        body: `The clarity reviewer raised ${findingCount} finding${
          findingCount === 1 ? '' : 's'
        } to react to.`,
        payload: {
          findingCount,
          ...(block.responsibleProductUserId
            ? { targetUserId: block.responsibleProductUserId }
            : {}),
        },
      })
    } catch {
      // Best-effort: the review is already persisted and returned to the caller.
    }
  }

  /** Record a human's answer to one item (and flip it to `answered`). */
  async replyToItem(
    workspaceId: string,
    reviewId: string,
    itemId: string,
    reply: string,
  ): Promise<ClarityReview> {
    return this.mutateItem(workspaceId, reviewId, itemId, (item, now) => {
      item.reply = reply
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
  ): Promise<ClarityReview> {
    return this.mutateItem(workspaceId, reviewId, itemId, (item, now) => {
      item.status = status
      item.updatedAt = now
    })
  }

  /**
   * Incorporate the human's answers into one self-contained, standard-format bug report.
   * Requires every finding to be answered or dismissed. Stores the document on the review
   * and parks it `merged` for the human to re-review or redo.
   */
  async incorporate(
    workspaceId: string,
    reviewId: string,
    opts: { feedback?: string; investigation?: string } = {},
  ): Promise<{ review: ClarityReview }> {
    const review = assertFound(
      await this.deps.clarityReviewRepository.get(workspaceId, reviewId),
      'Clarity review',
      reviewId,
    )
    const block = assertFound(
      await this.deps.blockRepository.get(workspaceId, review.blockId),
      'Block',
      review.blockId,
    )
    const open = review.items.filter(isOpen)
    if (open.length > 0) {
      throw new ValidationError(
        `Answer or dismiss all ${open.length} remaining item(s) before incorporating`,
      )
    }
    const modelProvider = await this.providerFor(workspaceId)
    const ref = await this.modelFor(workspaceId, block)
    if (!modelProvider || !ref) {
      throw new ValidationError('No model is configured for the clarity reviewer')
    }

    const context = this.gatherContext(block, {
      investigation: opts.investigation,
      clarifiedDoc: review.clarifiedReport ?? undefined,
    })
    if (opts.feedback?.trim()) context.reworkFeedback = opts.feedback.trim()
    let revised: string
    let finishReason: string
    try {
      const model = modelProvider.resolve(ref)
      const result = await generateText({
        model,
        system: CLARITY_REWORK_SYSTEM_PROMPT,
        prompt: buildClarityReworkPrompt(context, review.items),
        temperature: 0.2,
        maxOutputTokens: REWORK_MAX_OUTPUT_TOKENS,
        providerOptions: catFactoryObservability({ agentKind: 'clarity-rework', workspaceId }),
      })
      revised = result.text.trim()
      finishReason = result.finishReason
    } catch (e) {
      throw new ValidationError(
        `The clarity reviewer (${ref.provider}:${ref.model}) failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      )
    }
    if (!revised) {
      throw new ValidationError('The reviewer produced no revised bug report')
    }
    if (finishReason === 'length') {
      throw new ValidationError(
        'The reworked bug report was cut off before completion (model output limit reached). ' +
          'Try splitting this work into smaller tasks, then rework again.',
      )
    }

    const now = this.deps.clock.now()
    const updated: ClarityReview = {
      ...review,
      status: 'merged',
      clarifiedReport: revised,
      updatedAt: now,
    }
    await this.deps.clarityReviewRepository.upsert(workspaceId, updated)
    return { review: updated }
  }

  /** Mark the review settled (`incorporated`) — the last clarified report becomes the brief. */
  async markIncorporated(workspaceId: string, reviewId: string): Promise<ClarityReview> {
    return this.patchReview(workspaceId, reviewId, (review) => ({
      ...review,
      status: 'incorporated',
    }))
  }

  /** Grant one more reviewer pass after the cap was hit, reopening the loop (`ready`). */
  async grantExtraRound(workspaceId: string, reviewId: string): Promise<ClarityReview> {
    return this.patchReview(workspaceId, reviewId, (review) => ({
      ...review,
      status: 'ready',
      maxIterations: (review.maxIterations ?? DEFAULT_MAX_REQUIREMENT_ITERATIONS) + 1,
    }))
  }

  /** Flag a review as `incorporating` (the durable driver is about to fold + re-review). */
  async markIncorporating(workspaceId: string, reviewId: string): Promise<ClarityReview> {
    return this.patchReview(workspaceId, reviewId, (review) => ({
      ...review,
      status: 'incorporating',
    }))
  }

  /** Flag a review as `reviewing` (the second async stage — re-reviewing the folded report). */
  async markReReviewing(workspaceId: string, reviewId: string): Promise<ClarityReview> {
    return this.patchReview(workspaceId, reviewId, (review) => ({ ...review, status: 'reviewing' }))
  }

  private async patchReview(
    workspaceId: string,
    reviewId: string,
    patch: (review: ClarityReview) => ClarityReview,
  ): Promise<ClarityReview> {
    const review = assertFound(
      await this.deps.clarityReviewRepository.get(workspaceId, reviewId),
      'Clarity review',
      reviewId,
    )
    const updated = { ...patch(review), updatedAt: this.deps.clock.now() }
    await this.deps.clarityReviewRepository.upsert(workspaceId, updated)
    return updated
  }

  // ---- internals ----------------------------------------------------------

  private async mutateItem(
    workspaceId: string,
    reviewId: string,
    itemId: string,
    mutate: (item: ClarityReview['items'][number], now: number) => void,
  ): Promise<ClarityReview> {
    const review = assertFound(
      await this.deps.clarityReviewRepository.get(workspaceId, reviewId),
      'Clarity review',
      reviewId,
    )
    const item = review.items.find((i) => i.id === itemId)
    if (!item) throw new ValidationError(`Review item '${itemId}' not found`)
    const now = this.deps.clock.now()
    mutate(item, now)
    review.updatedAt = now
    await this.deps.clarityReviewRepository.upsert(workspaceId, review)
    return review
  }

  /** Assemble the bug report under review (block + optional investigation / clarified doc). */
  private gatherContext(
    block: Block,
    opts: { investigation?: string; clarifiedDoc?: string },
  ): ClarityContext {
    return {
      block: { title: block.title, type: block.type, description: block.description },
      investigation: opts.investigation,
      clarifiedDoc: opts.clarifiedDoc,
    }
  }
}
