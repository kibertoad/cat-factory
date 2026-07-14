import type {
  Clock,
  GitHubInstallationRepository,
  RepoProjectionRepository,
} from '@cat-factory/kernel'
import { GitHubApiError } from '../github/FetchGitHubClient.js'
import { installationTokenMintStatusOf } from '../github/GitHubAppAuth.js'
import type { Logger } from '../observability/logger.js'

// The runtime-neutral core of the periodic GitHub reconciliation pass, shared by both
// facades' sweeps (the Worker's every-2-min `github-reconcile` cron and the Node
// `setInterval` sweeper). Webhooks are the primary sync path but can be missed (a
// delivery outage, a restart mid-delivery), so this backstop re-syncs every tracked
// repo whose projection has gone stale — without it a dropped webhook leaves the
// branch/PR/issue/check-run projections stale forever. It also tombstones an
// installation whose uninstall webhook never arrived, so its repos stop being swept.
//
// Each facade supplies ONLY its driver via `syncRepoById`: the Worker enqueues a resync
// on `GITHUB_SYNC_QUEUE` when bound (else direct-syncs), while Node always direct-syncs
// inline (it has no queue). Hoisting the loop + the gone-installation classifiers here
// (the `escalateStaleNotifications` precedent) means a change can't silently diverge
// between the two facades — the shared unit test guards the behaviour for both.

/**
 * Default staleness window: a projection not synced for this long is picked up by the
 * pass. Shared alongside the pass itself so the facades' sweeps can't drift apart.
 */
export const GITHUB_RECONCILE_STALE_MS = 30 * 60 * 1000

/** The seams the reconcile pass drives (kept narrow so it is unit-testable with fakes). */
export interface GitHubReconcileDeps {
  repoProjectionRepository: Pick<RepoProjectionRepository, 'listStale'>
  installationRepository: Pick<GitHubInstallationRepository, 'softDelete'>
  /**
   * The facade's per-repo resync driver: on the Worker, enqueue on `GITHUB_SYNC_QUEUE`
   * (or direct-sync when no queue is bound); on Node, direct-sync inline. A throw is
   * classified below (gone installation vs real fault) and never aborts the pass.
   */
  syncRepoById: (workspaceId: string, repoGithubId: number) => Promise<void>
}

/**
 * One reconcile pass: re-sync (or enqueue a resync for) every stale repo projection,
 * tombstoning installations that are gone. Best-effort per repo — one failure must not
 * abort the rest. Returns the number of repos successfully re-synced/scheduled.
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
          sweep: 'github-reconcile',
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

/** The gone/forbidden HTTP statuses: an uninstalled/revoked install or a deleted/inaccessible repo. */
function isGoneStatus(status: number): boolean {
  return status === 401 || status === 404 || status === 410
}

/**
 * Whether a sync error is a *gone/forbidden GitHub App installation or repo* rather than a
 * transient fault: minting an installation token for an uninstalled or revoked installation
 * returns 401/404, and a deleted/inaccessible repo returns 404/410. These are not worth an
 * error-level log or a retry storm — the connection needs human action.
 *
 * Reads the structured HTTP status off the two errors the sync driver throws — the
 * {@link InstallationTokenMintError} (via {@link installationTokenMintStatusOf}) and the repo-level
 * {@link GitHubApiError} — both in-process, so `instanceof` is authoritative and no message is
 * parsed.
 */
function isInstallationGoneError(error: unknown): boolean {
  const status =
    installationTokenMintStatusOf(error) ??
    (error instanceof GitHubApiError ? error.status : undefined)
  return status !== undefined && isGoneStatus(status)
}

/**
 * Whether the error is specifically a *token mint* returning 404/410 — i.e. the installation
 * itself is gone (uninstalled/revoked), not merely a single repo being inaccessible. Reads the
 * structured {@link installationTokenMintStatusOf}, which is set ONLY on a real mint failure, so a
 * repo-level 404 (a {@link GitHubApiError}) can never be mistaken for a gone installation. Excludes
 * 401 (a transient app-JWT/clock fault would mint-fail for every installation, and must not
 * tombstone a healthy connection).
 */
function isInstallationTokenGoneError(error: unknown): boolean {
  const mintStatus = installationTokenMintStatusOf(error)
  return mintStatus === 404 || mintStatus === 410
}
