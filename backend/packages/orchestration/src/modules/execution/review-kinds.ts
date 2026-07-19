import type {
  BlockRepository,
  BrainstormSession,
  BrainstormStage,
  ClarityReview,
  ExecutionEventPublisher,
  ExecutionInstance,
  ExecutionRepository,
  IssueWritebackProvider,
  RequirementReview,
} from '@cat-factory/kernel'
import { assertFound, ConflictError } from '@cat-factory/kernel'
import { bugInvestigation } from '@cat-factory/agents'
import type { ReviewKind } from './ReviewGateController.js'
import type { RequirementReviewService } from '../requirements/RequirementReviewService.js'
import type { ClarityReviewService } from '../clarity/ClarityReviewService.js'
import type { BrainstormService } from '../brainstorm/BrainstormService.js'
import {
  BUG_INVESTIGATOR_AGENT_KIND,
  CLARITY_REVIEW_AGENT_KIND,
  REQUIREMENTS_REVIEW_AGENT_KIND,
} from './ci.logic.js'

/**
 * Collaborators the {@link ReviewKind} builders close over. Extracted out of
 * `ExecutionService` (which used to build the kinds as private methods) so each subject's
 * differentiators live beside each other instead of bloating the engine; the optional
 * services keep the exact same pass-through semantics (an unwired service throws the same
 * 409 the inline reviewer raised before the {@link ReviewGateController} extraction).
 */
export interface ReviewKindDeps {
  events: ExecutionEventPublisher
  blockRepository: BlockRepository
  executionRepository: ExecutionRepository
  requirementReviewService?: RequirementReviewService
  clarityReviewService?: ClarityReviewService
  brainstormServices?: Record<BrainstormStage, BrainstormService>
  issueWriteback?: IssueWritebackProvider
}

/**
 * The requirements subject for the review gate: closures over the requirements reviewer
 * service. The service-not-configured guard preserves the exact 409 the inline reviewer
 * raised before this extraction.
 */
export function buildRequirementsKind(deps: ReviewKindDeps): ReviewKind<RequirementReview> {
  const require = (): RequirementReviewService => {
    if (!deps.requirementReviewService?.enabled) {
      throw new ConflictError('The requirements reviewer is not configured')
    }
    return deps.requirementReviewService
  }
  return {
    agentKind: REQUIREMENTS_REVIEW_AGENT_KIND,
    entityName: 'Requirement review',
    enabled: () => !!deps.requirementReviewService?.enabled,
    getForBlock: (ws, blockId) => require().getForBlock(ws, blockId),
    review: (ws, block, preset) =>
      require().review(ws, block.id, {
        maxIterations: preset.maxRequirementIterations,
        concernThreshold: preset.maxRequirementConcernAllowed,
      }),
    reReview: (ws, reviewId, preset) =>
      require().reReview(ws, reviewId, { concernThreshold: preset.maxRequirementConcernAllowed }),
    incorporate: async (ws, _blockId, reviewId, feedback) => {
      await require().incorporate(ws, reviewId, { feedback })
    },
    markIncorporated: (ws, reviewId) => require().markIncorporated(ws, reviewId),
    markReReviewing: (ws, reviewId) => require().markReReviewing(ws, reviewId),
    markIncorporating: (ws, reviewId) => require().markIncorporating(ws, reviewId),
    grantExtraRound: (ws, reviewId) => require().grantExtraRound(ws, reviewId),
    prepareRecommendations: (ws, reviewId, items) =>
      require().prepareRecommendations(ws, reviewId, items),
    markRecommendationPending: (ws, reviewId, recId, note) =>
      require().markRecommendationPending(ws, reviewId, recId, note),
    fillRecommendations: async (ws, blockId) => {
      const svc = require()
      const review = assertFound(await svc.getForBlock(ws, blockId), 'Requirement review', blockId)
      await svc.fillPendingRecommendations(ws, review.id, {
        onProgress: (r) => deps.events.requirementReviewChanged?.(ws, r) ?? Promise.resolve(),
      })
      return assertFound(await svc.getForBlock(ws, blockId), 'Requirement review', blockId)
    },
    autoRecommend: async (ws, blockId) => {
      const svc = require()
      const review = assertFound(await svc.getForBlock(ws, blockId), 'Requirement review', blockId)
      await svc.autoRecommend(ws, review.id, {
        onProgress: (r) => deps.events.requirementReviewChanged?.(ws, r) ?? Promise.resolve(),
      })
    },
    emit: (ws, review) => deps.events.requirementReviewChanged?.(ws, review) ?? Promise.resolve(),
  }
}

/**
 * The clarity (bug-report triage) subject for the review gate: threads any upstream
 * `bug-investigator` output into the reviewer/incorporation context, otherwise identical to
 * the requirements kind.
 */
