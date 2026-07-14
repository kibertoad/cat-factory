import type { Clock } from '@cat-factory/kernel'
import type { GitHubClient, GitHubRepoRef, Paged } from '@cat-factory/kernel'
import type {
  BranchProjectionRepository,
  CheckRunProjectionRepository,
  CommitProjectionRepository,
  GitHubInstallationRepository,
  GroupCacheHandle,
  IssueProjectionRepository,
  PullRequestProjectionRepository,
  RepoProjectionRepository,
  SyncCursor,
  SyncCursorKind,
  UserRepoAccessRecord,
  UserRepoAccessRepository,
} from '@cat-factory/kernel'
import type { GitHubAvailableRepo, GitHubRepo, RepoTreeEntry } from '@cat-factory/kernel'
import pMap from 'p-map'

// How many repos one workspace resyncs at once, and how many workspaces one installation
// backfills at once. Each unit issues several GitHub reads, so these bound the concurrent
// call fan-out to stay well under GitHub's secondary (abuse) rate limits while still
// collapsing the old serial chains. Modest on purpose (the products stack: a backfill runs
// up to WORKSPACE × REPO syncs in flight).
const REPO_SYNC_CONCURRENCY = 4
const WORKSPACE_BACKFILL_CONCURRENCY = 3

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
   * The per-user "repos my PAT can reach" projection. When wired, browsing the picker with a
   * personal token records the viewer's PAT-reachable repos here (the fail-closed cache the
   * board redaction reads), and linking a personal repo records the linker's access. Optional:
   * a facade without it wired keeps the App-only behaviour.
   */
  userRepoAccessRepository?: UserRepoAccessRepository
  /**
   * Bounds the initial commit backfill: when a repo has no commit cursor yet
   * (its first sync), commits are listed only from `now - commitBackfillHorizonMs`
   * rather than from the dawn of the repo. This keeps a large/monorepo connect
   * from inserting its entire history in one step. Subsequent syncs use the
   * (more recent) cursor. Undefined means backfill the full history (legacy).
   */
  commitBackfillHorizonMs?: number
  /**
   * The workspace repo-projection cache (`AppCaches.repoProjection`, slice 3). Every
   * method here that mutates a workspace's projected repos (link / monorepo-flag / the
   * exact-set write + tombstone / the link-time full re-stamp) drops that workspace's group
   * after the write so the block→repo resolver re-lists fresh. Absent (tests / the
   * Worker's pass-through profile) ⇒ the invalidations are no-ops.
   */
  repoProjectionCache?: GroupCacheHandle<GitHubRepo[]>
}

export class GitHubSyncService {
  constructor(private readonly deps: GitHubSyncServiceDependencies) {}

  /** Drop a workspace's cached repo projection after a write that changed it. */
  private invalidateRepoProjection(workspaceId: string): Promise<void> {
    return this.deps.repoProjectionCache?.invalidateGroup(workspaceId) ?? Promise.resolve()
  }

  /**
   * The repos the workspace's installation can access, annotated with whether
   * this workspace currently links each one. Repos are linked *explicitly* per
   * workspace, so the connect UI lists these and the user picks a subset.
   *
   * An optional `q` is matched server-side in REALTIME via `searchInstallationRepos`
   * (one bounded request per query) so the add-service picker never prefetches the whole
   * installation — a wide install/PAT can expose thousands of repos, and enumerating +
   * filtering in memory both truncates at the enumeration cap (dropping matches beyond it)
   * and re-fetches every page on each keystroke. A blank/whitespace query returns every
   * accessible repo (the repo-link panel's browse-all), so existing callers are unchanged.
   */
  async listAvailableRepos(
    workspaceId: string,
    opts: { q?: string; userId?: string; userToken?: string } = {},
  ): Promise<GitHubAvailableRepo[]> {
    const installation = await this.deps.githubInstallationRepository.getByWorkspace(workspaceId)
    if (!installation || installation.deletedAt) return []
    const tracked = new Map(
      (await this.deps.repoProjectionRepository.list(workspaceId)).map((r) => [r.githubId, r]),
    )
    const query = opts.q?.trim()
    // With a query, search server-side in REALTIME (one bounded request) instead of
    // enumerating the whole installation and filtering in memory: a wide install can
    // expose far more repos than the enumeration cap, so a match beyond it would be
    // silently dropped — the exact "no results for a repo I have access to" bug. Without
    // a query, browse the whole accessible set (the repo-link panel's browse-all).
    const appRepos = query
      ? await this.deps.githubClient.searchInstallationRepos(installation.installationId, query, {
          owner: installation.accountLogin || undefined,
          ownerType: installation.targetType,
        })
      : (await this.deps.githubClient.listInstallationRepos(installation.installationId)).items

    // Expand with repos the signed-in user's own PAT can reach beyond the App's grant — even
    // on the hosted facades. The App repos win on a github-id collision (they're shared, so a
    // repo reachable both ways is NOT personal). Personal-only repos are badged so the user
    // knows linking one makes a frame others may not see.
    const personalRepos = await this.viewerPatRepos(workspaceId, opts, query)
    const appIds = new Set(appRepos.map((r) => r.githubId))
    const merged: GitHubAvailableRepo[] = appRepos.map((r) => ({
      githubId: r.githubId,
      owner: r.owner,
      name: r.name,
      defaultBranch: r.defaultBranch,
      private: r.private,
      linked: tracked.has(r.githubId),
      isMonorepo: tracked.get(r.githubId)?.isMonorepo ?? false,
      personal: false,
    }))
    for (const r of personalRepos) {
      if (appIds.has(r.githubId)) continue
      merged.push({
        githubId: r.githubId,
        owner: r.owner,
        name: r.name,
        defaultBranch: r.defaultBranch,
        private: r.private,
        linked: tracked.has(r.githubId),
        isMonorepo: tracked.get(r.githubId)?.isMonorepo ?? false,
        personal: true,
      })
    }
    return merged
  }

