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
  OwnServiceContext,
  RequirementConcernLevel,
  RequirementReviewItem,
  RequirementReviewStatus,
  ReviewItemStatus,
} from '@cat-factory/kernel'
import {
  assertFound,
  DEFAULT_MAX_REQUIREMENT_ITERATIONS,
  describeOwnService,
  getErrorMessage,
  resolveScopedModelProvider,
  resolveServiceFrameBlock,
  ReviewContendedError,
  ValidationError,
} from '@cat-factory/kernel'
import {
  type BespokeSystemPrompt,
  catFactoryObservability,
  composeBespokePrompt,
} from '@cat-factory/agents'
import { type ResolveBlockRunContext, scopeForBlockRun } from '../../inlineScope.js'
import { type InlineBlockModelDeps, resolveInlineBlockModelRef } from '../../inlineBlockModel.js'
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
  /** Optimistic-concurrency token; see the contracts' `rev`. A fresh review starts at 0. */
  rev: number
  createdAt: number
  updatedAt: number
}

/**
 * The structural persistence port both review repositories satisfy. Deliberately NARROWER than
 * the kernel ports: the force-write `upsert` is not on it, because no path in this service may
 * use one — a whole-row write from a stale read is the bug this concurrency model exists to
 * prevent, and a fresh review is published through `replaceForBlock`. The kernel ports keep
 * `upsert` for the seeding/RPC surfaces that legitimately own the row outright.
 */
export interface ReviewRepository<TReview> {
  getByBlock(workspaceId: string, blockId: string): Promise<TReview | null>
  get(workspaceId: string, id: string): Promise<TReview | null>
  /** Rev-guarded conditional update; false ⇒ another writer moved (or deleted) the row. */
  compareAndSwap(workspaceId: string, review: TReview): Promise<boolean>
  /** Atomically make this the block's (and, for brainstorm, the stage's) one live review. */
  replaceForBlock(workspaceId: string, review: TReview): Promise<void>
}

/**
 * How many times a contended {@link IterativeReviewService.mutateReview} reloads and re-applies
 * before giving up with a {@link ReviewContendedError}. Matches the engine's
 * `RunStateMachine.mutateInstance` budget: the contending writers here are human clicks and one
 * durable-driver pass, so a handful of retries covers real contention while still failing loudly
 * on a pathological hot row.
 */
