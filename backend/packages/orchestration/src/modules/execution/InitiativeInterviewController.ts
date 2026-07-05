import type { Initiative } from '@cat-factory/kernel'
import { INITIATIVE_INTERVIEWER_AGENT_KIND } from '@cat-factory/kernel'
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
  constructor(deps: InitiativeInterviewControllerDeps) {
    super(deps, initiativeInterviewKind(deps))
  }
}
