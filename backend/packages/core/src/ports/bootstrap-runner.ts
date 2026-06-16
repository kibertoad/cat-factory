// Port for durably driving a "bootstrap repo" run's poll loop, mirroring
// WorkRunner for pipeline runs. After BootstrapService dispatches the container it
// asks the runner to start driving: the worker maps each run to one Cloudflare
// Workflows instance (the BootstrapWorkflow) that polls until the run reaches a
// terminal state, updating subtasks and finalising the board frame. Tests leave it
// unset and drive `pollBootstrapJob` directly, exactly as the execution tests do.

export interface BootstrapRunner {
  /**
   * Begin durably driving the bootstrap job `jobId` for `workspaceId`. Must be
   * idempotent per job id (a duplicate start, or a sweeper re-drive racing a live
   * instance, is a no-op) — the persisted job record is authoritative.
   */
  startRun(workspaceId: string, jobId: string): Promise<void>
}

/** The default runner: does nothing (tests drive `pollBootstrapJob` directly). */
export class NoopBootstrapRunner implements BootstrapRunner {
  async startRun(): Promise<void> {}
}
