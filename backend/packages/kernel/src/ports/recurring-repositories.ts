import type { PipelineSchedule, ScheduleRun } from '../domain/types.js'

// Persistence ports for recurring pipelines. A *pipeline schedule* is a
// workspace-scoped resource (keyed by (workspace_id, id)); each fire is recorded
// as a *schedule run* for the inspector's history. `listDue` is a deliberately
// cross-workspace query — the cron sweeper enumerates every workspace's due
// schedules in one pass, mirroring `AgentRunRepository.listStale`.

/** A due schedule the sweeper should fire, paired with its owning workspace. */
export interface DueSchedule {
  workspaceId: string
  schedule: PipelineSchedule
}

export interface PipelineScheduleRepository {
  /** A schedule by id, or null if it does not exist. */
  get(workspaceId: string, id: string): Promise<PipelineSchedule | null>
  /** The schedule whose reused block is `blockId`, or null. */
  getByBlock(workspaceId: string, blockId: string): Promise<PipelineSchedule | null>
  /** All schedules for a workspace (for the snapshot + UI). */
  list(workspaceId: string): Promise<PipelineSchedule[]>
  /**
   * All schedules owned by a service, regardless of which workspace created them. Backs
   * the in-org board: a schedule on a shared service shows on every workspace that mounts
   * it. (Matches the schedule's `service_id` column.)
   */
  listByService(serviceId: string): Promise<PipelineSchedule[]>
  /**
   * Every schedule owned by ANY of the given services, in a single (chunked) query — the
   * batched form of {@link PipelineScheduleRepository.listByService} used to compose a board's
   * schedules from all the services it mounts without one round-trip per mount. Empty input →
   * empty.
   */
  listByServices(serviceIds: string[]): Promise<PipelineSchedule[]>
  /**
   * Every enabled schedule across ALL workspaces whose `nextRunAt <= asOf`. The
   * sweeper fires each one; the engine skips any whose block already has an active
   * run. Ordered by `nextRunAt` ascending.
   */
  listDue(asOf: number): Promise<DueSchedule[]>
  /** Create or replace a schedule (keyed by id). */
  upsert(workspaceId: string, schedule: PipelineSchedule): Promise<void>
  /** Remove a schedule by id (no-op if absent). Does not touch its run history. */
  remove(workspaceId: string, id: string): Promise<void>

  /** Record a fire of a schedule. */
  insertRun(workspaceId: string, run: ScheduleRun): Promise<void>
  /** Patch a run (e.g. set `status`/`finishedAt`/`outcome`). */
  updateRun(
    workspaceId: string,
    runId: string,
    patch: Partial<Pick<ScheduleRun, 'status' | 'finishedAt' | 'outcome' | 'executionId'>>,
  ): Promise<void>
  /** A schedule's run history (most recent first). */
  listRuns(workspaceId: string, scheduleId: string): Promise<ScheduleRun[]>
  /** Delete all run history started before `before` (retention). Returns rows removed. */
  pruneRunsBefore(before: number): Promise<number>
}
