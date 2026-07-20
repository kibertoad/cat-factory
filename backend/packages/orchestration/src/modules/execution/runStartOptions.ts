import type { RunOrigin } from '../pipelines/pipelineShape.js'

/**
 * Optional launch inputs for {@link ExecutionService.start} — the initiator identity, the
 * per-run personal-credential activation, the launch origin, and the per-run gate override.
 * Bundled into one object so `start` takes the block/pipeline identity plus a single options
 * bag rather than a long positional tail (all fields default to today's behaviour).
 */
export interface RunStartOptions {
  /**
   * Internal user id of the initiator. Recorded on the run so an individual-usage model
   * (Claude) uses this user's OWN personal subscription. Absent for system-initiated runs
   * (recurring schedules) and auth-disabled dev.
   */
  initiatedBy?: string | null
  /**
   * Mint the per-run personal-credential activation for an individual-usage model. Invoked
   * with the new run's id BEFORE it is persisted/dispatched, so the async steps can lease it;
   * a throw (wrong/missing password) aborts the start cleanly with nothing persisted. The
   * server layer supplies this (the personal store lives outside the domain Core); absent for
   * non-individual runs.
   */
  activate?: (executionId: string) => Promise<void>
  /**
   * How this run is being launched: a `'manual'` one-off task (default) or a `'recurring'`
   * schedule fire ({@link RecurringPipelineService.fire}). Gates the pipeline's declared
   * `availability` — a `'recurring'`-only pipeline can't be started manually and vice versa
   * (see {@link assertPipelineLaunchable}). A retry/restart re-drives an already-validated run,
   * so it never re-checks this.
   */
  origin?: RunOrigin
  /**
   * Per-run approval-gate override (the initiative-preset gate-override seam). When supplied it
   * REPLACES the pipeline's declared `gates` for THIS run only — one boolean per pipeline step,
   * indexed by the pipeline's ORIGINAL step index exactly like `pipeline.gates`, so it must be
   * parallel to `pipeline.agentKinds`. `undefined` ⇒ today's behaviour (the pipeline's own
   * gates). The initiative loop threads an item's `spawn.gates` through here; a preset's review
   * mapping computes the array from the user's `humanReview` choice. The override is copied onto
   * the run's steps (`requiresApproval`), so a retry/restart — which re-drive the STORED steps —
   * preserve it with no extra persistence.
   */
  gatesOverride?: boolean[]
}
