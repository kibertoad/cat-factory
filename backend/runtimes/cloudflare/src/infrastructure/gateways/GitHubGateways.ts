import type {
  GitHubBackfillScheduler,
  GitHubWebhookIngest,
  TrackerWebhookIngest,
} from '@cat-factory/server'
import { describeError, type TrackerWebhookEvent } from '@cat-factory/kernel'
import { logger } from '../observability/logger'
import type { Queue, Workflow } from '@cloudflare/workers-types'
import type { GitHubSyncMessage, TrackerSyncMessage } from '../env'

/**
 * Worker implementation of the GitHub backfill scheduler: creates a Cloudflare
 * Workflows instance to durably drive a full-installation backfill. When no
 * `GITHUB_BACKFILL_WORKFLOW` binding is present, returns false so the caller runs
 * the backfill inline.
 */
export class WorkflowsBackfillScheduler implements GitHubBackfillScheduler {
  constructor(private readonly workflow?: Workflow) {}

  async scheduleBackfill(installationId: number): Promise<boolean> {
    if (!this.workflow) return false
    // The create is swallowed but the return is still `true`: the caller uses the boolean to
    // decide whether to run the backfill INLINE instead, and re-running it inline on top of a
    // Workflows instance that did start would double the work. So a quota rejection or an
    // unbound namespace reports "scheduled" — it just no longer does so silently.
    try {
      await this.workflow.create({
        id: `backfill-${installationId}-${Date.now()}`,
        params: { installationId },
      })
    } catch (error) {
      logger.warn('github backfill workflow create failed; reported as scheduled anyway', {
        installationId,
        ...describeError(error),
      })
    }
    return true
  }
}

/**
 * Worker implementation of GitHub webhook ingest: enqueues verified deliveries and
 * incremental repo resyncs onto the `GITHUB_SYNC_QUEUE` so the request acks fast and
 * the consumer applies projections asynchronously. Returns false when no queue is
 * bound, so the caller handles the work inline (local/dev).
 */
export class CfGitHubWebhookIngest implements GitHubWebhookIngest {
  constructor(private readonly queue?: Queue<GitHubSyncMessage>) {}

  async enqueueWebhook(eventName: string, payload: unknown): Promise<boolean> {
    if (!this.queue) return false
    await this.queue.send({ kind: 'webhook', eventName, payload })
    return true
  }

  async queueRepoResync(workspaceId: string, repoGithubId: number): Promise<boolean> {
    if (!this.queue) return false
    await this.queue.send({ kind: 'resync-repo', workspaceId, repoGithubId })
    return true
  }

  async queueSkillResync(accountId: string, sourceId: string): Promise<boolean> {
    if (!this.queue) return false
    await this.queue.send({ kind: 'skill-source-resync', accountId, sourceId })
    return true
  }

  async queueFoundationalResync(sourceId: string): Promise<boolean> {
    if (!this.queue) return false
    await this.queue.send({ kind: 'foundational-source-resync', sourceId })
    return true
  }
}

/**
 * Worker implementation of TRACKER webhook ingest: enqueues a verified, parsed delivery onto the
 * `TRACKER_SYNC_QUEUE` so the receiver acks fast and the consumer applies it asynchronously.
 * Returns false when no queue is bound, so the receiver handles it inline (local/dev).
 *
 * It lives beside the GitHub gateways because it is the same seam at the same layer — a queue
 * producer over one binding — not because it shares any GitHub concern; the message type and the
 * queue are entirely separate.
 */
export class CfTrackerWebhookIngest implements TrackerWebhookIngest {
  constructor(private readonly queue?: Queue<TrackerSyncMessage>) {}

  async enqueueEvent(workspaceId: string, event: TrackerWebhookEvent): Promise<boolean> {
    if (!this.queue) return false
    await this.queue.send({ workspaceId, event })
    return true
  }
}
