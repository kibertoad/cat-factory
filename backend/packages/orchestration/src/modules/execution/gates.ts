import type {
  Block,
  ExecutionInstance,
  GateStepState,
  MergeThresholdPreset,
  PipelineStep,
} from '@cat-factory/kernel'

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
  /**
   * Structured failing checks behind {@link failureSummary} (the CI gate populates
   * this from the red check runs; the conflicts gate leaves it undefined). Persisted
   * onto `step.gate` so the run-detail UI can list each failing check.
   */
  failingChecks?: { name: string; conclusion: string | null }[]
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
  /**
   * What to do when the durable driver's poll budget (ciMaxPolls × ciPollInterval) is
   * spent while the gate is still `pending` — distinct from the attempt budget (helper
   * dispatches) handled by {@link onExhausted}:
   *   - `fail` (default) — the precheck never settled, which is a failure for the CI /
   *     conflicts gates (CI never went green / the PR never became mergeable).
   *   - `pass` — for a time-windowed watch gate (post-release-health), running out of
   *     polls just means the watch window outlasted the budget with NO regression seen,
   *     which is a healthy pass — not a timeout failure.
   * Resolved by {@link ExecutionService.resolveGatePollExhaustion}.
   */
  pollExhaustion?: 'pass' | 'fail'
  /**
   * Run the precheck against the provider and classify it. Receives the live gate
   * state so a time-windowed gate (post-release-health) can read its `watchSince`.
   */
  probe(workspaceId: string, blockId: string, gateState: GateStepState): Promise<GateProbe>
  /**
   * Optional: the attempt budget for this gate, resolved from the task's merge preset.
   * Defaults to `ciMaxAttempts` when omitted (the CI/conflicts gates use that).
   */
  attemptBudget?(preset: Pick<MergeThresholdPreset, 'ciMaxAttempts' | 'releaseMaxAttempts'>): number
  /**
   * Optional extra context handed to the helper agent on escalation (the CI gate
   * passes the failing-check summary; the conflicts gate passes nothing).
   */
  helperPriorOutput?(summary: string): { agentKind: string; output: string } | undefined
  /**
   * Optional async builder for richer helper context (gathered at dispatch time), used
   * when a gate's helper needs more than the precheck summary — e.g. the on-call agent
   * gets the full Datadog evidence bundle. Returns prior-output entries appended after
   * the base context's. Takes precedence over {@link helperPriorOutput} when present.
   */
  gatherHelperPriorOutputs?(
    workspaceId: string,
    blockId: string,
    gateState: GateStepState,
  ): Promise<{ agentKind: string; output: string }[]>
  /**
   * Called when the attempt budget is spent (or there is no async executor to escalate
   * to). May raise a notification; returns the message used to fail the run.
   */
  onExhausted(args: GateExhaustedArgs): Promise<{ error: string }>
}
