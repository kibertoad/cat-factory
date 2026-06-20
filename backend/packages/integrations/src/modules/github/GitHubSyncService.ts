import type { Clock } from '@cat-factory/kernel'
import type { GitHubClient, GitHubRepoRef } from '@cat-factory/kernel'
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
} from '@cat-factory/kernel'
import type { GitHubAvailableRepo, GitHubRepo } from '@cat-factory/kernel'

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
   * Link a single repo into this workspace without disturbing the rest (unlike
   * {@link setLinkedRepos}, which sets the exact set and tombstones the others).
   * Projects + deep-syncs the repo the first time it's seen, and is a no-op that
   * returns the live row when it's already tracked. Returns null when the repo is
   * not accessible to the installation (the App hasn't been granted it yet) — the
   * caller surfaces a "grant the App access" hint. Backs the "add an existing
   * repo as a board service" flow, where the workspace may not link the repo yet.
   */
  async linkRepo(workspaceId: string, repoGithubId: number): Promise<GitHubRepo | null> {
    const existing = await this.deps.repoProjectionRepository.get(workspaceId, repoGithubId)
    if (existing) return existing
    const installation = await this.deps.githubInstallationRepository.getByWorkspace(workspaceId)
    if (!installation || installation.deletedAt) return null
    const installationId = installation.installationId
    const { items } = await this.deps.githubClient.listInstallationRepos(installationId)
    const match = items.find((r) => r.githubId === repoGithubId)
    if (!match) return null
    const repo: GitHubRepo = { ...match, installationId, syncedAt: this.deps.clock.now() }
    await this.deps.repoProjectionRepository.upsertMany(workspaceId, [repo])
    // Full pass: the org cursor may already be advanced, so bypass it to populate this
    // newly-linked workspace.
    await this.syncRepo(repo, { full: true })
    return this.deps.repoProjectionRepository.get(workspaceId, repoGithubId)
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
    for (const repo of selected) await this.syncRepo(repo, { full: true })
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
    installationId: number,
    repoGithubId: number,
    kind: SyncCursorKind,
    full: boolean,
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
    // The cursor is installation-scoped (shared across the org's workspaces). A `full`
    // pass ignores it (treats it as empty) so a newly-linked workspace gets fully
    // populated even though the org's cursor is already advanced.
    const cursor = full ? null : await repos.getCursor(installationId, repoGithubId, kind)
    const res = await fetch(cursor)
    if (!res.notModified && res.items.length > 0) await upsert(res.items)
    await repos.setCursor(
      installationId,
      repoGithubId,
      kind,
      nextCursor(cursor, res.etag, this.deps.clock.now()),
    )
    return res
  }

  /** Every workspace in the installation's org that actually links this repo. */
  private async linkedWorkspaces(installationId: number, repoGithubId: number): Promise<string[]> {
    const all =
      await this.deps.githubInstallationRepository.listWorkspacesForInstallation(installationId)
    // One batched query for the whole org, instead of a `get` per workspace.
    return this.deps.repoProjectionRepository.linkedWorkspaces(repoGithubId, all)
  }

  /**
   * Incrementally resync one repo's branches, PRs, issues, commits and checks. The repo
   * is fetched from GitHub ONCE (installation-scoped cursor) and each projection is fanned
   * out to every workspace in the org that links it, so two teams sharing a repo cost one
   * API round-trip, not two. Pass `full` (at link time) to bypass the shared cursor and
   * fully populate a freshly-linked workspace.
   */
  async syncRepo(repo: GitHubRepo, options: { full?: boolean } = {}): Promise<void> {
    const full = options.full ?? false
    const ref: GitHubRepoRef = { owner: repo.owner, repo: repo.name }
    const id = repo.githubId
    const installationId = repo.installationId
    const client = this.deps.githubClient
    const workspaces = await this.linkedWorkspaces(installationId, id)
    const fanOut = async (apply: (ws: string) => Promise<void>) => {
      for (const ws of workspaces) await apply(ws)
    }

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
      installationId,
      id,
      'branches',
      full,
      (cursor) => client.listBranches(installationId, ref, cursor?.etag ?? undefined),
      (items) => fanOut((ws) => this.deps.branchProjectionRepository.upsertMany(ws, items)),
      etagCursor(false),
    )
    const defaultBranchSha =
      branches.items.find((b) => b.name === repo.defaultBranch)?.headSha ?? null

    // Pull requests — delta by `since` (GitHub's updated_at lower bound).
    await this.syncResource(
      installationId,
      id,
      'pulls',
      full,
      (cursor) =>
        client.listPullRequests(installationId, ref, {
          since: cursor?.sinceIso ?? undefined,
          etag: cursor?.etag ?? undefined,
        }),
      (items) => fanOut((ws) => this.deps.pullRequestProjectionRepository.upsertMany(ws, items)),
      etagCursor(true),
    )

    // Issues — delta by `since`.
    await this.syncResource(
      installationId,
      id,
      'issues',
      full,
      (cursor) =>
        client.listIssues(installationId, ref, {
          since: cursor?.sinceIso ?? undefined,
          etag: cursor?.etag ?? undefined,
        }),
      (items) => fanOut((ws) => this.deps.issueProjectionRepository.upsertMany(ws, items)),
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
      installationId,
      id,
      'commits',
      full,
      (cursor) =>
        client.listCommits(installationId, ref, {
          since: cursor?.sinceIso ?? commitBackfillSince,
        }),
      (items) => fanOut((ws) => this.deps.commitProjectionRepository.upsertMany(ws, items)),
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
        await fanOut((ws) => this.deps.checkRunProjectionRepository.upsertMany(ws, checks.items))
      }
    }

    // Stamp the repo row as freshly synced for every workspace that links it.
    const now = this.deps.clock.now()
    await fanOut((ws) =>
      this.deps.repoProjectionRepository.upsertMany(ws, [{ ...repo, syncedAt: now }]),
    )
  }

  /** Resync a single tracked repo by its GitHub id (used by the queue consumer). */
  async syncRepoById(workspaceId: string, repoGithubId: number): Promise<void> {
    const repo = await this.deps.repoProjectionRepository.get(workspaceId, repoGithubId)
    if (repo) await this.syncRepo(repo)
  }

  /** Incremental resync of every repo this workspace links. */
  async resyncWorkspace(workspaceId: string): Promise<void> {
    const repos = await this.deps.repoProjectionRepository.list(workspaceId)
    for (const repo of repos) await this.syncRepo(repo)
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
