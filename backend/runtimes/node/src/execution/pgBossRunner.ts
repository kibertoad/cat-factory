import type { WorkRunner } from '@cat-factory/kernel'
import type { Logger, ServerContainer } from '@cat-factory/server'
import type { Job, PgBoss, SendOptions } from 'pg-boss'
import { type DriveConfig, driveExecution } from './drive.js'

// Durable execution on pg-boss: the analogue of the Worker's Cloudflare Workflows
// driver. `startRun` enqueues an advance job (deduped per run via singletonKey); a
// registered worker drives the run to a standstill via `driveExecution`. A resolved
// decision re-enqueues an advance to resume a parked run. State lives in Postgres,
// so a crash mid-run is recovered two ways: pg-boss retries an expired/failed advance
// job, and the stale-run sweeper re-enqueues runs still `running` in storage.

const QUEUE = 'execution.advance'

interface AdvanceJob {
  workspaceId: string
  executionId: string
}

/**
 * Send options for an advance job. `singletonKey` (the run id) is the linchpin: while
 * an advance job for a run is active/queued, pg-boss suppresses any duplicate send —
 * so re-enqueues from `signalDecision` and the stale-run sweeper are safe no-ops for a
 * run that is still being driven, and only take effect once the prior job is gone. That
 * lets the sweeper use a short lease without ever double-driving a healthy run.
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
 * independent workers keep per-run retry semantics intact. `singletonKey` still prevents
 * the SAME run being driven by two workers at once. Scale `concurrency` with the DB pool
 * (each active drive borrows a connection only for its brief reads/writes between sleeps).
 */
export async function startExecutionWorker(
  boss: PgBoss,
  container: ServerContainer,
  cfg: DriveConfig,
  log: Logger,
  concurrency = 10,
): Promise<void> {
  await boss.createQueue(QUEUE)
  await boss.work<AdvanceJob>(
    QUEUE,
    { localConcurrency: Math.max(1, concurrency) },
    async (jobs: Job<AdvanceJob>[]) => {
      for (const job of jobs) {
        const { workspaceId, executionId } = job.data
        try {
          await driveExecution(container.executionService, workspaceId, executionId, cfg, log)
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

/** How often the stale-run sweeper runs, and how stale a `running` run must be to re-drive. */
export interface SweeperConfig {
  intervalMs: number
  leaseMs: number
}

/**
 * Backstop for runs that are still `running` in storage but whose advance job is gone
 * (the worker crashed/was evicted before the job retried). Mirrors the Worker's cron
 * `sweepStuckRuns`: on each tick it re-enqueues every stale `running` execution run.
 * The re-enqueue carries the run's `singletonKey`, so a run that IS still being driven
 * (its advance job active) is a silent no-op — only genuinely orphaned runs re-drive.
 * Decision-parked (`blocked`) and spend-paused (`paused`) runs aren't `running`, so the
 * sweeper leaves them alone. Returns a stop function (clears the interval).
 */
export function startStaleRunSweeper(
  boss: PgBoss,
  container: ServerContainer,
  cfg: SweeperConfig,
  queueOptions: AdvanceQueueOptions,
  log: Logger,
): () => void {
  const tick = async () => {
    try {
      const stale = await container.agentRunRepository.listStale(Date.now() - cfg.leaseMs)
      for (const ref of stale) {
        if (ref.kind !== 'execution') continue // bootstrap isn't durable on Node yet
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
  const timer = setInterval(() => void tick(), cfg.intervalMs)
  timer.unref?.() // never keep the process alive on the sweep timer alone
  return () => clearInterval(timer)
}
