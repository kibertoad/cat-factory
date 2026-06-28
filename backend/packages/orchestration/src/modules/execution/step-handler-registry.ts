import type { AgentRunResult, Block, ExecutionInstance, PipelineStep } from '@cat-factory/kernel'
import type { AdvanceResult, AdvanceOptions } from './advance.js'

// The per-step-kind handler abstraction — the engine-internal counterpart to the public
// `GateDefinition` / `StepCompletionResolver` registries.
//
// `ExecutionService.stepInstance` runs a fixed run-lifecycle PREAMBLE (existence check →
// spend gate → paused-resume → re-entrancy guards → start-step → block load → estimate
// gate) and then dispatches the per-kind work — deployer, tracker, the review/brainstorm
// gates, human-test, visual-confirm, the polling gates, inline companions, and the generic
// container/inline agent fallthrough — to the FIRST registered {@link StepHandler} whose
// `canHandle` returns true, ordered by `order`. That dispatch replaces the ~200-line
// implicit-ordering `if`/early-return chain the per-kind body used to be.
//
// Unlike the gate/resolver registries, this one is DELIBERATELY engine-internal: a step
// handler needs privileged access to the engine's controllers, repositories and durable
// driver hooks (far more than the minimal `GateContext` / `ResolverContext` a deployment
// gets), and `AdvanceResult` is orchestration-local. So the built-in handlers are built
// in-engine, closing over the ExecutionService instance, exactly the way
// `ExecutionService.buildStepResolverRegistry` builds the merger resolver inline — there is
// no public `registerStepHandler` seam. The external extension story stays `registerGate` /
// `registerStepResolver` / `registerAgentKind`.

/** Everything a {@link StepHandler} needs about the step it may handle. */
export interface StepHandlerContext {
  workspaceId: string
  instance: ExecutionInstance
  step: PipelineStep
  /** The run's block, already loaded by the preamble. */
  block: Block
  /** Whether this step is the pipeline's last (drives terminal finalization). */
  isFinalStep: boolean
  /** The advance options threaded from the durable driver (e.g. `rethrowAgentErrors`). */
  options: AdvanceOptions
}

/**
 * One step-kind's slice of the old `stepInstance` per-kind body. The engine builds the
 * ordered list once, caches it, and dispatches each step to the first handler that
 * `canHandle`s it.
 */
export interface StepHandler {
  /** Documentary id for the handled kind(s); dispatch is by `canHandle`, not this. */
  readonly kind: string
  /**
   * Dispatch order — the lower it runs first, so a specific handler can shadow the
   * generic fallthrough. Replaces the load-bearing-but-implicit ordering of the old
   * `if`/early-return chain with an explicit, declared number.
   */
  readonly order: number
  /** Whether this handler owns the given step (keyed on `step.agentKind` / gate lookup). */
  canHandle(ctx: StepHandlerContext): boolean
  /** Run the step's per-kind work, returning the same outcome `stepInstance` always has. */
  handle(ctx: StepHandlerContext): Promise<AdvanceResult>
}

/**
 * The order of the generic container/inline-agent fallthrough handler — the LAST resort,
 * matching every step that no more-specific handler claimed (today's body tail). Kept far
 * above any specific handler's order so specific handlers always shadow it.
 */
export const FALLTHROUGH_STEP_HANDLER_ORDER = Number.MAX_SAFE_INTEGER

// ---------------------------------------------------------------------------
// Step-completion interceptors
// ---------------------------------------------------------------------------
//
// The completion-path sibling of {@link StepHandler}. A handful of step kinds DON'T just
// finish-and-advance when their agent returns: a container-backed companion applies its
// verdict's threshold/rework/human-gate loop, and a Tester re-runs its `fixer` on a
// withheld greenlight. These run at the TOP of `recordStepResult` and SHORT-CIRCUIT it,
// returning a full {@link AdvanceResult} (park / loop / fail) instead of letting the normal
// completion spine run.
//
// They can't use the kernel {@link StepCompletionResolver} seam: that returns a
// `StepResolution` (reshape output / own terminal status), whereas these decide run FLOW and
// yield an orchestration-local `AdvanceResult`. So, like {@link StepHandler}, an interceptor
// is engine-internal — built in-engine closing over the controllers — and there is no public
// registration seam. `intercept` returns the short-circuit outcome, or `null` to let the
// normal completion continue (a Tester greenlight falls through this way).

/** Inputs to a {@link StepCompletionInterceptor}, at the point its step's agent finished. */
export interface StepCompletionContext {
  workspaceId: string
  instance: ExecutionInstance
  step: PipelineStep
  isFinalStep: boolean
  /** The finished agent's structured result. */
  result: AgentRunResult
}

/**
 * An engine-internal short-circuit on the completion path, keyed on `step.agentKind` via
 * `canIntercept`. The first interceptor that claims the step and returns a non-null
 * `AdvanceResult` short-circuits `recordStepResult`; returning `null` lets the normal
 * finish/advance spine run.
 */
export interface StepCompletionInterceptor {
  readonly kind: string
  readonly order: number
  canIntercept(ctx: StepCompletionContext): boolean
  intercept(ctx: StepCompletionContext): Promise<AdvanceResult | null>
}
