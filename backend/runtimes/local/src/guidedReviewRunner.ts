import type { GuidedReviewJob, GuidedReviewRunner, Logger } from '@cat-factory/kernel'
import { getErrorMessage, runBestEffort } from '@cat-factory/kernel'
import type { ClaimedGuidedReviewJob, SqliteGuidedReviewQueue } from './sqlite/guidedReviewQueue.js'

export interface SqliteGuidedReviewRunnerOptions {
  /** How long a claim holds before a later drain may take the job over (a crash). */
  leaseMs: number
  /** Pause before retrying a job whose drive threw. */
  errorBackoffMs: number
  sweepIntervalMs: number
  /** Consecutive failed drives before a job is dropped. */
  maxAttempts: number
  concurrency: number
}

/** The slice of `GuidedReviewService` the runner drives. */
export interface GuidedReviewJobDriver {
  runJob(workspaceId: string, job: GuidedReviewJob): Promise<void>
  abandonJob(workspaceId: string, job: GuidedReviewJob, detail: string): Promise<void>
}

/**
 * Drives guided-review jobs on a mothership-mode node, which has no pg-boss. The intent is
 * persisted in a local `node:sqlite` queue so a restart re-drives what was in flight; the node
 * never scans the mothership for stale jobs, so this queue is its only recovery.
 */
export class SqliteGuidedReviewRunner implements GuidedReviewRunner {
  private driver?: GuidedReviewJobDriver
  private readonly running = new Set<string>()
  private sweepTimer?: ReturnType<typeof setInterval>
  private stopped = false

  constructor(
    private readonly queue: SqliteGuidedReviewQueue,
    private readonly opts: SqliteGuidedReviewRunnerOptions,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  /** Bind the service once the container exists, recover orphans and start the periodic drain. */
  bind(driver: GuidedReviewJobDriver | undefined): void {
    if (!driver) return
    this.driver = driver
    const orphans = this.queue.resetOrphans()
    if (orphans > 0) {
      this.log.warn('guided-review queue: re-driving jobs orphaned by a prior process', { orphans })
    }
    this.drain()
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    this.sweepTimer = setInterval(() => this.drain(), this.opts.sweepIntervalMs)
    this.sweepTimer.unref?.()
  }

  stop(): void {
    this.stopped = true
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    this.sweepTimer = undefined
  }

  async start(workspaceId: string, job: GuidedReviewJob): Promise<void> {
    this.queue.enqueue(workspaceId, job, this.now())
    this.drain()
  }

  private drain(): void {
    const driver = this.driver
    if (!driver || this.stopped) return
    for (const dropped of this.queue.evictExhausted(this.now(), this.opts.maxAttempts)) {
      this.log.error('guided-review job dropped after repeated failures', {
        workspaceId: dropped.workspaceId,
        job: dropped.key,
        attempts: dropped.attempts,
      })
      // Settle the row too, or the mothership keeps it live and its thread reads as busy forever.
      void runBestEffort(
        this.log,
        'guidedReview.abandon',
        () =>
          driver.abandonJob(
            dropped.workspaceId,
            dropped.job,
            `The local queue gave up after ${dropped.attempts} failed attempts`,
          ),
        { workspaceId: dropped.workspaceId, job: dropped.key },
      )
    }
    while (this.running.size < this.opts.concurrency) {
      const claimed = this.queue.claim(this.now(), this.opts.leaseMs, this.running)
      if (!claimed) return
      this.running.add(claimed.key)
      void this.drive(driver, claimed)
    }
  }

  private async drive(
    driver: GuidedReviewJobDriver,
    claimed: ClaimedGuidedReviewJob,
  ): Promise<void> {
    try {
      await driver.runJob(claimed.workspaceId, claimed.job)
      this.queue.complete(claimed.key)
    } catch (error) {
      this.log.warn('guided-review job failed; retrying after backoff', {
        workspaceId: claimed.workspaceId,
        job: claimed.key,
        err: getErrorMessage(error),
      })
      this.queue.deferFailure(claimed.key, this.now() + this.opts.errorBackoffMs)
    } finally {
      this.running.delete(claimed.key)
      this.drain()
    }
  }
}
