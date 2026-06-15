import type {
  BootstrapJobRecord,
  BootstrapJobRecordPatch,
  BootstrapJobRepository,
} from '@cat-factory/core'
import type { D1Database } from '@cloudflare/workers-types'

interface BootstrapJobRow {
  id: string
  workspace_id: string
  reference_architecture_id: string
  reference_architecture_name: string
  repo_name: string
  repo_owner: string | null
  repo_url: string | null
  instructions: string
  status: string
  error: string | null
  created_at: number
  updated_at: number
}

function rowToRecord(row: BootstrapJobRow): BootstrapJobRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    referenceArchitectureId: row.reference_architecture_id,
    referenceArchitectureName: row.reference_architecture_name,
    repoName: row.repo_name,
    repoOwner: row.repo_owner,
    repoUrl: row.repo_url,
    instructions: row.instructions,
    status: row.status as BootstrapJobRecord['status'],
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** Maps a patch field name to its DB column. */
const PATCH_COLUMNS: Record<keyof BootstrapJobRecordPatch, string> = {
  status: 'status',
  repoOwner: 'repo_owner',
  repoUrl: 'repo_url',
  error: 'error',
  updatedAt: 'updated_at',
}

/** D1-backed log of "bootstrap repo" jobs (migration 0010). */
export class D1BootstrapJobRepository implements BootstrapJobRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async insert(record: BootstrapJobRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO bootstrap_jobs
          (id, workspace_id, reference_architecture_id, reference_architecture_name,
           repo_name, repo_owner, repo_url, instructions, status, error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        record.id,
        record.workspaceId,
        record.referenceArchitectureId,
        record.referenceArchitectureName,
        record.repoName,
        record.repoOwner,
        record.repoUrl,
        record.instructions,
        record.status,
        record.error,
        record.createdAt,
        record.updatedAt,
      )
      .run()
  }

  async update(workspaceId: string, id: string, patch: BootstrapJobRecordPatch): Promise<void> {
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined)
    if (entries.length === 0) return
    const setClause = entries
      .map(([key]) => `${PATCH_COLUMNS[key as keyof BootstrapJobRecordPatch]} = ?`)
      .join(', ')
    const values = entries.map(([, value]) => value as string | number | null)
    await this.db
      .prepare(`UPDATE bootstrap_jobs SET ${setClause} WHERE workspace_id = ? AND id = ?`)
      .bind(...values, workspaceId, id)
      .run()
  }

  async get(workspaceId: string, id: string): Promise<BootstrapJobRecord | null> {
    const row = await this.db
      .prepare('SELECT * FROM bootstrap_jobs WHERE workspace_id = ? AND id = ?')
      .bind(workspaceId, id)
      .first<BootstrapJobRow>()
    return row ? rowToRecord(row) : null
  }

  async listByWorkspace(workspaceId: string): Promise<BootstrapJobRecord[]> {
    const { results } = await this.db
      .prepare('SELECT * FROM bootstrap_jobs WHERE workspace_id = ? ORDER BY created_at DESC')
      .bind(workspaceId)
      .all<BootstrapJobRow>()
    return (results ?? []).map(rowToRecord)
  }
}
