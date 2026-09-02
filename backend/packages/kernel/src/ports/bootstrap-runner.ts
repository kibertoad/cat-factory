// Port for durably driving a "bootstrap repo" run's poll loop, mirroring
// WorkRunner for pipeline runs. After BootstrapService dispatches the container it
// asks the runner to start driving: the worker maps each run to one Cloudflare
// Workflows instance (the BootstrapWorkflow) that polls until the run reaches a
// terminal state, updating subtasks and finalising the board frame. Tests leave it
// unset and drive `pollBootstrapJob` directly, exactly as the execution tests do.

export interface BootstrapRunner {
  /**
   * Begin durably driving the bootstrap job `jobId` for `workspaceId`, under the drive key
   * `driveId`. Must be idempotent per DRIVE key (a duplicate start, or a sweeper re-drive racing
   * a live instance, is a no-op); the persisted job record is authoritative.
   *
   * The key is separate from the run id because a monorepo bootstrap is driven twice: once for
   * the survey, and once for the apply that a human's review releases, potentially days later.
   * Keying on the run would make the second start a no-op on Node (the pg-boss singleton dedupes
   * against the finished drive) and a hard failure on Cloudflare (a Workflows instance id cannot
   * be recreated once its instance is terminal). `driveId === jobId` for a single-drive run, so a
   * plain bootstrap behaves exactly as before.
   */
  startRun(workspaceId: string, jobId: string, driveId: string): Promise<void>
  /**
   * Best-effort: tear down the durable driver for the drive `driveId` (terminate its Workflows
   * instance) when the run is being stopped/cancelled. Idempotent: no live instance to terminate
   * is a no-op.
   */
  cancelRun(workspaceId: string, driveId: string): Promise<void>
}

/** The default runner: does nothing (tests drive `pollBootstrapJob` directly). */
export class NoopBootstrapRunner implements BootstrapRunner {
  async startRun(): Promise<void> {}
  async cancelRun(): Promise<void> {}
}
