import type { Initiative, InitiativeQaStatus } from '@cat-factory/kernel'
import {
  assertFound,
  INITIATIVE_INTERVIEWER_AGENT_KIND,
  ValidationError,
} from '@cat-factory/kernel'
import type { InitiativeService } from '../initiative/InitiativeService.js'
import type { InitiativeInterviewService } from '../initiative/InitiativeInterviewService.js'
import { interviewAtCap } from '../initiative/initiative.logic.js'
import {
  InterviewGateController,
  type InterviewGateDeps,
  type InterviewGateKind,
} from './InterviewGateController.js'

// ---------------------------------------------------------------------------
// The interactive-planning INTERVIEWER gate. A thin specialisation of the shared
// {@link InterviewGateController} spine (the park/answer/resume/advance orchestration is
// inherited) — but ENTITY-NATIVE: the questions / answers / synthesized brief live directly on the
// `initiatives` entity (its `qa` + `interview` + goal/constraints/nonGoals fields) via
// InitiativeService's CAS `mutate`, not in a parallel session table. The interviewer LLM lives in
// InitiativeInterviewService. Because the initiative entity's own lifecycle isolates runs, this
// gate needs no per-run reset hook (contrast the document interviewer).
// ---------------------------------------------------------------------------

export interface InitiativeInterviewControllerDeps extends InterviewGateDeps {
  /** The interviewer LLM. Absent (or model-less) → the gate passes through (no interview). */
  interviewService?: InitiativeInterviewService
  initiativeService: InitiativeService
}

function initiativeInterviewKind(
  deps: InitiativeInterviewControllerDeps,
): InterviewGateKind<Initiative> {
  const { interviewService, initiativeService } = deps
  return {
    agentKind: INITIATIVE_INTERVIEWER_AGENT_KIND,
    entityName: 'Initiative',
    enabled: () => !!interviewService?.enabled,
    async runPass(workspaceId, _instance, block, opts) {
      const initiative = interviewService
        ? await initiativeService.getByBlock(workspaceId, block.id)
        : null
      if (!interviewService || !initiative) {
        // No interviewer wired, or no initiative entity to interview into — don't wedge the run;
        // just advance (the fresh-entry `enabled` guard normally handles the former).
        return 'advance'
      }
      const finalize = opts.proceed || interviewAtCap(initiative)
      const output = await interviewService.runInterview(workspaceId, block, initiative, {
        finalize,
      })
      if (output.kind === 'questions') {
        await initiativeService.recordInterviewQuestions(workspaceId, block.id, output.questions)
        return 'park'
      }
      // Converged: fold the synthesized brief onto the entity and advance to the analyst.
      await initiativeService.recordInterviewOutcome(workspaceId, block.id, {
        goal: output.goal,
        constraints: output.constraints,
        nonGoals: output.nonGoals,
      })
      return 'advance'
    },
    recordAnswer: (workspaceId, blockId, questionId, answer) =>
      initiativeService.recordInterviewAnswer(workspaceId, blockId, questionId, answer),
    current: (workspaceId, blockId) => initiativeService.getByBlock(workspaceId, blockId),
  }
}

export class InitiativeInterviewController extends InterviewGateController<Initiative> {
  private readonly interviewService?: InitiativeInterviewService
  private readonly initiativeService: InitiativeService
  private readonly blocks: InterviewGateDeps['blockRepository']

  constructor(deps: InitiativeInterviewControllerDeps) {
    super(deps, initiativeInterviewKind(deps))
    this.interviewService = deps.interviewService
    this.initiativeService = deps.initiativeService
    this.blocks = deps.blockRepository
  }

  /**
   * Mark one planning question `dismissed` ("not relevant") or reopen it. Like {@link answer}, a
   * pure entity write that does NOT resume the run — the human is still curating the question set;
   * they resume with continue/proceed. Part of the shared clarification surface (dismiss/recommend)
   * the planning window borrows from requirements review.
   */
  setQuestionStatus(
    workspaceId: string,
    blockId: string,
    questionId: string,
    status: InitiativeQaStatus,
  ): Promise<Initiative> {
    return this.requireInitiative(
      this.initiativeService.recordQuestionStatus(workspaceId, blockId, questionId, status),
      blockId,
    )
  }

  /**
   * Draft an AI-suggested answer for one pending question and persist it onto that question (the
   * "recommend something" action). Runs the interviewer LLM inline — a single short call, not the
   * requirements Writer's async batch — then records the suggestion; no run resume. Throws when no
   * interviewer model is wired (the SPA surfaces it), or when the question no longer exists.
   */
  async recommendAnswer(
    workspaceId: string,
    blockId: string,
    questionId: string,
  ): Promise<Initiative> {
    if (!this.interviewService?.enabled) {
      throw new ValidationError('No model is configured for the initiative interviewer')
    }
    const initiative = assertFound(
      await this.initiativeService.getByBlock(workspaceId, blockId),
      'Initiative',
      blockId,
    )
    const question = (initiative.qa ?? []).find((q) => q.id === questionId)
    if (!question) throw new ValidationError(`Unknown planning question '${questionId}'`)
    const block = assertFound(await this.blocks.get(workspaceId, blockId), 'Block', blockId)
    const suggestion = await this.interviewService.recommendAnswer(
      workspaceId,
      block,
      initiative,
      question.question,
    )
    return this.requireInitiative(
      this.initiativeService.recordQuestionRecommendation(
        workspaceId,
        blockId,
        questionId,
        suggestion,
      ),
      blockId,
    )
  }

  private async requireInitiative(
    entity: Promise<Initiative | null>,
    blockId: string,
  ): Promise<Initiative> {
    return assertFound(await entity, 'Initiative', blockId)
  }
}