export function buildClarityKind(deps: ReviewKindDeps): ReviewKind<ClarityReview> {
  const require = (): ClarityReviewService => {
    if (!deps.clarityReviewService) {
      throw new ConflictError('The clarity reviewer is not configured')
    }
    return deps.clarityReviewService
  }
  return {
    agentKind: CLARITY_REVIEW_AGENT_KIND,
    // Enabled whenever the clarity STORE is wired — the bug-triage seed/auto-pass path is
    // deterministic (driven by the upstream investigator's structured triage) and needs no
    // reviewer model, so the gate must activate even with no model configured. The LLM
    // review/incorporate/re-review paths still resolve their own model (and degrade gracefully
    // when unwired: no investigation + no model ⇒ the review closure auto-passes).
    entityName: 'Clarity review',
    enabled: () => !!deps.clarityReviewService,
    getForBlock: (ws, blockId) => require().getForBlock(ws, blockId),
    review: async (ws, block, preset) => {
      const svc = require()
      const structured = await structuredInvestigationForBlock(deps, ws, block.id)
      let review: ClarityReview
      if (structured) {
        // An upstream structured `bug-investigator`: seed the gate from its triage — NO reviewer
        // LLM. `clear` → auto-pass; `needs_clarification` → one blocking finding per question.
        // The investigator explicitly asked for clarification, so those questions ALWAYS park
        // for a human — the requirements-review concern tolerance (`maxRequirementConcernAllowed`,
        // which governs the requirements reviewer, not bug triage) must not silently auto-pass
        // them — hence a fixed `none` threshold here rather than the preset's.
        review = await svc.seedReview(ws, block.id, {
          clarity: structured.clarity,
          questions: structured.questions,
          maxIterations: preset.maxRequirementIterations,
          concernThreshold: 'none',
        })
      } else if (!svc.enabled) {
        // No structured investigation and no reviewer model: nothing to review against, so
        // auto-pass (equivalent to the old pass-through when the reviewer wasn't configured).
        review = await svc.seedReview(ws, block.id, {
          clarity: 'clear',
          questions: [],
          maxIterations: preset.maxRequirementIterations,
          concernThreshold: preset.maxRequirementConcernAllowed,
        })
      } else {
        review = await svc.review(ws, block.id, {
          maxIterations: preset.maxRequirementIterations,
          concernThreshold: preset.maxRequirementConcernAllowed,
          investigation: await investigationForBlock(deps, ws, block.id),
        })
      }
      // Whenever the gate parks with open questions — from the deterministic seed OR the LLM
      // reviewer — best-effort echo them onto the linked tracker issue (answers still arrive
      // in-app). A settled/auto-passed review echoes nothing; a tracker outage never fails the run.
      await echoClarityQuestions(deps, ws, block.id, review)
      return review
    },
    reReview: async (ws, reviewId, preset) => {
      const svc = require()
      // No reviewer model wired: a re-review can't run, so settle the loop (converge) instead of
      // throwing — the deterministic seed path can reach a park with no model configured.
      if (!svc.enabled) return svc.markIncorporated(ws, reviewId)
      return svc.reReview(ws, reviewId, { concernThreshold: preset.maxRequirementConcernAllowed })
    },
    incorporate: async (ws, blockId, reviewId, feedback) => {
      const svc = require()
      // No reviewer model: can't LLM-fold the answers into a clarified report, so settle the
      // review as-is (the run advances on the raw report + the recorded answers) instead of
      // throwing — keeps the model-free seed path resolvable.
      if (!svc.enabled) {
        await svc.markIncorporated(ws, reviewId)
        return
      }
      const investigation = await investigationForBlock(deps, ws, blockId)
      await svc.incorporate(ws, reviewId, { feedback, investigation })
    },
    markIncorporated: (ws, reviewId) => require().markIncorporated(ws, reviewId),
    markReReviewing: (ws, reviewId) => require().markReReviewing(ws, reviewId),
    markIncorporating: (ws, reviewId) => require().markIncorporating(ws, reviewId),
    grantExtraRound: (ws, reviewId) => require().grantExtraRound(ws, reviewId),
    emit: (ws, review) => deps.events.clarityReviewChanged?.(ws, review) ?? Promise.resolve(),
  }
}

/**
 * A brainstorm (structured-dialogue) subject for the review gate, parameterised by stage.
 * Otherwise identical to the requirements kind — the service handles its own upstream context
 * (the architecture stage seeds from the refined requirements). The brainstorm services
 * resolve their model exactly like the requirements reviewer, so the cap knobs are reused.
 */
