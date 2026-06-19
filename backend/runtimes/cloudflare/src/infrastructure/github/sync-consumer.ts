import type { Clock } from '@cat-factory/kernel'
import type { MessageBatch } from '@cloudflare/workers-types'
import type { GitHubModule } from '@cat-factory/orchestration'
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
  const installationRepo = new D1GitHubInstallationRepository({ db: env.DB })
  // `listStale` already excludes repos whose installation is tombstoned, so a dead
  // installation stops being swept once it is known-gone; the handling below tombstones
  // one the webhook never told us about (a missed uninstall), so it stops next pass.
  const stale = await repoRepo.listStale(clock.now() - staleMs)
  let scheduled = 0
  for (const repo of stale) {
    try {
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
      scheduled += 1
    } catch (error) {
      // Best-effort pass (webhooks are the primary path): one repo failing must not
      // abort the rest or spam the error log every cron tick. A gone/forbidden GitHub
      // App installation (uninstalled or revoked → 401/404 when minting its token) is
      // an expected operational state for a stale projection, so log it at warn; any
      // other fault is a real error. Either way, continue with the next repo.
      const gone = isInstallationGoneError(error)
      // A token-mint 404/410 means the installation itself is gone — uninstalled or
      // revoked without us receiving the webhook (the cron's most common stuck state).
      // Tombstone it so this and every future pass skip ALL its repos until it is
      // reinstalled (the `unsuspend`/reinstall webhook clears the tombstone). Scoped to
      // the mint error (not a repo-level 404, which means a single deleted repo) and to
      // 404/410 (never 401, which can be a transient app-JWT fault hitting everything).
      if (isInstallationTokenGoneError(error)) {
        try {
          await installationRepo.softDelete(repo.installationId, clock.now())
        } catch {
          // Best-effort: a failed tombstone just means we retry (and warn) next pass.
        }
      }
      logger[gone ? 'warn' : 'error'](
        {
          cron: 'github-reconcile',
          workspaceId: repo.workspaceId,
          repoGithubId: repo.githubId,
          installationId: repo.installationId,
          err: errInfo(error),
        },
        gone
          ? 'skipping stale repo whose GitHub App installation is gone (uninstalled/revoked); reinstall the app to re-enable it'
          : 'repo resync failed',
      )
    }
  }
  return scheduled
}

/** Minimal error → log payload (mirrors the worker entry's `errInfo`). */
function errInfo(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) {
    return { message: error.message, ...(error.stack ? { stack: error.stack } : {}) }
  }
  return { message: String(error) }
}

/**
 * Whether a sync error is a *gone/forbidden GitHub App installation* rather than a
 * transient fault: minting an installation token for an uninstalled or revoked
 * installation returns 401/404 (and a deleted repo 404/410). These are not worth
 * an error-level log or a retry storm — the connection needs human action.
 */
function isInstallationGoneError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /\(HTTP (401|404|410)\)/.test(message)
}

/**
 * Whether the error is specifically a *token mint* returning 404/410 — i.e. the
 * installation itself is gone (uninstalled/revoked), not merely a single repo
 * being inaccessible. Matches {@link GitHubAppAuth.mintInstallationToken}'s
 * message. Excludes 401 (a transient app-JWT/clock fault would mint-fail for every
 * installation, and must not tombstone a healthy connection).
 */
function isInstallationTokenGoneError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /Failed to mint installation token .*\(HTTP (404|410)\)/i.test(message)
}
