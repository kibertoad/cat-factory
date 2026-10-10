import {
  changedDirectoryRepoIds,
  type GitHubRepo,
  type RepoProjectionRepository,
  type StaleRepoRef,
  type StoredDirectoryRepo,
  type SyncCursor,
  type SyncCursorKind,
} from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'
import { chunkForIn } from './chunk'
import { appendDirectoryChanges, reposSource, reposToTombstoneSource } from './directoryFeed'
import {
  type GitHubRepoRow,
  type SyncCursorRow,
  buildUpsert,
  repoValues,
  rowToCursor,
  rowToRepo,
} from './github-mappers'

/** D1-backed projection of repositories (migration 0004) plus per-repo sync cursors. */
export class D1RepoProjectionRepository implements RepoProjectionRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async upsertMany(workspaceId: string, repos: GitHubRepo[]): Promise<void> {
    if (repos.length === 0) return
    const changed = changedDirectoryRepoIds(
      await this.storedDirectoryRepos(
        workspaceId,
        repos.map((r) => r.githubId),
      ),
      repos,
    )
    const statements = repos.map((repo) => {
      // `is_monorepo` and `linked_via` are link-owned, not sync, so never overwrite them.
      const { sql, binds } = buildUpsert(
        'github_repos',
        repoValues(workspaceId, repo),
        ['workspace_id', 'github_id'],
        ['is_monorepo', 'linked_via'],
      )
      return this.db.prepare(sql).bind(...binds)
    })
    const at = Date.now()
    await this.db.batch([
      ...statements,
      ...chunkForIn(changed).map((ids) =>
        appendDirectoryChanges(this.db, reposSource(workspaceId, ids), at),
      ),
    ])
  }

  /** What the directory last published for these rows, tombstoned or not. */
  private async storedDirectoryRepos(
    workspaceId: string,
    githubIds: number[],
  ): Promise<StoredDirectoryRepo[]> {
    const stored: StoredDirectoryRepo[] = []
    // One batch for every chunk, so a large sync reads its stored rows in a single round trip.
    const reads = await this.db.batch<GitHubRepoRow & { deleted_at: number | null }>(
      chunkForIn(githubIds).map((chunk) =>
        this.db
          .prepare(
            `SELECT * FROM github_repos WHERE workspace_id = ? AND github_id IN (${chunk
              .map(() => '?')
              .join(', ')})`,
          )
          .bind(workspaceId, ...chunk),
      ),
    )
    for (const { results } of reads) {
      for (const row of results) {
        const repo = rowToRepo(row)
        stored.push({
          githubId: repo.githubId,
          owner: repo.owner,
          name: repo.name,
          defaultBranch: repo.defaultBranch,
          private: repo.private,
          provider: repo.provider ?? 'github',
          tombstoned: row.deleted_at !== null,
        })
      }
    }
    return stored
  }

  async list(workspaceId: string): Promise<GitHubRepo[]> {
    const { results } = await this.db
      .prepare(
        'SELECT * FROM github_repos WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY owner, name',
      )
      .bind(workspaceId)
      .all<GitHubRepoRow>()
    return results.map(rowToRepo)
  }

  async get(workspaceId: string, githubId: number): Promise<GitHubRepo | null> {
    const row = await this.db
      .prepare(
        'SELECT * FROM github_repos WHERE workspace_id = ? AND github_id = ? AND deleted_at IS NULL',
      )
      .bind(workspaceId, githubId)
      .first<GitHubRepoRow>()
    return row ? rowToRepo(row) : null
  }

  async listByInstallation(installationId: number): Promise<GitHubRepo[]> {
    const { results } = await this.db
      .prepare(
        'SELECT * FROM github_repos WHERE installation_id = ? AND deleted_at IS NULL ORDER BY owner, name',
      )
      .bind(installationId)
      .all<GitHubRepoRow>()
    return results.map(rowToRepo)
  }

  async linkedWorkspaces(repoGithubId: number, candidateWorkspaceIds: string[]): Promise<string[]> {
    if (candidateWorkspaceIds.length === 0) return []
    const found: string[] = []
    // Chunk the IN list to stay under D1's bound-parameter limit (plus the leading github_id bind).
    for (const chunk of chunkForIn(candidateWorkspaceIds)) {
      const placeholders = chunk.map(() => '?').join(', ')
      const { results } = await this.db
        .prepare(
          `SELECT DISTINCT workspace_id FROM github_repos
           WHERE github_id = ? AND deleted_at IS NULL AND workspace_id IN (${placeholders})`,
        )
        .bind(repoGithubId, ...chunk)
        .all<{ workspace_id: string }>()
      for (const row of results ?? []) found.push(row.workspace_id)
    }
    return found
  }

  async tombstoneMissing(
    workspaceId: string,
    installationId: number,
    seenGithubIds: number[],
    at: number,
  ): Promise<void> {
    // The feed rows go first, selected with the update's own predicate while the rows are live.
    const append = appendDirectoryChanges(
      this.db,
      reposToTombstoneSource(workspaceId, installationId, seenGithubIds),
      at,
    )
    if (seenGithubIds.length === 0) {
      await this.db.batch([
        append,
        this.db
          .prepare(
            'UPDATE github_repos SET deleted_at = ? WHERE workspace_id = ? AND installation_id = ? AND deleted_at IS NULL',
          )
          .bind(at, workspaceId, installationId),
      ])
      return
    }
    const placeholders = seenGithubIds.map(() => '?').join(', ')
    await this.db.batch([
      append,
      this.db
        .prepare(
          `UPDATE github_repos SET deleted_at = ?
           WHERE workspace_id = ? AND installation_id = ? AND deleted_at IS NULL
             AND github_id NOT IN (${placeholders})`,
        )
        .bind(at, workspaceId, installationId, ...seenGithubIds),
    ])
  }

  async setMonorepo(workspaceId: string, githubId: number, isMonorepo: boolean): Promise<void> {
    await this.db.batch([
      this.db
        .prepare('UPDATE github_repos SET is_monorepo = ? WHERE workspace_id = ? AND github_id = ?')
        .bind(isMonorepo ? 1 : 0, workspaceId, githubId),
      appendDirectoryChanges(this.db, reposSource(workspaceId, [githubId]), Date.now()),
    ])
  }

  async listStale(olderThanEpochMs: number): Promise<StaleRepoRef[]> {
    // Join the installation so a tombstoned (uninstalled/suspended) installation's
    // repos are excluded: there is no way to mint a token for it, so reconciling it
    // would 404 every pass. `unsuspend`/reinstall clears the installation tombstone,
    // which re-enables its repos automatically — that is the "until reactivated" gate.
    // An INNER JOIN also drops repos whose installation row is missing entirely.
    const { results } = await this.db
      .prepare(
        `SELECT r.workspace_id, r.github_id, r.installation_id, r.owner, r.name
         FROM github_repos r
         JOIN github_installations i ON i.installation_id = r.installation_id
         WHERE r.deleted_at IS NULL AND r.synced_at < ? AND i.deleted_at IS NULL`,
      )
      .bind(olderThanEpochMs)
      .all<{
        workspace_id: string
        github_id: number
        installation_id: number
        owner: string
        name: string
      }>()
    return results.map((r) => ({
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
    const row = await this.db
      .prepare(
        'SELECT etag, last_synced_at, since_iso FROM github_sync_cursors WHERE installation_id = ? AND repo_github_id = ? AND kind = ?',
      )
      .bind(installationId, repoGithubId, kind)
      .first<SyncCursorRow>()
    return row ? rowToCursor(row) : null
  }

  async setCursor(
    installationId: number,
    repoGithubId: number,
    kind: SyncCursorKind,
    cursor: SyncCursor,
  ): Promise<void> {
    const { sql, binds } = buildUpsert(
      'github_sync_cursors',
      {
        installation_id: installationId,
        repo_github_id: repoGithubId,
        kind,
        etag: cursor.etag,
        last_synced_at: cursor.lastSyncedAt,
        since_iso: cursor.sinceIso,
      },
      ['installation_id', 'repo_github_id', 'kind'],
    )
    await this.db
      .prepare(sql)
      .bind(...binds)
      .run()
  }
}
