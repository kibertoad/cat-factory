import { type Clock, NotFoundError } from '@cat-factory/kernel'
import type { MessageBatch } from '@cloudflare/workers-types'
import { reconcileStaleRepos as reconcileStaleReposCore } from '@cat-factory/server'
import type { Container } from '../container'
import type { Env, GitHubSyncMessage } from '../env'
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
 * when unwired: `webhook`/`resync-repo` need the GitHub module, `skill-source-resync` the
 * skill-library module (the push-webhook freshness fan-out, slice 4) — either can be absent
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
    } catch {
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
