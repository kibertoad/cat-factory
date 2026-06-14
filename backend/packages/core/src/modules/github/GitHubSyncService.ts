import type { Clock } from '../../ports/runtime'
import type { GitHubClient, GitHubRepoRef } from '../../ports/github-client'
import type {
  BranchProjectionRepository,
  CheckRunProjectionRepository,
  CommitProjectionRepository,
  GitHubInstallationRepository,
  IssueProjectionRepository,
  PullRequestProjectionRepository,
  RepoProjectionRepository,
} from '../../ports/github-repositories'
import type { GitHubRepo } from '../../domain/types'

// ---------------------------------------------------------------------------
// GitHubSyncService: keeps the local projections (repos/branches, PRs/issues,
// commits/checks) in step with GitHub. It is the *pull* side of resync — it
// fetches from the GitHubClient and persists via the projection repositories,
// advancing per-repo sync cursors (ETags / `since` timestamps) so subsequent
// passes are incremental. The complementary *push* side (applying data already
// embedded in a webhook delivery, no extra API call) lives in WebhookService.
//
// Pure orchestration over its ports, so it runs identically from an HTTP
// resync, the queue consumer, the backfill Workflow and the cron reconciler.
// ---------------------------------------------------------------------------

export interface GitHubSyncServiceDependencies {
  githubClient: GitHubClient
  githubInstallationRepository: GitHubInstallationRepository
  repoProjectionRepository: RepoProjectionRepository
  branchProjectionRepository: BranchProjectionRepository
  pullRequestProjectionRepository: PullRequestProjectionRepository
  issueProjectionRepository: IssueProjectionRepository
  commitProjectionRepository: CommitProjectionRepository
  checkRunProjectionRepository: CheckRunProjectionRepository
  clock: Clock
  /**
   * Bounds the initial commit backfill: when a repo has no commit cursor yet
   * (its first sync), commits are listed only from `now - commitBackfillHorizonMs`
   * rather than from the dawn of the repo. This keeps a large/monorepo connect
   * from inserting its entire history in one step. Subsequent syncs use the
   * (more recent) cursor. Undefined means backfill the full history (legacy).
   */
  commitBackfillHorizonMs?: number
}

export class GitHubSyncService {
  constructor(private readonly deps: GitHubSyncServiceDependencies) {}

  /**
   * Discover every repo the installation can access, upsert them, and tombstone
   * any previously-tracked repo that has gone away. Returns the live repos.
   */
  async syncInstallationRepos(workspaceId: string, installationId: number): Promise<GitHubRepo[]> {
    const { items } = await this.deps.githubClient.listInstallationRepos(installationId)
    const repos = items.map((r) => ({ ...r, installationId }))
    await this.deps.repoProjectionRepository.upsertMany(workspaceId, repos)
    await this.deps.repoProjectionRepository.tombstoneMissing(
      workspaceId,
      installationId,
      repos.map((r) => r.githubId),
      this.deps.clock.now(),
    )
    return repos
  }

