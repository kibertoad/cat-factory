import type { WorkRunner } from '@cat-factory/kernel'
import type { Logger, ServerContainer } from '@cat-factory/server'
import type { Job, JobInsert, PgBoss, SendOptions } from 'pg-boss'
import { BOOTSTRAP_QUEUE, reenqueueStaleBootstrap } from './bootstrapRunner.js'
import { ENV_CONFIG_REPAIR_QUEUE, reenqueueStaleEnvConfigRepair } from './envConfigRepairRunner.js'
import { type DriveConfig, driveExecution } from './drive.js'
import { type JobStore, classifyAdvanceJob, reclaimAdvanceJob } from './reclaim.js'

// Durable execution on pg-boss: the analogue of the Worker's Cloudflare Workflows
// driver. `startRun` enqueues an advance job (deduped per run via singletonKey); a
// registered worker drives the run to a standstill via `driveExecution`. A resolved
// decision re-enqueues an advance to resume a parked run. State lives in Postgres,
// so a crash mid-run is recovered two ways: pg-boss retries an expired/failed advance
// job, and the stale-run sweeper re-enqueues runs still `running` in storage.

const QUEUE = 'execution.advance'

// The queue MUST be created with the `exclusive` policy for the dedup below to hold.
// Under pg-boss's default `standard` policy, `singletonKey` alone enforces NO uniqueness
// (the singleton unique indexes are policy-gated, and the policy-independent one requires
// `singletonSeconds`, which we don't set). `exclusive` makes (name, singletonKey) unique
// across the `created`/`retry`/`active` states, so at most one advance job per run is
// alive at a time and a duplicate `send` is an `ON CONFLICT DO NOTHING` no-op.
const QUEUE_POLICY = 'exclusive' as const

interface AdvanceJob {
  workspaceId: string
  executionId: string
}

/**
 * Send options for an advance job. `singletonKey` (the run id) is the linchpin — but only
 * because the queue is created `exclusive` (see {@link QUEUE_POLICY}): while an advance job
 * for a run is active/queued/retrying, pg-boss suppresses any duplicate send — so re-enqueues
 * from `signalDecision` and the stale-run sweeper are safe no-ops for a run that is still being
 * driven, and only take effect once the prior job is gone. That lets the sweeper use a short
 * lease without ever double-driving a healthy run.
 *
 * `expireInSeconds` MUST exceed the longest a single advance can run (a drive can poll
 * a container job for `jobMaxPolls * jobPollInterval`, well past pg-boss's 15s default);
 * otherwise pg-boss would expire a healthy long-running drive, free its singletonKey,
 * and let a second driver start. `heartbeatSeconds` is the separate, fast crash-recovery
 * lever: a live worker auto-heartbeats its active job, so a crashed worker is detected
 * (and its job retried) within `heartbeatSeconds` rather than waiting out the large
 * `expireInSeconds` cap. `retryLimit`/`retryBackoff` make pg-boss itself re-drive a job
 * that throws, expires, or misses its heartbeat (a crashed worker) — the durable backstop.
 * See `executionRuntime` for how both are sized.
 */
export interface AdvanceQueueOptions {
  expireInSeconds: number
  heartbeatSeconds: number
  retryLimit: number
  retryDelaySeconds: number
}

/**
 * The single source of truth for an advance job's options, shared by `send` (one job) and
 * `insert` (a batch) so a batched re-drive carries EXACTLY the same singletonKey/retry/
 * expiry/heartbeat semantics as an individual `send` — the dedup linchpin can't drift
 * between the two enqueue paths.
 */
function advanceJobOptions(executionId: string, opts: AdvanceQueueOptions) {
  return {
    singletonKey: executionId,
    expireInSeconds: opts.expireInSeconds,
    heartbeatSeconds: opts.heartbeatSeconds,
    retryLimit: opts.retryLimit,
    retryDelay: opts.retryDelaySeconds,
    retryBackoff: true,
  }
}

function sendOptions(executionId: string, opts: AdvanceQueueOptions): SendOptions {
  return advanceJobOptions(executionId, opts)
}

/**
 * A batch-insert row for one advance job — the `boss.insert([...])` analogue of
 * {@link sendOptions}. `insert` compiles to a single
 * `INSERT … SELECT FROM json_to_recordset(…) ON CONFLICT DO NOTHING`, and the `exclusive`
 * queue's `(name, singleton_key)` unique index gates that conflict PER ROW — so a batched
 * re-drive dedupes exactly like N individual `send`s (a row whose run already has a live
 * advance job is a per-row no-op; the rest insert), preserving the sweeper's
 * no-double-drive guarantee while collapsing N round-trips into one.
 */
function advanceInsert(
  executionId: string,
  data: AdvanceJob,
  opts: AdvanceQueueOptions,
): JobInsert<AdvanceJob> {
  return { data, ...advanceJobOptions(executionId, opts) }
}

