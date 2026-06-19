import type { TaskComment, TaskRecord, TaskRepository, TaskSourceKind } from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'

interface TaskRow {
  workspace_id: string
  source: string
  external_id: string
  title: string
  url: string
  status: string
  type: string
  assignee: string | null
  priority: string | null
  labels: string
  description: string
  comments: string
  excerpt: string
  linked_block_id: string | null
  synced_at: number
  deleted_at: number | null
}

/** Parse a JSON column, falling back to an empty array on anything malformed. */
function parseJsonArray<T>(json: string): T[] {
  try {
    const parsed = JSON.parse(json)
    if (Array.isArray(parsed)) return parsed as T[]
  } catch {
    // A malformed blob is treated as empty.
  }
  return []
}

function rowToRecord(row: TaskRow): TaskRecord {
  return {
    workspaceId: row.workspace_id,
    source: row.source as TaskSourceKind,
    externalId: row.external_id,
    title: row.title,
    url: row.url,
    status: row.status,
    type: row.type,
    assignee: row.assignee,
    priority: row.priority,
    labels: parseJsonArray<string>(row.labels),
    description: row.description,
    comments: parseJsonArray<TaskComment>(row.comments),
    excerpt: row.excerpt,
    linkedBlockId: row.linked_block_id,
    syncedAt: row.synced_at,
    deletedAt: row.deleted_at,
  }
}

/** D1-backed store of imported issue projections, across sources (migration 0014). */
export class D1TaskRepository implements TaskRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async upsert(record: TaskRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO tasks
          (workspace_id, source, external_id, title, url, status, type, assignee, priority,
           labels, description, comments, excerpt, linked_block_id, synced_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT (workspace_id, source, external_id) DO UPDATE SET
           title = excluded.title,
           url = excluded.url,
           status = excluded.status,
           type = excluded.type,
           assignee = excluded.assignee,
           priority = excluded.priority,
           labels = excluded.labels,
           description = excluded.description,
           comments = excluded.comments,
           excerpt = excluded.excerpt,
           linked_block_id = excluded.linked_block_id,
           synced_at = excluded.synced_at,
           deleted_at = NULL`,
      )
      .bind(
        record.workspaceId,
        record.source,
        record.externalId,
        record.title,
        record.url,
        record.status,
        record.type,
        record.assignee,
        record.priority,
        JSON.stringify(record.labels),
        record.description,
        JSON.stringify(record.comments),
        record.excerpt,
        record.linkedBlockId,
        record.syncedAt,
      )
      .run()
  }

  async get(
    workspaceId: string,
    source: TaskSourceKind,
    externalId: string,
  ): Promise<TaskRecord | null> {
    const row = await this.db
      .prepare(
        'SELECT * FROM tasks WHERE workspace_id = ? AND source = ? AND external_id = ? AND deleted_at IS NULL',
      )
      .bind(workspaceId, source, externalId)
      .first<TaskRow>()
    return row ? rowToRecord(row) : null
  }

  async listByWorkspace(workspaceId: string): Promise<TaskRecord[]> {
    const { results } = await this.db
      .prepare(
        'SELECT * FROM tasks WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY synced_at DESC',
      )
      .bind(workspaceId)
      .all<TaskRow>()
    return results.map(rowToRecord)
  }

  async listByBlock(workspaceId: string, blockId: string): Promise<TaskRecord[]> {
    const { results } = await this.db
      .prepare(
        'SELECT * FROM tasks WHERE workspace_id = ? AND linked_block_id = ? AND deleted_at IS NULL ORDER BY synced_at DESC',
      )
      .bind(workspaceId, blockId)
      .all<TaskRow>()
    return results.map(rowToRecord)
  }

  async linkBlock(
    workspaceId: string,
    source: TaskSourceKind,
    externalId: string,
    blockId: string | null,
  ): Promise<void> {
    await this.db
      .prepare(
        'UPDATE tasks SET linked_block_id = ? WHERE workspace_id = ? AND source = ? AND external_id = ?',
      )
      .bind(blockId, workspaceId, source, externalId)
      .run()
  }
}
