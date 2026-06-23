import type { AgentRunResult, ExecutionInstance, PipelineStep } from '@cat-factory/kernel'

// The post-completion resolver abstraction — the agent-definition extension point for
// DETERMINISTIC backend logic that must run after an agent step finishes.
//
// Some agent kinds need mechanical, backend-side follow-up once their step completes:
// the `merger` performs the REAL GitHub merge (with backend-held credentials the agent,
// sandboxed in a container, does not have), a future `deployer` might promote an
// environment, etc. Crucially this work must be:
//   - DETERMINISTIC — driven by the engine from the agent's structured result, never by
//     re-prompting a non-deterministic agent; and
//   - POSITION-INDEPENDENT — it fires when THAT step finishes, not only when the step
//     happens to be the pipeline's last. (The merger merge logic used to be hard-coded
//     into the final-step branch of `recordStepResult`; appending any later step — e.g.
//     `post-release-health` — then silently disabled auto-merge entirely. A resolver keyed
//     on `agentKind` removes that coupling: the merge runs at the merger step regardless of
//     what follows it.)
//
// A resolver is registered by `agentKind` (mirroring the `GateDefinition` registry).
// Adding one is a new registry entry, not a new special-case branch in `recordStepResult`.

/** Context handed to a step-completion resolver after its step's agent finished. */
export interface StepResolverContext {
  workspaceId: string
  instance: ExecutionInstance
  step: PipelineStep
  /** The finished agent's structured result (the resolver acts on it mechanically). */
  result: AgentRunResult
  /** Whether this step is the pipeline's last (resolvers rarely need it). */
  isFinalStep: boolean
}

/** The outcome of a post-completion resolver. */
export interface StepResolution {
  /** Replacement step output (e.g. a human-readable merge summary). */
  output?: string
  /**
   * Set when the resolver has already decided the block's TERMINAL status itself (the
   * merger flips the block to `done` on a real merge or `pr_ready` on a review). The
   * engine's `finalizeBlock` then only backstops a block the resolver left untouched.
   */
  ownsTerminalStatus?: boolean
}

/**
 * Deterministic backend logic run after an agent step completes, keyed by `agentKind`.
 * Registered in {@link ExecutionService} (see `buildStepResolverRegistry`); the engine
 * runs the matching resolver in `recordStepResult` once the step's agent has finished,
 * regardless of the step's position in the pipeline.
 */
export interface StepCompletionResolver {
  /** Matches the step's `agentKind` (e.g. `merger`). */
  kind: string
  /**
   * Whether this resolver applies to the finished step's result — lets a resolver no-op
   * when its agent produced nothing to act on (e.g. the merger returned no assessment).
   * Defaults to always-applies when omitted.
   */
  applies?(result: AgentRunResult): boolean
  /** Run the mechanical post-completion logic. */
  resolve(ctx: StepResolverContext): Promise<StepResolution | void>
}
