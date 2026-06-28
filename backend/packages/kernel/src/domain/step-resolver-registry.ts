import type { ExecutionInstance, PipelineStep } from './types.js'
import type { AgentRunResult } from '../ports/agent-executor.js'
import type { RunInitiatorScope } from '../ports/user-secret-repositories.js'

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
// Lives in kernel so a deployment package can register its OWN resolver as a startup
// import side effect (see {@link registerStepResolver}) without depending on orchestration.

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
  /**
   * How the engine should proceed after this resolver runs, for the few kinds whose
   * completion is NOT a plain "finish the step and advance":
   *   - `advance` (default, also when omitted) — finish the step and advance/finalize as usual.
   *   - `park` — the resolver parked the run on a decision/approval; the engine returns the
   *     parking outcome instead of advancing (e.g. a container companion that withheld its
   *     verdict pending a human gate).
   *   - `loop` — the resolver re-queued an earlier step (e.g. a Tester that withheld its
   *     greenlight re-runs the fixer); the engine returns early WITHOUT finishing this step.
   * Consumed from Phase 3 of the ExecutionService split; resolvers that don't set it keep
   * today's advance-on-completion behaviour.
   */
  control?: 'park' | 'loop' | 'advance'
}

/**
 * Deterministic backend logic run after an agent step completes, keyed by `agentKind`.
 * The engine runs the matching resolver in `recordStepResult` once the step's agent has
 * finished, regardless of the step's position in the pipeline.
 */
export interface StepCompletionResolver {
  /** Matches the step's `agentKind` (e.g. `merger`). */
  kind: string
  /**
   * WHEN in `recordStepResult` this resolver runs:
   *   - `terminal` (default, also when omitted) — at the LATE slot, just before the
   *     step finalizes/advances. The right place for a resolver that owns the block's
   *     terminal status or acts on the settled step (the `merger`'s real merge). This is
   *     where deployment-registered custom resolvers run, preserving today's behaviour.
   *   - `post-completion` — at the EARLY slot, immediately after the step's output is
   *     recorded and BEFORE the follow-up / approval gates. The right place for a resolver
   *     that reshapes the agent's structured result into domain state the gates (or the
   *     reviewable-output rendering) then read — e.g. ingesting a blueprint/spec, or
   *     persisting a task estimate and replacing the step output with its summary (so an
   *     approval proposal shows the summary, not the raw JSON). A `post-completion`
   *     resolver MUST NOT own terminal status or park/loop the run.
   */
  phase?: 'post-completion' | 'terminal'
  /**
   * Whether this resolver applies to the finished step's result — lets a resolver no-op
   * when its agent produced nothing to act on (e.g. the merger returned no assessment).
   * Defaults to always-applies when omitted.
   */
  applies?(result: AgentRunResult): boolean
  /** Run the mechanical post-completion logic. */
  resolve(ctx: StepResolverContext): Promise<StepResolution | void>
}

/**
 * The shared engine seams a registered (custom) resolver legitimately needs, handed to
 * its factory at registry-build time. Minimal by design — a resolver acts on the
 * `result` it receives and reaches any external system through a provider it closes over.
 */
export interface ResolverContext {
  /** Run a function under the run initiator's ambient context (per-user credentials). */
  runInitiatorScope: RunInitiatorScope
}

/**
 * A registered resolver is a factory the engine invokes ONCE at registry-build time with
 * a {@link ResolverContext}, mirroring {@link GateFactory}.
 */
export type StepResolverFactory = (ctx: ResolverContext) => StepCompletionResolver

// Process-wide registry, mirroring the gate / agent-kind / pipeline registry seams.
// Registration is a startup import side effect, read once when an ExecutionService lazily
// builds its resolver registry — register at startup, before serving.
const registry = new Map<string, StepResolverFactory>()

/**
 * Register a custom step-completion resolver, keyed by the step `agentKind` whose
 * completion it resolves. A later registration of the same kind replaces the earlier one,
 * and a registered resolver replaces a built-in of the same kind.
 */
export function registerStepResolver(kind: string, factory: StepResolverFactory): void {
  registry.set(kind, factory)
}

/** The registered custom step resolvers (registration order). */
export function registeredStepResolverFactories(): {
  kind: string
  factory: StepResolverFactory
}[] {
  return [...registry].map(([kind, factory]) => ({ kind, factory }))
}

/** Drop all registered step resolvers. Intended for tests that exercise registration. */
export function clearRegisteredStepResolvers(): void {
  registry.clear()
}

/**
 * A minimal {@link ResolverContext} for tests that invoke a resolver factory in isolation
 * (the real one is built by `ExecutionService.makeResolverContext`). Centralised here so a
 * new required `ResolverContext` field is filled in ONE place instead of every test.
 */
export function stubResolverContext(overrides: Partial<ResolverContext> = {}): ResolverContext {
  return { runInitiatorScope: (_initiatedBy, fn) => fn(), ...overrides }
}
