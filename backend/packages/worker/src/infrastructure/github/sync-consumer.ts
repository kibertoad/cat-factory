import type { GitHubModule } from '@cat-factory/core'
import type { MessageBatch } from '@cloudflare/workers-types'
import type { Clock } from '@cat-factory/core'
import type { Env, GitHubSyncMessage } from '../env'
import { buildContainer } from '../container'
import { loadConfig } from '../config'
import { D1RepoProjectionRepository } from '../repositories/D1RepoProjectionRepository'

// The async side of the GitHub integration: applying queued webhook deliveries /
// resync jobs to the projections, and the periodic reconciliation pass. Pure
// orchestration over the GitHub module + its ports, so it is unit-testable with
// fakes (mirroring the execution sweeper's style).

/** Apply one queued message to the projections via the GitHub module. */
export async function applyGitHubSyncMessage(
  github: GitHubModule,
  message: GitHubSyncMessage,
): Promise<void> {
  if (message.kind === 'webhook') {
    await github.webhookService.handle(message.eventName, message.payload)
  } else {
    await github.syncService.syncRepoById(message.workspaceId, message.repoGithubId)
  }
}

/** Queue consumer for `cat-factory-github-sync`: ack on success, retry on error. */
export async function handleGitHubSyncBatch(
  batch: MessageBatch<GitHubSyncMessage>,
  env: Env,
): Promise<void> {
  const github = buildContainer(env).github
  for (const message of batch.messages) {
    if (!github) {
      message.ack() // GitHub not configured here; drop rather than retry forever.
      continue
    }
    try {
      await applyGitHubSyncMessage(github, message.body)
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
 * queue is bound.
 */
export async function reconcileStaleRepos(
  env: Env,
  clock: Clock,
  staleMs: number,
): Promise<number> {
  if (!loadConfig(env).github.enabled) return 0
  const repoRepo = new D1RepoProjectionRepository({ db: env.DB })
  const stale = await repoRepo.listStale(clock.now() - staleMs)
  for (const repo of stale) {
    if (env.GITHUB_SYNC_QUEUE) {
      await env.GITHUB_SYNC_QUEUE.send({
        kind: 'resync-repo',
        workspaceId: repo.workspaceId,
        repoGithubId: repo.githubId,
      })
    } else {
      const github = buildContainer(env).github
      if (github) await github.syncService.syncRepoById(repo.workspaceId, repo.githubId)
    }
  }
  return stale.length
}
