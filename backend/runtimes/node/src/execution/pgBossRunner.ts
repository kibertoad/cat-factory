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
 * and let a second driver start. `retryLimit`/`retryBackoff` make pg-boss itself
 * re-drive a job that throws or expires (a crashed worker), the durable backstop.
 */
export interface AdvanceQueueOptions {
  expireInSeconds: number
  retryLimit: number
  retryDelaySeconds: number
}

function sendOptions(executionId: string, opts: AdvanceQueueOptions): SendOptions {
  return {
    singletonKey: executionId,
    expireInSeconds: opts.expireInSeconds,
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

/** Create the execution queue and start the worker that drives runs. */
export async function startExecutionWorker(
  boss: PgBoss,
  container: ServerContainer,
  cfg: DriveConfig,
  log: Logger,
): Promise<void> {
  await boss.createQueue(QUEUE)
  await boss.work<AdvanceJob>(QUEUE, async (jobs: Job<AdvanceJob>[]) => {
    for (const job of jobs) {
      const { workspaceId, executionId } = job.data
      try {
        await driveExecution(container.executionService, workspaceId, executionId, cfg, log)
      } catch (error) {
        log.error(
          { workspaceId, executionId, err: error instanceof Error ? error.message : String(error) },
          'execution driver failed',
        )
        throw error
      }
    }
  })
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
