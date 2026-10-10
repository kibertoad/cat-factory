import { type Clock, NotFoundError, describeError } from '@cat-factory/kernel'
import type { MessageBatch } from '@cloudflare/workers-types'
import { reconcileStaleRepos as reconcileStaleReposCore } from '@cat-factory/server'
import type { Container } from '../container'
import type { Env, GitHubSyncMessage, TrackerSyncMessage } from '../env'
import { buildContainer } from '../container'
import { loadConfig } from '../config'
import { D1RepoProjectionRepository } from '../repositories/D1RepoProjectionRepository'
import { D1GitHubInstallationRepository } from '../repositories/D1GitHubInstallationRepository'
import { logger } from '../observability/logger'

// The async side of the GitHub integration: applying queued webhook deliveries /
// resync jobs to the projections, and the periodic reconciliation pass. Pure
// orchestration over the GitHub module + its ports, so it is unit-testable with
// fakes (mirroring the execution sweeper's style).

/**
 * Apply one queued message. Each kind resolves its own optional module and skips gracefully
 * when unwired: `webhook`/`resync-repo` need the GitHub module, the two `*-source-resync` kinds their own
 * repo-sourced library (the push-webhook freshness fan-out, slice 4) — each can be absent
 * independently. A source unlinked between enqueue and processing is a terminal `NotFoundError`
 * (swallowed, not retried); any other error propagates so the batch retries.
 */
async function applyGitHubSyncMessage(
  container: Container,
  message: GitHubSyncMessage,
): Promise<void> {
  switch (message.kind) {
    case 'webhook':
      await container.github?.webhookService.handle(message.eventName, message.payload)
      return
    case 'resync-repo':
      await container.github?.syncService.syncRepoById(message.workspaceId, message.repoGithubId)
      return
    case 'skill-source-resync': {
      const sourceService = container.skillLibrary?.sourceService
      if (!sourceService) return
      try {
        await sourceService.sync(message.accountId, message.sourceId)
      } catch (error) {
        if (error instanceof NotFoundError) return
        throw error
      }
      return
    }
    case 'foundational-source-resync': {
      // Resolved by SOURCE ID alone: `syncById` reads the owning tier off the stored row, so an
      // owner that rode the queue could only ever disagree with it.
      const sourceService = container.foundationalServices?.sourceService
      if (!sourceService) return
      try {
        await sourceService.syncById(message.sourceId)
      } catch (error) {
        if (error instanceof NotFoundError) return
        throw error
      }
      return
    }
  }
}

/** Queue consumer for `cat-factory-github-sync`: ack on success, retry on error. */
export async function handleGitHubSyncBatch(
  batch: MessageBatch<GitHubSyncMessage>,
  env: Env,
): Promise<void> {
  const container = buildContainer(env)
  for (const message of batch.messages) {
    try {
      await applyGitHubSyncMessage(container, message.body)
      message.ack()
    } catch (error) {
      // Retrying blind used to be the whole handling: a permanently-failing delivery burned its
      // retries with no evidence it ever arrived. Copied from the tracker-sync sibling below.
      logger.warn('github sync message failed; retrying', {
        messageKind: message.body.kind,
        attempts: message.attempts,
        ...describeError(error),
      })
      message.retry()
    }
  }
}

/**
 * Reconciliation pass for the cron sweeper: enqueue an incremental resync for
 * every tracked repo whose projection has gone stale (webhooks can be missed).
 * Returns the number of repos scheduled. Falls back to a direct sync when no
 * queue is bound. Thin Worker driver over the shared `@cat-factory/server`
 * `reconcileStaleRepos` core — it supplies only the D1 repos + the enqueue-or-sync
 * driver, so the classification/tombstone behaviour can't drift from the Node facade.
 */
export async function reconcileStaleRepos(
  env: Env,
  clock: Clock,
  staleMs: number,
): Promise<number> {
  if (!loadConfig(env).github.enabled) return 0
  // Resolve the direct-sync fallback once per pass, not per stale repo — building the
  // whole DI container inside the loop is wasted work. The queue-bound production
  // configuration never needs it.
  const github = env.GITHUB_SYNC_QUEUE ? undefined : buildContainer(env).github
  return reconcileStaleReposCore(
    {
      repoProjectionRepository: new D1RepoProjectionRepository({ db: env.DB }),
      installationRepository: new D1GitHubInstallationRepository({ db: env.DB }),
      syncRepoById: async (workspaceId, repoGithubId) => {
        // Enqueue on the sync queue when bound (the async consumer applies it), else
        // fall back to an inline direct sync — the Worker's local/dev configuration.
        if (env.GITHUB_SYNC_QUEUE) {
          await env.GITHUB_SYNC_QUEUE.send({ kind: 'resync-repo', workspaceId, repoGithubId })
        } else if (github) {
          await github.syncService.syncRepoById(workspaceId, repoGithubId)
        }
      },
    },
    clock,
    staleMs,
    logger,
  )
}

/**
 * Queue consumer for `cat-factory-tracker-sync`: apply one verified, parsed tracker delivery
 * (push-driven intake / a ticket reply to a parked review); ack on success, retry on error.
 *
 * A retry is safe because the apply is idempotent by the ingest CLAIM — a comment already applied
 * is skipped, an abandoned claim is retaken — which is exactly why that claim had to exist before
 * this queue did. With the tracker-webhook module unwired the message is ACKED (dropped) rather
 * than retried forever, mirroring the GitHub consumer's stance for an unwired module.
 *
 * It lives beside `handleGitHubSyncBatch` because it is the same shape at the same layer; the
 * queues, message types and modules are entirely separate.
 */
export async function handleTrackerSyncBatch(
  batch: MessageBatch<TrackerSyncMessage>,
  env: Env,
): Promise<void> {
  const container = buildContainer(env)
  const service = container.trackerWebhook?.service
  for (const message of batch.messages) {
    if (!service) {
      message.ack()
      continue
    }
    try {
      await service.handle(message.body.workspaceId, message.body.event)
      message.ack()
    } catch (error) {
      logger.warn('tracker webhook message failed; retrying', {
        workspaceId: message.body.workspaceId,
        source: message.body.event.source,
        kind: message.body.event.kind,
        attempts: message.attempts,
        ...describeError(error),
      })
      message.retry()
    }
  }
}