  /**
   * The repos the signed-in user's PAT can reach (via `/user/repos`), and — on a blank browse-all
   * — the refresh of their fail-closed access projection. Empty when no token is supplied, the
   * client can't enumerate by token, or the token can't be used (expired/revoked/network): a
   * personal-token failure degrades to App-only, it never fails the whole picker. A search filters
   * the (bounded) PAT set in memory.
   */
  private async viewerPatRepos(
    workspaceId: string,
    opts: { q?: string; userId?: string; userToken?: string },
    query: string | undefined,
  ): Promise<GitHubRepo[]> {
    const { userToken, userId } = opts
    if (!userToken || !this.deps.githubClient.listReposForToken) return []
    // A stored PAT can be expired/revoked while still decrypting fine (or GitHub can be
    // unreachable). Enumerating with it must NOT 500 the whole available-repos listing — the App
    // repos still have to render — so degrade to App-only on any failure (mirrors the link path's
    // `getRepoForToken` best-effort contract).
    let page: Paged<GitHubRepo>
    try {
      page = await this.deps.githubClient.listReposForToken(userToken)
    } catch {
      return []
    }
    const { items, truncated } = page
    // Refresh the fail-closed access cache only on a blank browse-all (the picker's initial
    // full list), NOT on every search keystroke — a per-search refresh would delete+reinsert the
    // user's whole recorded set on each request. A truncated enumeration is an incomplete prefix,
    // so it can't safely REPLACE the set (that would drop repos beyond the page cap the user
    // really can reach, then redact their own frames); record it additively instead. A complete
    // enumeration replaces, so a repo the PAT can no longer reach stops granting visibility.
    if (!query && userId && this.deps.userRepoAccessRepository) {
      const records = items.map((r) => this.toAccessRecord(userId, r))
      if (truncated) await this.deps.userRepoAccessRepository.recordAccessible(userId, records)
      else await this.deps.userRepoAccessRepository.replaceForUser(userId, records)
    }
    if (!query) return items
    const q = query.toLowerCase()
    return items.filter((r) => `${r.owner}/${r.name}`.toLowerCase().includes(q))
  }

  private toAccessRecord(userId: string, repo: GitHubRepo): UserRepoAccessRecord {
    return {
      userId,
      repoGithubId: repo.githubId,
      owner: repo.owner,
      name: repo.name,
      defaultBranch: repo.defaultBranch,
      private: repo.private,
      syncedAt: this.deps.clock.now(),
    }
  }

  /**
   * Mark (or unmark) a repo as a monorepo (hosting several services, each pinned
   * to a subdirectory). The flag is board-owned state on the projection. Lazily
   * links the repo first if the workspace doesn't track it yet — the "add an
   * existing repo as a service" flow flips this toggle before the repo is added,
   * so it may not be linked. Throws only if the repo isn't accessible to the
   * installation (the App hasn't been granted it).
   */
  async setRepoMonorepo(
    workspaceId: string,
    repoGithubId: number,
    isMonorepo: boolean,
  ): Promise<GitHubRepo> {
    const existing = await this.linkRepo(workspaceId, repoGithubId)
    if (!existing) {
      throw new Error(`Repo ${repoGithubId} is not accessible to workspace '${workspaceId}'`)
    }
    await this.deps.repoProjectionRepository.setMonorepo(workspaceId, repoGithubId, isMonorepo)
    // The monorepo flag decides whether the resolver hands agents the service subdirectory.
    await this.invalidateRepoProjection(workspaceId)
    return { ...existing, isMonorepo }
  }

