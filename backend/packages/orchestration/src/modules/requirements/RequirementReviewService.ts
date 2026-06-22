import { generateText } from 'ai'
import type {
  Block,
  RequirementConcernLevel,
  RequirementReview,
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
import type { DocumentRepository } from '@cat-factory/kernel'
import type { TaskRepository } from '@cat-factory/kernel'
import type { RequirementReviewRepository } from '@cat-factory/kernel'
import type { NotificationService } from '../notifications/NotificationService.js'
import {
  REVIEW_SYSTEM_PROMPT,
  REWORK_SYSTEM_PROMPT,
  catFactoryObservability,
} from '@cat-factory/agents'
import {
  type RequirementsContext,
  type ReviewDisposition,
  buildReviewPrompt,
  buildReworkPrompt,
  coerceReviewItems,
  disposeReview,
  extractJson,
} from './requirements.logic.js'

/** Map a reviewer pass's disposition to the review status it parks (or advances) at. */
function statusForDisposition(d: ReviewDisposition): RequirementReview['status'] {
  if (d === 'auto-pass') return 'incorporated'
  if (d === 'exceeded') return 'exceeded'
  return 'ready'
}

export interface RequirementReviewServiceDependencies {
  requirementReviewRepository: RequirementReviewRepository
  blockRepository: BlockRepository
  idGenerator: IdGenerator
  clock: Clock
  /**
   * Resolve a {@link ModelProvider} for a workspace's credential scope (DB-backed key
   * pool). Preferred over the static `modelProvider`; the facade supplies it.
   */
  modelProviderResolver?: ModelProviderResolver
  /** Static reviewer model provider (e.g. a fake in tests). Used when no resolver is set. */
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
  /**
   * Raises a `requirement_review` notification when a review yields findings, so
   * product people (and the task's creator) are told to react to them. Optional —
   * absent → no notification (the review is still persisted + returned as before).
   */
  notificationService?: NotificationService
}

/** An item still needs a human while `open`; answering or dismissing it settles it. */
const isOpen = (i: RequirementReviewItem): boolean => i.status === 'open'

/**
 * Output budget for the requirements-rework generation. The reworked doc is a full
 * standard-format spec that becomes the only requirements context fed to every
 * downstream agent step, so it needs ample room; a `length` finish is rejected
 * (see `incorporate`) rather than persisted as a truncated spec.
 */
const REWORK_MAX_OUTPUT_TOKENS = 16_000

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
    return (!!this.deps.modelProviderResolver || !!this.deps.modelProvider) && !!this.deps.modelRef
  }

  /** The model provider for a workspace's scope (per-scope DB pool, else the static one). */
  private async providerFor(workspaceId: string): Promise<ModelProvider | undefined> {
    if (this.deps.modelProviderResolver) {
      return this.deps.modelProviderResolver.forScope({ workspaceId })
    }
    return this.deps.modelProvider
  }

  /**
   * The model to run for a block, with the same precedence as a pipeline step: the
   * block's pinned selection wins, else the workspace's per-kind default for the
   * `requirements` kind, else the routing default. Each candidate id is run through
   * {@link resolveBlockModel} so a stale id falls through to the next source.
   */
  private async modelFor(workspaceId: string, block: Block): Promise<ModelRef | undefined> {
    const fallback = this.deps.modelRef
    const resolve = (ref: ModelRef): ModelRef =>
      // The reviewer is an INLINE LLM call: a pinned subscription model (Claude Code /
      // Codex) runs only in the container harness and has no provider key here, so
      // degrade it to the routing default the reviewer always carries — the same seam
      // the inline agent executor uses, so the two can't drift. (`fallback ?? ref`
      // keeps a non-degradable ref when no default is wired; that path already errors
      // cleanly below with "No model is configured".)
      inlineModelRef(ref, fallback ?? ref)
    const fromBlock = this.deps.resolveBlockModel?.(block.modelId)
    if (fromBlock) return resolve(fromBlock)
    const defaultId = await this.deps.resolveWorkspaceModelDefault?.(
      workspaceId,
      REQUIREMENTS_AGENT_KIND,
    )
    const fromDefault = this.deps.resolveBlockModel?.(defaultId)
    if (fromDefault) return resolve(fromDefault)
    return fallback
  }

  /** The current review for a block, or null if none has been run. */
  async getForBlock(workspaceId: string, blockId: string): Promise<RequirementReview | null> {
    return this.deps.requirementReviewRepository.getByBlock(workspaceId, blockId)
  }

  /**
   * Run a fresh review of a block's collected requirements (iteration 1). Replaces any
   * prior review for the block (answers from a stale run don't carry over — the
   * requirements may have changed underneath them). The returned review's `status`
   * encodes the disposition: `incorporated` (auto-pass: nothing, or every finding at or
   * below the tolerated severity — advance), `ready` (findings to answer) or `exceeded`
   * (findings but the iteration budget is already 1).
   */
  async review(
    workspaceId: string,
    blockId: string,
    opts: { maxIterations?: number; concernThreshold?: RequirementConcernLevel } = {},
  ): Promise<RequirementReview> {
    const block = assertFound(
      await this.deps.blockRepository.get(workspaceId, blockId),
      'Block',
      blockId,
    )
    const maxIterations = opts.maxIterations ?? DEFAULT_MAX_REQUIREMENT_ITERATIONS
    const concernThreshold = opts.concernThreshold ?? 'none'
    const { ref, items } = await this.runReviewer(workspaceId, block)
    const now = this.deps.clock.now()
    const disposition = disposeReview(items, { iteration: 1, maxIterations, concernThreshold })
    const review: RequirementReview = {
      id: this.deps.idGenerator.next('rrv'),
      blockId,
      status: statusForDisposition(disposition),
      items,
      model: `${ref.provider}:${ref.model}`,
      incorporatedRequirements: null,
      iteration: 1,
      maxIterations,
      createdAt: now,
      updatedAt: now,
    }

    await this.deps.requirementReviewRepository.deleteByBlock(workspaceId, blockId)
    await this.deps.requirementReviewRepository.upsert(workspaceId, review)
    if (disposition !== 'auto-pass') await this.notifyFindings(workspaceId, block, items.length)
    return review
  }

  /**
   * Re-review the block against its current incorporated document (one more reviewer
   * pass; `iteration` increments). Keeps the review id + the document; replaces the items
   * with the fresh findings and re-encodes the disposition into `status`. Called after an
   * incorporation so the loop can converge (`incorporated`), continue (`ready`) or stop
   * for a human (`exceeded`).
   */
  async reReview(
    workspaceId: string,
    reviewId: string,
    opts: { concernThreshold?: RequirementConcernLevel } = {},
  ): Promise<RequirementReview> {
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
    const concernThreshold = opts.concernThreshold ?? 'none'
    const { ref, items } = await this.runReviewer(workspaceId, block, {
      incorporatedDoc: review.incorporatedRequirements ?? undefined,
    })
    const now = this.deps.clock.now()
    const iteration = (review.iteration ?? 1) + 1
    const maxIterations = review.maxIterations ?? DEFAULT_MAX_REQUIREMENT_ITERATIONS
    const disposition = disposeReview(items, { iteration, maxIterations, concernThreshold })
    const updated: RequirementReview = {
      ...review,
      status: statusForDisposition(disposition),
      items,
      model: `${ref.provider}:${ref.model}`,
      iteration,
      maxIterations,
      updatedAt: now,
    }
    await this.deps.requirementReviewRepository.upsert(workspaceId, updated)
    if (disposition !== 'auto-pass') await this.notifyFindings(workspaceId, block, items.length)
    return updated
  }

  /**
   * Run the reviewer LLM over a block's collected requirements (or, on a re-review, its
   * incorporated document) and coerce the JSON into review items. Shared by
   * {@link review} and {@link reReview}.
   */
  private async runReviewer(
    workspaceId: string,
    block: Block,
    opts: { incorporatedDoc?: string } = {},
  ): Promise<{ ref: ModelRef; items: RequirementReviewItem[] }> {
    const modelProvider = await this.providerFor(workspaceId)
    const ref = await this.modelFor(workspaceId, block)
    if (!modelProvider || !ref) {
      throw new ValidationError('No model is configured for the requirements reviewer')
    }
    const context = await this.gatherContext(workspaceId, block)
    if (opts.incorporatedDoc) context.incorporatedDoc = opts.incorporatedDoc
    let text: string
    try {
      const model = modelProvider.resolve(ref)
      const result = await generateText({
        model,
        system: REVIEW_SYSTEM_PROMPT,
        prompt: buildReviewPrompt(context),
        temperature: 0.2,
        maxOutputTokens: 5000,
        providerOptions: catFactoryObservability({
          agentKind: 'requirements-review',
          workspaceId,
        }),
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
    return { ref, items }
  }

  /**
   * Tell product people (and the task's creator) to react to a review's findings.
   * Best-effort and only when there ARE findings — a clean review pings no one. Never
   * lets a notification failure break the review the caller is awaiting.
   */
  private async notifyFindings(
    workspaceId: string,
    block: Block,
    findingCount: number,
  ): Promise<void> {
    if (findingCount <= 0 || !this.deps.notificationService) return
    try {
      await this.deps.notificationService.raise(workspaceId, {
        type: 'requirement_review',
        blockId: block.id,
        executionId: null,
        title: `Requirements review: ${block.title}`,
        body: `The reviewer raised ${findingCount} finding${
          findingCount === 1 ? '' : 's'
        } to react to.`,
        // Direct it at the task's responsible product person when one is assigned, so
        // the inbox can highlight it for them (it stays visible to the whole workspace).
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
   * Incorporate the human's answers (and dismissals) into one self-contained,
   * standard-format requirements document — the incorporation "companion". Requires every
   * finding to be answered or dismissed (no `open` items). The optional `feedback` is the
   * human's "do it differently" direction when redoing a merge they were unhappy with,
   * folded into the prompt alongside the prior document. Stores the document on the review
   * and parks it `merged` for the human to re-review or redo. Returns the updated review.
   */
  async incorporate(
    workspaceId: string,
    reviewId: string,
    opts: { feedback?: string } = {},
  ): Promise<{ review: RequirementReview }> {
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
    const open = review.items.filter(isOpen)
    if (open.length > 0) {
      throw new ValidationError(
        `Answer or dismiss all ${open.length} remaining item(s) before incorporating`,
      )
    }
    const modelProvider = await this.providerFor(workspaceId)
    const ref = await this.modelFor(workspaceId, block)
    if (!modelProvider || !ref) {
      throw new ValidationError('No model is configured for the requirements reviewer')
    }

    const context = await this.gatherContext(workspaceId, block)
    // A redo carries the prior document forward (so the rework refines it, not the raw
    // description) plus the human's freeform correction.
    if (review.incorporatedRequirements) context.incorporatedDoc = review.incorporatedRequirements
    if (opts.feedback?.trim()) context.reworkFeedback = opts.feedback.trim()
    let revised: string
    let finishReason: string
    try {
      const model = modelProvider.resolve(ref)
      const result = await generateText({
        model,
        system: REWORK_SYSTEM_PROMPT,
        prompt: buildReworkPrompt(context, review.items),
        temperature: 0.2,
        // The reworked doc is a full standard-format spec (overview + functional +
        // non-functional requirements with Given/When/Then acceptance + domain rules +
        // assumptions + out-of-scope), and it becomes the SOLE source of truth fed to
        // every downstream agent step (the description + linked docs are then dropped).
        // A generous budget keeps a real spec from being cut off mid-document.
        maxOutputTokens: REWORK_MAX_OUTPUT_TOKENS,
        providerOptions: catFactoryObservability({
          agentKind: 'requirements-rework',
          workspaceId,
        }),
      })
      revised = result.text.trim()
      finishReason = result.finishReason
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
    // A length-truncated document would become a silently-incomplete spec that every
    // downstream agent then treats as authoritative. Reject it loudly instead of
    // persisting a half-written requirements doc.
    if (finishReason === 'length') {
      throw new ValidationError(
        'The reworked requirements were cut off before completion (model output limit ' +
          'reached). Try splitting this work into smaller tasks, then rework again.',
      )
    }

    const now = this.deps.clock.now()
    const updated: RequirementReview = {
      ...review,
      // `merged`: the document is produced and awaits the human's re-review / redo. It is
      // NOT yet the final accepted requirements (that is `incorporated`, set on converge).
      status: 'merged',
      incorporatedRequirements: revised,
      updatedAt: now,
    }
    await this.deps.requirementReviewRepository.upsert(workspaceId, updated)
    return { review: updated }
  }

  /**
   * Mark the review settled (`incorporated`) — the requirements phase is done and the
   * last incorporated document (if any) becomes what downstream agents consume. Used when
   * the human proceeds (all findings dismissed, or "proceed anyway" past the cap).
   */
  async markIncorporated(workspaceId: string, reviewId: string): Promise<RequirementReview> {
    return this.patchReview(workspaceId, reviewId, (review) => ({
      ...review,
      status: 'incorporated',
    }))
  }

  /** Grant one more reviewer pass after the cap was hit, reopening the loop (`ready`). */
  async grantExtraRound(workspaceId: string, reviewId: string): Promise<RequirementReview> {
    return this.patchReview(workspaceId, reviewId, (review) => ({
      ...review,
      status: 'ready',
      maxIterations: (review.maxIterations ?? DEFAULT_MAX_REQUIREMENT_ITERATIONS) + 1,
    }))
  }

  private async patchReview(
    workspaceId: string,
    reviewId: string,
    patch: (review: RequirementReview) => RequirementReview,
  ): Promise<RequirementReview> {
    const review = assertFound(
      await this.deps.requirementReviewRepository.get(workspaceId, reviewId),
      'Requirement review',
      reviewId,
    )
    const updated = { ...patch(review), updatedAt: this.deps.clock.now() }
    await this.deps.requirementReviewRepository.upsert(workspaceId, updated)
    return updated
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
