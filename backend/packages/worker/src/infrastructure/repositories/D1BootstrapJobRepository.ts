import type {
  BootstrapFailure,
  BootstrapJobRecord,
  BootstrapJobRecordPatch,
  BootstrapJobRepository,
} from '@cat-factory/core'
import type { D1Database } from '@cloudflare/workers-types'

interface BootstrapJobRow {
  id: string
  workspace_id: string
  reference_architecture_id: string | null
  reference_architecture_name: string | null
  repo_name: string
  repo_owner: string | null
  repo_url: string | null
  instructions: string
  status: string
  block_id: string | null
  /** JSON {completed,inProgress,total}; null until the agent reports. */
  subtasks: string | null
  error: string | null
  /** JSON-encoded BootstrapFailure; null unless the run failed (migration 0018). */
  failure: string | null
  created_at: number
  updated_at: number
}

/** Parse the JSON-encoded subtask counts column, tolerating a null/garbage value. */
function parseSubtasks(raw: string | null): BootstrapJobRecord['subtasks'] {
  if (!raw) return null
  try {
    const o = JSON.parse(raw) as Record<string, unknown>
    if (typeof o.completed === 'number' && typeof o.inProgress === 'number' && typeof o.total === 'number') {
      return { completed: o.completed, inProgress: o.inProgress, total: o.total }
    }
  } catch {
    // fall through
  }
  return null
}

/** Parse the JSON-encoded structured failure column, tolerating null/garbage. */
function parseFailure(raw: string | null): BootstrapFailure | null {
  if (!raw) return null
  try {
    const o = JSON.parse(raw) as BootstrapFailure
    if (o && typeof o.kind === 'string' && typeof o.message === 'string') return o
  } catch {
    // fall through
  }
  return null
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
    blockId: row.block_id ?? null,
    subtasks: parseSubtasks(row.subtasks ?? null),
    error: row.error,
    failure: parseFailure(row.failure ?? null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** Maps a patch field name to its DB column. */
const PATCH_COLUMNS: Record<keyof BootstrapJobRecordPatch, string> = {
  status: 'status',
  repoOwner: 'repo_owner',
  repoUrl: 'repo_url',
  blockId: 'block_id',
  subtasks: 'subtasks',
  error: 'error',
  failure: 'failure',
  updatedAt: 'updated_at',
}

/** Encode a patch value for D1: subtasks + failure are JSON, everything else scalar. */
function encodePatchValue(key: string, value: unknown): string | number | null {
  if (key === 'subtasks' || key === 'failure') return value == null ? null : JSON.stringify(value)
  return value as string | number | null
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
           repo_name, repo_owner, repo_url, instructions, status, block_id, subtasks,
           error, failure, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        record.blockId,
        record.subtasks == null ? null : JSON.stringify(record.subtasks),
        record.error,
        record.failure == null ? null : JSON.stringify(record.failure),
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
    const values = entries.map(([key, value]) => encodePatchValue(key, value))
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