export class PgBossWorkRunner implements WorkRunner {
  constructor(
    private readonly boss: PgBoss,
    private readonly queueOptions: AdvanceQueueOptions,
  ) {}

  async startRun(workspaceId: string, executionId: string): Promise<void> {
    await this.boss.send(
      QUEUE,
      { workspaceId, executionId },
      sendOptions(executionId, this.queueOptions),
    )
  }

  async signalDecision(
    workspaceId: string,
    executionId: string,
    _decisionId: string,
    _choice: string,
  ): Promise<void> {
    // The decision is already persisted by resolveDecision; re-enqueue an advance so
    // the parked run resumes. The DB write is the source of truth either way.
    await this.boss.send(
      QUEUE,
      { workspaceId, executionId },
      sendOptions(executionId, this.queueOptions),
    )
  }

  async cancelRun(_workspaceId: string, _executionId: string): Promise<void> {
    // Best-effort: the run is finalized via ExecutionService.stopRun; any in-flight
    // advance job is a no-op once the run is terminal (advanceInstance returns noop).
  }
}

/**
 * Create the execution queue and start the worker that drives runs.
 *
 * `concurrency` (pg-boss `localConcurrency`) spawns that many INDEPENDENT workers for
 * the queue on this node: each polls, fetches one job (`batchSize` stays 1) and acks /
 * retries it on its own, so up to `concurrency` runs drive in parallel. This is the key
 * to throughput — a single drive parks for the whole of a step's poll budget (sleeping
 * between polls), so without parallel workers one slow run would block every other run
 * behind it. We deliberately keep `batchSize: 1` rather than raising it: a batch handler
 * completes/fails all its jobs together, which would couple unrelated runs' retries;
 * independent workers keep per-run retry semantics intact. The `exclusive` queue policy
 * still prevents the SAME run being driven by two workers at once (one live advance job per
 * run id; duplicate sends no-op). Scale `concurrency` with the DB pool
 * (each active drive borrows a connection only for its brief reads/writes between sleeps).
 */
export async function startExecutionWorker(
  boss: PgBoss,
  container: ServerContainer,
  cfg: DriveConfig,
  log: Logger,
  options: { concurrency?: number } = {},
): Promise<void> {
  const concurrency = options.concurrency ?? 10
  await boss.createQueue(QUEUE, { policy: QUEUE_POLICY })
  await boss.work<AdvanceJob>(
    QUEUE,
    { localConcurrency: Math.max(1, concurrency) },
    async (jobs: Job<AdvanceJob>[]) => {
      for (const job of jobs) {
        const { workspaceId, executionId } = job.data
        try {
          // A parked run waits for a human indefinitely — it is never failed for waiting
          // (the old decision-timeout was removed). It simply parks here; `signalDecision`
          // re-enqueues an advance when the human resolves it, and the stale-run sweeper
          // leaves a `blocked` run alone. Urgency is conveyed by the escalating notification.
          const outcome = await driveExecution(
            container.executionService,
            workspaceId,
            executionId,
            cfg,
            { log },
          )
          // An unbounded-wait gate (human-review) released after one poll budget so this job
          // doesn't outlive its expire cap. The run stays `running`; the stale-run sweeper
          // re-enqueues a fresh advance for the next poll cycle (no in-handler re-send: the
          // `exclusive` queue would suppress it while this job is still active).
          if (outcome.rearmedGate) {
            log.info({ workspaceId, executionId }, 'human-review gate re-armed; awaiting sweep')
          }
        } catch (error) {
          log.error(
            {
              workspaceId,
              executionId,
              err: error instanceof Error ? error.message : String(error),
            },
            'execution driver failed',
          )
          throw error
        }
      }
    },
  )
}

/**
 * How often the stale-run sweeper runs, how stale a `running` run must be to re-drive, and
 * how long an orphaned run may stay unrecovered before it is failed as `stalled`.
 */
export interface SweeperConfig {
  intervalMs: number
  leaseMs: number
  /**
   * Hard deadline: a `running` execution this process has been UNABLE TO RECOVER for this
   * long (its advance job stays not-live across ticks despite re-driving) is failed `stalled`
   * rather than re-driven forever — so a run orphaned by a crashed orchestrator that recovery
   * can't resume stops spinning silently and surfaces (loudly) the failure banner + retry.
   *
   * The clock is per-PROCESS (measured from the first tick that observed the run orphaned),
   * NOT the raw lease age: a long orchestrator downtime inflates `updated_at`, so keying the
   * deadline off lease age would fail an otherwise-recoverable run on the very first boot tick
   * — before recovery was even attempted. Measuring from first-observed-orphaned excludes the
   * downtime and guarantees at least one re-drive attempt before giving up.
   */
  hardStallMs: number
}

