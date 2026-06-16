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
  SyncCursor,
  SyncCursorKind,
} from '../../ports/github-repositories'
import type { GitHubAvailableRepo, GitHubRepo } from '../../domain/types'

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
   * The repos the workspace's installation can access, annotated with whether
   * this workspace currently links each one. Repos are linked *explicitly* per
   * workspace, so the connect UI lists these and the user picks a subset.
   */
  async listAvailableRepos(workspaceId: string): Promise<GitHubAvailableRepo[]> {
    const installation = await this.deps.githubInstallationRepository.getByWorkspace(workspaceId)
    if (!installation || installation.deletedAt) return []
    const { items } = await this.deps.githubClient.listInstallationRepos(
      installation.installationId,
    )
    const linked = new Set(
      (await this.deps.repoProjectionRepository.list(workspaceId)).map((r) => r.githubId),
    )
    return items.map((r) => ({
      githubId: r.githubId,
      owner: r.owner,
      name: r.name,
      defaultBranch: r.defaultBranch,
      private: r.private,
      linked: linked.has(r.githubId),
    }))
  }

  /**
   * Set the exact set of repos this workspace links. Projects the newly selected
   * repos (from those the installation can access), tombstones any deselected
   * repo, then deep-syncs each linked repo. Returns the workspace's live repos.
   */
  async setLinkedRepos(workspaceId: string, repoGithubIds: number[]): Promise<GitHubRepo[]> {
    const installation = await this.deps.githubInstallationRepository.getByWorkspace(workspaceId)
    if (!installation || installation.deletedAt) return []
    const installationId = installation.installationId
    const wanted = new Set(repoGithubIds)
    const { items } = await this.deps.githubClient.listInstallationRepos(installationId)
    const selected = items
      .filter((r) => wanted.has(r.githubId))
      .map((r) => ({ ...r, installationId, syncedAt: this.deps.clock.now() }))

    if (selected.length > 0) {
      await this.deps.repoProjectionRepository.upsertMany(workspaceId, selected)
    }
    // Tombstone every previously-linked repo for this installation that is no
    // longer selected (the "seen" set is exactly the new selection).
    await this.deps.repoProjectionRepository.tombstoneMissing(
      workspaceId,
      installationId,
      selected.map((r) => r.githubId),
      this.deps.clock.now(),
    )
    for (const repo of selected) await this.syncRepo(workspaceId, repo)
    return this.deps.repoProjectionRepository.list(workspaceId)
  }

  /**
   * Run one incremental fetch→upsert→cursor cycle for a single resource kind.
   * Reads the prior cursor, fetches (conditionally, via the prior ETag/`since`),
   * upserts when there's anything new, then advances the cursor. The differences
   * between resources (how the request is shaped and how the next cursor is
   * derived) are supplied by the callbacks; the cursor bookkeeping is shared.
   */
  private async syncResource<T>(
    workspaceId: string,
    repoGithubId: number,
    kind: SyncCursorKind,
    fetch: (
      cursor: SyncCursor | null,
    ) => Promise<{ items: T[]; etag?: string | null; notModified?: boolean }>,
    upsert: (items: T[]) => Promise<void>,
    nextCursor: (
      prev: SyncCursor | null,
      etag: string | null | undefined,
      now: number,
    ) => SyncCursor,
  ): Promise<{ items: T[]; etag?: string | null; notModified?: boolean }> {
    const repos = this.deps.repoProjectionRepository
    const cursor = await repos.getCursor(workspaceId, repoGithubId, kind)
    const res = await fetch(cursor)
    if (!res.notModified && res.items.length > 0) await upsert(res.items)
    await repos.setCursor(
      workspaceId,
      repoGithubId,
      kind,
      nextCursor(cursor, res.etag, this.deps.clock.now()),
    )
    return res
  }

  /** Incrementally resync one repo's branches, PRs, issues, commits and checks. */
  async syncRepo(workspaceId: string, repo: GitHubRepo): Promise<void> {
    const ref: GitHubRepoRef = { owner: repo.owner, repo: repo.name }
    const id = repo.githubId
    const installationId = repo.installationId
    const client = this.deps.githubClient

    // ETag-conditional cursor: carry the prior ETag forward when the fetch
    // returns none. PRs/issues (`stampSince`) additionally record a fresh
    // `sinceIso` lower bound for the next delta; branches don't paginate by date.
    const etagCursor =
      (stampSince: boolean) =>
      (prev: SyncCursor | null, etag: string | null | undefined, now: number): SyncCursor => ({
        etag: etag ?? prev?.etag ?? null,
        lastSyncedAt: now,
        sinceIso: stampSince ? new Date(now).toISOString() : null,
      })

    // Branches — conditional GET via ETag.
    const branches = await this.syncResource(
      workspaceId,
      id,
      'branches',
      (cursor) => client.listBranches(installationId, ref, cursor?.etag ?? undefined),
      (items) => this.deps.branchProjectionRepository.upsertMany(workspaceId, items),
      etagCursor(false),
    )
    const defaultBranchSha =
      branches.items.find((b) => b.name === repo.defaultBranch)?.headSha ?? null

    // Pull requests — delta by `since` (GitHub's updated_at lower bound).
    await this.syncResource(
      workspaceId,
      id,
      'pulls',
      (cursor) =>
        client.listPullRequests(installationId, ref, {
          since: cursor?.sinceIso ?? undefined,
          etag: cursor?.etag ?? undefined,
        }),
      (items) => this.deps.pullRequestProjectionRepository.upsertMany(workspaceId, items),
      etagCursor(true),
    )

    // Issues — delta by `since`.
    await this.syncResource(
      workspaceId,
      id,
      'issues',
      (cursor) =>
        client.listIssues(installationId, ref, {
          since: cursor?.sinceIso ?? undefined,
          etag: cursor?.etag ?? undefined,
        }),
      (items) => this.deps.issueProjectionRepository.upsertMany(workspaceId, items),
      etagCursor(true),
    )

    // Commits — delta by `since` on the default branch. On the first sync there
    // is no cursor, so fall back to the backfill horizon (if configured) instead
    // of fetching the repo's entire commit history in one step.
    const commitBackfillSince =
      this.deps.commitBackfillHorizonMs !== undefined
        ? new Date(this.deps.clock.now() - this.deps.commitBackfillHorizonMs).toISOString()
        : undefined
    await this.syncResource(
      workspaceId,
      id,
      'commits',
      (cursor) =>
        client.listCommits(installationId, ref, {
          since: cursor?.sinceIso ?? commitBackfillSince,
        }),
      (items) => this.deps.commitProjectionRepository.upsertMany(workspaceId, items),
      (_prev, _etag, now) => ({
        etag: null,
        lastSyncedAt: now,
        sinceIso: new Date(now).toISOString(),
      }),
    )

    // Check runs for the default-branch head (CI gating signal). Not cursor-based.
    if (defaultBranchSha) {
      const checks = await client.listCheckRuns(installationId, ref, defaultBranchSha)
      if (checks.items.length > 0) {
        await this.deps.checkRunProjectionRepository.upsertMany(workspaceId, checks.items)
      }
    }

    // Stamp the repo row as freshly synced.
    await this.deps.repoProjectionRepository.upsertMany(workspaceId, [
      { ...repo, syncedAt: this.deps.clock.now() },
    ])
  }

  /** Resync a single tracked repo by its GitHub id (used by the queue consumer). */
  async syncRepoById(workspaceId: string, repoGithubId: number): Promise<void> {
    const repo = await this.deps.repoProjectionRepository.get(workspaceId, repoGithubId)
    if (repo) await this.syncRepo(workspaceId, repo)
  }

  /** Incremental resync of every repo this workspace links. */
  async resyncWorkspace(workspaceId: string): Promise<void> {
    const repos = await this.deps.repoProjectionRepository.list(workspaceId)
    for (const repo of repos) await this.syncRepo(workspaceId, repo)
  }

  /**
   * Full backfill for an installation: deep-sync the linked repos of every
   * workspace it backs (the connector workspace plus all workspaces in its
   * account). Repos are linked explicitly, so backfill refreshes what's linked
   * rather than rediscovering the whole installation.
   */
  async backfillInstallation(installationId: number): Promise<void> {
    const installation =
      await this.deps.githubInstallationRepository.getByInstallationId(installationId)
    if (!installation || installation.deletedAt) return
    const workspaceIds =
      await this.deps.githubInstallationRepository.listWorkspacesForInstallation(installationId)
    for (const ws of workspaceIds) await this.resyncWorkspace(ws)
  }
}
