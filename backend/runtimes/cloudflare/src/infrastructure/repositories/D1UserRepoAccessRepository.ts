import type { UserRepoAccessRecord, UserRepoAccessRepository } from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'
import { chunkForIn } from './chunk'

interface UserRepoAccessRow {
  user_id: string
  repo_github_id: number
  owner: string
  name: string
  default_branch: string | null
  private: number
  synced_at: number
}

function toRecord(row: UserRepoAccessRow): UserRepoAccessRecord {
  return {
    userId: row.user_id,
    repoGithubId: row.repo_github_id,
    owner: row.owner,
    name: row.name,
    defaultBranch: row.default_branch,
    private: row.private === 1,
    syncedAt: row.synced_at,
  }
}

/** D1-backed per-user "repos my PAT can reach" projection (migration 0038). */
export class D1UserRepoAccessRepository implements UserRepoAccessRepository {
  private readonly db: D1Database
  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  private upsertStatement(record: UserRepoAccessRecord) {
    return this.db
      .prepare(
        `INSERT INTO github_user_repo_access
           (user_id, repo_github_id, owner, name, default_branch, private, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id, repo_github_id) DO UPDATE SET
           owner = excluded.owner,
           name = excluded.name,
           default_branch = excluded.default_branch,
           private = excluded.private,
           synced_at = excluded.synced_at`,
      )
      .bind(
        record.userId,
        record.repoGithubId,
        record.owner,
        record.name,
        record.defaultBranch,
        record.private ? 1 : 0,
        record.syncedAt,
      )
  }

  async replaceForUser(userId: string, repos: UserRepoAccessRecord[]): Promise<void> {
    // A full re-enumeration: drop the stale set then insert the current one, so a repo the
    // PAT can no longer reach stops granting visibility.
    const statements = [
      this.db.prepare(`DELETE FROM github_user_repo_access WHERE user_id = ?`).bind(userId),
      ...repos.map((r) => this.upsertStatement(r)),
    ]
    await this.db.batch(statements)
  }

  async recordAccessible(userId: string, repos: UserRepoAccessRecord[]): Promise<void> {
    if (repos.length === 0) return
    await this.db.batch(repos.map((r) => this.upsertStatement(r)))
  }

  async listAccessibleRepoIds(userId: string, repoGithubIds: number[]): Promise<number[]> {
    if (repoGithubIds.length === 0) return []
    const found: number[] = []
    for (const chunk of chunkForIn(repoGithubIds)) {
      const placeholders = chunk.map(() => '?').join(', ')
      const { results } = await this.db
        .prepare(
          `SELECT repo_github_id FROM github_user_repo_access
           WHERE user_id = ? AND repo_github_id IN (${placeholders})`,
        )
        .bind(userId, ...chunk)
        .all<{ repo_github_id: number }>()
      for (const row of results ?? []) found.push(row.repo_github_id)
    }
    return found
  }

  async listByUser(userId: string): Promise<UserRepoAccessRecord[]> {
    const { results } = await this.db
      .prepare(`SELECT * FROM github_user_repo_access WHERE user_id = ? ORDER BY owner, name`)
      .bind(userId)
      .all<UserRepoAccessRow>()
    return (results ?? []).map(toRecord)
  }

  async removeForUser(userId: string): Promise<void> {
    await this.db
      .prepare(`DELETE FROM github_user_repo_access WHERE user_id = ?`)
      .bind(userId)
      .run()
  }
}
