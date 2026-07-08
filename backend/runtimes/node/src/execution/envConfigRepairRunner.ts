import type { EnvConfigRepairRunner } from '@cat-factory/kernel'
import type { Logger, ServerContainer } from '@cat-factory/server'
import type { Job, PgBoss, SendOptions } from 'pg-boss'
import type { AdvanceQueueOptions } from './pgBossRunner.js'
import type { DriveConfig } from './drive.js'

// Durable env-config-repair driving on pg-boss: the analogue of the Worker's
// EnvConfigRepairWorkflow (and a sibling of PgBossBootstrapRunner). `startRun` enqueues a
// drive job (deduped per job via the `exclusive` queue + singletonKey); a registered worker
// polls `EnvConfigRepairService.pollJob` until the run reaches a terminal state. The job
// record in Postgres is authoritative, so a crash mid-run is recovered by pg-boss's retry of
// the expired/failed drive job and by the stale-run sweeper (which re-drives stale
// `env-config-repair` runs too).

export const ENV_CONFIG_REPAIR_QUEUE = 'env-config-repair.advance'
const QUEUE = ENV_CONFIG_REPAIR_QUEUE
// `exclusive` so (queue, singletonKey=jobId) is unique across created/active/retry — at most
// one drive job per repair run alive, and duplicate sends are no-ops.
const QUEUE_POLICY = 'exclusive' as const

interface EnvConfigRepairJob {
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
 * Poll an env-config-repair run to a terminal state, sleeping between polls — the Node
 * analogue of the EnvConfigRepairWorkflow's `step.sleep` + `pollJob` loop, with plain async
 * sleeps instead of durable steps. `pollJob` is idempotent and persists every change (and
 * re-validates the repo on success), so a re-drive (retry/sweeper) safely resumes. Returns
 * when the run is done or failed, or when the poll budget is spent (the sweeper re-drives a
 * still-running run).
 */
async function driveEnvConfigRepair(
  container: ServerContainer,
  workspaceId: string,
  jobId: string,
  cfg: DriveConfig,
  log: Logger,
): Promise<void> {
  const repair = container.envConfigRepair
  if (!repair) return
  for (let p = 0; p < cfg.jobMaxPolls; p++) {
    const result = await repair.service.pollJob(workspaceId, jobId)
    if (result.state === 'done' || result.state === 'failed') return
    await sleep(cfg.jobPollIntervalMs)
  }
  log.warn(
    { workspaceId, jobId },
    'env-config-repair drive exhausted its poll budget; sweeper will re-drive',
  )
}

export class PgBossEnvConfigRepairRunner implements EnvConfigRepairRunner {
  constructor(
    private readonly boss: PgBoss,
    private readonly queueOptions: AdvanceQueueOptions,
  ) {}

  async startRun(workspaceId: string, jobId: string): Promise<void> {
    await this.boss.send(QUEUE, { workspaceId, jobId }, sendOptions(jobId, this.queueOptions))
  }

  async cancelRun(_workspaceId: string, _jobId: string): Promise<void> {
    // Best-effort: the job is finalized by EnvConfigRepairService; any in-flight drive job is
    // a no-op once the job is terminal (pollJob returns done/failed immediately).
  }
}

/** Create the repair drive queue and start the worker that drives env-config-repair runs. */
export async function startEnvConfigRepairWorker(
  boss: PgBoss,
  container: ServerContainer,
  cfg: DriveConfig,
  log: Logger,
  options: { concurrency?: number } = {},
): Promise<void> {
  const concurrency = Math.max(1, options.concurrency ?? 10)
  await boss.createQueue(QUEUE, { policy: QUEUE_POLICY })
  await boss.work<EnvConfigRepairJob>(
    QUEUE,
    { localConcurrency: concurrency },
    async (jobs: Job<EnvConfigRepairJob>[]) => {
      for (const job of jobs) {
        const { workspaceId, jobId } = job.data
        try {
          await driveEnvConfigRepair(container, workspaceId, jobId, cfg, log)
        } catch (error) {
          log.error(
            { workspaceId, jobId, err: error instanceof Error ? error.message : String(error) },
            'env-config-repair drive failed',
          )
          throw error // let pg-boss retry/backoff (the durable backstop)
        }
      }
    },
  )
}

/** Re-enqueue a stale env-config-repair run (used by the stale-run sweeper). */
export async function reenqueueStaleEnvConfigRepair(
  boss: PgBoss,
  workspaceId: string,
  jobId: string,
  queueOptions: AdvanceQueueOptions,
): Promise<void> {
  await boss.send(QUEUE, { workspaceId, jobId }, sendOptions(jobId, queueOptions))
}
