import type { BranchProjectionRepository, GitHubBranch } from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'
import { type GitHubBranchRow, branchValues, buildUpsert, rowToBranch } from './github-mappers'

/** D1-backed projection of repository branches (migration 0004). */
export class D1BranchProjectionRepository implements BranchProjectionRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async upsertMany(workspaceId: string, branches: GitHubBranch[]): Promise<void> {
    if (branches.length === 0) return
    const statements = branches.map((branch) => {
      const { sql, binds } = buildUpsert('github_branches', branchValues(workspaceId, branch), [
        'workspace_id',
        'repo_github_id',
        'name',
      ])
      return this.db.prepare(sql).bind(...binds)
    })
    await this.db.batch(statements)
  }

  async listByRepo(workspaceId: string, repoGithubId: number): Promise<GitHubBranch[]> {
    const { results } = await this.db
      .prepare(
        'SELECT * FROM github_branches WHERE workspace_id = ? AND repo_github_id = ? AND deleted_at IS NULL ORDER BY name',
      )
      .bind(workspaceId, repoGithubId)
      .all<GitHubBranchRow>()
    return results.map(rowToBranch)
  }
}
