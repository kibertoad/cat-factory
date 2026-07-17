import type { SkillSourceRecord, SkillSourceRepository } from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'

interface SkillSourceRow {
  id: string
  account_id: string
  repo_owner: string
  repo_name: string
  git_ref: string
  dir_path: string
  last_synced_commit: string | null
  last_synced_at: number | null
  created_at: number
  deleted_at: number | null
}

function rowToRecord(row: SkillSourceRow): SkillSourceRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    gitRef: row.git_ref,
    dirPath: row.dir_path,
    lastSyncedCommit: row.last_synced_commit,
    lastSyncedAt: row.last_synced_at,
    createdAt: row.created_at,
    deletedAt: row.deleted_at,
  }
}

/** D1-backed store of skill-source repo linkages (migration 0052). */
export class D1SkillSourceRepository implements SkillSourceRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async listByAccount(accountId: string): Promise<SkillSourceRecord[]> {
    const { results } = await this.db
      .prepare(
        'SELECT * FROM skill_sources WHERE account_id = ? AND deleted_at IS NULL ORDER BY created_at DESC',
      )
      .bind(accountId)
      .all<SkillSourceRow>()
    return results.map(rowToRecord)
  }

  async get(id: string): Promise<SkillSourceRecord | null> {
    const row = await this.db
      .prepare('SELECT * FROM skill_sources WHERE id = ?')
      .bind(id)
      .first<SkillSourceRow>()
    return row ? rowToRecord(row) : null
  }

  async upsert(record: SkillSourceRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO skill_sources
          (id, account_id, repo_owner, repo_name, git_ref, dir_path,
           last_synced_commit, last_synced_at, created_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           repo_owner = excluded.repo_owner,
           repo_name = excluded.repo_name,
           git_ref = excluded.git_ref,
           dir_path = excluded.dir_path,
           last_synced_commit = excluded.last_synced_commit,
           last_synced_at = excluded.last_synced_at,
           deleted_at = excluded.deleted_at`,
      )
      .bind(
        record.id,
        record.accountId,
        record.repoOwner,
        record.repoName,
        record.gitRef,
        record.dirPath,
        record.lastSyncedCommit,
        record.lastSyncedAt,
        record.createdAt,
        record.deletedAt,
      )
      .run()
  }

  async updateSyncState(
    id: string,
    lastSyncedCommit: string | null,
    lastSyncedAt: number,
  ): Promise<void> {
    await this.db
      .prepare('UPDATE skill_sources SET last_synced_commit = ?, last_synced_at = ? WHERE id = ?')
      .bind(lastSyncedCommit, lastSyncedAt, id)
      .run()
  }

  async softDelete(id: string, at: number): Promise<void> {
    await this.db.prepare('UPDATE skill_sources SET deleted_at = ? WHERE id = ?').bind(at, id).run()
  }
}
