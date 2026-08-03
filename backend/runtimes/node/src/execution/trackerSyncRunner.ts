import type { Logger, ServerContainer, TrackerWebhookIngest } from '@cat-factory/server'
import { createQueueWithDeadLetter } from './deadLetter.js'
import type { TrackerWebhookEvent } from '@cat-factory/kernel'
import type { Job, PgBoss, SendOptions } from 'pg-boss'

// Async TRACKER ingest on pg-boss: the Node analogue of the Worker's `TRACKER_SYNC_QUEUE`
// consumer, and a deliberate copy of `githubSyncRunner.ts`'s shape for the same reasons.
//
// The shared `taskWebhookController` verifies a delivery's HMAC over the raw body, parses it
// through the source's provider, and hands the neutral event to the `trackerWebhook` gateway
// seam; on Node that enqueues a job here so the HTTP request acks fast — every tracker expects a
// prompt 2xx and will redeliver otherwise, and the handle can fire a whole pipeline (intake) or
// drive a parked review through an LLM incorporation (a reply), neither of which belongs inside a
// webhook request. A registered worker drains the queue and applies each job through the SAME
// `TrackerWebhookService` the inline path uses, so only WHERE the work runs changes.
//
// A queue-less container (a pure-logic test, a local dev boot with no boss) gets the shared
// `InlineTrackerWebhookIngest` instead and the controller applies the event in-request.

export const TRACKER_SYNC_QUEUE = 'tracker.sync'

/** One unit of async tracker work: a verified, parsed delivery for one workspace. */
export interface TrackerSyncJob {
  workspaceId: string
  event: TrackerWebhookEvent
}

// Retry a handful of times with backoff so a transient failure (a DB blip, a rate-limited tracker
// comment) is redriven rather than dropped. The apply is idempotent by the ingest CLAIM (a comment
// already applied is skipped, an abandoned claim is retaken), so a retry is safe — which is
// exactly why the claim had to exist before this queue did.
const RETRY_LIMIT = 5
const RETRY_DELAY_SECONDS = 5
// `expireInSeconds` is an ABSOLUTE cap on a single job (pg-boss times a job out at
// `started_on + expireInSeconds`; heartbeats do NOT refresh it). A reply's apply runs an
// incorporation LLM call in the worst case, so size it past that with headroom — but well below
// the ingest claim's abandonment window, or an expired job would be retried while its claim is
// still considered in-flight and the comment would go unanswered until the window elapsed.
const EXPIRE_SECONDS = 5 * 60
// Fast crash recovery, DECOUPLED from that cap: a live worker auto-heartbeats its active job, so
// a crashed worker is detected within `HEARTBEAT_SECONDS` and pg-boss frees the job for a retry.
const HEARTBEAT_SECONDS = 60

function sendOptions(): SendOptions {
  return {
    retryLimit: RETRY_LIMIT,
    retryDelay: RETRY_DELAY_SECONDS,
    retryBackoff: true,
    expireInSeconds: EXPIRE_SECONDS,
    heartbeatSeconds: HEARTBEAT_SECONDS,
  }
}

/**
 * pg-boss tracker webhook ingest: enqueues a verified, parsed delivery so the receiver acks fast
 * and the worker applies it asynchronously. Node analogue of the Worker's `CfTrackerWebhookIngest`.
 */
export class PgBossTrackerWebhookIngest implements TrackerWebhookIngest {
  constructor(private readonly boss: PgBoss) {}

  async enqueueEvent(workspaceId: string, event: TrackerWebhookEvent): Promise<boolean> {
    await this.boss.send(TRACKER_SYNC_QUEUE, { workspaceId, event }, sendOptions())
    return true
  }
}

/**
 * Create the tracker-sync queue and start the worker that applies queued deliveries.
 *
 * No-op-safe: with no tracker-webhook module wired (task sources unconfigured) a job is completed
 * (dropped) rather than retried forever — the enqueue path is only reachable through the receiver,
 * which requires the module, so a job with no module is a boot-ordering edge, not a steady state.
 * `localConcurrency` lets independent deliveries apply in parallel, the same throughput lever the
 * GitHub-sync worker uses.
 */
export async function startTrackerSyncWorker(
  boss: PgBoss,
  container: ServerContainer,
  log: Logger,
  options: { concurrency?: number } = {},
): Promise<void> {
  const concurrency = Math.max(1, options.concurrency ?? 5)
  await createQueueWithDeadLetter(boss, TRACKER_SYNC_QUEUE)
  await boss.work<TrackerSyncJob>(
    TRACKER_SYNC_QUEUE,
    { localConcurrency: concurrency },
    async (jobs: Job<TrackerSyncJob>[]) => {
      const service = container.trackerWebhook?.service
      if (!service) return
      for (const job of jobs) {
        try {
          await service.handle(job.data.workspaceId, job.data.event)
        } catch (error) {
          log.error('tracker webhook job failed', {
            workspaceId: job.data.workspaceId,
            source: job.data.event.source,
            kind: job.data.event.kind,
            err: error instanceof Error ? error.message : String(error),
          })
          throw error // let pg-boss retry/backoff (the durable backstop)
        }
      }
    },
  )
}
