import type {
  Block,
  BrainstormSession,
  BrainstormStage,
  RequirementReviewItem,
} from '@cat-factory/kernel'
import type { BrainstormSessionRepository } from '@cat-factory/kernel'
import {
  ARCHITECTURE_BRAINSTORM_REWORK_SYSTEM_PROMPT,
  ARCHITECTURE_BRAINSTORM_SYSTEM_PROMPT,
  REQUIREMENTS_BRAINSTORM_REWORK_SYSTEM_PROMPT,
  REQUIREMENTS_BRAINSTORM_SYSTEM_PROMPT,
} from '@cat-factory/agents'
import {
  type IterativeReviewDeps,
  IterativeReviewService,
  type ReviewCommon,
  type ReviewRepository,
} from '../review/IterativeReviewService.js'
import {
  type BrainstormContext,
  buildBrainstormPrompt,
  buildBrainstormReworkPrompt,
} from './brainstorm.logic.js'

export interface BrainstormServiceDependencies extends IterativeReviewDeps {
  brainstormSessionRepository: BrainstormSessionRepository
  /** Which dialogue this instance drives. One service instance per stage shares the repo. */
  stage: BrainstormStage
  /**
   * Resolve the requirements refined in prior stages (a requirements review's incorporated
   * doc, or a requirements-brainstorm's converged direction) as the architecture stage's
   * seed. Consulted only for the `architecture` stage. Optional — unwired (tests / the
   * requirements stage) ⇒ the agent seeds from the raw description.
   */
  resolveRefinedRequirements?: (workspaceId: string, blockId: string) => Promise<string | undefined>
}

/**
 * The brainstorm (structured-dialogue) agent: a single LLM call PROPOSES a handful of
 * options with explicit trade-offs (raised as review items), a human picks / steers / dismisses
 * them, and a second LLM call folds the picks into ONE converged direction. The whole iterative
 * loop lives in {@link IterativeReviewService}; this class supplies only the brainstorm subject,
 * the per-stage prompts and the persisted document field (`convergedDirection`).
 *
 * One instance per {@link BrainstormStage} (they share the underlying repository through a thin
 * stage-bound adapter): a block may have a live `requirements` AND a live `architecture` session
 * at once, so the repo is keyed by (block, stage) while {@link IterativeReviewService} stays
 * block-keyed.
 */
export class BrainstormService extends IterativeReviewService<
  BrainstormSession,
  BrainstormContext
> {
  protected readonly repository: ReviewRepository<BrainstormSession>
  private readonly stage: BrainstormStage
  private readonly resolveRefinedRequirements?: (
    workspaceId: string,
    blockId: string,
  ) => Promise<string | undefined>

  constructor(deps: BrainstormServiceDependencies) {
    super(deps)
    this.stage = deps.stage
    this.resolveRefinedRequirements = deps.resolveRefinedRequirements
    const repo = deps.brainstormSessionRepository
    const stage = deps.stage
    // Adapt the (block, stage)-keyed repository to the block-keyed ReviewRepository the base
    // class drives: this instance pins its stage on every lookup / delete.
    this.repository = {
      getByBlock: (ws, blockId) => repo.getByBlockStage(ws, blockId, stage),
      get: (ws, id) => repo.get(ws, id),
      upsert: (ws, session) => repo.upsert(ws, session),
      deleteByBlock: (ws, blockId) => repo.deleteByBlockStage(ws, blockId, stage),
    }
  }

  protected get entityName(): string {
    return this.stage === 'architecture' ? 'Architecture brainstorm' : 'Requirements brainstorm'
  }
  protected get reviewerLabel(): string {
    return this.stage === 'architecture'
      ? 'architecture brainstorm agent'
      : 'requirements brainstorm agent'
  }
  protected get reviewAgentKind(): string {
    return this.stage === 'architecture' ? 'architecture-brainstorm' : 'requirements-brainstorm'
  }
  protected get reworkAgentKind(): string {
    return this.stage === 'architecture'
      ? 'architecture-brainstorm-rework'
      : 'requirements-brainstorm-rework'
  }
  protected get reviewSystemPrompt(): string {
    return this.stage === 'architecture'
      ? ARCHITECTURE_BRAINSTORM_SYSTEM_PROMPT
      : REQUIREMENTS_BRAINSTORM_SYSTEM_PROMPT
  }
  protected get reworkSystemPrompt(): string {
    return this.stage === 'architecture'
      ? ARCHITECTURE_BRAINSTORM_REWORK_SYSTEM_PROMPT
      : REQUIREMENTS_BRAINSTORM_REWORK_SYSTEM_PROMPT
  }
  protected get reviewIdPrefix(): string {
    return this.stage === 'architecture' ? 'abs' : 'rbs'
  }
  protected get itemIdPrefix(): string {
    return this.stage === 'architecture' ? 'absi' : 'rbsi'
  }
  protected get revisedNoun(): string {
    return this.stage === 'architecture' ? 'technical approach' : 'requirements direction'
  }
  protected get truncationMessage(): string {
    return (
      `The brainstormed ${this.revisedNoun} was cut off before completion (model output ` +
      'limit reached). Try splitting this work into smaller tasks, then incorporate again.'
    )
  }
  protected readonly notificationType = 'requirement_review' as const
  protected get notificationSubject(): string {
    return this.stage === 'architecture'
      ? 'The architecture brainstorm'
      : 'The requirements brainstorm'
  }

  protected notificationTitle(block: Block): string {
    const label =
      this.stage === 'architecture' ? 'Architecture brainstorm' : 'Requirements brainstorm'
    return `${label}: ${block.title}`
  }

  protected buildReviewPrompt(ctx: BrainstormContext): string {
    return buildBrainstormPrompt(ctx)
  }

  protected buildReworkPrompt(ctx: BrainstormContext, items: RequirementReviewItem[]): string {
    return buildBrainstormReworkPrompt(ctx, items)
  }

  protected applyIncorporatedDoc(ctx: BrainstormContext, doc: string): void {
    ctx.convergedDoc = doc
  }

  protected applyFeedback(ctx: BrainstormContext, feedback: string): void {
    ctx.reworkFeedback = feedback
  }

  protected readDoc(session: BrainstormSession): string | null {
    return session.convergedDirection
  }

  protected withDoc(session: BrainstormSession, doc: string): BrainstormSession {
    return { ...session, convergedDirection: doc }
  }

  protected newReview(common: ReviewCommon): BrainstormSession {
    return { ...common, stage: this.stage, convergedDirection: null }
  }

  /** Assemble the brainstorm subject for this stage (+ the refined requirements for architecture). */
  protected async gatherContext(workspaceId: string, block: Block): Promise<BrainstormContext> {
    const refinedRequirements =
      this.stage === 'architecture'
        ? await this.resolveRefinedRequirements?.(workspaceId, block.id)
        : undefined
    return {
      block: { title: block.title, type: block.type, description: block.description },
      stage: this.stage,
      ...(refinedRequirements ? { refinedRequirements } : {}),
    }
  }
}
