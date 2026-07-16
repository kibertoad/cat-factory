import type { AccountSkillRecord, AccountSkillRepository, SkillResource } from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'

interface AccountSkillRow {
  skill_id: string
  account_id: string
  name: string
  description: string
  instructions: string
  resources: string
  source_id: string
  source_path: string
  source_sha: string
  pinned_commit: string | null
  created_at: number
  updated_at: number
  deleted_at: number | null
}

function parseResources(raw: string | null): SkillResource[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as SkillResource[]) : []
  } catch {
    return []
  }
}

function rowToRecord(row: AccountSkillRow): AccountSkillRecord {
  return {
    skillId: row.skill_id,
    accountId: row.account_id,
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    resources: parseResources(row.resources),
    sourceId: row.source_id,
    sourcePath: row.source_path,
    sourceSha: row.source_sha,
    pinnedCommit: row.pinned_commit,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  }
}

/** D1-backed store of account skill rows (migration 0052). */
export class D1AccountSkillRepository implements AccountSkillRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async listByAccount(accountId: string, includeDeleted = false): Promise<AccountSkillRecord[]> {
    const sql = includeDeleted
      ? 'SELECT * FROM account_skills WHERE account_id = ?'
      : 'SELECT * FROM account_skills WHERE account_id = ? AND deleted_at IS NULL'
    const { results } = await this.db.prepare(sql).bind(accountId).all<AccountSkillRow>()
    return results.map(rowToRecord)
  }

  async get(accountId: string, skillId: string): Promise<AccountSkillRecord | null> {
    const row = await this.db
      .prepare('SELECT * FROM account_skills WHERE account_id = ? AND skill_id = ?')
      .bind(accountId, skillId)
      .first<AccountSkillRow>()
    return row ? rowToRecord(row) : null
  }

  async upsert(record: AccountSkillRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO account_skills
          (skill_id, account_id, name, description, instructions, resources,
           source_id, source_path, source_sha, pinned_commit, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (account_id, skill_id) DO UPDATE SET
           name = excluded.name,
           description = excluded.description,
           instructions = excluded.instructions,
           resources = excluded.resources,
           source_id = excluded.source_id,
           source_path = excluded.source_path,
           source_sha = excluded.source_sha,
           pinned_commit = excluded.pinned_commit,
           updated_at = excluded.updated_at,
           deleted_at = excluded.deleted_at`,
      )
      .bind(
        record.skillId,
        record.accountId,
        record.name,
        record.description,
        record.instructions,
        JSON.stringify(record.resources),
        record.sourceId,
        record.sourcePath,
        record.sourceSha,
        record.pinnedCommit,
        record.createdAt,
        record.updatedAt,
        record.deletedAt,
      )
      .run()
  }

  async softDelete(accountId: string, skillId: string, at: number): Promise<void> {
    await this.db
      .prepare(
        'UPDATE account_skills SET deleted_at = ?, updated_at = ? WHERE account_id = ? AND skill_id = ?',
      )
      .bind(at, at, accountId, skillId)
      .run()
  }

  async softDeleteBySource(sourceId: string, at: number): Promise<void> {
    await this.db
      .prepare(
        'UPDATE account_skills SET deleted_at = ?, updated_at = ? WHERE source_id = ? AND deleted_at IS NULL',
      )
      .bind(at, at, sourceId)
      .run()
  }

  async listBySource(sourceId: string): Promise<AccountSkillRecord[]> {
    const { results } = await this.db
      .prepare('SELECT * FROM account_skills WHERE source_id = ? AND deleted_at IS NULL')
      .bind(sourceId)
      .all<AccountSkillRow>()
    return results.map(rowToRecord)
  }
}
