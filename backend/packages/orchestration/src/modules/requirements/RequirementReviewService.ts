import type {
  Block,
  ModelProvider,
  ModelRef,
  RequirementRecommendation,
  RequirementReview,
  RequirementReviewItem,
  ResolveRunRepoContext,
} from '@cat-factory/kernel'
import type { DocumentRepository, TaskRepository } from '@cat-factory/kernel'
import type { RequirementReviewRepository } from '@cat-factory/kernel'
import { assertFound, ValidationError } from '@cat-factory/kernel'
import { generateText } from 'ai'
import {
  catFactoryObservability,
  providerWebSearchTools,
  REVIEW_SYSTEM_PROMPT,
  REWORK_SYSTEM_PROMPT,
  WRITER_SYSTEM_PROMPT,
} from '@cat-factory/agents'
import {
  type IterativeReviewDeps,
  IterativeReviewService,
  type ReviewCommon,
  type ReviewRepository,
} from '../review/IterativeReviewService.js'
import {
  type GroundingFragment,
  type GroundingWebResult,
  type RecommendationGrounding,
  type RequirementsContext,
  buildRecommendationPrompt,
  buildReviewPrompt,
  buildReworkPrompt,
  coerceSingleRecommendation,
  extractJson,
  findSourceItem,
} from './requirements.logic.js'

export interface RequirementReviewServiceDependencies extends IterativeReviewDeps {
  requirementReviewRepository: RequirementReviewRepository
  /** Linked PRD/RFC documents (optional; only when the documents integration is on). */
  documentRepository?: DocumentRepository
  /** Linked tracker issues (optional; only when the task-source integration is on). */
  taskRepository?: TaskRepository
  /**
   * Resolve the run's repo (checkout-free {@link RepoFiles}) so the Requirement Writer can
   * read `spec/` + `tech-spec/` to ground recommendations. Optional — unwired (tests / no
   * GitHub) ⇒ the Writer grounds on fragments + web only.
   */
  resolveRunRepoContext?: ResolveRunRepoContext
  /**
   * Resolve a block's applicable best-practice fragments (block + inherited service
   * standards) as {id,title,body}. The Requirement Writer checks these FIRST. Optional.
   */
  resolveBlockFragments?: (workspaceId: string, blockId: string) => Promise<GroundingFragment[]>
  /**
   * Gateway-RAG web search (Brave/SearXNG) for what the project material leaves open —
   * model-agnostic grounding. Optional; provider-hosted web search is attached separately
   * when the resolved model supports it.
   */
  webSearch?: (workspaceId: string, query: string) => Promise<GroundingWebResult[]>
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
  private readonly resolveRunRepoContext?: ResolveRunRepoContext
  private readonly resolveBlockFragments?: (
    workspaceId: string,
    blockId: string,
  ) => Promise<GroundingFragment[]>
  private readonly webSearch?: (workspaceId: string, query: string) => Promise<GroundingWebResult[]>

  constructor(deps: RequirementReviewServiceDependencies) {
    super(deps)
    this.repository = deps.requirementReviewRepository
    this.documentRepository = deps.documentRepository
    this.taskRepository = deps.taskRepository
    this.resolveRunRepoContext = deps.resolveRunRepoContext
    this.resolveBlockFragments = deps.resolveBlockFragments
    this.webSearch = deps.webSearch
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
    return { ...common, incorporatedRequirements: null, recommendations: [] }
  }

  // ---- Requirement Writer (the second companion: grounded recommendations) -----------

  /** Whether the Writer can run (same model gate as the reviewer). */
  get writerEnabled(): boolean {
    return this.enabled
  }

  /**
   * Prepare a recommendation batch SYNCHRONOUSLY: mark the targeted findings
   * `recommend_requested` and append one `pending` placeholder recommendation per finding
   * (snapshotting the source finding by title/detail). The slow Writer LLM does NOT run here —
   * {@link fillPendingRecommendations} fills the placeholders later, in the durable driver, so
   * the human is handed straight back to the board. Returns the review with the placeholders so
   * the SPA shows the "generating…" state immediately. Idempotent per finding: a finding that
   * already carries a `pending` placeholder is not duplicated.
   */
  async prepareRecommendations(
    workspaceId: string,
    reviewId: string,
    itemIds: string[],
    note?: string,
  ): Promise<RequirementReview> {
    const targetIds = new Set(itemIds)
    const review = assertFound(
      await this.repository.get(workspaceId, reviewId),
      this.entityName,
      reviewId,
    )
    const now = this.deps.clock.now()
    const trimmedNote = note?.trim() || null
    const recommendations = [...review.recommendations]
    let changed = false
    for (const item of review.items) {
      if (!targetIds.has(item.id) || item.status === 'dismissed') continue
      if (item.status !== 'recommend_requested') {
        item.status = 'recommend_requested'
        item.updatedAt = now
        changed = true
      }
      // Don't queue a second placeholder for a finding the Writer is already working on. Keyed
      // on the finding id so two findings that share an identical title+detail still each get
      // their own placeholder.
      const alreadyPending = recommendations.some(
        (r) => r.status === 'pending' && r.sourceFinding.itemId === item.id,
      )
      if (alreadyPending) continue
      recommendations.push({
        id: this.deps.idGenerator.next('rec'),
        sourceFinding: { title: item.title, detail: item.detail, itemId: item.id },
        recommendedText: '',
        status: 'pending',
        note: trimmedNote,
        groundedInFragment: null,
        createdAt: now,
        updatedAt: now,
      })
      changed = true
    }
    if (!changed) return review
    const updated: RequirementReview = { ...review, recommendations, updatedAt: now }
    await this.repository.upsert(workspaceId, updated)
    return updated
  }

