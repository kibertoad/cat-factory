import type {
  BlueprintService,
  RepoBlueprintRecord,
  RepoBlueprintRepository,
} from '@cat-factory/core'
import type { D1Database } from '@cloudflare/workers-types'

interface RepoBlueprintRow {
  id: string
  workspace_id: string
  repo_owner: string
  repo_name: string
  source: string
  service_json: string
  created_at: number
  updated_at: number
}

function rowToRecord(row: RepoBlueprintRow): RepoBlueprintRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    source: row.source as RepoBlueprintRecord['source'],
    service: JSON.parse(row.service_json) as BlueprintService,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * D1-backed store of repository blueprints (migration 0011). One row per
 * (workspace, repo): `upsert` replaces the existing blueprint in place, keyed by
 * the unique `(workspace_id, repo_owner, repo_name)` index, so the row is always
 * the single current decomposition. The tree is persisted whole as JSON.
 */
export class D1RepoBlueprintRepository implements RepoBlueprintRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async upsert(record: RepoBlueprintRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO repo_blueprints
          (id, workspace_id, repo_owner, repo_name, source, service_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id, repo_owner, repo_name) DO UPDATE SET
           source = excluded.source,
           service_json = excluded.service_json,
           updated_at = excluded.updated_at`,
      )
      .bind(
        record.id,
        record.workspaceId,
        record.repoOwner,
        record.repoName,
        record.source,
        JSON.stringify(record.service),
        record.createdAt,
        record.updatedAt,
      )
      .run()
  }

  async get(workspaceId: string, id: string): Promise<RepoBlueprintRecord | null> {
    const row = await this.db
      .prepare('SELECT * FROM repo_blueprints WHERE workspace_id = ? AND id = ?')
      .bind(workspaceId, id)
      .first<RepoBlueprintRow>()
    return row ? rowToRecord(row) : null
  }

  async getByRepo(
    workspaceId: string,
    repoOwner: string,
    repoName: string,
  ): Promise<RepoBlueprintRecord | null> {
    const row = await this.db
      .prepare(
        'SELECT * FROM repo_blueprints WHERE workspace_id = ? AND repo_owner = ? AND repo_name = ?',
      )
      .bind(workspaceId, repoOwner, repoName)
      .first<RepoBlueprintRow>()
    return row ? rowToRecord(row) : null
  }

  async listByWorkspace(workspaceId: string): Promise<RepoBlueprintRecord[]> {
    const { results } = await this.db
      .prepare('SELECT * FROM repo_blueprints WHERE workspace_id = ? ORDER BY updated_at DESC')
      .bind(workspaceId)
      .all<RepoBlueprintRow>()
    return (results ?? []).map(rowToRecord)
  }

  async delete(workspaceId: string, id: string): Promise<void> {
    await this.db
      .prepare('DELETE FROM repo_blueprints WHERE workspace_id = ? AND id = ?')
      .bind(workspaceId, id)
      .run()
  }
}
