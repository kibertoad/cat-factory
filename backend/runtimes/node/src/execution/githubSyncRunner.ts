import type { GitHubModule } from '@cat-factory/orchestration'
import type {
  GitHubBackfillScheduler,
  GitHubWebhookIngest,
  Logger,
  ServerContainer,
} from '@cat-factory/server'
import type { Job, PgBoss, SendOptions } from 'pg-boss'

// Async GitHub ingest on pg-boss: the Node analogue of the Worker's `GITHUB_SYNC_QUEUE`
// consumer (`sync-consumer.ts`) plus its `GitHubBackfillWorkflow`. The shared GitHub
// controllers hand verified webhook deliveries, single-repo resyncs and full-installation
// backfills to the `githubWebhook` / `githubBackfill` gateway seams; on Node those enqueue
// a job here so the HTTP request acks fast — GitHub expects a prompt 2xx on a webhook, and
// a large initial backfill would otherwise block the request past its timeout — instead of
// running the sync inline in the handler. A registered worker drains the queue and applies
// each job to the projections via the SAME `GitHubSyncService` / `WebhookService` the inline
// path used, so the projection result is identical; only WHERE the work runs changes.
//
// This is the durable driver, so — like the execution/bootstrap pg-boss runners — it is a
// per-facade analogue of the Worker's Queue + Workflow (the pure classification/reconcile
// logic that both facades share lives in `@cat-factory/server`; the ingest apply is a thin
// mirror of the Worker's `applyGitHubSyncMessage`, kept local alongside its driver).

export const GITHUB_SYNC_QUEUE = 'github.sync'

/**
 * One unit of async GitHub work. Mirrors the Worker's `GitHubSyncMessage` (`webhook` +
 * `resync-repo`) and folds in the `backfill` kind the Worker drives through a separate
 * Workflow — on Node all three ride the one pg-boss queue.
 */
export type GitHubSyncJob =
  | { kind: 'webhook'; eventName: string; payload: unknown }
  | { kind: 'resync-repo'; workspaceId: string; repoGithubId: number }
  | { kind: 'backfill'; installationId: number }

// Retry a handful of times with backoff so a transient failure (a momentary DB blip, a
// rate-limited GitHub read) is redriven rather than dropped — the durable analogue of the
// Worker consumer's `message.retry()`. The apply is idempotent (upserts), so a retry is safe.
const RETRY_LIMIT = 5
const RETRY_DELAY_SECONDS = 5
// `expireInSeconds` is an ABSOLUTE cap on a single job (pg-boss times a job out at
// `started_on + expireInSeconds`; heartbeats do NOT refresh it — see `execution/config.ts`).
// Size it past the longest single job — a full-installation backfill deep-syncs every repo
// (the Worker gives its backfill step a 10-minute timeout) — so a healthy long backfill is
// never expired mid-run and re-driven.
const EXPIRE_SECONDS = 15 * 60
// Fast crash recovery, DECOUPLED from that large cap: a live worker auto-heartbeats its active
// job, so a crashed/evicted worker is detected within `HEARTBEAT_SECONDS` and pg-boss frees the
// job for a retry — instead of the installation's queued sync sitting stuck for the full
// `EXPIRE_SECONDS`. Mirrors the execution/bootstrap/env-repair runners' 60s default.
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
 * pg-boss GitHub backfill scheduler: enqueues a full-installation backfill so the
 * `resync?full=true` request acks 202 ("backfill_started") instead of blocking on the
 * deep sync. Node analogue of the Worker's `WorkflowsBackfillScheduler`.
 */
export class PgBossGitHubBackfillScheduler implements GitHubBackfillScheduler {
  constructor(private readonly boss: PgBoss) {}

  async scheduleBackfill(installationId: number): Promise<boolean> {
    await this.boss.send(GITHUB_SYNC_QUEUE, { kind: 'backfill', installationId }, sendOptions())
    return true
  }
}

/**
 * pg-boss GitHub webhook ingest: enqueues verified webhook deliveries + incremental repo
 * resyncs so the request acks fast and the worker applies the projection asynchronously.
 * Node analogue of the Worker's `CfGitHubWebhookIngest`.
 */
export class PgBossGitHubWebhookIngest implements GitHubWebhookIngest {
  constructor(private readonly boss: PgBoss) {}

  async enqueueWebhook(eventName: string, payload: unknown): Promise<boolean> {
    await this.boss.send(GITHUB_SYNC_QUEUE, { kind: 'webhook', eventName, payload }, sendOptions())
    return true
  }

  async queueRepoResync(workspaceId: string, repoGithubId: number): Promise<boolean> {
    await this.boss.send(
      GITHUB_SYNC_QUEUE,
      { kind: 'resync-repo', workspaceId, repoGithubId },
      sendOptions(),
    )
    return true
  }
}

/**
 * Apply one queued job to the projections via the GitHub module — a mirror of the Worker
 * consumer's `applyGitHubSyncMessage`, extended with the `backfill` kind. All the business
 * logic lives in the shared `GitHubSyncService` / `WebhookService`; this just routes the
 * kind, exactly as the inline controller path does.
 */
export async function applyGitHubSyncJob(github: GitHubModule, job: GitHubSyncJob): Promise<void> {
  switch (job.kind) {
    case 'webhook':
      await github.webhookService.handle(job.eventName, job.payload)
      return
    case 'resync-repo':
      await github.syncService.syncRepoById(job.workspaceId, job.repoGithubId)
      return
    case 'backfill':
      await github.syncService.backfillInstallation(job.installationId)
      return
  }
}

/**
 * Create the GitHub-sync queue and start the worker that applies async ingest jobs.
 *
 * No-op-safe: when the GitHub module isn't wired (GitHub App unconfigured) a job is
 * completed (dropped) rather than retried forever — mirroring the Worker consumer's `ack()`
 * for that case. In practice the enqueue path is only reachable through the GitHub
 * controllers, which require the module, so a job with no module is a rare boot-ordering
 * edge, not a steady state. `localConcurrency` lets independent deliveries apply in parallel
 * (each is a short DB write), the same throughput lever as the execution/bootstrap workers.
 */
export async function startGitHubSyncWorker(
  boss: PgBoss,
  container: ServerContainer,
  log: Logger,
  options: { concurrency?: number } = {},
): Promise<void> {
  const concurrency = Math.max(1, options.concurrency ?? 10)
  await boss.createQueue(GITHUB_SYNC_QUEUE)
  await boss.work<GitHubSyncJob>(
    GITHUB_SYNC_QUEUE,
    { localConcurrency: concurrency },
    async (jobs: Job<GitHubSyncJob>[]) => {
      for (const job of jobs) {
        const github = container.github
        if (!github) continue // GitHub not configured here; complete (drop), don't retry forever.
        try {
          await applyGitHubSyncJob(github, job.data)
        } catch (error) {
          log.error(
            { kind: job.data.kind, err: error instanceof Error ? error.message : String(error) },
            'github sync job failed',
          )
          throw error // let pg-boss retry/backoff (the durable backstop)
        }
      }
    },
  )
}
