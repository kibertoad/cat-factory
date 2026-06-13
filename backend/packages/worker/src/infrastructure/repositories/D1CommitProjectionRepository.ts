import type { CommitProjectionRepository, GitHubCommit } from '@cat-factory/core'
import type { D1Database } from '@cloudflare/workers-types'
import { type GitHubCommitRow, buildUpsert, commitValues, rowToCommit } from './github-mappers'

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
    await this.db.batch(statements)
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