/** Queue name carrying a run kind's durable advance/drive job. */
function queueForKind(kind: string): string | null {
  if (kind === 'execution') return QUEUE
  if (kind === 'bootstrap') return BOOTSTRAP_QUEUE
  if (kind === 'env-config-repair') return ENV_CONFIG_REPAIR_QUEUE
  return null
}

/**
 * Backstop for runs still `running` in storage but whose durable advance job is gone or
 * orphaned (the worker crashed/was evicted). Mirrors — and now matches the recovery power
 * of — the Worker's cron `sweepStuckRuns`.
 *
 * Per stale run, the sweeper first classifies its advance job by pg-boss's own heartbeat
 * (see {@link classifyAdvanceJob}), because the `exclusive` queue makes a bare re-`send` a
 * no-op while ANY advance job exists — which previously left an ORPHANED-`active` run (job
 * stuck active, worker dead, heartbeat frozen) permanently un-recoverable by this sweeper:
 *
 * - `live`     — a real drive is running (or a job is queued to run). Leave it.
 * - `orphaned` — reclaim the dead job to free its singletonKey, then re-drive (or fail).
 * - `missing`  — re-drive directly.
 *
 * An execution this process has been unable to recover for `hardStallMs` (measured from the
 * first tick that saw it orphaned, so a long downtime doesn't count) is failed `stalled`
 * instead of re-driven forever, so an unrecoverable run doesn't spin `running` forever — but
 * every orphan still gets at least one re-drive attempt first. Decision-parked (`blocked`)
 * and spend-paused (`paused`) runs aren't `running`, so they're left alone. Returns a stop
 * function; also runs one tick immediately (boot reconcile — recover runs a crashed previous
 * process orphaned without waiting a full interval).
 */
