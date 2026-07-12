import type { EnvironmentTestStage, EnvironmentTestStatus } from '../domain/types.js'

// ---------------------------------------------------------------------------
// Ports for the ephemeral-environment SELF-TEST run.
//
// The self-test is a durable, asynchronous, observable run modelled like a
// "bootstrap repo" run — it never blocks the triggering request:
//   - EnvironmentTestRunRepository — the `environment_test_runs` rows (its own
//     table, since a self-test carries a `stage` state machine and is not a
//     container agent, unlike the `agent_runs`-backed bootstrap/config-repair).
//   - EnvironmentTestRunner        — durably drives the poll loop (the worker's
//     EnvironmentTestWorkflow / Node pg-boss), the analogue of BootstrapRunner.
//
// The orchestration (EnvironmentTestService) composes the existing provisioning /
// teardown services + the VCS client behind these ports; tests leave the runner
// unset and poll directly.
// ---------------------------------------------------------------------------

/** One ephemeral-environment self-test run, projected locally. */
export interface EnvironmentTestRunRecord {
  id: string
  workspaceId: string
  /** The service frame (board block) whose provisioning config is under test. */
  blockId: string
  status: EnvironmentTestStatus
  /** The stage currently in flight (or `done` when finished successfully). */
  stage: EnvironmentTestStage
  /**
   * The run initiator's user id, persisted so the durable poll resolves the same
   * per-user handler overrides (local mode) the start-time check used. Null when the
   * dispatch had no user context.
   */
  initiatedBy: string | null
  /** The temporary branch the run created; null until it is created. */
  branch: string | null
  /** The provisioned environment's registry id, so the teardown stage can reclaim it. */
  environmentId: string | null
  /** The provisioned environment's URL, when the provider exposed one. */
  envUrl: string | null
  /** One-line failure reason when `status` is `failed`; null otherwise. */
  error: string | null
  /** The stage the run was at when it failed; null unless `status` is `failed`. */
  failedStage: EnvironmentTestStage | null
  createdAt: number
  updatedAt: number
}

export type EnvironmentTestRunRecordPatch = Partial<
  Pick<
    EnvironmentTestRunRecord,
    | 'status'
    | 'stage'
    | 'branch'
    | 'environmentId'
    | 'envUrl'
    | 'error'
    | 'failedStage'
    | 'updatedAt'
  >
>

export interface EnvironmentTestRunRepository {
  insert(record: EnvironmentTestRunRecord): Promise<void>
  update(workspaceId: string, id: string, patch: EnvironmentTestRunRecordPatch): Promise<void>
  get(workspaceId: string, id: string): Promise<EnvironmentTestRunRecord | null>
  /** All currently-running self-tests for a workspace (carried in the snapshot). */
  listRunningByWorkspace(workspaceId: string): Promise<EnvironmentTestRunRecord[]>
}

export interface EnvironmentTestRunner {
  /**
   * Begin durably driving the self-test run `id` for `workspaceId`. Must be
   * idempotent per run id (a duplicate start, or a sweeper re-drive racing a live
   * instance, is a no-op) — the persisted run record is authoritative.
   */
  startRun(workspaceId: string, id: string): Promise<void>
  /**
   * Best-effort: tear down the durable driver for `id` when the run is being
   * stopped. Idempotent — no live instance to terminate is a no-op.
   */
  cancelRun(workspaceId: string, id: string): Promise<void>
}

/** The default runner: does nothing (tests drive `pollEnvTest` directly). */
export class NoopEnvironmentTestRunner implements EnvironmentTestRunner {
  async startRun(): Promise<void> {}
  async cancelRun(): Promise<void> {}
}
