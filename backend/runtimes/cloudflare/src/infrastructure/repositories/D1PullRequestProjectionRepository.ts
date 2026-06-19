import type { GitHubPullRequest, PullRequestProjectionRepository } from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'
import {
  type GitHubPullRequestRow,
  buildUpsert,
  pullRequestValues,
  rowToPullRequest,
} from './github-mappers'

/** D1-backed projection of pull requests (migration 0004). */
export class D1PullRequestProjectionRepository implements PullRequestProjectionRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async upsertMany(workspaceId: string, pulls: GitHubPullRequest[]): Promise<void> {
    if (pulls.length === 0) return
    const statements = pulls.map((pr) => {
      const { sql, binds } = buildUpsert(
        'github_pull_requests',
        pullRequestValues(workspaceId, pr),
        ['workspace_id', 'repo_github_id', 'number'],
      )
      return this.db.prepare(sql).bind(...binds)
    })
    await this.db.batch(statements)
  }

  async listByRepo(workspaceId: string, repoGithubId: number): Promise<GitHubPullRequest[]> {
    const { results } = await this.db
      .prepare(
        'SELECT * FROM github_pull_requests WHERE workspace_id = ? AND repo_github_id = ? AND deleted_at IS NULL ORDER BY number DESC',
      )
      .bind(workspaceId, repoGithubId)
      .all<GitHubPullRequestRow>()
    return results.map(rowToPullRequest)
  }

  async listByWorkspace(workspaceId: string): Promise<GitHubPullRequest[]> {
    const { results } = await this.db
      .prepare(
        'SELECT * FROM github_pull_requests WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY gh_updated_at DESC',
      )
      .bind(workspaceId)
      .all<GitHubPullRequestRow>()
    return results.map(rowToPullRequest)
  }
}