  /**
   * Fill every `pending` recommendation on a review by running the Requirement Writer once per
   * finding, so progress streams in as `ready / total`. Grounding shared across findings (the
   * block's best-practice fragments + the in-repo `spec/`/`tech-spec/` excerpts) is gathered
   * ONCE; only web search runs per finding. Each filled recommendation is persisted and
   * `onProgress` is invoked with the fresh review, so an open window tracks the count live and
   * the board's "Recommending…" badge clears the moment the last placeholder settles. A
   * per-finding Writer failure drops that placeholder and reopens its finding (so the human can
   * answer manually) rather than wedging the whole batch. Best-effort and re-entrant: a replay
   * that re-runs it simply finds no `pending` placeholders and produces nothing. Returns the
   * number of recommendations produced (for the completion notification).
   */
  async fillPendingRecommendations(
    workspaceId: string,
    reviewId: string,
    opts: { onProgress?: (review: RequirementReview) => Promise<void> } = {},
  ): Promise<{ produced: number }> {
    const initial = assertFound(
      await this.repository.get(workspaceId, reviewId),
      this.entityName,
      reviewId,
    )
    const pending = initial.recommendations.filter((r) => r.status === 'pending')
    if (pending.length === 0) return { produced: 0 }

    const block = assertFound(
      await this.deps.blockRepository.get(workspaceId, initial.blockId),
      'Block',
      initial.blockId,
    )
    let model: ReturnType<ModelProvider['resolve']>
    let ref: ModelRef
    try {
      const resolved = await this.resolveModel(workspaceId, block)
      ref = resolved.ref
      model = resolved.modelProvider.resolve(ref)
    } catch {
      // The reviewer model can't be resolved for this deployment (no provider key / binding wired
      // for the resolved ref). The Writer cannot run, so degrade gracefully exactly like a
      // per-finding failure: drop every pending placeholder and reopen its finding for manual
      // answering, rather than throwing. A raw throw here 500'd the off-path inline request on the
      // runtime whose default resolves to an unregistered provider while the other resolved its
      // binding and returned 200 — the cross-runtime divergence the conformance suite guards.
      await this.dropPendingRecommendations(workspaceId, reviewId, opts.onProgress)
      return { produced: 0 }
    }
    const context = await this.gatherContext(workspaceId, block)
    const fragments = (await this.resolveBlockFragments?.(workspaceId, block.id)) ?? []
    const fragmentById = new Map(fragments.map((f) => [f.id, f]))
    // Shared, finding-independent grounding gathered ONCE for the whole batch (repo reads + a
    // single web search over the batch's finding titles), reused across the per-finding calls.
    const sharedSpecExcerpts = await this.gatherSpecExcerpts(workspaceId, block)
    const sharedWebResults = await this.gatherWebResults(
      workspaceId,
      pending.map((p) => p.sourceFinding.title),
    )

    let produced = 0
    for (const placeholder of pending) {
      // Re-anchor the placeholder to a LIVE finding — prefer the snapshotted finding id, falling
      // back to title/detail when ids churned across a re-review. Gone → nothing to recommend for.
      const before = assertFound(
        await this.repository.get(workspaceId, reviewId),
        this.entityName,
        reviewId,
      )
      const liveFinding = findSourceItem(before.items, placeholder.sourceFinding)
      const suggestion = liveFinding
        ? await this.runWriterForFinding(
            workspaceId,
            model,
            ref,
            context,
            liveFinding,
            placeholder.note ?? undefined,
            fragments,
            sharedSpecExcerpts,
            sharedWebResults,
          )
        : null
      // Re-read fresh each iteration: the per-finding Writer calls take seconds, during which the
      // human may have answered/dismissed other findings or accepted an earlier recommendation.
      const review = assertFound(
        await this.repository.get(workspaceId, reviewId),
        this.entityName,
        reviewId,
      )
      const rec = review.recommendations.find((r) => r.id === placeholder.id)
      if (!rec || rec.status !== 'pending') continue // accepted/rejected/churned away meanwhile
      const now = this.deps.clock.now()
      if (suggestion) {
        const standard = suggestion.fromStandard
          ? fragmentById.get(suggestion.fromStandard)
          : undefined
        rec.recommendedText = suggestion.recommendation
        rec.groundedInFragment = standard ? { id: standard.id, title: standard.title } : null
        rec.status = 'ready'
        rec.updatedAt = now
        produced += 1
      } else {
        // The Writer failed for (or no longer matches) this finding: drop the dead placeholder
        // and reopen its finding so the human can answer it by hand.
        review.recommendations = review.recommendations.filter((r) => r.id !== placeholder.id)
        const item = findSourceItem(review.items, placeholder.sourceFinding)
        if (item && item.status === 'recommend_requested') {
          item.status = 'open'
          item.updatedAt = now
        }
      }
      review.updatedAt = now
      await this.repository.upsert(workspaceId, review)
      await opts.onProgress?.(review)
    }
    if (produced > 0) await this.notifyRecommendationsReady(workspaceId, block, produced)
    return { produced }
  }

