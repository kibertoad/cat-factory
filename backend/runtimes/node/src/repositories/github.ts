import type {
  BranchProjectionRepository,
  CheckRunProjectionRepository,
  CommitProjectionRepository,
  GitHubBranch,
  GitHubCheckRun,
  GitHubCommit,
  GitHubIssue,
  GitHubPullRequest,
  GitHubRepo,
  IssueProjectionRepository,
  PullRequestProjectionRepository,
  RepoProjectionRepository,
  StaleRepoRef,
  SyncCursor,
  SyncCursorKind,
} from '@cat-factory/kernel'
import { and, eq, inArray, isNull, lt, notInArray } from 'drizzle-orm'
import type { DrizzleDb } from '../db/client.js'
import {
  githubBranches,
  githubCheckRuns,
  githubCommits,
  githubInstallations,
  githubIssues,
  githubPullRequests,
  githubRepos,
  githubSyncCursors,
} from '../db/schema.js'

// Drizzle/Postgres mirrors of the GitHub projection D1 repositories (migration 0004;
// cursors re-keyed by migration 0032). The inline GitHub sync populates these read
// models. Behaviourally identical to the D1 repos so the cross-runtime conformance
// suite asserts the same projections against both stores. 0/1 integer flags map to
// booleans here exactly as the D1 mappers do.

const bool = (v: number): boolean => v === 1
const intBool = (v: boolean | undefined): number => (v ? 1 : 0)

// ---- repositories projection (+ sync cursors) -----------------------------

function rowToRepo(row: typeof githubRepos.$inferSelect): GitHubRepo {
  return {
    githubId: row.github_id,
    installationId: row.installation_id,
    owner: row.owner,
    name: row.name,
    defaultBranch: row.default_branch,
    private: bool(row.private),
    blockId: row.block_id,
    isMonorepo: bool(row.is_monorepo),
    syncedAt: row.synced_at,
  }
}

/** Repositories projection over Postgres plus per-(installation,repo) sync cursors. */
export class DrizzleRepoProjectionRepository implements RepoProjectionRepository {
  constructor(private readonly db: DrizzleDb) {}

  async upsertMany(workspaceId: string, repos: GitHubRepo[]): Promise<void> {
    if (repos.length === 0) return
    for (const repo of repos) {
      const values = {
        workspace_id: workspaceId,
        github_id: repo.githubId,
        installation_id: repo.installationId,
        owner: repo.owner,
        name: repo.name,
        default_branch: repo.defaultBranch,
        private: intBool(repo.private),
        is_monorepo: intBool(repo.isMonorepo ?? false),
        synced_at: repo.syncedAt,
        deleted_at: null,
      }
      // `block_id` and `is_monorepo` are board-owned (set via linkBlock/setMonorepo),
      // not sync — the update set deliberately omits them so sync never clobbers them.
      await this.db
        .insert(githubRepos)
        .values(values)
        .onConflictDoUpdate({
          target: [githubRepos.workspace_id, githubRepos.github_id],
          set: {
            installation_id: values.installation_id,
            owner: values.owner,
            name: values.name,
            default_branch: values.default_branch,
            private: values.private,
            synced_at: values.synced_at,
            deleted_at: null,
          },
        })
    }
  }

  async list(workspaceId: string): Promise<GitHubRepo[]> {
    const rows = await this.db
      .select()
      .from(githubRepos)
      .where(and(eq(githubRepos.workspace_id, workspaceId), isNull(githubRepos.deleted_at)))
      .orderBy(githubRepos.owner, githubRepos.name)
    return rows.map(rowToRepo)
  }

  async get(workspaceId: string, githubId: number): Promise<GitHubRepo | null> {
    const rows = await this.db
      .select()
      .from(githubRepos)
      .where(
        and(
          eq(githubRepos.workspace_id, workspaceId),
          eq(githubRepos.github_id, githubId),
          isNull(githubRepos.deleted_at),
        ),
      )
      .limit(1)
    return rows[0] ? rowToRepo(rows[0]) : null
  }

  async linkedWorkspaces(
    repoGithubId: number,
    candidateWorkspaceIds: string[],
  ): Promise<string[]> {
    if (candidateWorkspaceIds.length === 0) return []
    const rows = await this.db
      .selectDistinct({ workspace_id: githubRepos.workspace_id })
      .from(githubRepos)
      .where(
        and(
          eq(githubRepos.github_id, repoGithubId),
          isNull(githubRepos.deleted_at),
          inArray(githubRepos.workspace_id, candidateWorkspaceIds),
        ),
      )
    return rows.map((r) => r.workspace_id)
  }

