import type { GitHubBackfillScheduler, GitHubWebhookIngest } from '@cat-factory/server'
import type { Queue, Workflow } from '@cloudflare/workers-types'
import type { GitHubSyncMessage } from '../env'

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
    await this.workflow
      .create({
        id: `backfill-${installationId}-${Date.now()}`,
        params: { installationId },
      })
      .catch(() => {})
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
}
