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
   * A `ci` step is gating the PR on green CI. The run is parked: the durable driver
   * sleeps, then polls {@link ExecutionService.pollCi} to re-check GitHub check
   * runs. Polling stops the moment `pollCi` returns anything else — green CI yields
   * `continue`, a dispatched CI-fixer yields `awaiting_job`, exhaustion fails the run.
   */
  | { kind: 'awaiting_ci'; stepIndex: number }
  /**
   * A `conflicts` step is gating the PR on being mergeable. The run is parked: the
   * durable driver sleeps, then polls {@link ExecutionService.pollConflicts} to
   * re-check mergeability. Polling stops the moment it returns anything else —
   * mergeable yields `continue`, a dispatched conflict-resolver yields
   * `awaiting_job`, exhaustion fails the run.
   */
  | { kind: 'awaiting_conflicts'; stepIndex: number }
  /** A polled async job finished with a failure; the driver should fail the run. */
  | { kind: 'job_failed'; error: string }
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
