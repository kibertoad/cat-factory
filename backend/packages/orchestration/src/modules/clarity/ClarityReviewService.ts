import type {
  Block,
  ClarityReview,
  RequirementConcernLevel,
  RequirementReviewItem,
} from '@cat-factory/kernel'
import type { ClarityReviewRepository } from '@cat-factory/kernel'
import { assertFound, DEFAULT_MAX_REQUIREMENT_ITERATIONS } from '@cat-factory/kernel'
import { CLARITY_REVIEW_SYSTEM_PROMPT, CLARITY_REWORK_SYSTEM_PROMPT } from '@cat-factory/agents'
import {
  type IterativeReviewDeps,
  IterativeReviewService,
  type ReviewCommon,
  type ReviewRepository,
} from '../review/IterativeReviewService.js'
import {
  type ClarityContext,
  buildClarityPrompt,
  buildClarityReworkPrompt,
  buildSeededClarityItems,
} from './clarity.logic.js'

export interface ClarityReviewServiceDependencies extends IterativeReviewDeps {
  clarityReviewRepository: ClarityReviewRepository
}

/** The extra per-call input the clarity reviewer threads into its context. */
interface ClarityContextInput {
  /** An upstream `bug-investigator` step's enriched prose report — the primary triage subject. */
  investigation?: string
}

/**
 * The clarity-review (bug-report triage) agent. A single LLM call triages a block's bug
 * report for fixability and raises findings, humans answer them, and a second LLM call folds
 * the answers into a clarified report. The iterative loop lives in
 * {@link IterativeReviewService}; this class supplies only the bug-report subject (optionally
 * enriched by an investigator), the prompts and the persisted document field
 * (`clarifiedReport`).
 */
export class ClarityReviewService extends IterativeReviewService<
  ClarityReview,
  ClarityContext,
  ClarityContextInput
> {
  protected readonly repository: ReviewRepository<ClarityReview>

  constructor(deps: ClarityReviewServiceDependencies) {
    super(deps)
    this.repository = deps.clarityReviewRepository
  }

  protected readonly entityName = 'Clarity review'
  protected readonly reviewerLabel = 'clarity reviewer'
  protected readonly reviewAgentKind = 'clarity-review'
  protected readonly reworkAgentKind = 'clarity-rework'
  protected readonly reviewSystemPrompt = CLARITY_REVIEW_SYSTEM_PROMPT
  protected readonly reworkSystemPrompt = CLARITY_REWORK_SYSTEM_PROMPT
  protected readonly reviewIdPrefix = 'clr'
  protected readonly itemIdPrefix = 'clri'
  protected readonly revisedNoun = 'revised bug report'
  protected readonly truncationMessage =
    'The reworked bug report was cut off before completion (model output limit reached). ' +
    'Try splitting this work into smaller tasks, then rework again.'
  protected readonly notificationType = 'clarity_review' as const
  protected readonly notificationSubject = 'The clarity reviewer'

  protected notificationTitle(block: Block): string {
    return `Bug-report triage: ${block.title}`
  }

  protected buildReviewPrompt(ctx: ClarityContext): string {
    return buildClarityPrompt(ctx)
  }

  protected buildReworkPrompt(ctx: ClarityContext, items: RequirementReviewItem[]): string {
    return buildClarityReworkPrompt(ctx, items)
  }

  protected applyIncorporatedDoc(ctx: ClarityContext, doc: string): void {
    ctx.clarifiedDoc = doc
  }

  protected applyFeedback(ctx: ClarityContext, feedback: string): void {
    ctx.reworkFeedback = feedback
  }

  protected readDoc(review: ClarityReview): string | null {
    return review.clarifiedReport
  }

  protected withDoc(review: ClarityReview, doc: string): ClarityReview {
    return { ...review, clarifiedReport: doc }
  }

  protected newReview(common: ReviewCommon): ClarityReview {
    return { ...common, clarifiedReport: null }
  }

  /**
   * Seed the FIRST clarity pass from an upstream `bug-investigator`'s structured triage —
   * DETERMINISTICALLY, with no reviewer LLM call and no model required (so it runs on every
   * runtime, wired model or not):
   *
   * - `clarity: 'clear'` → zero items → the shared dispose logic auto-passes (status
   *   `incorporated`), so the gate advances with no park and no notification.
   * - `clarity: 'needs_clarification'` → one blocking finding per question → the gate parks the
   *   run for the human, exactly as an LLM reviewer pass would (the questions came from the
   *   investigator instead of a second LLM). Re-review / incorporate later still use the model.
   *
   * Mirrors the requirements-review auto-pass pattern (see `IterativeReviewService.review`);
   * `model` is `null` because no model produced these items.
   */
  async seedReview(
    workspaceId: string,
    blockId: string,
    opts: {
      clarity: 'clear' | 'needs_clarification'
      questions: string[]
      maxIterations?: number
      concernThreshold?: RequirementConcernLevel
    },
  ): Promise<ClarityReview> {
    const block = assertFound(
      await this.deps.blockRepository.get(workspaceId, blockId),
      'Block',
      blockId,
    )
    const now = this.deps.clock.now()
    const items =
      opts.clarity === 'needs_clarification'
        ? buildSeededClarityItems(opts.questions, () => this.deps.idGenerator.next('clri'), now)
        : []
    return this.persistInitialReview(workspaceId, block, items, null, {
      maxIterations: opts.maxIterations ?? DEFAULT_MAX_REQUIREMENT_ITERATIONS,
      concernThreshold: opts.concernThreshold ?? 'none',
    })
  }

  /** Assemble the bug report under review (block + optional investigation). */
  protected async gatherContext(
    _workspaceId: string,
    block: Block,
    input: ClarityContextInput,
  ): Promise<ClarityContext> {
    return {
      block: { title: block.title, type: block.type, description: block.description },
      investigation: input.investigation,
    }
  }
}
