import type {
  AgentRunContext,
  ExecutionInstance,
  StepCompletionResolver,
} from '@cat-factory/kernel'
import type { AdvanceResult } from '../execution/advance.js'
import type {
  StepCompletionInterceptor,
  StepHandler,
  StepHandlerContext,
} from '../execution/step-handler-registry.js'
import type { ResearchStepController } from './ResearchStepController.js'

// The research step's three engine registrations, beside the controller they delegate to so the
// dispatcher's registry file only spreads them in.

/** The agent kind a research project's run dispatches. */
export const PROJECT_RESEARCHER_STEP_KIND = 'project-researcher'

export interface ResearchRegistrationDeps {
  researchStep?: ResearchStepController
  handleAgentStep: (
    ctx: StepHandlerContext,
    dispatchKind?: string,
    augmentContext?: (context: AgentRunContext) => void,
  ) => Promise<AdvanceResult>
  /** Persist and publish the run, so a step mutation survives the park that reloads it. */
  persistInstance: (workspaceId: string, instance: ExecutionInstance) => Promise<void>
}

/**
 * Resolve a research step's brief before the ordinary container dispatch: claim the task's
 * findings sequence on its first dispatch, fix its questions on the step, and hand the agent the
 * definition, what is already known and any checkpoint. Unwired research persistence leaves the
 * step to the fallthrough, whose dispatch then refuses for want of a brief.
 */
export function researchStepHandler(d: ResearchRegistrationDeps): StepHandler {
  return {
    kind: 'research',
    order: 179,
    canHandle: ({ step }) => !!d.researchStep && step.agentKind === PROJECT_RESEARCHER_STEP_KIND,
    handle: async (ctx) => {
      const research = await d.researchStep!.prepare(ctx.step, ctx.block)
      return d.handleAgentStep(ctx, undefined, (context) => {
        context.research = research
      })
    },
  }
}

/**
 * The research agent stopped to ask a person for a credential: checkpoint its partial findings on
 * the step, persist, and raise the refusal the credential-wait guard parks the step on. The
 * resumed dispatch starts from the checkpoint, and the task still writes one revision.
 */
export function researchCredentialInterceptor(
  d: ResearchRegistrationDeps,
): StepCompletionInterceptor {
  return {
    kind: 'research-credential',
    order: 120,
    canIntercept: ({ step, result }) =>
      !!d.researchStep &&
      step.agentKind === PROJECT_RESEARCHER_STEP_KIND &&
      result.credentialRequest !== undefined,
    intercept: async ({ workspaceId, instance, step, result }) => {
      const refusal = await d.researchStep!.checkpoint(step, result)
      await d.persistInstance(workspaceId, instance)
      throw refusal
    },
  }
}

/** Record the research task's findings revision and render the step's output from it. */
export function researchFindingsResolver(d: ResearchRegistrationDeps): StepCompletionResolver {
  return {
    kind: PROJECT_RESEARCHER_STEP_KIND,
    phase: 'post-completion',
    resolve: async ({ workspaceId, instance, step, result }) => {
      if (!d.researchStep) return
      return d.researchStep.record(workspaceId, step, instance.blockId, result)
    },
  }
}
