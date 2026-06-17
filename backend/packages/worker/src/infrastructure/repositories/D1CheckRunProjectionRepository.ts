import type { CheckRunProjectionRepository, GitHubCheckRun } from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'
import {
  type GitHubCheckRunRow,
  buildUpsert,
  checkRunValues,
  rowToCheckRun,
} from './github-mappers'

/** D1-backed projection of check runs (migration 0004). */
export class D1CheckRunProjectionRepository implements CheckRunProjectionRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async upsertMany(workspaceId: string, checks: GitHubCheckRun[]): Promise<void> {
    if (checks.length === 0) return
    const statements = checks.map((check) => {
      const { sql, binds } = buildUpsert('github_check_runs', checkRunValues(workspaceId, check), [
        'workspace_id',
        'repo_github_id',
        'github_id',
      ])
      return this.db.prepare(sql).bind(...binds)
    })
    await this.db.batch(statements)
  }

  async listBySha(
    workspaceId: string,
    repoGithubId: number,
    headSha: string,
  ): Promise<GitHubCheckRun[]> {
    const { results } = await this.db
      .prepare(
        'SELECT * FROM github_check_runs WHERE workspace_id = ? AND repo_github_id = ? AND head_sha = ? ORDER BY name',
      )
      .bind(workspaceId, repoGithubId, headSha)
      .all<GitHubCheckRunRow>()
    return results.map(rowToCheckRun)
  }
}