  async tombstoneMissing(
    workspaceId: string,
    installationId: number,
    seenGithubIds: number[],
    at: number,
  ): Promise<void> {
    const base = and(
      eq(githubRepos.workspace_id, workspaceId),
      eq(githubRepos.installation_id, installationId),
      isNull(githubRepos.deleted_at),
    )
    await this.db
      .update(githubRepos)
      .set({ deleted_at: at })
      .where(
        seenGithubIds.length === 0
          ? base
          : and(base, notInArray(githubRepos.github_id, seenGithubIds)),
      )
  }

  async linkBlock(workspaceId: string, githubId: number, blockId: string | null): Promise<void> {
    await this.db
      .update(githubRepos)
      .set({ block_id: blockId })
      .where(and(eq(githubRepos.workspace_id, workspaceId), eq(githubRepos.github_id, githubId)))
  }

  async setMonorepo(workspaceId: string, githubId: number, isMonorepo: boolean): Promise<void> {
    await this.db
      .update(githubRepos)
      .set({ is_monorepo: intBool(isMonorepo) })
      .where(and(eq(githubRepos.workspace_id, workspaceId), eq(githubRepos.github_id, githubId)))
  }

  async listStale(olderThanEpochMs: number): Promise<StaleRepoRef[]> {
    // Inner-join the installation so a tombstoned (uninstalled/suspended) installation's
    // repos are excluded — there's no token to mint, so reconciling would 404 every pass.
    const rows = await this.db
      .select({
        workspace_id: githubRepos.workspace_id,
        github_id: githubRepos.github_id,
        installation_id: githubRepos.installation_id,
        owner: githubRepos.owner,
        name: githubRepos.name,
      })
      .from(githubRepos)
      .innerJoin(
        githubInstallations,
        eq(githubInstallations.installation_id, githubRepos.installation_id),
      )
      .where(
        and(
          isNull(githubRepos.deleted_at),
          lt(githubRepos.synced_at, olderThanEpochMs),
          isNull(githubInstallations.deleted_at),
        ),
      )
    return rows.map((r) => ({
      workspaceId: r.workspace_id,
      githubId: r.github_id,
      installationId: r.installation_id,
      owner: r.owner,
      name: r.name,
    }))
  }

  async getCursor(
    installationId: number,
    repoGithubId: number,
    kind: SyncCursorKind,
  ): Promise<SyncCursor | null> {
    const rows = await this.db
      .select()
      .from(githubSyncCursors)
      .where(
        and(
          eq(githubSyncCursors.installation_id, installationId),
          eq(githubSyncCursors.repo_github_id, repoGithubId),
          eq(githubSyncCursors.kind, kind),
        ),
      )
      .limit(1)
    const row = rows[0]
    return row
      ? { etag: row.etag, lastSyncedAt: row.last_synced_at, sinceIso: row.since_iso }
      : null
  }

  async setCursor(
    installationId: number,
    repoGithubId: number,
    kind: SyncCursorKind,
    cursor: SyncCursor,
  ): Promise<void> {
    await this.db
      .insert(githubSyncCursors)
      .values({
        installation_id: installationId,
        repo_github_id: repoGithubId,
        kind,
        etag: cursor.etag,
        last_synced_at: cursor.lastSyncedAt,
        since_iso: cursor.sinceIso,
      })
      .onConflictDoUpdate({
        target: [
          githubSyncCursors.installation_id,
          githubSyncCursors.repo_github_id,
          githubSyncCursors.kind,
        ],
        set: { etag: cursor.etag, last_synced_at: cursor.lastSyncedAt, since_iso: cursor.sinceIso },
      })
  }
}

// ---- branches -------------------------------------------------------------

export class DrizzleBranchProjectionRepository implements BranchProjectionRepository {
  constructor(private readonly db: DrizzleDb) {}

  async upsertMany(workspaceId: string, branches: GitHubBranch[]): Promise<void> {
    for (const b of branches) {
      await this.db
        .insert(githubBranches)
        .values({
          workspace_id: workspaceId,
          repo_github_id: b.repoGithubId,
          name: b.name,
          head_sha: b.headSha,
          protected: intBool(b.protected),
          synced_at: b.syncedAt,
          deleted_at: null,
        })
        .onConflictDoUpdate({
          target: [githubBranches.workspace_id, githubBranches.repo_github_id, githubBranches.name],
          set: { head_sha: b.headSha, protected: intBool(b.protected), synced_at: b.syncedAt, deleted_at: null },
        })
    }
  }

