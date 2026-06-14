// The outcome of advancing a single run by one step. A durable driver (the
// Cloudflare Workflows instance) inspects this to decide what to do next: loop
// again for the next step, park until a human resolves a decision, or stop.
export type AdvanceResult =
  /** The step completed; the run is still running and has more steps. */
  | { kind: 'continue' }
  /** The step raised a decision; the run is parked until it is resolved. */
  | { kind: 'awaiting_decision'; decisionId: string }
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
