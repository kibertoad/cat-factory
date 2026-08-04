import type { IntakeOrigin, RunMode, WorkspaceRole } from '@cat-factory/kernel'
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
   * The workspace ROLE that initiator holds, as the auth gate already resolved it for this
   * request. Supplied by the HTTP layer, which is the only layer that has it: the engine sits
   * below the gate and must never re-derive membership (workspace-rbac keeps resolution in exactly
   * one place). Pinned onto the run so the durable merge path can scope its decision to the tier
   * the run was admitted under — see {@link ExecutionInstance.initiatedByRole} for why it is
   * pinned rather than re-read, and why absent stays absent instead of defaulting to a tier.
   */
  initiatedByRole?: WorkspaceRole | null
  /**
   * The run mode the caller ASKED for ({@link RunMode}); absent ⇒ `live`. The task's merge preset
   * can still force a sandboxed role's run to `dry_run` regardless of what was asked, so this is
   * an input to the decision rather than the decision itself.
   */
  mode?: RunMode
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
   * How this run is ENTERING the system (`IntakeOrigin`: `ui`, `public-api`, `tracker` or
   * `schedule`). Persisted on the run ({@link ExecutionInstance.intakeOrigin}) because
   * clarification behaviour diverges by intake: a HEADLESS run (`isHeadlessIntake`) pushes its
   * parked questions out to the task's linked tracker issue, whereas a UI-started task's overseer
   * is in the SPA. Distinct from {@link origin}, which gates pipeline availability and is not
   * persisted, and from `initiatedBy`, which is `null` for a public-API run, a schedule fire and
   * auth-disabled dev alike. A retry/restart carries the stored value forward.
   *
   * **Every UNATTENDED start path must SET this**; only the in-app start may rely on the `ui`
   * default, because the default is a positive claim that a human is watching. The optionality is
   * for that one caller, so a typecheck cannot enforce the rule: `intakeOrigin.coverage.spec.ts`
   * (in `@cat-factory/server`) classifies each start path instead, and a new one fails there
   * until it is answered.
   */
  intakeOrigin?: IntakeOrigin
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