  /**
   * Drop every `pending` placeholder on a review and reopen its source finding (the same cleanup
   * the per-finding failure path does, applied to the whole batch). Used when the Writer can't run
   * at all — the reviewer model is unresolvable — so the human gets the findings back to answer by
   * hand instead of a wedged "generating…" state. Best-effort: emits progress after the cleanup.
   */
  private async dropPendingRecommendations(
    workspaceId: string,
    reviewId: string,
    onProgress?: (review: RequirementReview) => Promise<void>,
  ): Promise<void> {
    const review = await this.repository.get(workspaceId, reviewId)
    if (!review) return
    const pending = review.recommendations.filter((r) => r.status === 'pending')
    if (pending.length === 0) return
    const now = this.deps.clock.now()
    review.recommendations = review.recommendations.filter((r) => r.status !== 'pending')
    for (const placeholder of pending) {
      const item = findSourceItem(review.items, placeholder.sourceFinding)
      if (item && item.status === 'recommend_requested') {
        item.status = 'open'
        item.updatedAt = now
      }
    }
    review.updatedAt = now
    await this.repository.upsert(workspaceId, review)
    await onProgress?.(review)
  }

  /**
   * Flip a settled recommendation back to `pending` with a fresh "do it differently" note and
   * re-mark its source finding `recommend_requested`. The (slow) Writer re-runs later via
   * {@link fillPendingRecommendations} in the durable driver — the SAME async path as a fresh
   * batch — so a re-request never blocks the request either. Returns the review (with the
   * placeholder reset). The source finding for the recommendation must still exist.
   */
  async markRecommendationPending(
    workspaceId: string,
    reviewId: string,
    recId: string,
    note: string,
  ): Promise<RequirementReview> {
    return this.mutateRecommendation(workspaceId, reviewId, recId, (rec, review, now) => {
      rec.status = 'pending'
      rec.recommendedText = ''
      rec.groundedInFragment = null
      rec.note = note.trim() || null
      const item = findSourceItem(review.items, rec.sourceFinding)
      if (!item) {
        throw new ValidationError('The finding this recommendation answers no longer exists')
      }
      if (item.status !== 'recommend_requested') {
        item.status = 'recommend_requested'
        item.updatedAt = now
      }
    })
  }

  /**
   * Accept a recommendation: it becomes the source finding's answer (the matching item flips
   * to `answered`) so the NEXT incorporation folds it in. Match by the snapshotted finding
   * title/detail since item ids churn across re-reviews.
   */
  async acceptRecommendation(
    workspaceId: string,
    reviewId: string,
    recId: string,
  ): Promise<RequirementReview> {
    return this.mutateRecommendation(workspaceId, reviewId, recId, (rec, review, now) => {
      rec.status = 'accepted'
      const item = findSourceItem(review.items, rec.sourceFinding)
      if (item) {
        item.reply = rec.recommendedText
        item.status = 'answered'
        item.updatedAt = now
      }
    })
  }

  /**
   * Reject a recommendation and reopen its source finding (status `open`) so the human can
   * answer it manually — a `recommend_requested` finding hides its answer box, so leaving it
   * marked would strand the finding with no way to settle it.
   */
  async rejectRecommendation(
    workspaceId: string,
    reviewId: string,
    recId: string,
  ): Promise<RequirementReview> {
    return this.mutateRecommendation(workspaceId, reviewId, recId, (rec, review, now) => {
      rec.status = 'rejected'
      const item = findSourceItem(review.items, rec.sourceFinding)
      if (item && item.status === 'recommend_requested') {
        item.status = 'open'
        item.updatedAt = now
      }
    })
  }

