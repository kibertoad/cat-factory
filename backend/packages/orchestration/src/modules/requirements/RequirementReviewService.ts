import { generateText } from 'ai'
import type { Block, CompanionVerdict, RequirementReview, ReviewItemStatus } from '@cat-factory/kernel'
import { assertFound, ValidationError } from '@cat-factory/kernel'
import type { BlockRepository } from '@cat-factory/kernel'
import type { Clock, IdGenerator } from '@cat-factory/kernel'
import type { ModelProvider, ModelRef } from '@cat-factory/kernel'
import type { DocumentRepository } from '@cat-factory/kernel'
import type { TaskRepository } from '@cat-factory/kernel'
import type { RequirementReviewRepository } from '@cat-factory/kernel'
import { REVIEW_SYSTEM_PROMPT, REWORK_SYSTEM_PROMPT } from '@cat-factory/agents'
import { DEFAULT_COMPANION_THRESHOLD, safeParseCompanionAssessment } from '@cat-factory/contracts'
import {
  type RequirementsContext,
  buildReviewPrompt,
  buildReworkPrompt,
  REWORK_COMPANION_SYSTEM_PROMPT,
  buildReworkCompanionPrompt,
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
      companionVerdicts: [],
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
   * Rework the block's requirements: fold the human's answers (and dismissals) into
   * one self-contained, standard-format requirements document. Requires every
   * finding to be settled (resolved or dismissed) — an empty findings list (no
   * challenges raised) passes, so a clean standardized doc is still produced. The
   * reworked text is stored on the review (`incorporatedRequirements`); the block's
   * own description and linked docs/tasks are left untouched. Downstream agent steps
   * and the requirements-writer consume the reworked text instead (see
   * `ExecutionService`). Returns the updated review.
   */
  async incorporate(workspaceId: string, reviewId: string): Promise<{ review: RequirementReview }> {
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
        `Resolve or dismiss all ${unsettled.length} remaining item(s) before reworking`,
      )
    }
    const { modelProvider } = this.deps
    const ref = await this.modelFor(workspaceId, block)
    if (!modelProvider || !ref) {
      throw new ValidationError('No model is configured for the requirements reviewer')
    }

    const context = await this.gatherContext(workspaceId, block)
    // A prior rework rejected by the companion feeds its challenge into this attempt so
    // the regenerated document addresses the gaps rather than repeating them.
    const lastVerdict = review.companionVerdicts.at(-1)
    if (lastVerdict && !lastVerdict.passed) {
      context.companionFeedback = lastVerdict.feedback
    }
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

    // Companion gate: a quality companion challenges the reworked document before it
    // becomes the spec every downstream agent trusts. Below the threshold the rework is
    // NOT accepted — the review stays `ready` and the companion's challenge is surfaced
    // (and fed into the next rework). A companion failure / unparseable verdict passes
    // through (a broken critic must never wedge the human's flow).
    const verdict = await this.gradeRework(modelProvider, ref, context, revised)

    const now = this.deps.clock.now()
    const passed = verdict.passed
    const updated: RequirementReview = {
      ...review,
      status: passed ? 'incorporated' : 'ready',
      incorporatedRequirements: passed ? revised : null,
      // Append this cycle's verdict so the whole correction sequence is preserved.
      companionVerdicts: [...review.companionVerdicts, verdict],
      updatedAt: now,
    }
    await this.deps.requirementReviewRepository.upsert(workspaceId, updated)
    return { review: updated }
  }

  /**
   * Grade a reworked requirements document with the quality companion. Returns the
   * companion verdict (rating, threshold, pass/fail, feedback). A model failure or an
   * unparseable response yields a passing verdict so a broken critic never blocks the
   * human — the truncation + empty-doc guards already caught the dangerous cases.
   */
  private async gradeRework(
    modelProvider: ModelProvider,
    ref: ModelRef,
    context: RequirementsContext,
    reworked: string,
  ): Promise<CompanionVerdict> {
    const threshold = DEFAULT_COMPANION_THRESHOLD
    try {
      const result = await generateText({
        model: modelProvider.resolve(ref),
        system: REWORK_COMPANION_SYSTEM_PROMPT,
        prompt: buildReworkCompanionPrompt(context, reworked),
        temperature: 0.1,
        maxOutputTokens: 2_000,
      })
      const assessment = safeParseCompanionAssessment(extractJson(result.text))
      if (!assessment) return { rating: 1, threshold, passed: true, feedback: '' }
      return {
        rating: assessment.rating,
        threshold,
        passed: assessment.rating >= threshold,
        feedback: assessment.summary,
      }
    } catch {
      return { rating: 1, threshold, passed: true, feedback: '' }
    }
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
