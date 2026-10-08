import { describeError, guidedReviewJobKey } from '@cat-factory/kernel'
import type { GuidedReviewJob, GuidedReviewRunner, OperationalMetrics } from '@cat-factory/kernel'
import type { Logger, ServerContainer, SweepHealthTracker } from '@cat-factory/server'
import type { Job, PgBoss } from 'pg-boss'
import { createQueueWithDeadLetter } from './deadLetter.js'
import type { AdvanceQueueOptions } from './pgBossRunner.js'
import { driveJobOptions } from './pgBossRunner.js'
import { startSweeper } from '../sweeper.js'

// Durable guided-review driving on pg-boss: the analogue of the Worker's GuidedReviewWorkflow.
// `start` enqueues one job per piece of work, deduped per job key by the `exclusive` queue, and
// the worker hands it to `GuidedReviewService.runJob`, whose own claim makes a redelivery a no-op.

const QUEUE = 'guided-review.run'
const QUEUE_POLICY = 'exclusive' as const

interface GuidedReviewQueueJob {
  workspaceId: string
  job: GuidedReviewJob
}

export class PgBossGuidedReviewRunner implements GuidedReviewRunner {
  constructor(
    private readonly boss: PgBoss,
    private readonly queueOptions: AdvanceQueueOptions,
  ) {}

  async start(workspaceId: string, job: GuidedReviewJob): Promise<void> {
    await this.boss.send(
      QUEUE,
      { workspaceId, job } satisfies GuidedReviewQueueJob,
      driveJobOptions(guidedReviewJobKey(job), this.queueOptions),
    )
  }
}

/** Create the guided-review queue and start the worker that runs its jobs. */
export async function startGuidedReviewWorker(
  boss: PgBoss,
  container: ServerContainer,
  log: Logger,
  options: { concurrency?: number } = {},
): Promise<void> {
  const concurrency = Math.max(1, options.concurrency ?? 10)
  await createQueueWithDeadLetter(boss, QUEUE, { policy: QUEUE_POLICY })
  await boss.work<GuidedReviewQueueJob>(
    QUEUE,
    { localConcurrency: concurrency },
    async (jobs: Job<GuidedReviewQueueJob>[]) => {
      for (const { data } of jobs) {
        const service = container.guidedReview?.service
        if (!service) return
        try {
          await service.runJob(data.workspaceId, data.job)
        } catch (error) {
          log.error('guided-review job failed', {
            workspaceId: data.workspaceId,
            job: guidedReviewJobKey(data.job),
            ...describeError(error),
          })
          throw error
        }
      }
    },
  )
}

/**
 * Backstop for a job whose wake was lost or whose worker died mid-claim: re-wake this
 * deployment's jobs whose lease lapsed. The queue's singleton key drops a re-wake for a job that
 * is already queued.
 */
export function startGuidedReviewSweeper(
  container: ServerContainer,
  cfg: { intervalMs: number },
  log: Logger,
  metrics: OperationalMetrics,
  health: SweepHealthTracker,
): () => void {
  return startSweeper({
    name: 'guided-review',
    intervalMs: cfg.intervalMs,
    log,
    health,
    failureMessage: 'guided-review sweep failed',
    tick: async () => {
      const service = container.guidedReview?.service
      if (!service) return
      const redriven = await service.redriveStale()
      if (redriven > 0) {
        log.warn('re-drove stale guided-review jobs', { redriven })
        metrics.increment('sweep.run_redriven', { kind: 'guided-review' }, redriven)
      }
    },
  })
}
