import type { Block, ExecutionInstance, PipelineStep } from '@cat-factory/kernel'
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
