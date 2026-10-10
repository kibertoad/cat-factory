import type {
  AgentJobUpdate,
  ExecutionInstance,
  GateDefinition,
  PipelineStep,
} from '@cat-factory/kernel'
import type { AdvanceResult } from './advance.js'

// ---------------------------------------------------------------------------
// A settled job that belongs to a step's HELPER, not to the step itself.
//
// Four different step kinds now dispatch a helper agent onto their own `step.jobId`: a gate's
// `ci-fixer` / `conflict-resolver`, an investigate-don't-fix gate's `on-call`, a tester /
// human-test / visual-confirmation gate's `fixer`, and a failed `deployer`'s `deploy-fixer`. They
// all land back on the ONE job-poll path, and for every one of them the settled update must NOT be
// recorded as the step's result: the helper's job is a round in the step's own loop, so it drops
// the handle and returns the step to whatever it was doing.
//
// Extracted from `RunDispatcher.pollAgentJob` because the chain had grown to four consecutive
// "is this actually a helper?" probes, each with the paragraph of context explaining why it comes
// before the ordinary completion path. That is one cohesive concern with one rule, and keeping it
// inline is what pushed `RunDispatcher` over its size budget when the deploy-fixer joined.
//
// ORDER IS LOAD-BEARING and is the reason this is a sequence rather than a lookup by step kind:
// the investigate hook is offered a gate step BEFORE the re-probe, because re-probing a helper
// that only investigates would regress again and burn the budget. Anything reordering these is
// changing behaviour.
// ---------------------------------------------------------------------------

/** A settled poll: the two dispositions a helper round can finish in. */
type SettledUpdate = Extract<AgentJobUpdate, { state: 'done' } | { state: 'failed' }>

/** The context every probe below is handed. */
export interface SettledHelperContext {
  workspaceId: string
  instance: ExecutionInstance
  step: PipelineStep
  update: SettledUpdate
}

/**
 * Bound callbacks onto the controllers that own each loop. Callbacks rather than the controllers
 * themselves, so this router knows nothing about how any of them is built and cannot grow a second
 * reason to reach into one.
 */
export interface SettledHelperRouterDeps {
  /** Post-release-health → `on-call`: settle the gate from the hook instead of re-probing. */
  resolveInvestigateHelperCompletion: (
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    update: AgentJobUpdate,
  ) => Promise<AdvanceResult | null>
  /** A failed `deployer`'s `deploy-fixer`: clear the frame's failure and re-provision. */
  resolveDeployFixCompletion: (ctx: SettledHelperContext) => Promise<AdvanceResult | null>
  /** The registered polling gate for a step kind, when it is one. */
  gateFor: (agentKind: string) => GateDefinition | undefined
  /** A polling gate's `ci-fixer` / `conflict-resolver`: return to `checking` and re-probe. */
  reprobeGateAfterHelper: (
    gate: GateDefinition,
    ctx: SettledHelperContext,
  ) => Promise<AdvanceResult>
  /** A tester / human-test / visual-confirmation gate's phased helper. */
  resolveHelperPhaseCompletion: (
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    update: SettledUpdate,
  ) => Promise<AdvanceResult | null>
}

/**
 * Route a settled job that belongs to a helper, or `null` when it is the step's OWN work and the
 * caller should record it as the step result.
 */
export class SettledHelperRouter {
  constructor(private readonly deps: SettledHelperRouterDeps) {}

  async route(ctx: SettledHelperContext): Promise<AdvanceResult | null> {
    const { workspaceId, instance, step, update } = ctx

    // BEFORE the re-probe below: see the ordering note in the module header.
    const investigated = await this.deps.resolveInvestigateHelperCompletion(
      workspaceId,
      instance,
      step,
      update,
    )
    if (investigated) return investigated

    const deployFixed = await this.deps.resolveDeployFixCompletion(ctx)
    if (deployFixed) return deployFixed

    // A helper that failed WITHOUT pushing leaves the precheck negative, so the next check
    // re-dispatches until the attempt budget is spent; that is why this settles nothing itself.
    const gate = this.deps.gateFor(step.agentKind)
    if (gate) return this.deps.reprobeGateAfterHelper(gate, ctx)

    return this.deps.resolveHelperPhaseCompletion(workspaceId, instance, step, update)
  }
}
