import type { Block, ExecutionInstance, PipelineStep } from '@cat-factory/kernel'

// The polling-gate abstraction. A "gate" step (today `ci` and `conflicts`) is NOT a
// container/inline LLM agent: it runs a programmatic precheck against a provider and
// only escalates to a helper container agent (`ci-fixer` / `conflict-resolver`) on a
// negative verdict, looping until the precheck passes or an attempt budget is spent.
//
// The engine (ExecutionService) owns the shared state machine — re-attach on replay,
// pass-through when unwired, init/persist `step.gate`, dispatch the helper, count
// attempts, emit. A concrete gate is just a `GateDefinition` describing its
// differentiators, registered by `agentKind`. Adding a gate is a new entry here, not a
// new copy of the machinery. See `ExecutionService.evaluateGate` / `pollGate`.

/** The outcome of a single gate precheck against its provider. */
export interface GateProbe {
  /**
   *  - `pass`    — the precheck is satisfied; the step finishes and the run advances
   *                (the "skip the agent" path — nothing was spun up).
   *  - `pending` — the provider is still computing; keep polling.
   *  - `fail`    — the precheck failed; escalate to the helper agent (or give up once
   *                the attempt budget is spent).
   */
  status: 'pass' | 'pending' | 'fail'
  /** The PR head commit the precheck ran against, or null when there is no open PR. */
  headSha: string | null
  /** Step output recorded on `pass` (a short human-readable reason). */
  passOutput?: string
  /** A summary of what failed on `fail` — fed to the helper agent and the give-up error. */
  failureSummary?: string
}

/** Inputs to a gate's exhaustion handler (budget spent / no executor to escalate to). */
export interface GateExhaustedArgs {
  workspaceId: string
  instance: ExecutionInstance
  block: Block
  step: PipelineStep
  summary?: string
}

/**
 * The per-gate differentiators the engine's generic gate machine needs. Everything
 * shared (the state machine, persistence, dispatch, budget) lives in ExecutionService.
 */
export interface GateDefinition {
  /** Matches the step's `agentKind` (e.g. `ci`, `conflicts`). */
  kind: string
  /** The container agent kind dispatched on a failed precheck (e.g. `ci-fixer`). */
  helperKind: string
  /** Whether the gate's provider is wired. When false the gate is a pass-through. */
  wired(): boolean
  /** Step output recorded when the gate passes through (no provider configured). */
  unwiredOutput: string
  /** Run the precheck against the provider and classify it. */
  probe(workspaceId: string, blockId: string): Promise<GateProbe>
  /**
   * Optional extra context handed to the helper agent on escalation (the CI gate
   * passes the failing-check summary; the conflicts gate passes nothing).
   */
  helperPriorOutput?(summary: string): { agentKind: string; output: string } | undefined
  /**
   * Called when the attempt budget is spent (or there is no async executor to escalate
   * to). May raise a notification; returns the message used to fail the run.
   */
  onExhausted(args: GateExhaustedArgs): Promise<{ error: string }>
}
