import type { CommitProjectionRepository, GitHubCommit } from '@cat-factory/kernel'
import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types'
import { type GitHubCommitRow, buildUpsert, commitValues, rowToCommit } from './github-mappers'

/**
 * Cap how many single-row upserts go in one `db.batch`. A backfill can hand us
 * 100k+ commits in a single call; chunking keeps each batch well under D1's
 * statement-count and bound-parameter ceilings (~100 params/statement). Each
 * statement here binds one row's columns, so the cap is comfortably conservative.
 */
const UPSERT_CHUNK_SIZE = 50

/** D1-backed projection of commits (migration 0004). */
export class D1CommitProjectionRepository implements CommitProjectionRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async upsertMany(workspaceId: string, commits: GitHubCommit[]): Promise<void> {
    if (commits.length === 0) return
    const statements = commits.map((commit) => {
      const { sql, binds } = buildUpsert('github_commits', commitValues(workspaceId, commit), [
        'workspace_id',
        'repo_github_id',
        'sha',
      ])
      return this.db.prepare(sql).bind(...binds)
    })
    for (let i = 0; i < statements.length; i += UPSERT_CHUNK_SIZE) {
      const chunk: D1PreparedStatement[] = statements.slice(i, i + UPSERT_CHUNK_SIZE)
      await this.db.batch(chunk)
    }
  }

  async deleteOlderThan(epochMs: number): Promise<number> {
    // Range delete on idx_gh_commits_authored. NULL authored_at rows are kept,
    // since we can't place them in the retention window.
    const { meta } = await this.db
      .prepare('DELETE FROM github_commits WHERE authored_at IS NOT NULL AND authored_at < ?')
      .bind(epochMs)
      .run()
    return meta.changes ?? 0
  }

  async listByRepo(
    workspaceId: string,
    repoGithubId: number,
    limit = 100,
  ): Promise<GitHubCommit[]> {
    const { results } = await this.db
      .prepare(
        'SELECT * FROM github_commits WHERE workspace_id = ? AND repo_github_id = ? ORDER BY authored_at DESC LIMIT ?',
      )
      .bind(workspaceId, repoGithubId, limit)
      .all<GitHubCommitRow>()
    return results.map(rowToCommit)
  }
}
