import type { EnvironmentTestRunner, EnvironmentTestRunRepository } from '@cat-factory/kernel'
import type { Logger, ServerContainer } from '@cat-factory/server'
import type { Job, PgBoss, SendOptions } from 'pg-boss'
import type { AdvanceQueueOptions } from './pgBossRunner.js'
import type { DriveConfig } from './drive.js'

// Durable ephemeral-environment self-test driving on pg-boss: the analogue of the Worker's
// EnvironmentTestWorkflow (and a sibling of the bootstrap/env-config-repair drivers).
// `startRun` enqueues a drive job (deduped per run via the `exclusive` queue + singletonKey);
// a registered worker calls `EnvironmentTestService.pollEnvTest` until the run reaches a
// terminal state. The run record in Postgres is authoritative, so a crash mid-run is
// recovered by pg-boss's retry of the expired/failed drive job.

export const ENV_TEST_QUEUE = 'env-test.advance'
const QUEUE = ENV_TEST_QUEUE
// `exclusive` so (queue, singletonKey=runId) is unique across created/active/retry — at most
// one drive job per self-test run alive. Mirrors the bootstrap/execution advance queues.
const QUEUE_POLICY = 'exclusive' as const

interface EnvTestJob {
  workspaceId: string
  id: string
}

function sendOptions(id: string, opts: AdvanceQueueOptions): SendOptions {
  return {
    singletonKey: id,
    expireInSeconds: opts.expireInSeconds,
    heartbeatSeconds: opts.heartbeatSeconds,
    retryLimit: opts.retryLimit,
    retryDelay: opts.retryDelaySeconds,
    retryBackoff: true,
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Advance a self-test run to a terminal state, sleeping between polls — the Node analogue of
 * the EnvironmentTestWorkflow's `step.sleep` + `pollEnvTest` loop, with plain async sleeps
 * instead of durable steps. `pollEnvTest` is idempotent and persists every change, so a
 * re-drive (retry) safely resumes.
 */
async function driveEnvTest(
  container: ServerContainer,
  workspaceId: string,
  id: string,
  cfg: DriveConfig,
  log: Logger,
): Promise<void> {
  const service = container.environments?.environmentTest
  if (!service) return
  for (let p = 0; p < cfg.jobMaxPolls; p++) {
    const result = await service.pollEnvTest(workspaceId, id)
    if (result.state === 'done' || result.state === 'failed') return
    await sleep(cfg.jobPollIntervalMs)
  }
  // Budget exhausted: finalize the run HERE (best-effort cleanup + failed) — this drive
  // job is about to COMPLETE (not fail), so pg-boss will never retry it and nothing else
  // would ever settle the run. The stale-run sweep below is only the backstop for a
  // drive whose worker died.
  log.warn({ workspaceId, id }, 'env-test drive exhausted its poll budget; finalizing as failed')
  await service.expire(
    workspaceId,
    id,
    'The environment test did not finish within its polling budget.',
  )
}

export class PgBossEnvironmentTestRunner implements EnvironmentTestRunner {
  constructor(
    private readonly boss: PgBoss,
    private readonly queueOptions: AdvanceQueueOptions,
  ) {}

  async startRun(workspaceId: string, id: string): Promise<void> {
    await this.boss.send(QUEUE, { workspaceId, id }, sendOptions(id, this.queueOptions))
  }

  async cancelRun(_workspaceId: string, _id: string): Promise<void> {
    // Best-effort: the run is finalized by EnvironmentTestService; any in-flight drive job is
    // a no-op once the run is terminal (pollEnvTest returns done/failed immediately).
  }
}

/**
 * Backstop for self-test runs whose drive job died with the worker (or was never
 * enqueued): re-enqueue a drive for every stale `running` run. Env-test runs live in
 * their own `environment_test_runs` table, so `startStaleRunSweeper` (agent_runs) never
 * sees them. Re-driving is always safe: the `exclusive` queue + `singletonKey=runId`
 * drops the send when a drive job is already alive, and `pollEnvTest` is idempotent. A
 * re-driven run that still can't finish is settled by the drive's own budget-exhaustion
 * finalize above, so this can't loop a wedged run forever.
 */
export function startEnvTestSweeper(
  runner: EnvironmentTestRunner,
  repository: Pick<EnvironmentTestRunRepository, 'listStale'>,
  cfg: { leaseMs: number; intervalMs: number },
  log: Logger,
): () => void {
  const tick = async () => {
    try {
      const stale = await repository.listStale(Date.now() - cfg.leaseMs)
      for (const run of stale) {
        log.warn(
          { workspaceId: run.workspaceId, runId: run.id, stage: run.stage },
          're-driving stale env-test run',
        )
        await runner.startRun(run.workspaceId, run.id)
      }
    } catch (error) {
      log.error(
        { err: error instanceof Error ? error.message : String(error) },
        'env-test sweep failed',
      )
    }
  }
  const timer = setInterval(() => void tick(), cfg.intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}

/** Create the env-test drive queue and start the worker that drives self-test runs. */
export async function startEnvTestWorker(
  boss: PgBoss,
  container: ServerContainer,
  cfg: DriveConfig,
  log: Logger,
  options: { concurrency?: number } = {},
): Promise<void> {
  const concurrency = Math.max(1, options.concurrency ?? 10)
  await boss.createQueue(QUEUE, { policy: QUEUE_POLICY })
  await boss.work<EnvTestJob>(
    QUEUE,
    { localConcurrency: concurrency },
    async (jobs: Job<EnvTestJob>[]) => {
      for (const job of jobs) {
        const { workspaceId, id } = job.data
        try {
          await driveEnvTest(container, workspaceId, id, cfg, log)
        } catch (error) {
          log.error(
            { workspaceId, id, err: error instanceof Error ? error.message : String(error) },
            'env-test drive failed',
          )
          throw error // let pg-boss retry/backoff (the durable backstop)
        }
      }
    },
  )
}
