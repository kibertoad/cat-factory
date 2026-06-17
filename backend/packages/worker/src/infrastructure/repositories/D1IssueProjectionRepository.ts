import type { GitHubIssue, IssueProjectionRepository } from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'
import { type GitHubIssueRow, buildUpsert, issueValues, rowToIssue } from './github-mappers'

/** D1-backed projection of issues (migration 0004). */
export class D1IssueProjectionRepository implements IssueProjectionRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async upsertMany(workspaceId: string, issues: GitHubIssue[]): Promise<void> {
    if (issues.length === 0) return
    const statements = issues.map((issue) => {
      const { sql, binds } = buildUpsert('github_issues', issueValues(workspaceId, issue), [
        'workspace_id',
        'repo_github_id',
        'number',
      ])
      return this.db.prepare(sql).bind(...binds)
    })
    await this.db.batch(statements)
  }

  async listByRepo(workspaceId: string, repoGithubId: number): Promise<GitHubIssue[]> {
    const { results } = await this.db
      .prepare(
        'SELECT * FROM github_issues WHERE workspace_id = ? AND repo_github_id = ? AND deleted_at IS NULL ORDER BY number DESC',
      )
      .bind(workspaceId, repoGithubId)
      .all<GitHubIssueRow>()
    return results.map(rowToIssue)
  }

  async listByWorkspace(workspaceId: string): Promise<GitHubIssue[]> {
    const { results } = await this.db
      .prepare(
        'SELECT * FROM github_issues WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY gh_updated_at DESC',
      )
      .bind(workspaceId)
      .all<GitHubIssueRow>()
    return results.map(rowToIssue)
  }
}
