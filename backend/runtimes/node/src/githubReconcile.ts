import type {
  Clock,
  GitHubInstallationRepository,
  RepoProjectionRepository,
} from '@cat-factory/kernel'
import type { Logger } from '@cat-factory/server'

// Periodic GitHub reconciliation for the Node facade — the analogue of the Worker's
// every-2-min `github-reconcile` cron (`infrastructure/github/sync-consumer.ts`'s
// `reconcileStaleRepos`). Webhooks are the primary sync path but can be missed (a
// delivery outage, a restart mid-delivery), so this backstop re-syncs every tracked
// repo whose projection has gone stale — without it a dropped webhook leaves the
// branch/PR/issue/check-run projections stale forever. It also tombstones an
// installation whose uninstall webhook never arrived, so its repos stop being swept.
// The Worker enqueues resyncs when a queue is bound; Node has no queue, so it uses
// the Worker's direct-sync fallback path (`syncService.syncRepoById`) inline.

/** How often the reconcile pass runs (matches the Worker's frequent cron). */
const GITHUB_RECONCILE_INTERVAL_MS = 2 * 60 * 1000
/** A projection not synced for this long is considered stale (matches the Worker). */
export const GITHUB_RECONCILE_STALE_MS = 30 * 60 * 1000

/** The seams the reconcile pass drives (kept narrow so it is unit-testable with fakes). */
export interface GitHubReconcileDeps {
  repoProjectionRepository: Pick<RepoProjectionRepository, 'listStale'>
  installationRepository: Pick<GitHubInstallationRepository, 'softDelete'>
  /** The GitHub module's incremental per-repo resync (`GitHubSyncService.syncRepoById`). */
  syncRepoById: (workspaceId: string, repoGithubId: number) => Promise<void>
}

/**
 * One reconcile pass: re-sync every stale repo projection, tombstoning installations
 * that are gone. Best-effort per repo — one failure must not abort the rest. Returns
 * the number of repos successfully re-synced.
 */
export async function reconcileStaleRepos(
  deps: GitHubReconcileDeps,
  clock: Clock,
  staleMs: number,
  log: Logger,
): Promise<number> {
  // `listStale` already excludes repos whose installation is tombstoned, so a dead
  // installation stops being swept once it is known-gone; the handling below tombstones
  // one the webhook never told us about (a missed uninstall), so it stops next pass.
  const stale = await deps.repoProjectionRepository.listStale(clock.now() - staleMs)
  let synced = 0
  for (const repo of stale) {
    try {
      await deps.syncRepoById(repo.workspaceId, repo.githubId)
      synced += 1
    } catch (error) {
      // Best-effort pass (webhooks are the primary path): a gone/forbidden GitHub App
      // installation (uninstalled or revoked → 401/404 when minting its token) is an
      // expected operational state for a stale projection, so log it at warn; any
      // other fault is a real error. Either way, continue with the next repo.
      const gone = isInstallationGoneError(error)
      // A token-mint 404/410 means the installation itself is gone — uninstalled or
      // revoked without us receiving the webhook. Tombstone it so this and every future
      // pass skip ALL its repos until it is reinstalled (the `unsuspend`/reinstall
      // webhook clears the tombstone). Scoped to the mint error (not a repo-level 404,
      // which means a single deleted repo) and to 404/410 (never 401, which can be a
      // transient app-JWT fault hitting everything).
      if (isInstallationTokenGoneError(error)) {
        try {
          await deps.installationRepository.softDelete(repo.installationId, clock.now())
        } catch {
          // Best-effort: a failed tombstone just means we retry (and warn) next pass.
        }
      }
      log[gone ? 'warn' : 'error'](
        {
          sweeper: 'github-reconcile',
          workspaceId: repo.workspaceId,
          repoGithubId: repo.githubId,
          installationId: repo.installationId,
          err: error instanceof Error ? error.message : String(error),
        },
        gone
          ? 'skipping stale repo whose GitHub App installation is gone (uninstalled/revoked); reinstall the app to re-enable it'
          : 'repo resync failed',
      )
    }
  }
  return synced
}

/**
 * Start the periodic reconcile sweep. Runs once immediately then on the two-minute
 * timer. Best-effort: a failed pass is logged and retried next tick, never thrown.
 * Returns a stop function that clears the timer.
 */
export function startGitHubReconcileSweeper(
  deps: GitHubReconcileDeps,
  clock: Clock,
  log: Logger,
): () => void {
  let running = false
  const tick = async () => {
    // Skip if the previous pass is still in flight: a pass re-syncing many repos can
    // outlast the interval, and setInterval would otherwise stack overlapping passes.
    if (running) return
    running = true
    try {
      const synced = await reconcileStaleRepos(deps, clock, GITHUB_RECONCILE_STALE_MS, log)
      if (synced > 0) log.info({ synced }, 'reconciled stale github repo projections')
    } catch (error) {
      log.error(
        { err: error instanceof Error ? error.message : String(error) },
        'github reconcile sweep failed',
      )
    } finally {
      running = false
    }
  }
  void tick()
  const timer = setInterval(() => void tick(), GITHUB_RECONCILE_INTERVAL_MS)
  timer.unref?.()
  return () => clearInterval(timer)
}

/**
 * Whether a sync error is a *gone/forbidden GitHub App installation* rather than a
 * transient fault: minting an installation token for an uninstalled or revoked
 * installation returns 401/404 (and a deleted repo 404/410). These are not worth
 * an error-level log or a retry storm — the connection needs human action.
 * (Mirrors the Worker's `sync-consumer.ts` classification.)
 */
function isInstallationGoneError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /\(HTTP (401|404|410)\)/.test(message)
}

/**
 * Whether the error is specifically a *token mint* returning 404/410 — i.e. the
 * installation itself is gone (uninstalled/revoked), not merely a single repo
 * being inaccessible. Matches the App registry's mint-failure message. Excludes 401
 * (a transient app-JWT/clock fault would mint-fail for every installation, and must
 * not tombstone a healthy connection).
 */
function isInstallationTokenGoneError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /Failed to mint installation token .*\(HTTP (404|410)\)/i.test(message)
}
