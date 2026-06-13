import type {
  GitHubRepo,
  RepoProjectionRepository,
  StaleRepoRef,
  SyncCursor,
  SyncCursorKind,
} from '@cat-factory/core'
import type { D1Database } from '@cloudflare/workers-types'
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
    const statements = repos.map((repo) => {
      // `block_id` is owned by the board link, not sync — never overwrite it.
      const { sql, binds } = buildUpsert(
        'github_repos',
        repoValues(workspaceId, repo),
        ['workspace_id', 'github_id'],
        ['block_id'],
      )
      return this.db.prepare(sql).bind(...binds)
    })
    await this.db.batch(statements)
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

  async tombstoneMissing(
    workspaceId: string,
    installationId: number,
    seenGithubIds: number[],
    at: number,
  ): Promise<void> {
    if (seenGithubIds.length === 0) {
      await this.db
        .prepare(
          'UPDATE github_repos SET deleted_at = ? WHERE workspace_id = ? AND installation_id = ? AND deleted_at IS NULL',
        )
        .bind(at, workspaceId, installationId)
        .run()
      return
    }
    const placeholders = seenGithubIds.map(() => '?').join(', ')
    await this.db
      .prepare(
        `UPDATE github_repos SET deleted_at = ?
         WHERE workspace_id = ? AND installation_id = ? AND deleted_at IS NULL
           AND github_id NOT IN (${placeholders})`,
      )
      .bind(at, workspaceId, installationId, ...seenGithubIds)
      .run()
  }

  async linkBlock(workspaceId: string, githubId: number, blockId: string | null): Promise<void> {
    await this.db
      .prepare('UPDATE github_repos SET block_id = ? WHERE workspace_id = ? AND github_id = ?')
      .bind(blockId, workspaceId, githubId)
      .run()
  }

  async listStale(olderThanEpochMs: number): Promise<StaleRepoRef[]> {
    const { results } = await this.db
      .prepare(
        `SELECT workspace_id, github_id, installation_id, owner, name
         FROM github_repos WHERE deleted_at IS NULL AND synced_at < ?`,
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
    workspaceId: string,
    repoGithubId: number,
    kind: SyncCursorKind,
  ): Promise<SyncCursor | null> {
    const row = await this.db
      .prepare(
        'SELECT etag, last_synced_at, since_iso FROM github_sync_cursors WHERE workspace_id = ? AND repo_github_id = ? AND kind = ?',
      )
      .bind(workspaceId, repoGithubId, kind)
      .first<SyncCursorRow>()
    return row ? rowToCursor(row) : null
  }

  async setCursor(
    workspaceId: string,
    repoGithubId: number,
    kind: SyncCursorKind,
    cursor: SyncCursor,
  ): Promise<void> {
    const { sql, binds } = buildUpsert(
      'github_sync_cursors',
      {
        workspace_id: workspaceId,
        repo_github_id: repoGithubId,
        kind,
        etag: cursor.etag,
        last_synced_at: cursor.lastSyncedAt,
        since_iso: cursor.sinceIso,
      },
      ['workspace_id', 'repo_github_id', 'kind'],
    )
    await this.db
      .prepare(sql)
      .bind(...binds)
      .run()
  }
}
