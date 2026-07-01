import type { WorkRunner } from '@cat-factory/kernel'
import type { Logger, ServerContainer } from '@cat-factory/server'
import type { Job, PgBoss, SendOptions } from 'pg-boss'
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

function sendOptions(executionId: string, opts: AdvanceQueueOptions): SendOptions {
  return {
    singletonKey: executionId,
    expireInSeconds: opts.expireInSeconds,
    heartbeatSeconds: opts.heartbeatSeconds,
    retryLimit: opts.retryLimit,
    retryDelay: opts.retryDelaySeconds,
    retryBackoff: true,
  }
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
   * Hard deadline: a `running` execution whose lease has been stale this long AND whose
   * advance job is not live is failed `stalled` rather than re-driven forever — so a run
   * orphaned by a crashed orchestrator that recovery can't resume stops spinning silently
   * and surfaces (loudly) the failure banner + retry instead.
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
 * An execution orphaned past `hardStallMs` is failed `stalled` instead of re-driven, so an
 * unrecoverable run doesn't spin `running` forever. Decision-parked (`blocked`) and
 * spend-paused (`paused`) runs aren't `running`, so they're left alone. Returns a stop
 * function; also runs one tick immediately (boot reconcile — recover runs a crashed
 * previous process orphaned without waiting a full interval).
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
  const tick = async () => {
    try {
      const now = Date.now()
      const stale = await container.agentRunRepository.listStale(now - cfg.leaseMs)
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
        if (state === 'live') continue
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

        // Hard-stall backstop (execution only): an orphaned run that recovery cannot resume
        // within the deadline is failed rather than left spinning `running` with no progress.
        if (ref.kind === 'execution' && now - ref.updatedAt > cfg.hardStallMs) {
          const mins = Math.round((now - ref.updatedAt) / 60_000)
          log.warn(
            { workspaceId: ref.workspaceId, executionId: ref.id, staleMinutes: mins },
            'run stalled past hard deadline with no live driver; failing',
          )
          await container.executionService.failRun(
            ref.workspaceId,
            ref.id,
            `Run stalled: no progress for ${mins} minutes and its durable driver was gone.`,
            'stalled',
            null,
          )
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
        await boss.send(
          QUEUE,
          { workspaceId: ref.workspaceId, executionId: ref.id },
          sendOptions(ref.id, queueOptions),
        )
      }
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