  async listByRepo(workspaceId: string, repoGithubId: number): Promise<GitHubBranch[]> {
    const rows = await this.db
      .select()
      .from(githubBranches)
      .where(
        and(
          eq(githubBranches.workspace_id, workspaceId),
          eq(githubBranches.repo_github_id, repoGithubId),
          isNull(githubBranches.deleted_at),
        ),
      )
      .orderBy(githubBranches.name)
    return rows.map((row) => ({
      repoGithubId: row.repo_github_id,
      name: row.name,
      headSha: row.head_sha,
      protected: bool(row.protected),
      syncedAt: row.synced_at,
    }))
  }
}

// ---- pull requests --------------------------------------------------------

export class DrizzlePullRequestProjectionRepository implements PullRequestProjectionRepository {
  constructor(private readonly db: DrizzleDb) {}

  async upsertMany(workspaceId: string, pulls: GitHubPullRequest[]): Promise<void> {
    for (const p of pulls) {
      const set = {
        github_id: p.githubId,
        title: p.title,
        state: p.state,
        head_ref: p.headRef,
        base_ref: p.baseRef,
        head_sha: p.headSha,
        merged: intBool(p.merged),
        author: p.author,
        gh_updated_at: p.updatedAt,
        synced_at: p.syncedAt,
        deleted_at: null,
      }
      await this.db
        .insert(githubPullRequests)
        .values({
          workspace_id: workspaceId,
          repo_github_id: p.repoGithubId,
          number: p.number,
          ...set,
        })
        .onConflictDoUpdate({
          target: [
            githubPullRequests.workspace_id,
            githubPullRequests.repo_github_id,
            githubPullRequests.number,
          ],
          set,
        })
    }
  }

  private rowToPr(row: typeof githubPullRequests.$inferSelect): GitHubPullRequest {
    return {
      repoGithubId: row.repo_github_id,
      number: row.number,
      githubId: row.github_id,
      title: row.title,
      state: row.state === 'closed' ? 'closed' : 'open',
      headRef: row.head_ref,
      baseRef: row.base_ref,
      headSha: row.head_sha,
      merged: bool(row.merged),
      author: row.author,
      updatedAt: row.gh_updated_at,
      syncedAt: row.synced_at,
    }
  }

  async listByRepo(workspaceId: string, repoGithubId: number): Promise<GitHubPullRequest[]> {
    const rows = await this.db
      .select()
      .from(githubPullRequests)
      .where(
        and(
          eq(githubPullRequests.workspace_id, workspaceId),
          eq(githubPullRequests.repo_github_id, repoGithubId),
          isNull(githubPullRequests.deleted_at),
        ),
      )
    return rows.map((r) => this.rowToPr(r)).sort((a, b) => b.number - a.number)
  }

  async listByWorkspace(workspaceId: string): Promise<GitHubPullRequest[]> {
    const rows = await this.db
      .select()
      .from(githubPullRequests)
      .where(
        and(
          eq(githubPullRequests.workspace_id, workspaceId),
          isNull(githubPullRequests.deleted_at),
        ),
      )
    return rows
      .map((r) => this.rowToPr(r))
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  }
}

// ---- issues ---------------------------------------------------------------

export class DrizzleIssueProjectionRepository implements IssueProjectionRepository {
  constructor(private readonly db: DrizzleDb) {}

  async upsertMany(workspaceId: string, issues: GitHubIssue[]): Promise<void> {
    for (const i of issues) {
      const set = {
        github_id: i.githubId,
        title: i.title,
        state: i.state,
        author: i.author,
        labels: JSON.stringify(i.labels),
        gh_updated_at: i.updatedAt,
        synced_at: i.syncedAt,
        deleted_at: null,
      }
      await this.db
        .insert(githubIssues)
        .values({ workspace_id: workspaceId, repo_github_id: i.repoGithubId, number: i.number, ...set })
        .onConflictDoUpdate({
          target: [githubIssues.workspace_id, githubIssues.repo_github_id, githubIssues.number],
          set,
        })
    }
  }

  private rowToIssue(row: typeof githubIssues.$inferSelect): GitHubIssue {
    return {
      repoGithubId: row.repo_github_id,
      number: row.number,
      githubId: row.github_id,
      title: row.title,
      state: row.state === 'closed' ? 'closed' : 'open',
      author: row.author,
      labels: JSON.parse(row.labels) as string[],
      updatedAt: row.gh_updated_at,
      syncedAt: row.synced_at,
    }
  }

