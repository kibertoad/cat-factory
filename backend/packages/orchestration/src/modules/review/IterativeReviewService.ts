import { generateText } from 'ai'
import type {
  Block,
  BlockRepository,
  Clock,
  IdGenerator,
  ModelProvider,
  ModelProviderResolver,
  ModelRef,
  NotificationType,
  RequirementConcernLevel,
  RequirementReviewItem,
  RequirementReviewStatus,
  ReviewItemStatus,
} from '@cat-factory/kernel'
import {
  assertFound,
  DEFAULT_MAX_REQUIREMENT_ITERATIONS,
  inlineModelRef,
  resolveScopedModelProvider,
  ValidationError,
} from '@cat-factory/kernel'
import { catFactoryObservability } from '@cat-factory/agents'
import type { NotificationService } from '../notifications/NotificationService.js'
import {
  type ReviewDisposition,
  coerceReviewItems,
  disposeReview,
  extractJson,
} from '../requirements/requirements.logic.js'

// ---------------------------------------------------------------------------
// The iterative-review engine, shared by the requirements-review and
// clarity-review (bug-report triage) agents. Both run the SAME loop — a reviewer
// LLM raises findings, a human answers/dismisses them, an incorporation LLM folds
// the answers into one standardized document, and the reviewer re-reviews it until
// it converges (or the iteration budget runs out) — differing only in subject (a
// task's requirements vs a bug report), the persisted document field, prompts, id
// prefixes, the agent-kind tags and the notification type.
//
// This base class owns the entire control flow; each concrete service supplies
// only those differentiators through the abstract members below. Keeping it in one
// place means a fix to the loop (a status transition, a truncation guard, the
// model-resolution precedence) lands for both kinds at once.
// ---------------------------------------------------------------------------

/** The fields every review (requirements or clarity) shares; the doc field is per-kind. */
export interface ReviewCommon {
  id: string
  blockId: string
  status: RequirementReviewStatus
  items: RequirementReviewItem[]
  model: string | null
  iteration: number
  maxIterations: number
  createdAt: number
  updatedAt: number
}

/** The structural persistence port both review repositories satisfy. */
export interface ReviewRepository<TReview> {
  getByBlock(workspaceId: string, blockId: string): Promise<TReview | null>
  get(workspaceId: string, id: string): Promise<TReview | null>
  upsert(workspaceId: string, review: TReview): Promise<void>
  deleteByBlock(workspaceId: string, blockId: string): Promise<void>
}

/** The runtime dependencies shared by every iterative-review service. */
export interface IterativeReviewDeps {
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
  /**
   * Whether a container-only subscription harness ref can run as an INLINE call in this
   * deployment (local mode's ambient CLI). Keeps an ambient-eligible harness ref instead of
   * degrading it to the routing default, so the harness-aware model provider serves the
   * reviewer/rework on a subscription model. Absent → always degrade (Node/Worker).
   */
  runsInline?: (ref: ModelRef) => boolean
  /** Resolve the workspace's per-agent-kind default model id (consulted when the block pins none). */
  resolveWorkspaceModelDefault?: (
    workspaceId: string,
    agentKind: string,
    modelPresetId?: string,
  ) => Promise<string | undefined>
  /** Raises a notification when a review yields findings. Optional. */
  notificationService?: NotificationService
}

/** Output budget for the rework generation (a full standard-format document). */
const REWORK_MAX_OUTPUT_TOKENS = 16_000

/** An item still needs a human while `open`. */
const isOpen = (i: RequirementReviewItem): boolean => i.status === 'open'

/** Map a reviewer pass's disposition to the review status it parks (or advances) at. */
function statusForDisposition(d: ReviewDisposition): RequirementReviewStatus {
  if (d === 'auto-pass') return 'incorporated'
  if (d === 'exceeded') return 'exceeded'
  return 'ready'
}

