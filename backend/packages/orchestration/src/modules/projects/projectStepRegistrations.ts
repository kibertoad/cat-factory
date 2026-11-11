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
import type { ProjectStepController } from './ProjectStepController.js'

// A project task's three engine registrations, beside the controller they delegate to so the
// dispatcher's registry file only spreads them in. They claim the step of every agent kind a
// registered project kind module dispatches.

export interface ProjectRegistrationDeps {
  projectStep?: ProjectStepController
  handleAgentStep: (
    ctx: StepHandlerContext,
    dispatchKind?: string,
    augmentContext?: (context: AgentRunContext) => void,
  ) => Promise<AdvanceResult>
  /** Persist and publish the run, so a step mutation survives the park that reloads it. */
  persistInstance: (workspaceId: string, instance: ExecutionInstance) => Promise<void>
}

/**
 * Resolve a project step's brief before the ordinary container dispatch: claim the task's outcome
 * sequence on its first dispatch, fix the kind's plan on the step, and hand the agent the brief.
 * Unwired project persistence leaves the step to the fallthrough, whose dispatch then refuses
 * for want of a brief.
 */
export function projectStepHandler(d: ProjectRegistrationDeps): StepHandler {
  return {
    kind: 'project',
    order: 179,
    canHandle: ({ step }) => !!d.projectStep?.handles(step.agentKind),
    handle: async (ctx) => {
      const project = await d.projectStep!.prepare(ctx.step, ctx.block)
      return d.handleAgentStep(ctx, undefined, (context) => {
        context.project = project
      })
    },
  }
}

/**
 * The agent stopped to ask a person for a credential: checkpoint what it produced on the step,
 * persist, and raise the refusal the credential-wait guard parks the step on. The resumed dispatch
 * starts from the checkpoint, and the task still writes one outcome.
 */
export function projectCredentialInterceptor(
  d: ProjectRegistrationDeps,
): StepCompletionInterceptor {
  return {
    kind: 'project-credential',
    order: 120,
    canIntercept: ({ step, result }) =>
      !!d.projectStep?.handles(step.agentKind) && result.credentialRequest !== undefined,
    intercept: async ({ workspaceId, instance, step, result }) => {
      const refusal = await d.projectStep!.checkpoint(step, result)
      await d.persistInstance(workspaceId, instance)
      throw refusal
    },
  }
}

/** Record each project task's outcome and render the step's output, one resolver per kind. */
export function projectOutcomeResolvers(d: ProjectRegistrationDeps): StepCompletionResolver[] {
  return (d.projectStep?.agentKinds() ?? []).map((agentKind) => ({
    kind: agentKind,
    phase: 'post-completion',
    resolve: async ({ workspaceId, instance, step, result }) => {
      if (!d.projectStep) return
      return d.projectStep.record(workspaceId, step, instance.blockId, result)
    },
  }))
}