const MAX_MUTATE_ATTEMPTS = 8

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
  /** Resolve a block's selected model id to a ref, under the preset's route order. */
  resolveBlockModel?: InlineBlockModelDeps['resolveBlockModel']
  /**
   * Whether a container-only subscription harness ref can run as an INLINE call in this
   * deployment (local mode's ambient CLI). Keeps an ambient-eligible harness ref instead of
   * degrading it to the routing default, so the harness-aware model provider serves the
   * reviewer/rework on a subscription model. Absent → always degrade (Node/Worker).
   */
  runsInline?: (ref: ModelRef) => boolean
  /**
   * The workspace's per-kind default MODEL and the ROUTE order the preset in force states, from
   * ONE read. Absent ⇒ block pin plus the routing default, on the deployment's default order.
   */
  resolvePresetRouting?: InlineBlockModelDeps['resolvePresetRouting']
  /**
   * Resolve the run/execution + initiator a reviewer pass belongs to, from the block under
   * review. Threaded into the model scope so a facade that serves an inline subscription ref
   * through a LEASED per-run activation (local mode's container inline backend) can lease the
   * initiator's credential — the reviewer runs during a parked run, so its execution is the
   * block's active run. Wired by the engine (looks up the block's execution + `initiatedBy`);
   * absent in tests/conformance → workspace-only scope (pooled lease only), unchanged.
   */
  resolveRunContext?: ResolveBlockRunContext
  /** Raises a notification when a review yields findings. Optional. */
  notificationService?: NotificationService
  /**
   * The workspace's live system prompt for an agent kind, when it has edited one from the prompt
   * editor — the same append-only revision log the engine reads per dispatch, reaching the inline
   * review kinds here.
   *
   * They were the one prompt-assembly path that ignored it: the editor accepts any kind id, so a
   * workspace could save an override for `requirements-review` and have it silently never run.
   * Optional so a standalone/unit construction still works; absent ⇒ the shipped prompt.
   */
  resolveSystemPromptOverride?: (
    workspaceId: string,
    agentKind: string,
  ) => Promise<string | undefined>
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
  /**
   * The reviewer's and rework editor's system prompts, each SPLIT into the role half a workspace
   * override replaces and the directives half it may not (`BespokeSystemPrompt`). These kinds run
   * as bare inline `generateText` calls and so never reach `systemPromptFor`, which is the seam
   * that applies an override elsewhere AND re-appends what an override must not delete — here the
   * JSON output contract this service parses and the scope rules the whole flow depends on.
   */
  protected abstract readonly reviewPrompt: BespokeSystemPrompt
  protected abstract readonly reworkPrompt: BespokeSystemPrompt
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
    return this.persistInitialReview(workspaceId, block, items, `${ref.provider}:${ref.model}`, {
      maxIterations,
      concernThreshold,
    })
  }

  /**
   * Persist a fresh (iteration-1) review from ALREADY-PRODUCED items: dispose them, encode the
   * disposition into `status` (auto-pass → `incorporated`; findings → `ready`/`exceeded`),
   * replace any prior review for the block, and raise the findings notification unless it
   * auto-passed. Extracted from {@link review} so a kind can seed the initial items WITHOUT the
   * reviewer LLM (the clarity kind seeds them from an upstream investigator; `model` is then
   * `null`) and still share this exact dispose/persist/notify tail.
   */
  protected async persistInitialReview(
    workspaceId: string,
    block: Block,
    items: RequirementReviewItem[],
    model: string | null,
    opts: { maxIterations: number; concernThreshold: RequirementConcernLevel },
  ): Promise<TReview> {
    const now = this.deps.clock.now()
    const disposition = disposeReview(items, {
      iteration: 1,
      maxIterations: opts.maxIterations,
      concernThreshold: opts.concernThreshold,
    })
    const review = this.newReview({
      id: this.deps.idGenerator.next(this.reviewIdPrefix),
      blockId: block.id,
      status: statusForDisposition(disposition),
      items,
      model,
      iteration: 1,
      maxIterations: opts.maxIterations,
      // A fresh review; the store re-stamps this on insert.
      rev: 0,
      createdAt: now,
      updatedAt: now,
    })
    // ATOMIC replace, never delete-then-insert: two review runs for one block (a double-submit,
    // or a manual run racing the engine's gate) would otherwise interleave their delete/insert
    // pairs and leave the block with TWO live reviews — the window then loads one while the
    // parked run's decision keys to the other (race-audit 2.5).
    await this.repository.replaceForBlock(workspaceId, review)
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
    // The reviewer call is slow, so the snapshot loaded above is stale by the time it returns
    // (a human can grant an extra round, or answer an item that this pass is about to replace).
    // Re-derive the counters from the FRESH review under CAS rather than writing the pre-call
    // snapshot back — a retry recomputes them against whichever snapshot it lands on.
    const updated = await this.mutateReview(workspaceId, reviewId, (fresh) => {
      const iteration = (fresh.iteration ?? 1) + 1
      const maxIterations = fresh.maxIterations ?? DEFAULT_MAX_REQUIREMENT_ITERATIONS
      Object.assign(fresh, {
        status: statusForDisposition(
          disposeReview(items, { iteration, maxIterations, concernThreshold }),
        ),
        items,
        model: `${ref.provider}:${ref.model}`,
        iteration,
        maxIterations,
      })
    })
    // Re-derived from what was actually PERSISTED, not smuggled out of the mutation on a closure
    // variable: `disposeReview` is pure, so reading the committed counters back cannot disagree
    // with the status the winning attempt wrote.
    const disposition = disposeReview(updated.items, {
      iteration: updated.iteration,
      maxIterations: updated.maxIterations,
      concernThreshold,
    })
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
        system: await this.systemPromptFor(workspaceId, this.reworkAgentKind, this.reworkPrompt),
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

    // `merged`: the document is produced and awaits the human's re-review / redo. It is NOT
    // yet the final accepted document (that is `incorporated`, set on converge). The snapshot
    // read at the top of this method is stale — the incorporation LLM call is the longest
    // window in the whole loop, and a human dismissal landing inside it was previously
    // clobbered (race-audit 2.5) — so fold the document onto the FRESH review under CAS.
    const updated = await this.mutateReview(workspaceId, reviewId, (fresh) => {
      Object.assign(fresh, this.withDoc(fresh, revised), { status: 'merged' as const })
    })
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

  /**
   * The model provider for a block's run scope (per-scope DB pool, else the static one). The
   * run context (execution + initiator) is folded into the scope so an inline subscription ref
   * served through a leased per-run activation can lease it; absent → workspace-only scope.
   */
  protected async providerFor(
    workspaceId: string,
    block: Block,
  ): Promise<ModelProvider | undefined> {
    const scope = await scopeForBlockRun(workspaceId, block, this.deps.resolveRunContext)
    return resolveScopedModelProvider(scope, this.deps)
  }

  /**
   * The model to run for a block, with the same precedence as a pipeline step: the block's
   * pinned selection wins, else the workspace's per-kind default, else the routing default.
   * A pinned subscription model (Claude Code / Codex) is degraded to the routing default
   * because the reviewer is an INLINE LLM call with no provider key for the container harness
   * — the same seam the inline agent executor uses, so the two can't drift.
   */
  protected modelFor(workspaceId: string, block: Block): Promise<ModelRef | undefined> {
    return resolveInlineBlockModelRef(this.deps, workspaceId, this.reviewAgentKind, block)
  }

  /** Resolve the provider + ref, throwing the kind's "no model configured" error if unavailable. */
  /**
   * Compose a bespoke inline prompt for one call, honouring the workspace's override of its ROLE
   * half. The directives half is re-appended on top, so an edited prompt keeps the JSON output
   * contract this service parses and the flow-wide rules (product/technical scope, the
   * no-assumed-product rule) it is run under — the same guarantee `systemPromptFor` gives the
   * kinds that go through it.
   *
   * Resolved per call rather than cached on the instance: the log is append-only and a human may
   * edit the prompt between a reviewer pass and the incorporation that follows it, and one point
   * read beside an LLM call costs nothing.
   */
  /**
   * Which system the block under review belongs to (see kernel's `OwnServiceContext`). Walks the
   * block's ancestry through the SAME shared helper the engine's `AgentContextBuilder` uses, so an
   * inline reviewer and a container agent cannot answer "what am I working on" differently.
   *
   * On the base class because all three inline flows need it for the same reason: none has a
   * checkout, so without it their entire notion of the subject is a block title.
   */
  protected async resolveOwnService(workspaceId: string, block: Block): Promise<OwnServiceContext> {
    const serviceFrame = await resolveServiceFrameBlock(
      (id) => this.deps.blockRepository.get(workspaceId, id),
      block.id,
      block,
    )
    return describeOwnService(block, serviceFrame)
  }

  protected async systemPromptFor(
    workspaceId: string,
    agentKind: string,
    prompt: BespokeSystemPrompt,
  ): Promise<string> {
    const override = await this.deps.resolveSystemPromptOverride?.(workspaceId, agentKind)
    return composeBespokePrompt(prompt, override?.trim() ? override : undefined)
  }

  protected async resolveModel(
    workspaceId: string,
    block: Block,
  ): Promise<{ modelProvider: ModelProvider; ref: ModelRef }> {
    const modelProvider = await this.providerFor(workspaceId, block)
    const ref = await this.modelFor(workspaceId, block)
    if (!modelProvider || !ref) {
      throw new ValidationError(`No model is configured for the ${this.reviewerLabel}`)
    }
    return { modelProvider, ref }
  }

  private reviewerFailed(ref: ModelRef, e: unknown): string {
    // Surface the real cause (binding missing, rate limit, provider error) rather than
    // masking every failure behind one vague message.
    return `The ${this.reviewerLabel} (${ref.provider}:${ref.model}) failed: ${getErrorMessage(e)}`
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
        system: await this.systemPromptFor(workspaceId, this.reviewAgentKind, this.reviewPrompt),
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
        // Carry the run's id so `RunStateMachine.ensureWaitingNotification`'s executionId-scoped
        // guard (F7) treats this as THIS run's richer card and suppresses the generic
        // `decision_required` fallback — otherwise a review park raising findings would get a
        // duplicate card. `block.executionId` is the active run during a step (see `merge_review`).
        executionId: block.executionId ?? null,
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

  /**
   * Apply a pure in-memory mutation to a review under OPTIMISTIC CONCURRENCY: load it, run
   * `mutate`, then `compareAndSwap`. A review is ONE JSON blob holding every finding, so two
   * writers that each load it, edit a DIFFERENT item and write the whole row back would leave
   * only the last writer's edit — and because `incorporate` refuses to run while any finding is
   * still `open`, a lost dismissal blocks incorporation on a phantom open item (race-audit 2.5).
   * On a lost race this reloads and re-applies `mutate` on the winning snapshot (bounded
   * retries) rather than force-writing over it.
   *
   * `mutate` MUST be idempotent w.r.t. external systems — it can run several times, so do all
   * non-idempotent work (notifications, driver signals, emits) AFTER this resolves, on the
   * returned review. A domain error thrown from `mutate` (the fresh state no longer admits the
   * action) propagates immediately and is NOT retried. `updatedAt` is stamped centrally, so a
   * mutation never has to remember to. Returning `false` from `mutate` means "the fresh state
   * already satisfies this" — no write happens at all, so an idempotent re-request doesn't
   * churn `updatedAt` (and the live event it drives).
   *
   * Giving up throws {@link ReviewContendedError}, which is BOTH a 409 for an HTTP caller and the
   * durable driver's re-drive signal — the driver owns the two paths whose mutation carries
   * paid-for LLM output (`incorporate`, `reReview`), and failing the run there would throw that
   * work away for good rather than re-deriving it on fresh state.
   */
  protected async mutateReview(
    workspaceId: string,
    reviewId: string,
    mutate: (review: TReview, now: number) => boolean | void,
  ): Promise<TReview> {
    return assertFound(
      await this.mutateReviewIfPresent(workspaceId, reviewId, mutate),
      this.entityName,
      reviewId,
    )
  }

  /**
   * {@link mutateReview} for a caller to whom a review that is GONE is an ordinary outcome rather
   * than a 404 — resolving to null instead of throwing. The absence is re-checked on every
   * attempt, so a fresh review run replacing the row mid-retry settles as "gone" rather than
   * surfacing as a `NotFoundError` from a path that must not throw.
   */
  protected async mutateReviewIfPresent(
    workspaceId: string,
    reviewId: string,
    mutate: (review: TReview, now: number) => boolean | void,
  ): Promise<TReview | null> {
    for (let attempt = 0; attempt < MAX_MUTATE_ATTEMPTS; attempt++) {
      const review = await this.repository.get(workspaceId, reviewId)
      if (!review) return null
      const now = this.deps.clock.now()
      if (mutate(review, now) === false) return review
      review.updatedAt = now
      if (await this.repository.compareAndSwap(workspaceId, review)) return review
    }
    throw new ReviewContendedError(this.entityName, reviewId)
  }

  protected async patchReview(
    workspaceId: string,
    reviewId: string,
    patch: (review: TReview) => TReview,
  ): Promise<TReview> {
    // The patch is expressed as a copy, so fold it back onto the loaded instance the CAS guards.
    // NOTE: this OVERLAYS the copy's fields — a patch that returns an object with a field OMITTED
    // does not delete it (unlike replacing the object wholesale). Patches here set fields; one
    // that needs to clear a field must set it explicitly (to null/undefined), not drop the key.
    return this.mutateReview(workspaceId, reviewId, (review) => {
      Object.assign(review, patch(review))
    })
  }

  private async mutateItem(
    workspaceId: string,
    reviewId: string,
    itemId: string,
    mutate: (item: RequirementReviewItem, now: number) => void,
  ): Promise<TReview> {
    return this.mutateReview(workspaceId, reviewId, (review, now) => {
      const item = review.items.find((i) => i.id === itemId)
      // Re-resolved on every attempt: a concurrent re-review replaces the item list wholesale,
      // so an answer aimed at a finding that no longer exists must fail rather than be re-applied
      // to a stale copy of the array.
      if (!item) throw new ValidationError(`Review item '${itemId}' not found`)
      mutate(item, now)
    })
  }
}