/**
 * Stateless, synchronous iterative reviewer (no container, no durable driver). The LLM is
 * reached through the provider-agnostic {@link ModelProvider} port — the same one the
 * document planner uses — so this service never imports a provider SDK or an API key. The
 * model is resolved exactly like an agent step: a model pinned on the block wins, else the
 * workspace's per-kind default, else the routing default (which falls back to Cloudflare
 * Workers AI when no direct provider key is set). Reads of an existing review work
 * regardless.
 *
 * @typeParam TReview      The persisted review type (adds a kind-specific document field).
 * @typeParam TContext     The reviewer's per-kind context (the subject under review).
 * @typeParam TContextInput Extra per-call inputs threaded into context gathering (e.g. an
 *                          investigation report for clarity); `{}` when a kind needs none.
 */
export abstract class IterativeReviewService<
  TReview extends ReviewCommon,
  TContext,
  // `unknown` is the neutral element for `&`, so a kind with no extra inputs keeps the
  // public `review`/`incorporate` opts types exactly as they were (no phantom keys).
  TContextInput = unknown,
> {
  constructor(protected readonly deps: IterativeReviewDeps) {}

  // ---- abstract differentiators (supplied by each kind) -------------------

  protected abstract readonly repository: ReviewRepository<TReview>
  /** Label for `assertFound` (e.g. 'Requirement review' / 'Clarity review'). */
  protected abstract readonly entityName: string
  /** Human label for error messages (e.g. 'requirements reviewer' / 'clarity reviewer'). */
  protected abstract readonly reviewerLabel: string
  /** The agent kind keying the workspace default model + observability (e.g. 'requirements-review'). */
  protected abstract readonly reviewAgentKind: string
  /** The rework agent kind for observability (e.g. 'requirements-rework'). */
  protected abstract readonly reworkAgentKind: string
  protected abstract readonly reviewSystemPrompt: string
  protected abstract readonly reworkSystemPrompt: string
  /** Id prefix for fresh reviews / items (e.g. 'rrv' / 'rri'). */
  protected abstract readonly reviewIdPrefix: string
  protected abstract readonly itemIdPrefix: string
  /** Noun for the "no revised X produced" error (e.g. 'revised requirements'). */
  protected abstract readonly revisedNoun: string
  /** The full error message when the rework output is length-truncated. */
  protected abstract readonly truncationMessage: string
  protected abstract readonly notificationType: NotificationType
  /** Notification title for a findings notification (e.g. `Requirements review: ${title}`). */
  protected abstract notificationTitle(block: Block): string
  /** Notification body lead-in noun (e.g. 'The reviewer' / 'The clarity reviewer'). */
  protected abstract readonly notificationSubject: string

  /** Assemble the subject under review (block + any kind-specific context). */
  protected abstract gatherContext(
    workspaceId: string,
    block: Block,
    input: TContextInput,
  ): Promise<TContext>
  protected abstract buildReviewPrompt(ctx: TContext): string
  protected abstract buildReworkPrompt(ctx: TContext, items: RequirementReviewItem[]): string
  /** Apply a prior incorporated document to the context (a re-review / redo base). */
  protected abstract applyIncorporatedDoc(ctx: TContext, doc: string): void
  /** Apply the human's freeform "do it differently" feedback to the context. */
  protected abstract applyFeedback(ctx: TContext, feedback: string): void
  /** Read the kind-specific document field off a review. */
  protected abstract readDoc(review: TReview): string | null
  /** Return a copy of the review with its document field set. */
  protected abstract withDoc(review: TReview, doc: string): TReview
  /** Build a fresh review from the common fields, initialising the document field to null. */
  protected abstract newReview(common: ReviewCommon): TReview

  // ---- public surface (shared by every kind) ------------------------------

  /** Whether the LLM-backed review path is available. */
  get enabled(): boolean {
    return (!!this.deps.modelProviderResolver || !!this.deps.modelProvider) && !!this.deps.modelRef
  }

  /** The current review for a block, or null if none has been run. */
  async getForBlock(workspaceId: string, blockId: string): Promise<TReview | null> {
    return this.repository.getByBlock(workspaceId, blockId)
  }

  /**
   * Run a fresh review of a block (iteration 1). Replaces any prior review for the block
   * (answers from a stale run don't carry over). The returned review's `status` encodes the
   * disposition: `incorporated` (auto-pass — advance), `ready` (findings to answer) or
   * `exceeded` (findings but the iteration budget is already 1).
   */
  async review(
    workspaceId: string,
    blockId: string,
    opts: {
      maxIterations?: number
      concernThreshold?: RequirementConcernLevel
    } & TContextInput = {} as {
      maxIterations?: number
      concernThreshold?: RequirementConcernLevel
    } & TContextInput,
  ): Promise<TReview> {
    const block = assertFound(
      await this.deps.blockRepository.get(workspaceId, blockId),
      'Block',
      blockId,
    )
    const maxIterations = opts.maxIterations ?? DEFAULT_MAX_REQUIREMENT_ITERATIONS
    const concernThreshold = opts.concernThreshold ?? 'none'
    const context = await this.gatherContext(workspaceId, block, opts)
    const { ref, items } = await this.runReviewer(workspaceId, block, context)
    const now = this.deps.clock.now()
    const disposition = disposeReview(items, { iteration: 1, maxIterations, concernThreshold })
    const review = this.newReview({
      id: this.deps.idGenerator.next(this.reviewIdPrefix),
      blockId,
      status: statusForDisposition(disposition),
      items,
      model: `${ref.provider}:${ref.model}`,
      iteration: 1,
      maxIterations,
      createdAt: now,
      updatedAt: now,
    })

    await this.repository.deleteByBlock(workspaceId, blockId)
    await this.repository.upsert(workspaceId, review)
    if (disposition !== 'auto-pass') await this.notifyFindings(workspaceId, block, items.length)
    return review
  }

  /**
   * Re-review the block against its current incorporated document (one more reviewer pass;
   * `iteration` increments). Keeps the review id + the document; replaces the items with the
   * fresh findings and re-encodes the disposition into `status`. Called after an
   * incorporation so the loop can converge (`incorporated`), continue (`ready`) or stop for a
   * human (`exceeded`).
   */
  async reReview(
    workspaceId: string,
    reviewId: string,
    opts: { concernThreshold?: RequirementConcernLevel } = {},
  ): Promise<TReview> {
    const review = await this.load(workspaceId, reviewId)
    const block = assertFound(
      await this.deps.blockRepository.get(workspaceId, review.blockId),
      'Block',
      review.blockId,
    )
    const concernThreshold = opts.concernThreshold ?? 'none'
    const context = await this.gatherContext(workspaceId, block, {} as TContextInput)
    const doc = this.readDoc(review)
    if (doc) this.applyIncorporatedDoc(context, doc)
    const { ref, items } = await this.runReviewer(workspaceId, block, context)
    const now = this.deps.clock.now()
    const iteration = (review.iteration ?? 1) + 1
    const maxIterations = review.maxIterations ?? DEFAULT_MAX_REQUIREMENT_ITERATIONS
    const disposition = disposeReview(items, { iteration, maxIterations, concernThreshold })
    const updated: TReview = {
      ...review,
      status: statusForDisposition(disposition),
      items,
      model: `${ref.provider}:${ref.model}`,
      iteration,
      maxIterations,
      updatedAt: now,
    }
    await this.repository.upsert(workspaceId, updated)
    if (disposition !== 'auto-pass') await this.notifyFindings(workspaceId, block, items.length)
    return updated
  }

  /** Record a human's answer to one item (and flip it to `answered`). */
  async replyToItem(
    workspaceId: string,
    reviewId: string,
    itemId: string,
    reply: string,
  ): Promise<TReview> {
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
  ): Promise<TReview> {
    return this.mutateItem(workspaceId, reviewId, itemId, (item, now) => {
      item.status = status
      item.updatedAt = now
    })
  }

  /**
   * Incorporate the human's answers (and dismissals) into one self-contained, standard-format
   * document. Requires every finding to be answered or dismissed (no `open` items). The
   * optional `feedback` is the human's "do it differently" direction when redoing a merge they
   * were unhappy with, folded into the prompt alongside the prior document. Stores the document
   * on the review and parks it `merged` for the human to re-review or redo.
   */
  async incorporate(
    workspaceId: string,
    reviewId: string,
    opts: { feedback?: string } & TContextInput = {} as { feedback?: string } & TContextInput,
  ): Promise<{ review: TReview }> {
    const review = await this.load(workspaceId, reviewId)
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
    const { modelProvider, ref } = await this.resolveModel(workspaceId, block)

    const context = await this.gatherContext(workspaceId, block, opts)
    // A redo carries the prior document forward (so the rework refines it, not the raw
    // description) plus the human's freeform correction.
    const prior = this.readDoc(review)
    if (prior) this.applyIncorporatedDoc(context, prior)
    if (opts.feedback?.trim()) this.applyFeedback(context, opts.feedback.trim())
    let revised: string
    let finishReason: string
    try {
      const model = modelProvider.resolve(ref)
      const result = await generateText({
        model,
        system: this.reworkSystemPrompt,
        prompt: this.buildReworkPrompt(context, review.items),
        temperature: 0.2,
        // The reworked doc is a full standard-format document that becomes the SOLE source of
        // truth fed to every downstream agent step; a generous budget keeps a real spec from
        // being cut off mid-document.
        maxOutputTokens: REWORK_MAX_OUTPUT_TOKENS,
        providerOptions: catFactoryObservability({ agentKind: this.reworkAgentKind, workspaceId }),
      })
      revised = result.text.trim()
      finishReason = result.finishReason
    } catch (e) {
      throw new ValidationError(this.reviewerFailed(ref, e))
    }
    if (!revised) {
      throw new ValidationError(`The reviewer produced no ${this.revisedNoun}`)
    }
    // A length-truncated document would become a silently-incomplete spec that every
    // downstream agent then treats as authoritative. Reject it loudly instead.
    if (finishReason === 'length') {
      throw new ValidationError(this.truncationMessage)
    }

    const now = this.deps.clock.now()
    // `merged`: the document is produced and awaits the human's re-review / redo. It is NOT
    // yet the final accepted document (that is `incorporated`, set on converge).
    const updated = { ...this.withDoc(review, revised), status: 'merged' as const, updatedAt: now }
    await this.repository.upsert(workspaceId, updated)
    return { review: updated }
  }

  /**
   * Mark the review settled (`incorporated`) — the phase is done and the last incorporated
   * document (if any) becomes what downstream agents consume.
   */
  async markIncorporated(workspaceId: string, reviewId: string): Promise<TReview> {
    return this.patchReview(workspaceId, reviewId, (review) => ({
      ...review,
      status: 'incorporated',
    }))
  }

  /** Grant one more reviewer pass after the cap was hit, reopening the loop (`ready`). */
  async grantExtraRound(workspaceId: string, reviewId: string): Promise<TReview> {
    return this.patchReview(workspaceId, reviewId, (review) => ({
      ...review,
      status: 'ready',
      maxIterations: (review.maxIterations ?? DEFAULT_MAX_REQUIREMENT_ITERATIONS) + 1,
    }))
  }

  /** Flag a review as `incorporating` (the durable driver is about to fold + re-review). */
  async markIncorporating(workspaceId: string, reviewId: string): Promise<TReview> {
    return this.patchReview(workspaceId, reviewId, (review) => ({
      ...review,
      status: 'incorporating',
    }))
  }

  /** Flag a review as `reviewing` (the second async stage — re-reviewing the folded document). */
  async markReReviewing(workspaceId: string, reviewId: string): Promise<TReview> {
    return this.patchReview(workspaceId, reviewId, (review) => ({ ...review, status: 'reviewing' }))
  }

  // ---- internals ----------------------------------------------------------

  /** The model provider for a workspace's scope (per-scope DB pool, else the static one). */
  protected providerFor(workspaceId: string): Promise<ModelProvider | undefined> {
    return resolveScopedModelProvider(workspaceId, this.deps)
  }

  /**
   * The model to run for a block, with the same precedence as a pipeline step: the block's
   * pinned selection wins, else the workspace's per-kind default, else the routing default.
   * A pinned subscription model (Claude Code / Codex) is degraded to the routing default
   * because the reviewer is an INLINE LLM call with no provider key for the container harness
   * — the same seam the inline agent executor uses, so the two can't drift.
   */
  protected async modelFor(workspaceId: string, block: Block): Promise<ModelRef | undefined> {
    const fallback = this.deps.modelRef
    const runsInline = this.deps.runsInline
    const resolve = (ref: ModelRef): ModelRef =>
      inlineModelRef(ref, fallback ?? ref, runsInline ? { runsInline } : {})
    const fromBlock = this.deps.resolveBlockModel?.(block.modelId)
    if (fromBlock) return resolve(fromBlock)
    const defaultId = await this.deps.resolveWorkspaceModelDefault?.(
      workspaceId,
      this.reviewAgentKind,
      block.modelPresetId,
    )
    const fromDefault = this.deps.resolveBlockModel?.(defaultId)
    if (fromDefault) return resolve(fromDefault)
    return fallback
  }

  /** Resolve the provider + ref, throwing the kind's "no model configured" error if unavailable. */
  protected async resolveModel(
    workspaceId: string,
    block: Block,
  ): Promise<{ modelProvider: ModelProvider; ref: ModelRef }> {
    const modelProvider = await this.providerFor(workspaceId)
    const ref = await this.modelFor(workspaceId, block)
    if (!modelProvider || !ref) {
      throw new ValidationError(`No model is configured for the ${this.reviewerLabel}`)
    }
    return { modelProvider, ref }
  }

  private reviewerFailed(ref: ModelRef, e: unknown): string {
    // Surface the real cause (binding missing, rate limit, provider error) rather than
    // masking every failure behind one vague message.
    return `The ${this.reviewerLabel} (${ref.provider}:${ref.model}) failed: ${
      e instanceof Error ? e.message : String(e)
    }`
  }

  /** Run the reviewer LLM over the prepared context and coerce the JSON into review items. */
  protected async runReviewer(
    workspaceId: string,
    block: Block,
    context: TContext,
  ): Promise<{ ref: ModelRef; items: RequirementReviewItem[] }> {
    const { modelProvider, ref } = await this.resolveModel(workspaceId, block)
    let text: string
    try {
      const model = modelProvider.resolve(ref)
      const result = await generateText({
        model,
        system: this.reviewSystemPrompt,
        prompt: this.buildReviewPrompt(context),
        temperature: 0.2,
        maxOutputTokens: 5000,
        providerOptions: catFactoryObservability({ agentKind: this.reviewAgentKind, workspaceId }),
      })
      text = result.text
    } catch (e) {
      throw new ValidationError(this.reviewerFailed(ref, e))
    }
    const now = this.deps.clock.now()
    const items = coerceReviewItems(
      extractJson(text),
      () => this.deps.idGenerator.next(this.itemIdPrefix),
      now,
    )
    return { ref, items }
  }

  /**
   * Tell people to react to a review's findings. Best-effort and only when there ARE findings
   * — a clean review pings no one. Never lets a notification failure break the awaited review.
   */
  protected async notifyFindings(
    workspaceId: string,
    block: Block,
    findingCount: number,
  ): Promise<void> {
    if (findingCount <= 0 || !this.deps.notificationService) return
    try {
      await this.deps.notificationService.raise(workspaceId, {
        type: this.notificationType,
        blockId: block.id,
        executionId: null,
        title: this.notificationTitle(block),
        body: `${this.notificationSubject} raised ${findingCount} finding${
          findingCount === 1 ? '' : 's'
        } to react to.`,
        // Direct it at the task's responsible product person when one is assigned, so the
        // inbox can highlight it for them (it stays visible to the whole workspace).
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

  private async load(workspaceId: string, reviewId: string): Promise<TReview> {
    return assertFound(await this.repository.get(workspaceId, reviewId), this.entityName, reviewId)
  }

  protected async patchReview(
    workspaceId: string,
    reviewId: string,
    patch: (review: TReview) => TReview,
  ): Promise<TReview> {
    const review = await this.load(workspaceId, reviewId)
    const updated = { ...patch(review), updatedAt: this.deps.clock.now() }
    await this.repository.upsert(workspaceId, updated)
    return updated
  }

  private async mutateItem(
    workspaceId: string,
    reviewId: string,
    itemId: string,
    mutate: (item: RequirementReviewItem, now: number) => void,
  ): Promise<TReview> {
    const review = await this.load(workspaceId, reviewId)
    const item = review.items.find((i) => i.id === itemId)
    if (!item) throw new ValidationError(`Review item '${itemId}' not found`)
    const now = this.deps.clock.now()
    mutate(item, now)
    review.updatedAt = now
    await this.repository.upsert(workspaceId, review)
    return review
  }
}
