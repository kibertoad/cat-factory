import type {
  EnvironmentProbeReport,
  EnvironmentProbeSurface,
  EnvironmentTestMode,
  EnvironmentTestStage,
  EnvironmentTestStatus,
  ServiceProvisioning,
  StepSubtasks,
} from '../domain/types.js'

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
  /** What this run exercises: the provisioning alone, or provisioning plus an agent dry run. */
  mode: EnvironmentTestMode
  status: EnvironmentTestStatus
  /** The stage currently in flight (or `done` when finished successfully). */
  stage: EnvironmentTestStage
  /**
   * The run initiator's user id, persisted so the durable poll resolves the same
   * per-user handler overrides (local mode) the start-time check used. Null when the
   * dispatch had no user context.
   */
  initiatedBy: string | null
  /**
   * The frame's provisioning config, PINNED at dispatch time so the durable poll
   * finalizes/tears down against exactly what it dispatched — a mid-flight edit of the
   * frame (or its deletion) can't strand a live environment. Never `infraless`
   * (`startTest` rejects that before inserting the record).
   */
  provisioning: ServiceProvisioning
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
  /**
   * The dry run's CLAIM, and the surface it claimed: one field doing both jobs.
   *
   * It is the claim because it is written (guarded) BEFORE the probe container is dispatched,
   * never after: the durable driver replays, and a marker written after the effect would let a
   * crash between the two dispatch a second agent at the same environment. A poll that finds the
   * `probing` stage with this still null therefore knows the claim is its to take.
   *
   * It carries the SURFACE because the surface decides which container the job runs in (the
   * browser prober needs the heavier image), so every later poll and every reclaim has to address
   * the one that was started. Re-deriving it from the frame would address the wrong container for
   * a frame whose type was edited, or none at all for a frame that was deleted, which is exactly
   * when a leaked browser container costs the most. Null in `provision` mode and before the claim.
   */
  probeSurface: EnvironmentProbeSurface | null
  /**
   * When the prober's container was accepted, so a replay can tell a CLAIMED probe from a
   * DISPATCHED one.
   *
   * The claim above is written before the dispatch, which is the only ordering that cannot start
   * two agents against one environment. It leaves a window the claim alone cannot describe: a
   * durable replay landing between the two finds a claim with no job behind it, polls a container
   * that was never started, and reads the backend's "no such job" as an EVICTION, so a run that
   * simply lost its isolate reports a container failure that never happened. Written AFTER the
   * dispatch is accepted, so a poll that finds it null re-dispatches (idempotent per job id) and a
   * poll that finds it set knows the job is real.
   */
  probeDispatchedAt: number | null
  /**
   * The prober's live todo counts while it works. Null in `provision` mode, before the container
   * reports any, and once the report has landed (the report is the finer answer). See the wire
   * type for why a multi-minute stage that writes nothing is a bug rather than an omission.
   */
  probeProgress: StepSubtasks | null
  /**
   * What the prober's DISPATCH resolved, written with {@link probeDispatchedAt} and re-supplied to
   * every later poll: the model the container ran (`provider:model`) and the pooled subscription
   * token it leased.
   *
   * Persisted rather than re-derived for the reason a pipeline step persists the same pair
   * (`recordDispatchAttribution`): the poll runs in a fresh process and rebuilds its handle from
   * this row alone. Asking the frame and preset again there answers about them AS THEY ARE NOW, so
   * a pin cleared mid-run stamps the report with a model nobody ran; and the leased token id has no
   * second source at all, so without it a subscription-routed dry run's tokens are attributed to
   * nothing. Both null in `provision` mode and until the dispatch is accepted.
   */
  probeModel: string | null
  probeSubscriptionTokenId: string | null
  probeSubscriptionVendor: string | null
  /** The dry-run agent's report, once the probe settled. Null until then, and in `provision` mode. */
  probe: EnvironmentProbeReport | null
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
    | 'probeSurface'
    | 'probeDispatchedAt'
    | 'probeModel'
    | 'probeSubscriptionTokenId'
    | 'probeSubscriptionVendor'
    | 'probeProgress'
    | 'probe'
    | 'updatedAt'
  >
>

export interface EnvironmentTestRunRepository {
  insert(record: EnvironmentTestRunRecord): Promise<void>
  /**
   * Apply `patch` ONLY while the run is still `running`, returning whether a row was
   * written. Every service write happens on a live run, so the guard makes the
   * stop-button ⇄ durable-driver race first-writer-wins: a driver poll can never
   * resurrect (or overwrite the terminal state of) a run the user already stopped.
   */
  updateIfRunning(
    workspaceId: string,
    id: string,
    patch: EnvironmentTestRunRecordPatch,
  ): Promise<boolean>
  get(workspaceId: string, id: string): Promise<EnvironmentTestRunRecord | null>
  /** All currently-running self-tests for a workspace (carried in the snapshot). */
  listRunningByWorkspace(workspaceId: string): Promise<EnvironmentTestRunRecord[]>
  /**
   * Running runs (across workspaces) whose `updatedAt` is older than `cutoffMs`, oldest
   * first — the stale set the cron sweeper classifies (re-drive a lost driver / finalize
   * an orphan). Mirrors `AgentRunRepository.listStale`.
   */
  listStale(cutoffMs: number, limit?: number): Promise<EnvironmentTestRunRecord[]>
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
