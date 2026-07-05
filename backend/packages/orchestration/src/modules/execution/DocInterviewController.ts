import type {
  DocInterviewSession,
  ExecutionEventPublisher,
  ExecutionInstance,
} from '@cat-factory/kernel'
import { DOC_INTERVIEWER_AGENT_KIND } from '@cat-factory/kernel'
import type {
  DocInterviewPriorOutput,
  DocInterviewService,
} from '../docInterview/DocInterviewService.js'
import { docInterviewAtCap, newDocInterviewSession } from '../docInterview/doc-interview.logic.js'
import {
  InterviewGateController,
  type InterviewGateDeps,
  type InterviewGateKind,
} from './InterviewGateController.js'

// ---------------------------------------------------------------------------
// The interactive document-review INTERVIEWER gate (WS5). A thin specialisation of the shared
// {@link InterviewGateController} spine: the park/answer/resume/advance orchestration is inherited,
// and this file supplies only the doc differentiators through a {@link InterviewGateKind} strategy.
// Unlike the entity-native planning interviewer, a document task has no owning row, so the
// transcript lives in its own `doc_interview_sessions` table (via DocInterviewService, which owns
// the inline LLM + the session persistence), the loop emits a live `docInterview` event, and a
// re-run CLEARS the block's prior session so it starts a clean interview.
// ---------------------------------------------------------------------------

export interface DocInterviewControllerDeps extends InterviewGateDeps {
  events: ExecutionEventPublisher
  /** The interviewer LLM + session store. Absent (or model-less) → the gate passes through. */
  docInterviewService?: DocInterviewService
}

/** The completed prior steps' outputs, so the interviewer can read the outline / research. */
function priorOutputs(instance: ExecutionInstance): DocInterviewPriorOutput[] {
  return instance.steps
    .slice(0, instance.currentStep)
    .filter((s) => s.output)
    .map((s) => ({ agentKind: s.agentKind, output: s.output! }))
}

function docInterviewKind(
  deps: DocInterviewControllerDeps,
): InterviewGateKind<DocInterviewSession> {
  const service = deps.docInterviewService
  const emit = (workspaceId: string, session: DocInterviewSession): Promise<void> =>
    deps.events.docInterviewChanged?.(workspaceId, session) ?? Promise.resolve()
  return {
    agentKind: DOC_INTERVIEWER_AGENT_KIND,
    entityName: 'DocInterviewSession',
    enabled: () => !!service?.enabled,
    // Drop the block's prior session on a fresh run so a re-run interviews from scratch rather
    // than reusing a stale (often converged / at-cap) session and its old answers.
    resetForFreshRun: (workspaceId, blockId) =>
      service?.clearForBlock(workspaceId, blockId) ?? Promise.resolve(),
    async runPass(workspaceId, instance, block, opts) {
      if (!service) return 'advance'
      const session = await service.getByBlock(workspaceId, block.id)
      const finalize = opts.proceed || (session ? docInterviewAtCap(session) : false)
      const { output, model } = await service.runInterview(
        workspaceId,
        block,
        // No live session yet (fresh entry): a throwaway empty session for the prompt digest.
        session ?? newDocInterviewSession('', block.id, 0, 0),
        { finalize, priorOutputs: priorOutputs(instance) },
      )
      if (output.kind === 'questions') {
        const updated = await service.recordQuestions(
          workspaceId,
          block.id,
          output.questions,
          model,
        )
        await emit(workspaceId, updated)
        return 'park'
      }
      // Converged: fold the synthesized brief onto the session and advance to the writer.
      const done = await service.recordOutcome(workspaceId, block.id, output.brief, model)
      if (done) await emit(workspaceId, done)
      return 'advance'
    },
    async recordAnswer(workspaceId, blockId, questionId, answer) {
      if (!service) return null
      const updated = await service.recordAnswer(workspaceId, blockId, questionId, answer)
      if (updated) await emit(workspaceId, updated)
      return updated
    },
    current: (workspaceId, blockId) =>
      service ? service.getByBlock(workspaceId, blockId) : Promise.resolve(null),
  }
}

export class DocInterviewController extends InterviewGateController<DocInterviewSession> {
  constructor(deps: DocInterviewControllerDeps) {
    super(deps, docInterviewKind(deps))
  }
}