export function startStaleRunSweeper(
  boss: PgBoss,
  jobs: JobStore,
  container: ServerContainer,
  cfg: SweeperConfig,
  queueOptions: AdvanceQueueOptions,
  log: Logger,
): () => void {
  // A live drive heartbeats its active job every `heartbeatSeconds`; treat a heartbeat older
  // than a generous multiple of that (but at least the lease) as a dead worker.
  const staleHeartbeatMs = Math.max(cfg.leaseMs, queueOptions.heartbeatSeconds * 1000 * 3)
  // Per-PROCESS "first observed orphaned" clock, keyed by run id. The hard-stall deadline is
  // measured from this — NOT the raw lease age — so a long orchestrator downtime (which
  // inflates `updated_at`) can't fail an otherwise-recoverable run before recovery is even
  // attempted. Entries are dropped once a run recovers or leaves the stale set.
  const orphanedSince = new Map<string, number>()
  const tick = async () => {
    try {
      const now = Date.now()
      const stale = await container.agentRunRepository.listStale(now - cfg.leaseMs)
      const stillOrphaned = new Set<string>()
      // Every `execution.advance` re-drive this tick decides on — stale re-drives below AND
      // spend-paused resumes further down — is gathered here and flushed as ONE batch
      // `insert` instead of a `send` per run. singletonKeys are distinct across the batch
      // (a run is either `running`/stale or `paused`, never both in one tick), so no row
      // conflicts with another in the same insert; each conflicts only with its own already
      // -live advance job, which the exclusive index no-ops per row. (Bootstrap /
      // env-config-repair re-drives target other queues via their own helpers and are left
      // as individual sends — different queue, typically N=1.)
      const advanceReenqueues: JobInsert<AdvanceJob>[] = []
      for (const ref of stale) {
        const queue = queueForKind(ref.kind)
        if (!queue) continue

        // Distinguish a healthy long drive (heartbeating) from an orphaned job whose worker
        // died, so we recover the orphan instead of silently no-op re-sending onto it.
        const { state, jobId } = await classifyAdvanceJob(
          jobs,
          queue,
          ref.id,
          staleHeartbeatMs,
          now,
        )
        if (state === 'live') {
          orphanedSince.delete(ref.id)
          continue
        }
        // Start (or carry forward) this run's per-process orphaned clock.
        const firstSeenOrphaned = orphanedSince.get(ref.id) ?? now
        orphanedSince.set(ref.id, firstSeenOrphaned)
        stillOrphaned.add(ref.id)

        if (state === 'orphaned' && jobId) {
          log.warn(
            { workspaceId: ref.workspaceId, runId: ref.id, kind: ref.kind, jobId },
            'reclaiming orphaned advance job (dead worker) before re-drive',
          )
          await reclaimAdvanceJob(boss, queue, jobId).catch((err) =>
            log.error(
              { runId: ref.id, err: err instanceof Error ? err.message : String(err) },
              'failed to reclaim orphaned advance job',
            ),
          )
        }

        // Hard-stall backstop (execution only): a run this process has been unable to recover
        // for the whole deadline — re-driven on earlier ticks yet still not live — is failed
        // rather than left spinning `running`. Gated on the per-process clock (not lease age),
        // so a run first seen orphaned this tick (e.g. right after a long downtime) is always
        // re-driven at least once below before it can ever be given up on.
        if (ref.kind === 'execution' && now - firstSeenOrphaned > cfg.hardStallMs) {
          const mins = Math.round((now - ref.updatedAt) / 60_000)
          log.warn(
            { workspaceId: ref.workspaceId, executionId: ref.id, staleMinutes: mins },
            'run stalled past hard deadline; recovery could not resume it; failing',
          )
          await container.executionService.failRun(
            ref.workspaceId,
            ref.id,
            `Run stalled: no progress for ${mins} minutes and recovery could not resume it.`,
            'stalled',
            null,
          )
          orphanedSince.delete(ref.id)
          stillOrphaned.delete(ref.id)
          continue
        }

        if (ref.kind === 'bootstrap') {
          log.warn({ workspaceId: ref.workspaceId, jobId: ref.id }, 're-driving stale bootstrap')
          await reenqueueStaleBootstrap(boss, ref.workspaceId, ref.id, queueOptions)
          continue
        }
        if (ref.kind === 'env-config-repair') {
          log.warn(
            { workspaceId: ref.workspaceId, jobId: ref.id },
            're-driving stale env-config-repair',
          )
          await reenqueueStaleEnvConfigRepair(boss, ref.workspaceId, ref.id, queueOptions)
          continue
        }
        log.warn({ workspaceId: ref.workspaceId, executionId: ref.id }, 're-driving stale run')
        advanceReenqueues.push(
          advanceInsert(
            ref.id,
            { workspaceId: ref.workspaceId, executionId: ref.id },
            queueOptions,
          ),
        )
      }
      // Forget runs that recovered (bumped their lease → left the stale set) or went terminal,
      // so their per-process orphaned clock restarts if they ever stall again.
      for (const id of orphanedSince.keys()) {
        if (!stillOrphaned.has(id)) orphanedSince.delete(id)
      }

      // Auto-resume spend-paused runs once the monthly budget frees (parity with the Cloudflare
      // ExecutionWorkflow, whose parked instance re-checks the budget itself). `listStale` skips
      // `paused` runs, so re-check them here: re-drive ONLY those whose WORKSPACE and ACCOUNT
      // tiers are both back under budget — a still-exhausted workspace/account causes no churn.
      // Both are keyed only by the workspace (a workspace has one owning account), so the check
      // is cached per distinct workspace, not per run. The USER tier is deliberately NOT checked
      // here: it needs the run's initiator, which the lightweight paused ref doesn't carry, so a
      // run paused solely on a user cap is re-driven and the tier-aware step gate in
      // `ExecutionService.stepInstance` re-pauses it (a bounded, per-sweep one-step blip, not an
      // un-gated run). So this is a best-effort resume, not a proof the run will advance.
      const paused = await container.agentRunRepository.listPausedExecutions()
      const exhaustedByWorkspace = new Map<string, boolean>()
      const accountByWorkspace = new Map<string, string | null>()
      for (const ref of paused) {
        let exhausted = exhaustedByWorkspace.get(ref.workspaceId)
        if (exhausted === undefined) {
          let accountId = accountByWorkspace.get(ref.workspaceId)
          if (accountId === undefined) {
            accountId = (await container.workspaceService.accountOf(ref.workspaceId)) ?? null
            accountByWorkspace.set(ref.workspaceId, accountId)
          }
          exhausted = await container.spendService.isOverBudget(ref.workspaceId, { accountId })
          exhaustedByWorkspace.set(ref.workspaceId, exhausted)
        }
        if (exhausted) continue
        log.info(
          { workspaceId: ref.workspaceId, executionId: ref.id },
          're-driving spend-paused run (workspace/account budget free; step gate re-checks the user tier)',
        )
        advanceReenqueues.push(
          advanceInsert(
            ref.id,
            { workspaceId: ref.workspaceId, executionId: ref.id },
            queueOptions,
          ),
        )
      }

      // One batch insert for every execution.advance re-drive gathered this tick (stale
      // re-drives + spend-paused resumes), replacing N per-run `send` round-trips.
      if (advanceReenqueues.length > 0) await boss.insert(QUEUE, advanceReenqueues)
    } catch (error) {
      log.error(
        { err: error instanceof Error ? error.message : String(error) },
        'stale-run sweep failed',
      )
    }
  }
  // Boot reconcile: recover runs a crashed previous process orphaned right away, not after
  // one full interval (the incident that motivated this: a restart left a run frozen).
  void tick()
  const timer = setInterval(() => void tick(), cfg.intervalMs)
  timer.unref?.() // never keep the process alive on the sweep timer alone
  return () => clearInterval(timer)
}
