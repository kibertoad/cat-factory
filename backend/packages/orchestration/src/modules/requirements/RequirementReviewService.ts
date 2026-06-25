import type {
  Block,
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
  coerceRecommendations,
  extractJson,
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
   * Recommend grounded answers for a batch of findings the human marked "recommend something".
   * Marks those items `recommend_requested`, then runs the Requirement Writer LLM — grounded on
   * the block's best-practice fragments (FIRST), the in-repo `spec/`/`tech-spec/`, and web search
   * — and appends one `ready` recommendation per finding. NOT AI-reviewed; the human decides.
   * Runs in parallel with incorporation (the driver awaits both). Best-effort: a Writer failure
   * still leaves the items `recommend_requested` so the human can answer manually.
   */
  async recommend(
    workspaceId: string,
    reviewId: string,
    itemIds: string[],
    note?: string,
  ): Promise<RequirementReview> {
    const review = assertFound(
      await this.repository.get(workspaceId, reviewId),
      this.entityName,
      reviewId,
    )
    const block = assertFound(
      await this.deps.blockRepository.get(workspaceId, review.blockId),
      'Block',
      review.blockId,
    )
    const targetIds = new Set(itemIds)
    const findings = review.items.filter((i) => targetIds.has(i.id))
    if (findings.length === 0) return review

    const now = this.deps.clock.now()
    for (const item of review.items) {
      if (targetIds.has(item.id) && item.status !== 'dismissed') {
        item.status = 'recommend_requested'
        item.updatedAt = now
      }
    }

    const { modelProvider, ref } = await this.resolveModel(workspaceId, block)
    const context = await this.gatherContext(workspaceId, block)
    const fragments = (await this.resolveBlockFragments?.(workspaceId, block.id)) ?? []
    const grounding = await this.gatherGrounding(workspaceId, block, findings, fragments)

    let suggestions: Map<string, { recommendation: string; fromStandard: string | null }>
    try {
      const model = modelProvider.resolve(ref)
      const result = await generateText({
        model,
        system: WRITER_SYSTEM_PROMPT,
        prompt: buildRecommendationPrompt(context, findings, grounding, note),
        temperature: 0.2,
        maxOutputTokens: 6000,
        // Provider-hosted web search when the model supports it (Anthropic/OpenAI); the
        // gateway-RAG `webResults` already folded into the prompt cover other providers.
        ...(providerWebSearchTools(ref.provider)
          ? { tools: providerWebSearchTools(ref.provider) }
          : {}),
        providerOptions: catFactoryObservability({ agentKind: 'requirements-writer', workspaceId }),
      })
      suggestions = coerceRecommendations(extractJson(result.text))
    } catch (e) {
      throw new ValidationError(
        `The requirement writer (${ref.provider}:${ref.model}) failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      )
    }

    const fragmentById = new Map(fragments.map((f) => [f.id, f]))
    const recommendations = [...review.recommendations]
    for (const finding of findings) {
      const suggestion = suggestions.get(finding.id)
      if (!suggestion) continue
      const standard = suggestion.fromStandard ? fragmentById.get(suggestion.fromStandard) : undefined
      recommendations.push({
        id: this.deps.idGenerator.next('rec'),
        sourceFinding: { title: finding.title, detail: finding.detail },
        recommendedText: suggestion.recommendation,
        status: 'ready',
        note: note?.trim() || null,
        groundedInFragment: standard ? { id: standard.id, title: standard.title } : null,
        createdAt: now,
        updatedAt: now,
      })
    }
    const updated: RequirementReview = { ...review, recommendations, updatedAt: now }
    await this.repository.upsert(workspaceId, updated)
    return updated
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
      const item = review.items.find(
        (i) => i.title === rec.sourceFinding.title && i.detail === rec.sourceFinding.detail,
      )
      if (item) {
        item.reply = rec.recommendedText
        item.status = 'answered'
        item.updatedAt = now
      }
    })
  }

  /** Reject a recommendation (the human will dismiss / answer manually / re-request). */
  async rejectRecommendation(
    workspaceId: string,
    reviewId: string,
    recId: string,
  ): Promise<RequirementReview> {
    return this.mutateRecommendation(workspaceId, reviewId, recId, (rec) => {
      rec.status = 'rejected'
    })
  }

  /**
   * Re-request a single recommendation with a "do it differently" note: re-runs the Writer for
   * just that finding and replaces the suggestion text (back to `ready`).
   */
  async reRequestRecommendation(
    workspaceId: string,
    reviewId: string,
    recId: string,
    note: string,
  ): Promise<RequirementReview> {
    const review = assertFound(
      await this.repository.get(workspaceId, reviewId),
      this.entityName,
      reviewId,
    )
    const rec = review.recommendations.find((r) => r.id === recId)
    if (!rec) throw new ValidationError(`Recommendation '${recId}' not found`)
    const item = review.items.find(
      (i) => i.title === rec.sourceFinding.title && i.detail === rec.sourceFinding.detail,
    )
    if (!item) throw new ValidationError('The finding this recommendation answers no longer exists')

    const block = assertFound(
      await this.deps.blockRepository.get(workspaceId, review.blockId),
      'Block',
      review.blockId,
    )
    const { modelProvider, ref } = await this.resolveModel(workspaceId, block)
    const context = await this.gatherContext(workspaceId, block)
    const fragments = (await this.resolveBlockFragments?.(workspaceId, block.id)) ?? []
    const grounding = await this.gatherGrounding(workspaceId, block, [item], fragments)
    let suggestions: Map<string, { recommendation: string; fromStandard: string | null }>
    try {
      const model = modelProvider.resolve(ref)
      const result = await generateText({
        model,
        system: WRITER_SYSTEM_PROMPT,
        prompt: buildRecommendationPrompt(context, [item], grounding, note),
        temperature: 0.2,
        maxOutputTokens: 6000,
        ...(providerWebSearchTools(ref.provider)
          ? { tools: providerWebSearchTools(ref.provider) }
          : {}),
        providerOptions: catFactoryObservability({ agentKind: 'requirements-writer', workspaceId }),
      })
      suggestions = coerceRecommendations(extractJson(result.text))
    } catch (e) {
      throw new ValidationError(
        `The requirement writer (${ref.provider}:${ref.model}) failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      )
    }
    const suggestion = suggestions.get(item.id)
    const now = this.deps.clock.now()
    if (suggestion) {
      const fragmentById = new Map(fragments.map((f) => [f.id, f]))
      const standard = suggestion.fromStandard ? fragmentById.get(suggestion.fromStandard) : undefined
      rec.recommendedText = suggestion.recommendation
      rec.groundedInFragment = standard ? { id: standard.id, title: standard.title } : null
    }
    rec.status = 'ready'
    rec.note = note.trim() || null
    rec.updatedAt = now
    const updated: RequirementReview = { ...review, updatedAt: now }
    await this.repository.upsert(workspaceId, updated)
    return updated
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
   * Gather the Writer's grounding material: best-practice fragments (passed in), in-repo
   * `spec/`/`tech-spec/` overviews (via RepoFiles when wired), and gateway-RAG web snippets
   * (when wired). All best-effort — any source that errors or is unwired is simply omitted.
   */
  private async gatherGrounding(
    workspaceId: string,
    block: Block,
    findings: RequirementReviewItem[],
    fragments: GroundingFragment[],
  ): Promise<RecommendationGrounding> {
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
    let webResults: GroundingWebResult[] = []
    if (this.webSearch) {
      try {
        const query = findings.map((f) => f.title).join('; ')
        webResults = await this.webSearch(workspaceId, query)
      } catch {
        webResults = []
      }
    }
    return { fragments, specExcerpts, webResults }
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
