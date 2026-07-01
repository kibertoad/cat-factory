import type { BootstrapRunner } from '@cat-factory/kernel'
import type { Logger, ServerContainer } from '@cat-factory/server'
import type { Job, PgBoss, SendOptions } from 'pg-boss'
import type { AdvanceQueueOptions } from './pgBossRunner.js'
import type { DriveConfig } from './drive.js'

// Durable bootstrap driving on pg-boss: the analogue of the Worker's BootstrapWorkflow
// (and a sibling of the execution PgBossWorkRunner). `startRun` enqueues a drive job
// (deduped per job via the `exclusive` queue + singletonKey); a registered worker polls
// `BootstrapService.pollBootstrapJob` until the run reaches a terminal state. The job
// record in Postgres is authoritative, so a crash mid-run is recovered by pg-boss's
// retry of the expired/failed drive job and by the stale-run sweeper (which now re-drives
// stale `bootstrap` runs too).

export const BOOTSTRAP_QUEUE = 'bootstrap.advance'
const QUEUE = BOOTSTRAP_QUEUE
// `exclusive` so (queue, singletonKey=jobId) is unique across created/active/retry — at
// most one drive job per bootstrap run alive, and duplicate sends are no-ops. Mirrors the
// execution advance queue.
const QUEUE_POLICY = 'exclusive' as const

interface BootstrapJob {
  workspaceId: string
  jobId: string
}

function sendOptions(jobId: string, opts: AdvanceQueueOptions): SendOptions {
  return {
    singletonKey: jobId,
    expireInSeconds: opts.expireInSeconds,
    heartbeatSeconds: opts.heartbeatSeconds,
    retryLimit: opts.retryLimit,
    retryDelay: opts.retryDelaySeconds,
    retryBackoff: true,
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Poll a bootstrap run to a terminal state, sleeping between polls — the Node analogue
 * of the BootstrapWorkflow's `step.sleep` + `pollBootstrapJob` loop, with plain async
 * sleeps instead of durable steps. `pollBootstrapJob` is idempotent and persists every
 * change, so a re-drive (retry/sweeper) safely resumes. Returns when the run is done or
 * failed, or when the poll budget is spent (the sweeper re-drives a still-running run).
 */
export async function driveBootstrap(
  container: ServerContainer,
  workspaceId: string,
  jobId: string,
  cfg: DriveConfig,
  log: Logger,
): Promise<void> {
  const bootstrap = container.bootstrap
  if (!bootstrap) return
  for (let p = 0; p < cfg.jobMaxPolls; p++) {
    const result = await bootstrap.service.pollBootstrapJob(workspaceId, jobId)
    if (result.state === 'done' || result.state === 'failed') return
    await sleep(cfg.jobPollIntervalMs)
  }
  log.warn(
    { workspaceId, jobId },
    'bootstrap drive exhausted its poll budget; sweeper will re-drive',
  )
}

export class PgBossBootstrapRunner implements BootstrapRunner {
  constructor(
    private readonly boss: PgBoss,
    private readonly queueOptions: AdvanceQueueOptions,
  ) {}

  async startRun(workspaceId: string, jobId: string): Promise<void> {
    await this.boss.send(QUEUE, { workspaceId, jobId }, sendOptions(jobId, this.queueOptions))
  }

  async cancelRun(_workspaceId: string, _jobId: string): Promise<void> {
    // Best-effort: the job is finalized by BootstrapService; any in-flight drive job is a
    // no-op once the job is terminal (pollBootstrapJob returns done/failed immediately).
  }
}

/** Create the bootstrap drive queue and start the worker that drives bootstrap runs. */
export async function startBootstrapWorker(
  boss: PgBoss,
  container: ServerContainer,
  cfg: DriveConfig,
  log: Logger,
  options: { concurrency?: number } = {},
): Promise<void> {
  const concurrency = Math.max(1, options.concurrency ?? 10)
  await boss.createQueue(QUEUE, { policy: QUEUE_POLICY })
  await boss.work<BootstrapJob>(
    QUEUE,
    { localConcurrency: concurrency },
    async (jobs: Job<BootstrapJob>[]) => {
      for (const job of jobs) {
        const { workspaceId, jobId } = job.data
        try {
          await driveBootstrap(container, workspaceId, jobId, cfg, log)
        } catch (error) {
          log.error(
            { workspaceId, jobId, err: error instanceof Error ? error.message : String(error) },
            'bootstrap drive failed',
          )
          throw error // let pg-boss retry/backoff (the durable backstop)
        }
      }
    },
  )
}

/** Re-enqueue a stale bootstrap run (used by the stale-run sweeper). */
export async function reenqueueStaleBootstrap(
  boss: PgBoss,
  workspaceId: string,
  jobId: string,
  queueOptions: AdvanceQueueOptions,
): Promise<void> {
  await boss.send(QUEUE, { workspaceId, jobId }, sendOptions(jobId, queueOptions))
}
