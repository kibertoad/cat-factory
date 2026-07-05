import type { AgentFailureKind } from '@cat-factory/kernel'

// The outcome of advancing a single run by one step. A durable driver (the
// Cloudflare Workflows instance) inspects this to decide what to do next: loop
// again for the next step, park until a human resolves a decision, or stop.
export type AdvanceResult =
  /** The step completed; the run is still running and has more steps. */
  | { kind: 'continue' }
  /** The step raised a decision; the run is parked until it is resolved. */
  | { kind: 'awaiting_decision'; decisionId: string }
  /**
   * The step dispatched an asynchronous agent job (a container run). The run is
   * parked: the durable driver polls {@link ExecutionService.pollAgentJob} between
   * sleeps until the job finishes, then records its result and continues.
   */
  | { kind: 'awaiting_job'; jobId: string; stepIndex: number }
  /**
   * A polling **gate** step (`ci` / `conflicts`) is gating the PR on its precheck.
   * The run is parked: the durable driver sleeps, then polls
   * {@link ExecutionService.pollGate} to re-run the precheck (which gate is resolved
   * from the current step's `agentKind`). Polling stops the moment `pollGate` returns
   * anything else — a passing precheck yields `continue`, a dispatched helper agent
   * (ci-fixer / conflict-resolver) yields `awaiting_job`, exhaustion fails the run.
   */
  | { kind: 'awaiting_gate'; stepIndex: number }
  /**
   * A step finished in a terminal failure; the driver records it via the single
   * `failRun` funnel and stops. `error` is the human-readable message. An inline
   * gate that already knows the precise classification sets `failureKind` (e.g. an
   * unparseable companion verdict → `'companion_rejected'`, a Tester gate that
   * exhausted its fixer budget → `'agent'`) and may attach extended `detail` (e.g.
   * the companion's raw reply); the driver records those instead of the generic
   * `'job_failed'` container-failure framing. `reason` is an optional machine-readable
   * cause code (e.g. an environment failure's `deploy_runner_unwired`) the SPA maps to
   * precise guidance. Defaults: `failureKind` → `'job_failed'`, `detail`/`reason` → none.
   * Inline gates MUST NOT call `failRun` themselves — returning this is the single path so
   * the driver can't double-write and clobber the rich record.
   */
  | {
      kind: 'job_failed'
      error: string
      failureKind?: AgentFailureKind
      detail?: string
      reason?: string
    }
  /**
   * A polled async job's container was evicted/crashed and the single automatic
   * recovery (a fresh-container re-dispatch of the same step) has been spent, so the
   * eviction is treated as deterministic. The driver fails the run as `evicted`.
   * (A first eviction is recovered silently inside {@link ExecutionService.pollAgentJob}
   * by re-dispatching and returning `continue`, so it never reaches the driver.)
   */
  | { kind: 'job_evicted'; error: string }
  /** The final step completed; the run is finished. */
  | { kind: 'done' }
  /** The spend budget is exhausted; the run is paused until it frees up. */
  | { kind: 'paused' }
  /** Nothing to do — the run is absent or not running (replay/idempotent). */
  | { kind: 'noop' }

/** Options controlling how a single advance behaves. */
export interface AdvanceOptions {
  /**
   * When true, an agent failure is rethrown instead of being swallowed into the
   * step output. The durable driver sets this so a failed `step.do` retries; tests
   * leave it false to preserve the "never wedge" behaviour.
   */
  rethrowAgentErrors?: boolean
}