export function buildBrainstormKind(
  stage: BrainstormStage,
  agentKind: string,
  deps: ReviewKindDeps,
): ReviewKind<BrainstormSession> {
  const require = (): BrainstormService => {
    const svc = deps.brainstormServices?.[stage]
    if (!svc?.enabled) throw new ConflictError('The brainstorm agent is not configured')
    return svc
  }
  return {
    agentKind,
    entityName: 'Brainstorm session',
    enabled: () => !!deps.brainstormServices?.[stage]?.enabled,
    getForBlock: (ws, blockId) => require().getForBlock(ws, blockId),
    review: (ws, block, preset) =>
      require().review(ws, block.id, {
        maxIterations: preset.maxRequirementIterations,
        concernThreshold: preset.maxRequirementConcernAllowed,
      }),
    reReview: (ws, reviewId, preset) =>
      require().reReview(ws, reviewId, { concernThreshold: preset.maxRequirementConcernAllowed }),
    incorporate: async (ws, _blockId, reviewId, feedback) => {
      await require().incorporate(ws, reviewId, { feedback })
    },
    markIncorporated: (ws, reviewId) => require().markIncorporated(ws, reviewId),
    markReReviewing: (ws, reviewId) => require().markReReviewing(ws, reviewId),
    markIncorporating: (ws, reviewId) => require().markIncorporating(ws, reviewId),
    grantExtraRound: (ws, reviewId) => require().grantExtraRound(ws, reviewId),
    emit: (ws, session) => deps.events.brainstormSessionChanged?.(ws, session) ?? Promise.resolve(),
  }
}

// ---- clarity-review context helpers (bug-report triage) ------------------
// The clarity gate triages a block's bug report — optionally enriched by an upstream
// `bug-investigator` step's prose output — through the SAME ReviewGateController flow as
// requirements; these helpers resolve that investigator output as the triage subject,
// threaded into the clarity {@link ReviewKind}.

/** The latest `bug-investigator` step output on a run (the triage subject), or undefined. */
function investigationFor(instance: ExecutionInstance): string | undefined {
  for (let i = instance.steps.length - 1; i >= 0; i--) {
    const s = instance.steps[i]!
    if (s.agentKind === BUG_INVESTIGATOR_AGENT_KIND && s.output) return s.output
  }
  return undefined
}

/** Resolve a block's investigator output via its current execution (off the gate path). */
async function investigationForBlock(
  deps: ReviewKindDeps,
  workspaceId: string,
  blockId: string,
): Promise<string | undefined> {
  const block = await deps.blockRepository.get(workspaceId, blockId)
  if (!block?.executionId) return undefined
  const instance = await deps.executionRepository.get(workspaceId, block.executionId)
  return instance ? investigationFor(instance) : undefined
}

/**
 * The latest `bug-investigator` step's STRUCTURED triage on a run — its `clarity` verdict +
 * `questions` — parsed leniently from `step.custom`. Drives the clarity gate's seed/auto-pass
 * (see {@link buildClarityKind}): a structured investigator upstream means the gate seeds its
 * findings from `questions` (or auto-passes on `clarity === 'clear'`) instead of running its
 * own reviewer LLM. Undefined when no investigator ran or its result wasn't structured (an
 * older prose investigator, or an unparseable reply) — the gate then falls back to the LLM path.
 */
function structuredInvestigationFor(
  instance: ExecutionInstance,
): { clarity: 'clear' | 'needs_clarification'; questions: string[] } | undefined {
  for (let i = instance.steps.length - 1; i >= 0; i--) {
    const s = instance.steps[i]!
    if (s.agentKind !== BUG_INVESTIGATOR_AGENT_KIND || s.custom === undefined) continue
    const parsed = bugInvestigation.safeParse(s.custom)
    if (!parsed) return undefined
    return { clarity: parsed.clarity, questions: parsed.questions }
  }
  return undefined
}

/** Resolve a block's structured investigator triage via its current execution. */
async function structuredInvestigationForBlock(
  deps: ReviewKindDeps,
  workspaceId: string,
  blockId: string,
): Promise<{ clarity: 'clear' | 'needs_clarification'; questions: string[] } | undefined> {
  const block = await deps.blockRepository.get(workspaceId, blockId)
  if (!block?.executionId) return undefined
  const instance = await deps.executionRepository.get(workspaceId, block.executionId)
  return instance ? structuredInvestigationFor(instance) : undefined
}

/**
 * Best-effort echo of a parked clarity review's open questions onto the block's linked tracker
 * issue (see {@link IssueWritebackProvider.postQuestions}). Fires for BOTH the deterministic
 * investigator seed and the LLM reviewer, so identical human-parked states behave the same. A
 * settled/auto-passed review (status `incorporated`) or one with no open items echoes nothing,
 * and a tracker outage never fails the run.
 */
async function echoClarityQuestions(
  deps: ReviewKindDeps,
  workspaceId: string,
  blockId: string,
  review: ClarityReview,
): Promise<void> {
  if (!deps.issueWriteback || review.status === 'incorporated') return
  const questions = review.items.filter((i) => i.status === 'open').map((i) => i.detail)
  if (questions.length === 0) return
  await deps.issueWriteback.postQuestions(workspaceId, blockId, questions).catch(() => {})
}