  async listByRepo(workspaceId: string, repoGithubId: number): Promise<GitHubIssue[]> {
    const rows = await this.db
      .select()
      .from(githubIssues)
      .where(
        and(
          eq(githubIssues.workspace_id, workspaceId),
          eq(githubIssues.repo_github_id, repoGithubId),
          isNull(githubIssues.deleted_at),
        ),
      )
    return rows.map((r) => this.rowToIssue(r)).sort((a, b) => b.number - a.number)
  }

  async listByWorkspace(workspaceId: string): Promise<GitHubIssue[]> {
    const rows = await this.db
      .select()
      .from(githubIssues)
      .where(and(eq(githubIssues.workspace_id, workspaceId), isNull(githubIssues.deleted_at)))
    return rows
      .map((r) => this.rowToIssue(r))
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  }
}

// ---- commits --------------------------------------------------------------

export class DrizzleCommitProjectionRepository implements CommitProjectionRepository {
  constructor(private readonly db: DrizzleDb) {}

  async upsertMany(workspaceId: string, commits: GitHubCommit[]): Promise<void> {
    for (const c of commits) {
      const set = {
        message: c.message,
        author: c.author,
        authored_at: c.authoredAt,
        synced_at: c.syncedAt,
      }
      await this.db
        .insert(githubCommits)
        .values({ workspace_id: workspaceId, repo_github_id: c.repoGithubId, sha: c.sha, ...set })
        .onConflictDoUpdate({
          target: [githubCommits.workspace_id, githubCommits.repo_github_id, githubCommits.sha],
          set,
        })
    }
  }

  async deleteOlderThan(epochMs: number): Promise<number> {
    // NULL authored_at rows are kept (we can't place them in the retention window).
    const deleted = await this.db
      .delete(githubCommits)
      .where(lt(githubCommits.authored_at, epochMs))
      .returning({ sha: githubCommits.sha })
    return deleted.length
  }

  async listByRepo(
    workspaceId: string,
    repoGithubId: number,
    limit = 100,
  ): Promise<GitHubCommit[]> {
    const rows = await this.db
      .select()
      .from(githubCommits)
      .where(
        and(
          eq(githubCommits.workspace_id, workspaceId),
          eq(githubCommits.repo_github_id, repoGithubId),
        ),
      )
    return rows
      .map((row) => ({
        repoGithubId: row.repo_github_id,
        sha: row.sha,
        message: row.message,
        author: row.author,
        authoredAt: row.authored_at,
        syncedAt: row.synced_at,
      }))
      .sort((a, b) => (b.authoredAt ?? 0) - (a.authoredAt ?? 0))
      .slice(0, limit)
  }
}

// ---- check runs -----------------------------------------------------------

export class DrizzleCheckRunProjectionRepository implements CheckRunProjectionRepository {
  constructor(private readonly db: DrizzleDb) {}

  async upsertMany(workspaceId: string, checks: GitHubCheckRun[]): Promise<void> {
    for (const c of checks) {
      const set = {
        head_sha: c.headSha,
        name: c.name,
        status: c.status,
        conclusion: c.conclusion,
        synced_at: c.syncedAt,
      }
      await this.db
        .insert(githubCheckRuns)
        .values({ workspace_id: workspaceId, repo_github_id: c.repoGithubId, github_id: c.githubId, ...set })
        .onConflictDoUpdate({
          target: [
            githubCheckRuns.workspace_id,
            githubCheckRuns.repo_github_id,
            githubCheckRuns.github_id,
          ],
          set,
        })
    }
  }

  async listBySha(
    workspaceId: string,
    repoGithubId: number,
    headSha: string,
  ): Promise<GitHubCheckRun[]> {
    const rows = await this.db
      .select()
      .from(githubCheckRuns)
      .where(
        and(
          eq(githubCheckRuns.workspace_id, workspaceId),
          eq(githubCheckRuns.repo_github_id, repoGithubId),
          eq(githubCheckRuns.head_sha, headSha),
        ),
      )
      .orderBy(githubCheckRuns.name)
    return rows.map((row) => ({
      repoGithubId: row.repo_github_id,
      githubId: row.github_id,
      headSha: row.head_sha,
      name: row.name,
      status: row.status,
      conclusion: row.conclusion,
      syncedAt: row.synced_at,
    }))
  }
}