  /** Run the Writer for one live finding; returns null when it fails (the caller reopens the finding). */
  private async runWriterForFinding(
    workspaceId: string,
    model: ReturnType<ModelProvider['resolve']>,
    ref: ModelRef,
    context: RequirementsContext,
    finding: RequirementReviewItem,
    note: string | undefined,
    fragments: GroundingFragment[],
    sharedSpecExcerpts: string[],
    sharedWebResults: GroundingWebResult[],
  ): Promise<{ recommendation: string; fromStandard: string | null } | null> {
    const grounding: RecommendationGrounding = {
      fragments,
      specExcerpts: sharedSpecExcerpts,
      webResults: sharedWebResults,
    }
    try {
      const result = await generateText({
        model,
        system: WRITER_SYSTEM_PROMPT,
        prompt: buildRecommendationPrompt(context, [finding], grounding, note),
        temperature: 0.2,
        maxOutputTokens: 6000,
        // Provider-hosted web search when the model supports it (Anthropic/OpenAI); the
        // gateway-RAG `webResults` already folded into the prompt cover other providers.
        ...(providerWebSearchTools(ref.provider)
          ? { tools: providerWebSearchTools(ref.provider) }
          : {}),
        providerOptions: catFactoryObservability({ agentKind: 'requirements-writer', workspaceId }),
      })
      // Single-finding call: tolerate a missing/garbled echoed itemId rather than discarding a
      // valid suggestion (which would force-reopen the finding as if the Writer had failed).
      return coerceSingleRecommendation(extractJson(result.text), finding.id)
    } catch {
      // Best-effort per finding — a failure drops just this placeholder (the caller reopens it).
      return null
    }
  }

  private async mutateRecommendation(
    workspaceId: string,
    reviewId: string,
    recId: string,
    mutate: (rec: RequirementRecommendation, review: RequirementReview, now: number) => void,
  ): Promise<RequirementReview> {
    const review = assertFound(
      await this.repository.get(workspaceId, reviewId),
      this.entityName,
      reviewId,
    )
    const rec = review.recommendations.find((r) => r.id === recId)
    if (!rec) throw new ValidationError(`Recommendation '${recId}' not found`)
    const now = this.deps.clock.now()
    mutate(rec, review, now)
    rec.updatedAt = now
    review.updatedAt = now
    await this.repository.upsert(workspaceId, review)
    return review
  }

  /**
   * Read the in-repo `spec/`/`tech-spec/` overviews (via RepoFiles when wired) the Writer
   * grounds on. Gathered ONCE per batch (finding-independent) and reused across the per-finding
   * Writer calls. Best-effort — unwired / errors → an empty list.
   */
  private async gatherSpecExcerpts(workspaceId: string, block: Block): Promise<string[]> {
    const specExcerpts: string[] = []
    try {
      const ctx = await this.resolveRunRepoContext?.(workspaceId, block.id)
      if (ctx) {
        for (const path of ['spec/overview.md', 'tech-spec/overview.md']) {
          const file = await ctx.repo.getFile(path, ctx.baseBranch)
          if (file?.content) specExcerpts.push(`#### ${path}\n${file.content}`)
        }
      }
    } catch {
      // best-effort grounding
    }
    return specExcerpts
  }

  /**
   * Gateway-RAG web snippets for a recommendation batch (when web search is wired). Gathered
   * ONCE over the batch's finding titles — like the spec excerpts and fragments — so a batch of
   * N findings makes a single web-search call, not N. Best-effort — unwired / errors → an empty
   * list.
   */
  private async gatherWebResults(
    workspaceId: string,
    findingTitles: string[],
  ): Promise<GroundingWebResult[]> {
    if (!this.webSearch || findingTitles.length === 0) return []
    try {
      return await this.webSearch(workspaceId, findingTitles.join('; '))
    } catch {
      return []
    }
  }

  /**
   * Tell people the Requirement Writer finished a recommendation batch (so the human who walked
   * away from the window is summoned back to accept/reject). Best-effort, mirrors
   * {@link notifyFindings}; reuses the `requirement_review` notification type (the inbox routes it
   * to the same review window).
   */
  private async notifyRecommendationsReady(
    workspaceId: string,
    block: Block,
    count: number,
  ): Promise<void> {
    if (count <= 0 || !this.deps.notificationService) return
    try {
      await this.deps.notificationService.raise(workspaceId, {
        type: 'requirement_review',
        blockId: block.id,
        executionId: null,
        title: `Requirements recommendations: ${block.title}`,
        body: `The requirement writer prepared ${count} recommendation${
          count === 1 ? '' : 's'
        } to review.`,
        payload: {
          findingCount: count,
          ...(block.responsibleProductUserId
            ? { targetUserId: block.responsibleProductUserId }
            : {}),
        },
      })
    } catch {
      // Best-effort: the recommendations are already persisted.
    }
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
