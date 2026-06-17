// Port for driving a run *durably* outside the request that started it. The
// execution engine calls this to hand a run off to a background worker (in the
// Cloudflare facade, a Workflows instance) so progress proceeds server-side
// without a browser open. Modelling it as a port keeps the engine free of any
// Cloudflare/Workflows concern. Concrete implementations:
//   - NoopWorkRunner       — the default; does nothing (tests advance runs directly)
//   - WorkflowsWorkRunner  — creates/signals a Cloudflare Workflows instance
// All methods must be idempotent on `executionId` so a retry or replay is safe.

export interface WorkRunner {
  /** Begin durable execution of a run. Idempotent on `executionId`. */
  startRun(workspaceId: string, executionId: string): Promise<void>
  /** Signal a resolved decision to a parked run so it can continue. */
  signalDecision(
    workspaceId: string,
    executionId: string,
    decisionId: string,
    choice: string,
  ): Promise<void>
  /** Best-effort cancel of the durable run. */
  cancelRun(workspaceId: string, executionId: string): Promise<void>
}

/**
 * The default runner: it does nothing. With it wired, starting a run hands off to
 * nobody — the integration tests rely on this and advance runs directly via
 * `advanceInstance`.
 */
export class NoopWorkRunner implements WorkRunner {
  async startRun(): Promise<void> {}
  async signalDecision(): Promise<void> {}
  async cancelRun(): Promise<void> {}
}
