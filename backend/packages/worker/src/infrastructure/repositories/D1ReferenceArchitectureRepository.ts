import type {
  ReferenceArchitectureRecord,
  ReferenceArchitectureRecordPatch,
  ReferenceArchitectureRepository,
} from '@cat-factory/core'
import type { D1Database } from '@cloudflare/workers-types'

interface ReferenceArchitectureRow {
  id: string
  workspace_id: string
  name: string
  description: string
  repo_owner: string
  repo_name: string
  default_instructions: string
  created_at: number
  updated_at: number
  deleted_at: number | null
}

function rowToRecord(row: ReferenceArchitectureRow): ReferenceArchitectureRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    description: row.description,
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    defaultInstructions: row.default_instructions,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  }
}

/** Maps a patch field name to its DB column. */
const PATCH_COLUMNS: Record<keyof ReferenceArchitectureRecordPatch, string> = {
  name: 'name',
  description: 'description',
  repoOwner: 'repo_owner',
  repoName: 'repo_name',
  defaultInstructions: 'default_instructions',
  updatedAt: 'updated_at',
}

/** D1-backed list of reference architectures (migration 0010). */
export class D1ReferenceArchitectureRepository implements ReferenceArchitectureRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async insert(record: ReferenceArchitectureRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO reference_architectures
          (id, workspace_id, name, description, repo_owner, repo_name,
           default_instructions, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .bind(
        record.id,
        record.workspaceId,
        record.name,
        record.description,
        record.repoOwner,
        record.repoName,
        record.defaultInstructions,
        record.createdAt,
        record.updatedAt,
      )
      .run()
  }

  async update(
    workspaceId: string,
    id: string,
    patch: ReferenceArchitectureRecordPatch,
  ): Promise<void> {
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined)
    if (entries.length === 0) return
    const setClause = entries
      .map(([key]) => `${PATCH_COLUMNS[key as keyof ReferenceArchitectureRecordPatch]} = ?`)
      .join(', ')
    const values = entries.map(([, value]) => value as string | number | null)
    await this.db
      .prepare(
        `UPDATE reference_architectures SET ${setClause}
         WHERE workspace_id = ? AND id = ? AND deleted_at IS NULL`,
      )
      .bind(...values, workspaceId, id)
      .run()
  }

  async get(workspaceId: string, id: string): Promise<ReferenceArchitectureRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT * FROM reference_architectures
         WHERE workspace_id = ? AND id = ? AND deleted_at IS NULL`,
      )
      .bind(workspaceId, id)
      .first<ReferenceArchitectureRow>()
    return row ? rowToRecord(row) : null
  }

  async listByWorkspace(workspaceId: string): Promise<ReferenceArchitectureRecord[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM reference_architectures
         WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY created_at DESC`,
      )
      .bind(workspaceId)
      .all<ReferenceArchitectureRow>()
    return (results ?? []).map(rowToRecord)
  }

  async softDelete(workspaceId: string, id: string, at: number): Promise<void> {
    await this.db
      .prepare(
        `UPDATE reference_architectures SET deleted_at = ?
         WHERE workspace_id = ? AND id = ? AND deleted_at IS NULL`,
      )
      .bind(at, workspaceId, id)
      .run()
  }
}