  /**
   * List the entries of a directory (one level) in a tracked repo, on its default
   * branch, so the monorepo service picker can browse the repo and pin a service to a
   * subdirectory. `path` is repo-root-relative ('' = the root). Directories are
   * returned first (the picker navigates into those), then files for context.
   */
  async listRepoDirectory(
    workspaceId: string,
    repoGithubId: number,
    path = '',
  ): Promise<RepoTreeEntry[]> {
    const installation = await this.deps.githubInstallationRepository.getByWorkspace(workspaceId)
    if (!installation || installation.deletedAt) return []
    // Lazily link the repo if the workspace doesn't track it yet (the add-service
    // flow browses the tree before the repo is added), same as setRepoMonorepo.
    const repo = await this.linkRepo(workspaceId, repoGithubId)
    if (!repo) {
      throw new Error(`Repo ${repoGithubId} is not accessible to workspace '${workspaceId}'`)
    }
    const entries = await this.deps.githubClient.listDirectory(
      installation.installationId,
      { owner: repo.owner, repo: repo.name },
      path.replace(/^\/+|\/+$/g, ''),
      repo.defaultBranch ?? undefined,
    )
    const mapped: RepoTreeEntry[] = entries.map((e) => ({
      path: e.path,
      name: e.name,
      type: e.type,
    }))
    return mapped.sort((a, b) => {
      if (a.type === 'dir' && b.type !== 'dir') return -1
      if (a.type !== 'dir' && b.type === 'dir') return 1
      return a.name.localeCompare(b.name)
    })
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
  async linkRepo(
    workspaceId: string,
    repoGithubId: number,
    opts: { userId?: string; userToken?: string } = {},
  ): Promise<GitHubRepo | null> {
    const existing = await this.deps.repoProjectionRepository.get(workspaceId, repoGithubId)
    if (existing) return existing
    const installation = await this.deps.githubInstallationRepository.getByWorkspace(workspaceId)
    if (!installation || installation.deletedAt) return null
    const installationId = installation.installationId
    // Point-read the single repo by id rather than enumerating the whole installation and
    // scanning it: the enumeration caps at a bounded page count, so a repo the picker's
    // realtime search surfaced from beyond that window would be unlinkable (returned null →
    // a spurious "grant the App access" 409) even though the App can access it.
    const match = await this.deps.githubClient.getRepoById(installationId, repoGithubId)
    if (match) {
      const repo: GitHubRepo = {
        ...match,
        installationId,
        linkedVia: 'app',
        syncedAt: this.deps.clock.now(),
      }
      await this.deps.repoProjectionRepository.upsertMany(workspaceId, [repo])
      await this.invalidateRepoProjection(workspaceId)
      // Full pass: the org cursor may already be advanced, so bypass it to populate this
      // newly-linked workspace.
      await this.syncRepo(repo, { full: true })
      return this.deps.repoProjectionRepository.get(workspaceId, repoGithubId)
    }
    // The App can't reach it — try the linking user's own PAT. If it can, project the repo as
    // a PERSONAL repo (attributed to the workspace installation so `resolveRepoTarget` resolves
    // it, but marked `user_pat`), record the linker's access, and SKIP the App-based sync (the
    // App token can't read its branches/PRs). Runs against it use the initiator's PAT (already
    // wired via the PAT-preferring token mint).
    return this.linkPersonalRepo(workspaceId, repoGithubId, installationId, opts)
  }

  private async linkPersonalRepo(
    workspaceId: string,
    repoGithubId: number,
    installationId: number,
    opts: { userId?: string; userToken?: string },
  ): Promise<GitHubRepo | null> {
    const { userToken, userId } = opts
    if (!userToken || !this.deps.githubClient.getRepoForToken) return null
    const personal = await this.deps.githubClient.getRepoForToken(userToken, repoGithubId)
    if (!personal) return null
    const repo: GitHubRepo = {
      ...personal,
      installationId,
      linkedVia: 'user_pat',
      syncedAt: this.deps.clock.now(),
    }
    await this.deps.repoProjectionRepository.upsertMany(workspaceId, [repo])
    await this.invalidateRepoProjection(workspaceId)
    if (userId && this.deps.userRepoAccessRepository) {
      await this.deps.userRepoAccessRepository.recordAccessible(userId, [
        this.toAccessRecord(userId, repo),
      ])
    }
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
    // The exact-set write + tombstone changed this workspace's projection (even when
    // nothing was selected — a full deselect tombstones everything and runs no syncRepo).
    await this.invalidateRepoProjection(workspaceId)
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
    // Fan a resource's projected rows out to every workspace that links the repo. The
    // per-workspace applies are independent writes (each to its own workspace's projection),
    // so run them concurrently rather than one-after-another — a repo shared by N workspaces
    // then costs one write's latency per resource, not N.
    const fanOut = async (apply: (ws: string) => Promise<void>) => {
      await Promise.all(workspaces.map(apply))
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

    // Commits fall back to the backfill horizon on the first sync (no cursor) instead of
    // fetching the repo's entire history in one step — a plain sync computation, so hoist it
    // out of the wave below.
    const commitBackfillSince =
      this.deps.commitBackfillHorizonMs !== undefined
        ? new Date(this.deps.clock.now() - this.deps.commitBackfillHorizonMs).toISOString()
        : undefined

    // Branches, PRs, issues and commits are independent GitHub resources, each on its OWN
    // installation-scoped cursor (no cross-kind ordering — `syncResource` reads+writes a single
    // per-kind cursor), so fetch+upsert them in one concurrent wave rather than serially. This
    // is a fixed 4-wide fan-out per repo (not data-scaled), so it doesn't risk the secondary
    // rate limits the data-scaled loops below stay bounded against. Checks alone must wait: it
    // needs the default-branch head resolved from the branch fetch.
    const [branches] = await Promise.all([
      // Branches — conditional GET via ETag.
      this.syncResource(
        installationId,
        id,
        'branches',
        full,
        (cursor) => client.listBranches(installationId, ref, cursor?.etag ?? undefined),
        (items) => fanOut((ws) => this.deps.branchProjectionRepository.upsertMany(ws, items)),
        etagCursor(false),
      ),
      // Pull requests — delta by `since` (GitHub's updated_at lower bound).
      this.syncResource(
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
      ),
      // Issues — delta by `since`.
      this.syncResource(
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
      ),
      // Commits — delta by `since` on the default branch. On the first sync there is no
      // cursor, so fall back to the backfill horizon (if configured).
      this.syncResource(
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
      ),
    ])
    const defaultBranchSha =
      branches.items.find((b) => b.name === repo.defaultBranch)?.headSha ?? null

    // Check runs for the default-branch head (CI gating signal). Not cursor-based.
    if (defaultBranchSha) {
      const checks = await client.listCheckRuns(installationId, ref, defaultBranchSha)
      if (checks.items.length > 0) {
        await fanOut((ws) => this.deps.checkRunProjectionRepository.upsertMany(ws, checks.items))
      }
    }

    // Stamp the repo row as freshly synced for every workspace that links it. On an
    // incremental resync (`full` false — the queue consumer / periodic reconcile) the
    // `repo` came from the stored projection, so only `syncedAt` changes — not a field the
    // resolver reads — and there is nothing to invalidate. A `full` pass runs only at link
    // time (linkRepo / setLinkedRepos) with freshly-FETCHED metadata, which can differ from
    // what ANOTHER workspace sharing this repo has cached, so drop each fanned-out
    // workspace's group then. (The triggering workspace's own group was already dropped by
    // the link/set caller.) Gating on `full` keeps the frequent resync path from churning
    // the cache the durable poll ticks are meant to hit.
    const now = this.deps.clock.now()
    await fanOut((ws) =>
      this.deps.repoProjectionRepository.upsertMany(ws, [{ ...repo, syncedAt: now }]),
    )
    if (full) await Promise.all(workspaces.map((ws) => this.invalidateRepoProjection(ws)))
  }

  /** Resync a single tracked repo by its GitHub id (used by the queue consumer). */
  async syncRepoById(workspaceId: string, repoGithubId: number): Promise<void> {
    const repo = await this.deps.repoProjectionRepository.get(workspaceId, repoGithubId)
    if (repo) await this.syncRepo(repo)
  }

  /** Incremental resync of every repo this workspace links. */
  async resyncWorkspace(workspaceId: string): Promise<void> {
    const repos = await this.deps.repoProjectionRepository.list(workspaceId)
    // Resync repos with bounded concurrency, not a serial chain nor an unbounded `Promise.all`:
    // each `syncRepo` issues several GitHub reads, so a workspace linking many repos would
    // otherwise crawl (serial) or burst enough concurrent calls to trip GitHub's secondary
    // (abuse) rate limits (unbounded).
    await pMap(repos, (repo) => this.syncRepo(repo), { concurrency: REPO_SYNC_CONCURRENCY })
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
    // Bounded per-workspace concurrency (each `resyncWorkspace` itself bounds its per-repo
    // reads), so a large installation backfills in parallel without an unbounded GitHub burst.
    await pMap(workspaceIds, (ws) => this.resyncWorkspace(ws), {
      concurrency: WORKSPACE_BACKFILL_CONCURRENCY,
    })
  }
}