  /** Incrementally resync one repo's branches, PRs, issues, commits and checks. */
  async syncRepo(workspaceId: string, repo: GitHubRepo): Promise<void> {
    const ref: GitHubRepoRef = { owner: repo.owner, repo: repo.name }
    const id = repo.githubId
    const installationId = repo.installationId
    const repos = this.deps.repoProjectionRepository
    const now = () => this.deps.clock.now()

    // Branches — conditional GET via ETag.
    const branchCursor = await repos.getCursor(workspaceId, id, 'branches')
    const branches = await this.deps.githubClient.listBranches(
      installationId,
      ref,
      branchCursor?.etag ?? undefined,
    )
    if (!branches.notModified && branches.items.length > 0) {
      await this.deps.branchProjectionRepository.upsertMany(workspaceId, branches.items)
    }
    const defaultBranchSha =
      branches.items.find((b) => b.name === repo.defaultBranch)?.headSha ?? null
    await repos.setCursor(workspaceId, id, 'branches', {
      etag: branches.etag ?? branchCursor?.etag ?? null,
      lastSyncedAt: now(),
      sinceIso: null,
    })

    // Pull requests — delta by `since` (GitHub's updated_at lower bound).
    const prCursor = await repos.getCursor(workspaceId, id, 'pulls')
    const pulls = await this.deps.githubClient.listPullRequests(installationId, ref, {
      since: prCursor?.sinceIso ?? undefined,
      etag: prCursor?.etag ?? undefined,
    })
    if (!pulls.notModified && pulls.items.length > 0) {
      await this.deps.pullRequestProjectionRepository.upsertMany(workspaceId, pulls.items)
    }
    await repos.setCursor(workspaceId, id, 'pulls', {
      etag: pulls.etag ?? prCursor?.etag ?? null,
      lastSyncedAt: now(),
      sinceIso: new Date(now()).toISOString(),
    })

    // Issues — delta by `since`.
    const issueCursor = await repos.getCursor(workspaceId, id, 'issues')
    const issues = await this.deps.githubClient.listIssues(installationId, ref, {
      since: issueCursor?.sinceIso ?? undefined,
      etag: issueCursor?.etag ?? undefined,
    })
    if (!issues.notModified && issues.items.length > 0) {
      await this.deps.issueProjectionRepository.upsertMany(workspaceId, issues.items)
    }
    await repos.setCursor(workspaceId, id, 'issues', {
      etag: issues.etag ?? issueCursor?.etag ?? null,
      lastSyncedAt: now(),
      sinceIso: new Date(now()).toISOString(),
    })

    // Commits — delta by `since` on the default branch. On the first sync there
    // is no cursor, so fall back to the backfill horizon (if configured) instead
    // of fetching the repo's entire commit history in one step.
    const commitCursor = await repos.getCursor(workspaceId, id, 'commits')
    const commitBackfillSince =
      this.deps.commitBackfillHorizonMs !== undefined
        ? new Date(now() - this.deps.commitBackfillHorizonMs).toISOString()
        : undefined
    const commits = await this.deps.githubClient.listCommits(installationId, ref, {
      since: commitCursor?.sinceIso ?? commitBackfillSince,
    })
    if (commits.items.length > 0) {
      await this.deps.commitProjectionRepository.upsertMany(workspaceId, commits.items)
    }
    await repos.setCursor(workspaceId, id, 'commits', {
      etag: null,
      lastSyncedAt: now(),
      sinceIso: new Date(now()).toISOString(),
    })

    // Check runs for the default-branch head (CI gating signal).
    if (defaultBranchSha) {
      const checks = await this.deps.githubClient.listCheckRuns(
        installationId,
        ref,
        defaultBranchSha,
      )
      if (checks.items.length > 0) {
        await this.deps.checkRunProjectionRepository.upsertMany(workspaceId, checks.items)
      }
    }

    // Stamp the repo row as freshly synced.
    await repos.upsertMany(workspaceId, [{ ...repo, syncedAt: now() }])
  }

  /** Resync a single tracked repo by its GitHub id (used by the queue consumer). */
  async syncRepoById(workspaceId: string, repoGithubId: number): Promise<void> {
    const repo = await this.deps.repoProjectionRepository.get(workspaceId, repoGithubId)
    if (repo) await this.syncRepo(workspaceId, repo)
  }

  /** Incremental resync of every tracked repo for a workspace. */
  async resyncWorkspace(workspaceId: string): Promise<void> {
    const installation = await this.deps.githubInstallationRepository.getByWorkspace(workspaceId)
    if (!installation || installation.deletedAt) return
    const repos = await this.syncInstallationRepos(workspaceId, installation.installationId)
    for (const repo of repos) await this.syncRepo(workspaceId, repo)
  }

  /**
   * Full backfill for an installation: rediscover repos then deep-sync each one.
   * Resolves the owning workspace from the installation binding.
   */
  async backfillInstallation(installationId: number): Promise<void> {
    const installation =
      await this.deps.githubInstallationRepository.getByInstallationId(installationId)
    if (!installation || installation.deletedAt) return
    const repos = await this.syncInstallationRepos(installation.workspaceId, installationId)
    for (const repo of repos) await this.syncRepo(installation.workspaceId, repo)
  }
}
